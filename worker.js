// Cloudflare Worker: ndërmjetës për adsb.lol (shton CORS që faqja jote ta lexojë)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    // Lejo vetëm kërkesat për avionë rreth një pike, që të mos përdoret për gjëra të tjera
    if (!/^\/v2\/point\/-?[\d.]+\/-?[\d.]+\/\d+$/.test(url.pathname)) {
      return new Response("Radar proxy OK", { headers: CORS });
    }

    const res = await fetch("https://api.adsb.lol" + url.pathname, {
      headers: { "User-Agent": "radar-fluturimesh (personal)" },
    });
    return new Response(res.body, {
      status: res.status,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "max-age=5" },
    });
  },
};
