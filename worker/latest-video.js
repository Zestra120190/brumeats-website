// Brum Eats: latest long-form YouTube episode for the brumeats.com hero player.
// Deployed as the Cloudflare Worker "damp-mud-1915-brumeats-wesbite-yt-player".
//
// Returns {"videoId": "..."} for the newest public upload longer than 3 minutes,
// so Shorts are skipped but episodes of any length count.
//
// YouTube quota: 2 units per lookup (playlistItems + videos), down from 100 for
// search. Each Worker instance also reuses its answer for FRESH_FOR_SECONDS.
//
// Bindings (unchanged from the previous version, set in the dashboard):
//   "Youtube-API"   Secrets Store secret: YouTube Data API key
//   YT_CHANNEL_ID   Secrets Store secret: channel ID, starts with "UC"

const ALLOWED_ORIGINS = ['https://brumeats.com', 'https://www.brumeats.com'];
const SHORTS_MAX_SECONDS = 180; // YouTube Shorts can run up to 3 minutes
const RECENT_UPLOADS = 25;      // enough to see past a week or two of daily Shorts
const FRESH_FOR_SECONDS = 600;  // how long one answer is reused (10 minutes)

// Best-effort memory of the last good answer, per Worker instance. It holds only
// public data (a video ID and a timestamp), never anything from a request, so it
// cannot leak between visitors. It also lets the site keep showing the last known
// episode if YouTube is down or the quota runs out.
let remembered = { videoId: null, fetchedAt: 0 };

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Forbidden', { status: 403 });
    }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };

    const ageSeconds = (Date.now() - remembered.fetchedAt) / 1000;
    if (remembered.videoId && ageSeconds < FRESH_FOR_SECONDS) {
      return reply({ videoId: remembered.videoId }, 200, cors, Math.floor(FRESH_FOR_SECONDS - ageSeconds));
    }

    try {
      const videoId = await latestLongFormVideo(env);
      if (!videoId) {
        throw new Error(`No public video over ${SHORTS_MAX_SECONDS}s in the last ${RECENT_UPLOADS} uploads`);
      }
      remembered = { videoId, fetchedAt: Date.now() };
      return reply({ videoId }, 200, cors, FRESH_FOR_SECONDS);
    } catch (err) {
      console.error(JSON.stringify({ message: 'latest video lookup failed', error: err.message }));
      // Keep showing the last episode we knew about; try YouTube again in a minute.
      if (remembered.videoId) return reply({ videoId: remembered.videoId }, 200, cors, 60);
      // Nothing to fall back on: the site shows its "New episode every Friday" tile.
      // no-store so browsers do not hold on to the failure.
      return reply({ videoId: null }, 502, cors, 0);
    }
  },
};

async function latestLongFormVideo(env) {
  const key = await env['Youtube-API'].get();
  const channelId = await env.YT_CHANNEL_ID.get();
  if (!channelId || !channelId.startsWith('UC')) {
    throw new Error('YT_CHANNEL_ID should be a channel ID starting with "UC"');
  }
  // Every channel's uploads playlist has the channel's ID with "UU" in place of "UC".
  const uploadsPlaylist = 'UU' + channelId.slice(2);

  // 1 unit: the newest uploads, Shorts included.
  const list = await youtube('playlistItems', {
    part: 'contentDetails',
    playlistId: uploadsPlaylist,
    maxResults: RECENT_UPLOADS,
    fields: 'items/contentDetails(videoId,videoPublishedAt)',
  }, key);
  const recent = (list.items || [])
    .map((item) => item.contentDetails)
    .filter((v) => v && v.videoId)
    .sort((a, b) => (b.videoPublishedAt || '').localeCompare(a.videoPublishedAt || ''));
  if (recent.length === 0) return null;

  // 1 unit: length and live/premiere status for all of them in one call.
  const details = await youtube('videos', {
    part: 'contentDetails,snippet',
    id: recent.map((v) => v.videoId).join(','),
    fields: 'items(id,contentDetails/duration,snippet/liveBroadcastContent)',
  }, key);
  const byId = new Map((details.items || []).map((v) => [v.id, v]));

  const newest = recent.find(({ videoId }) => {
    const v = byId.get(videoId);
    return v
      && v.snippet && v.snippet.liveBroadcastContent === 'none' // skip upcoming premieres and live streams
      && durationSeconds(v.contentDetails && v.contentDetails.duration) > SHORTS_MAX_SECONDS;
  });
  return newest ? newest.videoId : null;
}

async function youtube(endpoint, params, key) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  url.searchParams.set('key', key);

  const res = await fetch(url.toString());
  if (!res.ok) {
    // YouTube's error body names the reason (for example quotaExceeded) and does
    // not echo the key. Never log `url`: it contains the key.
    const body = await res.text();
    throw new Error(`YouTube ${endpoint} returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// "PT1H2M3S" -> 3723. Unparseable values count as 0, so they are never picked.
function durationSeconds(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return 0;
  const [days, hours, minutes, secs] = m.slice(1).map((n) => Number(n) || 0);
  return ((days * 24 + hours) * 60 + minutes) * 60 + secs;
}

function reply(body, status, cors, maxAgeSeconds) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': maxAgeSeconds > 0 ? `public, max-age=${maxAgeSeconds}` : 'no-store',
      ...cors,
    },
  });
}
