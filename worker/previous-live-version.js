// The Worker code that was live before 2026-11-24 (deployed 2026-03-08), kept for reference and rollback.
// Cloudflare also keeps this as an earlier version under the Worker's Deployments tab.
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = ['https://brumeats.com', 'https://www.brumeats.com'];

    if (!allowed.includes(origin)) {
      return new Response(`Forbidden - origin received: "${origin}"`, { status: 403 });
    }

    try {
      const apiKey = await env['Youtube-API'].get();
      const channelId = await env.YT_CHANNEL_ID.get();
      const url = `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&channelId=${channelId}&part=id&order=date&maxResults=1&type=video&videoDuration=medium`;
      const res = await fetch(url);
      const data = await res.json();
      const videoId = data.items?.[0]?.id?.videoId || null;

      return new Response(JSON.stringify({ videoId }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
          'Cache-Control': 'public, max-age=3600',
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ videoId: null, error: err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
        }
      });
    }
  }
}
