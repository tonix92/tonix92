// Viaro — Cloudflare Worker
// Vendos çelësin si Secret me emrin ANTHROPIC_API_KEY (Settings → Variables and Secrets)

const ALLOWED_ORIGINS = ["https://tonix92.github.io"]; // faqet që lejohen ta përdorin
const DAILY_LIMIT = 1;                                  // plane provë në ditë pa llogari (sipas IP)
const MONTHLY_LIMIT = 5;                                // plane në muaj për çdo llogari (rifillon më 1 të muajit)
const GLOBAL_DAILY_LIMIT = 300;                         // plane të reja me AI në ditë gjithsej (~1 $/ditë maksimumi)
const CACHE_DAYS = 30;                                  // sa ditë ripërdoret i njëjti plan për të njëjtën kërkesë
const MODEL = "claude-haiku-5-5";
const UA = "udhetimi-app/1.0 (+https://tonix92.github.io/tonix92/udhetimi/)";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) || /^(https?|capacitor):\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}
const MSG = {
  sq: { nokey: "Mungon ANTHROPIC_API_KEY te Cloudflare.", origin: "Faqja nuk lejohet.", bad: "Kërkesë e pavlefshme.", city: "Shkruaj qytetin.",
        limit: n => `Plani provë i sotëm u përdor. Hyr ose krijo llogari falas për 5 plane në muaj.`, month: (n, d) => `Ke përdorur të ${n} planet e këtij muaji. Planet e reja vijnë më ${d}.`, auth: "Sesioni skadoi. Hyr përsëri.", nocity: c => `Nuk e gjeta qytetin "${c}".`,
        few: "Nuk gjeta mjaftueshëm atraksione për këtë vend.", fail: "Diçka shkoi keq: ", badplan: "Plani nuk u krijua si duhet. Provo përsëri.",
        busy: "Sot janë krijuar shumë plane. Provo përsëri nesër, ose shiko planet te \"Zbulo\"." },
  en: { nokey: "ANTHROPIC_API_KEY is missing in Cloudflare.", origin: "This site is not allowed.", bad: "Invalid request.", city: "Enter a city.",
        limit: n => `You've used today's trial plan. Log in or create a free account for 5 plans a month.`, month: (n, d) => `You've used all ${n} plans this month. New plans arrive on ${d}.`, auth: "Your session expired. Please log in again.", nocity: c => `Couldn't find the city "${c}".`,
        few: "Couldn't find enough attractions for this place.", fail: "Something went wrong: ", badplan: "The plan wasn't generated correctly. Please try again.",
        busy: "Lots of plans were created today. Please try again tomorrow, or browse plans in \"Explore\"." },
  de: { nokey: "ANTHROPIC_API_KEY fehlt in Cloudflare.", origin: "Diese Seite ist nicht erlaubt.", bad: "Ungültige Anfrage.", city: "Bitte eine Stadt eingeben.",
        limit: n => `Dein Testplan für heute ist verbraucht. Melde dich an oder erstelle ein kostenloses Konto für 5 Pläne im Monat.`, month: (n, d) => `Du hast alle ${n} Pläne dieses Monats genutzt. Neue Pläne gibt es am ${d}.`, auth: "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.", nocity: c => `Die Stadt „${c}“ wurde nicht gefunden.`,
        few: "Für diesen Ort wurden nicht genug Sehenswürdigkeiten gefunden.", fail: "Etwas ist schiefgelaufen: ", badplan: "Der Plan wurde nicht richtig erstellt. Bitte erneut versuchen.",
        busy: "Heute wurden schon sehr viele Pläne erstellt. Versuch es morgen wieder oder stöbere unter \"Entdecken\"." },
};
Object.assign(MSG.sq, { edit_login: "Hyr në llogari për të ndryshuar planin me AI.", edit_limit: n => `I ke përdorur të ${n} ndryshimet me AI këtë muaj.`, now_limit: n => `Sot e ke përdorur "Çfarë të vizitoj tani?" ${n} herë. Provo nesër.`, now_where: "Lejo vendndodhjen ose shkruaj ku ndodhesh." });
Object.assign(MSG.en, { edit_login: "Log in to change the plan with AI.", edit_limit: n => `You've used all ${n} AI edits this month.`, now_limit: n => `You've used "What to visit now?" ${n} times today. Try again tomorrow.`, now_where: "Allow location or type where you are." });
Object.assign(MSG.de, { edit_login: "Melde dich an, um den Plan mit KI zu ändern.", edit_limit: n => `Du hast alle ${n} KI-Änderungen in diesem Monat genutzt.`, now_limit: n => `Du hast „Was jetzt besuchen?" heute ${n}-mal genutzt. Versuch es morgen wieder.`, now_where: "Erlaube den Standort oder gib ein, wo du bist." });
const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });

// Thirr një funksion në Supabase me tokenin e përdoruesit (kështu Supabase e di kush është)
async function sbRpc(env, token, fn, args = {}) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST", body: JSON.stringify(args),
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
function nextMonth(lang) {
  const d = new Date(); const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const loc = { sq: "sq-AL", en: "en-GB", de: "de-DE" }[lang] || "en-GB";
  try { return n.toLocaleDateString(loc, { day: "numeric", month: "long", timeZone: "UTC" }); } catch { return n.toISOString().slice(0, 10); }
}

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export default {
  // Çdo ditë: "zgjon" databazën që Supabase falas të mos e pauzojë projektin
  async scheduled(event, env, ctx) {
    if (env.SUPABASE_URL && env.SUPABASE_KEY)
      ctx.waitUntil(fetch(`${env.SUPABASE_URL}/rest/v1/plans?select=id&limit=1`, { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` } }));
  },

  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const H = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, { headers: H });
    if (req.method === "GET") {
      const m = new URL(req.url).pathname.match(/^\/p\/([0-9a-f-]{36})$/i);
      if (m) return sharePage(m[1], env);
      const u = new URL(req.url);
      if (u.pathname === "/status") {
        // Gjendja: versioni, planet dhe kostoja e sotme; me ?osm=1 provon serverët e OpenStreetMap
        const day = new Date().toISOString().slice(0, 10);
        const out = { version: "p9.0", kv: !!env.LIMITS, ors: !!env.ORS_KEY, today: await limitGet(env, caches.default, `d/${day}`) };
        if (u.searchParams.get("osm")) out.osm = await Promise.all(OVERPASS.map(async ep => {
          const t = Date.now();
          try {
            const r = await fetch(ep, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent('[out:json][timeout:20];node["tourism"="museum"]["wikidata"](around:1500,48.2085,16.3721);out tags 20;'), signal: AbortSignal.timeout(25000) });
            const txt = await r.text(); let n = null; try { n = JSON.parse(txt).elements.length; } catch {}
            return { ep, status: r.status, ms: Date.now() - t, n, body: n == null ? txt.slice(0, 80) : undefined };
          } catch (e) { return { ep, error: String(e.message || e), ms: Date.now() - t }; }
        }));
        return json(out, 200, H);
      }
      return new Response("Viaro API OK", { headers: H });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: H });
    let q;
    try { q = await req.json(); } catch { return json({ error: MSG.sq.bad }, 400, H); }
    const M = MSG[q?.ui] || MSG[q?.lang] || MSG.sq;
    const path = new URL(req.url).pathname;
    if (path === "/near") {
      if (origin && H["Access-Control-Allow-Origin"] !== origin) return json({ error: M.origin }, 403, H);
      return handleNear(q, req, env, ctx, H, M);
    }
    if (path === "/chat") {
      if (origin && H["Access-Control-Allow-Origin"] !== origin) return json({ error: M.origin }, 403, H);
      return handleChat(q, req, env, ctx, H, M);
    }
    if (path === "/replan") {
      if (origin && H["Access-Control-Allow-Origin"] !== origin) return json({ error: M.origin }, 403, H);
      return handleReplan(q, req, env, ctx, H, M);
    }
    if (path === "/edit" || path === "/now") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: M.nokey }, 500, H);
      if (origin && H["Access-Control-Allow-Origin"] !== origin) return json({ error: M.origin }, 403, H);
      return path === "/edit" ? handleEdit(q, req, env, ctx, H, M) : handleNow(q, req, env, ctx, H, M);
    }
    if (!env.ANTHROPIC_API_KEY) return json({ error: M.nokey }, 500, H);
    if (origin && H["Access-Control-Allow-Origin"] !== origin) return json({ error: M.origin }, 403, H);
    const p = sanitize(q);
    if (p.error) return json({ error: M.city }, 400, H);

    const cache = caches.default;

    // --- 1. A kemi plan të gatshëm për të njëjtën kërkesë? (falas, pa AI) ---
    const planKey = new Request("https://plans.local/v3/" + await sha(JSON.stringify([p.date,
      p.city.toLowerCase(), p.days, p.start, p.end, p.pace, p.transport, p.budget, p.lang, [...p.interests].sort(), p.notes.trim().toLowerCase(), p.adults, p.kids, [...p.kidAges].sort()])));
    if (!q.fresh) {
      const hit = await cache.match(planKey);
      if (hit) { const cached = await hit.json(); cached.cached = true; return json(cached, 200, H); }
    }

    // --- 2. Kufijtë: llogari = 5 në muaj (rezervohet para AI), pa llogari = 1 në ditë (IP), gjithsej 300 në ditë ---
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const day = new Date().toISOString().slice(0, 10);
    const ipKey = `g/${day}/${(await sha("vianto|" + (req.headers.get("CF-Connecting-IP") || "anon") + "|" + day)).slice(0, 32)}`;
    const dayKey = `d/${day}`;
    const [gUsed, dStat] = await Promise.all([token ? null : limitGet(env, cache, ipKey), limitGet(env, cache, dayKey)]);
    const stat = dStat || { n: 0, in: 0, out: 0, usd: 0 };
    if (stat.n >= GLOBAL_DAILY_LIMIT) return json({ error: M.busy }, 429, H);
    if (!token && (gUsed || 0) >= DAILY_LIMIT) return json({ error: M.limit(DAILY_LIMIT), code: "guest" }, 429, H);
    let quota = null, rid = null;
    if (token) {
      const r = await sbRpc(env, token, "reserve_plan_credit");
      if (!r) return json({ error: M.auth, code: "auth" }, 401, H);
      quota = { used: r.used, limit: r.limit || MONTHLY_LIMIT };
      if (!r.ok) return json({ error: M.month(MONTHLY_LIMIT, nextMonth(p.lang || q.ui)), code: "month", quota }, 429, H);
      rid = r.rid;
    }
    if (!token) await limitPut(env, cache, ipKey, (gUsed || 0) + 1);
    const refund = () => rid ? sbRpc(env, token, "refund_plan_credit", { rid }) : (!token ? limitPut(env, cache, ipKey, gUsed || 0) : null);

    try {
      // 1. Gjej qytetin
      const place = await geocode(p.city);
      if (!place) { await refund(); return json({ error: M.nocity(p.city) }, 404, H); }

      // 2. Atraksionet nga OpenStreetMap
      const radius = place.radius;
      let pois = await fetchPois(place.lat, place.lon, radius);
      if (pois.length < 5) { await refund(); return json({ error: M.few }, 404, H); }

      // 3. Popullariteti nga Wikidata (sa Wikipedia e kanë artikullin)
      await addPopularity(pois);
      pois.sort((a, b) => b.pop - a.pop);
      const perDay = { qete: 4, normal: 6, intensiv: 8 }[p.pace];
      const take = Math.min(pois.length, Math.max(15, Math.min(70, Math.round(p.days * perDay * 1.8))));
      pois = pois.slice(0, take).map((x, i) => ({ ...x, id: "P" + (i + 1) }));

      // 4. Ndarja në zona (një zonë ≈ një ditë)
      kmeans(pois, Math.min(p.days, pois.length));

      // 5. Plani nga Claude
      const plan = await askClaude(env.ANTHROPIC_API_KEY, p, place, pois, M, tripDates(p.date, p.days));

      // 6. Verifikimi, renditja, rrugët dhe oraret sipas datës
      const byId = Object.fromEntries(pois.map(x => [x.id, x]));
      await finishPlan(env, plan, p, byId);
      plan.city = { name: place.name, country: place.country, lat: place.lat, lon: place.lon };
      plan.request = p;
      plan.ai = aiCost(MODEL, plan.usage);
      plan.v = 2;
      plan.budget = cleanBudget(plan.budget, plan.days.length);
      plan.poi_src = pois.some(x => !String(x.osm || "").startsWith("wiki")) ? "osm" : "wiki";

      stat.n++; stat.in += plan.ai.in; stat.out += plan.ai.out; stat.usd = +(stat.usd + plan.ai.usd).toFixed(5);
      ctx.waitUntil(Promise.all([
        limitPut(env, cache, dayKey, stat),
        cache.put(planKey, new Response(JSON.stringify(plan), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_DAYS * 86400}` } })),
      ]));
      if (token) plan.quota = quota; else plan.guest = true;
      return json(plan, 200, H);
    } catch (e) {
      await refund();
      return json({ error: M.fail + (e.message || e) }, 502, H);
    }
  },
};

// ---------- Faqja e ndarjes (pamja paraprake në WhatsApp, Facebook, X…) ----------
const APP_URL = "https://tonix92.github.io/tonix92/udhetimi/";
async function sharePage(id, env) {
  const appLink = `${APP_URL}?p=${id}`;
  const OG = {
    sq: { t: (d, c) => `${d} ditë në ${c}`, def: "Plan udhëtimi", desc: "Shiko këtë plan udhëtimi ditë për ditë, krijuar me Viaro.", by: a => ` — nga ${a}`, open: "Po hapet plani…", click: "Kliko këtu nëse nuk hapet" },
    en: { t: (d, c) => `${d} days in ${c}`, def: "Travel plan", desc: "See this day-by-day travel plan, made with Viaro.", by: a => ` — by ${a}`, open: "Opening the plan…", click: "Click here if it doesn't open" },
    de: { t: (d, c) => `${d} Tage in ${c}`, def: "Reiseplan", desc: "Sieh dir diesen Tag-für-Tag-Reiseplan an, erstellt mit Viaro.", by: a => ` — von ${a}`, open: "Plan wird geöffnet…", click: "Hier klicken, falls er sich nicht öffnet" },
  };
  let L = OG.sq, title = L.def, desc = L.desc, img = null;
  if (env.SUPABASE_URL && env.SUPABASE_KEY) {
    try {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/plans?id=eq.${id}&is_public=eq.true&select=title,city,country,days,summary,author_name,photo_url,lang:data->request->>lang`,
        { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` } });
      const [p] = r.ok ? await r.json() : [];
      if (p) {
        L = OG[p.lang] || OG.sq;
        title = L.t(p.days, p.city);
        desc = (p.summary || p.title || L.desc) + (p.author_name ? L.by(p.author_name) : "");
        if (p.photo_url && /^https:\/\//.test(p.photo_url)) img = p.photo_url;   // foto e postimit si pamje paraprake
      } else { title = L.def; desc = L.desc; }
    } catch {}
  }
  const e = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<!DOCTYPE html><html lang="${Object.keys(OG).find(k => OG[k] === L)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Viaro">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:image" content="${e(img || APP_URL + "og.png")}">
${img ? "" : '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'}
<meta property="og:url" content="${e(appLink)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}"><meta name="twitter:description" content="${e(desc)}">
<meta name="twitter:image" content="${e(img || APP_URL + "og.png")}">
<meta http-equiv="refresh" content="0;url=${e(appLink)}">
</head><body style="font-family:system-ui;padding:24px">
<p>${L.open} <a href="${e(appLink)}">${L.click}</a>.</p>
<script>location.replace(${JSON.stringify(appLink)})</script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}

// ---------- Kontrolli i të dhënave ----------
const KID_AGES = ["0-3", "4-8", "9-12", "13-17"];
const INTERESTS = ["histori", "muze", "art", "arkitekture", "natyre", "pamje", "ushqim", "blerje", "nate", "femije", "fe", "fotografi"];
function sanitize(q) {
  const city = String(q.city || "").trim().slice(0, 80);
  if (city.length < 2) return { error: "Shkruaj qytetin." };
  const days = Math.max(1, Math.min(7, parseInt(q.days) || 2));
  const time = s => /^\d{2}:\d{2}$/.test(s || "") ? s : null;
  const start = time(q.start) || "09:00", end = time(q.end) || "19:00";
  const pace = ["qete", "normal", "intensiv"].includes(q.pace) ? q.pace : "normal";
  const transport = ["kembe", "publik", "vetura"].includes(q.transport) ? q.transport : "kembe";
  const interests = (Array.isArray(q.interests) ? q.interests : []).filter(i => INTERESTS.includes(i)).slice(0, 8);
  const budget = ["ulet", "mesem", "larte"].includes(q.budget) ? q.budget : "mesem";
  const lang = ["sq", "en", "de"].includes(q.lang) ? q.lang : "sq";
  const notes = String(q.notes || "").slice(0, 300);
  const adults = Math.max(1, Math.min(12, parseInt(q.adults) || 1));
  const kids = Math.max(0, Math.min(8, parseInt(q.kids) || 0));
  const kidAges = kids ? (Array.isArray(q.kidAges) ? q.kidAges : []).filter(a => KID_AGES.includes(a)) : [];
  let date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : null;
  if (date) { const t = Date.parse(date + "T00:00:00Z"), now = Date.now(); if (isNaN(t) || t < now - 2 * 86400000 || t > now + 730 * 86400000) date = null; }
  return { city, days, start, end, pace, transport, interests, budget, lang, notes, adults, kids, kidAges, date };
}

// ---------- Gjeokodimi ----------
async function geocode(city) {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=en&q=${encodeURIComponent(city)}`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("Gjeokodimi dështoi (" + r.status + ")");
  const [g] = await r.json();
  if (!g) return null;
  const bb = g.boundingbox.map(Number); // [s, n, w, e]
  const lat = +g.lat, lon = +g.lon;
  const diag = hav(bb[0], bb[2], bb[1], bb[3]);
  const radius = Math.round(Math.max(2500, Math.min(9000, diag * 0.35)));
  return { lat, lon, radius, name: g.address?.city || g.address?.town || g.address?.village || g.name, country: g.address?.country || "" };
}

// ---------- Atraksionet ----------
// Atraksionet ruhen 30 ditë për çdo qytet, që Overpass të mos pyetet çdo herë
async function fetchPois(lat, lon, R) {
  const key = new Request(`https://cache.udhetimi/pois4/${lat.toFixed(3)},${lon.toFixed(3)},${R}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  let out = [];
  // Overpass nuk arrihet nga Cloudflare (provuar me /status?osm=1), prandaj nuk pyetet: kursen 4 kërkesa
  let osmOk = false;
  if (USE_OVERPASS) { osmOk = true; try { out = await fetchPoisLive(lat, lon, R); } catch (e) { out = []; osmOk = false; } }
  if (out.length < 15) {
    if (out.length < 5) osmOk = false;
    const wiki = await fetchWikiPois(lat, lon, R).catch(() => []);
    const seen = new Set(out.map(x => x.wd));
    out = out.concat(wiki.filter(x => !seen.has(x.wd)));
  }
  // Nga OSM ruhet 30 ditë; kur u përdor vetëm Wikipedia (OSM ra), vetëm 1 ditë
  if (out.length) await addPopularity(out);
  if (out.length >= 5) await caches.default.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=" + 86400 * (osmOk ? 30 : 1) } }));
  return out;
}

async function fetchPoisLive(lat, lon, R) {
  const a = `(around:${R},${lat},${lon})`;
  const query = `[out:json][timeout:40];
(
  nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park|artwork)$"]["wikidata"]${a};
  nwr["historic"~"^(castle|monument|palace|fort|ruins|city_gate|church|cathedral|archaeological_site|memorial|building|tower|citywalls)$"]["wikidata"]${a};
  nwr["amenity"~"^(place_of_worship|theatre|marketplace|fountain|library)$"]["wikidata"]${a};
  nwr["leisure"~"^(park|garden|stadium)$"]["wikidata"]${a};
  nwr["man_made"~"^(tower|bridge|lighthouse)$"]["wikidata"]${a};
  nwr["place"="square"]["wikidata"]${a};
  nwr["bridge"="yes"]["wikidata"]["name"]${a};
);
out center tags qt 900;`;
  // Të gjithë serverët Overpass pyeten njëkohësisht; fiton përgjigja e parë e vlefshme
  const ctrl = new AbortController();
  const ask = async ep => {
    const r = await fetch(ep, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query), signal: ctrl.signal });
    if (!r.ok) throw new Error("Overpass " + r.status);
    const d = await r.json(); if (!d.elements?.length) throw new Error("Overpass bosh");
    return d;
  };
  let data; const timer = setTimeout(() => ctrl.abort(), 8000);
  try { data = await Promise.any(OVERPASS.map(ask)); } catch { throw new Error("Overpass dështoi"); } finally { clearTimeout(timer); ctrl.abort(); }
  const seen = new Set(), out = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    const wd = t.wikidata, name = t["name:en"] || t.name;
    if (!wd || !name || seen.has(wd)) continue;
    const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon;
    if (la == null || lo == null) continue;
    seen.add(wd);
    out.push({
      wd, name, local: t.name && t.name !== name ? t.name : undefined, lat: +la.toFixed(5), lon: +lo.toFixed(5),
      kind: t.tourism || t.historic || t.amenity || t.leisure || t.man_made || (t.place ? "square" : t.bridge ? "bridge" : "place"),
      religion: t.religion, oh: t.opening_hours ? t.opening_hours.slice(0, 200) : undefined,
      fee: t.fee, charge: t.charge ? t.charge.slice(0, 60) : undefined,
      addr: t["addr:street"] ? [[t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ")].filter(Boolean).join(", ") : undefined, osm: `${el.type}/${el.id}`, wiki: t.wikipedia,
    });
  }
  return out;
}

// Rezervë: artikujt e Wikipedia-s afër qendrës (shpejt dhe i qëndrueshëm)
const SKIP = /station|stop\b|company|school|university|college|hospital|embassy|consulate|hotel|street|road|avenue|airport|bank|office|corporation|club|agency|ministry|court|prison|electoral|constituency|subdivision|municipality|settlement|neighbourhood|district|quarter|business|apartment|residential|monarchy|empire|kingdom|republic|country|capital|largest city|city in|city of|town in|siege|battle|treaty|congress|conference|meeting|war\b|riot|protest|attack|bombing|massacre|dynasty|period|era\b|organi[sz]ation|party|people|family|band\b|novel|film|album|song|event|festival|election|incident|plan\b|metro|tram|railway|line\b|company|newspaper|publisher|record label|brand|restaurant chain|sports team/i;
async function fetchWikiPois(lat, lon, R) {
  const url = "https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=geosearch" +
    `&ggscoord=${lat}|${lon}&ggsradius=${Math.min(R, 10000)}&ggslimit=500&prop=coordinates|pageprops|description&ppprop=wikibase_item&colimit=500`;
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
  const d = await r.json();
  const out = [];
  for (const pg of d.query?.pages || []) {
    const wd = pg.pageprops?.wikibase_item, c = pg.coordinates?.[0];
    if (!wd || !c) continue;
    const desc = pg.description || "";
    if (!desc || /^\d/.test(desc) || SKIP.test(desc) || /^(List of|History of|Timeline of)|\(disambiguation\)/.test(pg.title)) continue;
    out.push({ wd, name: pg.title, lat: +c.lat.toFixed(5), lon: +c.lon.toFixed(5), kind: desc.slice(0, 50) || "place", osm: "wiki/" + pg.pageid, wiki: "en:" + pg.title });
  }
  return out;
}

const USE_OVERPASS = false;
async function addPopularity(all) {
  const pois = all.filter(p => p.pop == null && p.wd);
  if (!pois.length) return;
  const ids = pois.map(p => p.wd);
  const pop = {};
  const batches = [];
  for (let i = 0; i < ids.length && i < 750; i += 50) batches.push(ids.slice(i, i + 50));
  await Promise.all(batches.map(async b => {
    try {
      const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&ids=${b.join("|")}`, { headers: { "User-Agent": UA } });
      const d = await r.json();
      for (const [id, ent] of Object.entries(d.entities || {}))
        pop[id] = Object.keys(ent.sitelinks || {}).filter(k => /wiki$/.test(k) && !/commonswiki|specieswiki|wikidatawiki|metawiki/.test(k)).length;
    } catch {}
  }));
  for (const p of pois) {
    p.pop = pop[p.wd] || 0;
    if (p.kind === "place_of_worship" || p.kind === "church") p.pop *= 0.8; // shumë kisha të vogla
    if (p.kind === "artwork" || p.kind === "memorial") p.pop *= 0.6;
  }
  for (const p of all) if (p.pop == null) p.pop = 0;
}

// ---------- Zonat (k-means) ----------
function kmeans(pts, k) {
  if (k <= 1) { pts.forEach(p => p.zone = 1); return; }
  let c = [...pts].sort((a, b) => b.pop - a.pop).slice(0, k).map(p => [p.lat, p.lon]);
  for (let it = 0; it < 25; it++) {
    for (const p of pts) {
      let best = 0, bd = Infinity;
      c.forEach((cc, i) => { const d = (p.lat - cc[0]) ** 2 + ((p.lon - cc[1]) * Math.cos(p.lat * Math.PI / 180)) ** 2; if (d < bd) { bd = d; best = i; } });
      p.zone = best + 1;
    }
    c = c.map((cc, i) => {
      const m = pts.filter(p => p.zone === i + 1);
      return m.length ? [m.reduce((s, p) => s + p.lat, 0) / m.length, m.reduce((s, p) => s + p.lon, 0) / m.length] : cc;
    });
  }
}

// ---------- Claude ----------
const LANG = { sq: "shqip", en: "English", de: "Deutsch" };
const INTEREST_NAMES = { histori: "history", muze: "museums", art: "art", arkitekture: "architecture", natyre: "nature & parks", pamje: "viewpoints",
  ushqim: "local food", blerje: "shopping", nate: "nightlife", femije: "with children", fe: "religious sites", fotografi: "photography" };

async function askClaude(key, p, place, pois, M, dates = []) {
  const closedOn = x => {
    if (!dates.length || !x.oh) return "";
    const rules = ohParse(x.oh); if (!rules) return "";
    const c = dates.map((dt, i) => ohOn(rules, dt).st === "closed" ? i + 1 : 0).filter(Boolean);
    return c.length ? `|CLOSED on day ${c.join(",")}` : "";
  };
  const list = pois.map(x =>
    `${x.id}|${x.name}${x.local ? " (" + x.local + ")" : ""}|${x.kind}${x.religion ? "/" + x.religion : ""}|zone ${x.zone}|${x.lat},${x.lon}|pop ${Math.round(x.pop)}${x.oh ? "|hours: " + x.oh.slice(0, 80) : ""}${closedOn(x)}${x.fee ? "|fee: " + x.fee : ""}`
  ).join("\n");

  const system = `You are an expert local travel planner. You build realistic, walkable day-by-day itineraries.
Rules:
- Use ONLY places from the provided list for sightseeing stops, referenced by their id (e.g. "P3"). Never invent attractions.
- Each day should mostly stay within one zone (places in the same zone are close together). Order stops to minimise walking/backtracking, using the coordinates.
- Never schedule a place on a day marked "CLOSED on day N". Respect the daily time window, pace and opening hours where given. Most museums are closed on Monday in many European cities — mention it in tips if relevant.
- Include a lunch stop (and dinner if the day ends after 19:00) as {"poi": null, "type": "meal"} with a suggestion of the neighbourhood and a typical local dish. Do not name specific restaurants.
- Prioritise famous places (higher "pop") and the traveller's interests. Do not repeat a place.
- Give realistic visit durations (big museums 2–3h, viewpoints 20–30 min) and travel time between stops.
- If children are travelling: pick child-friendly stops first, keep museum visits short, add a rest or playground/park break every 2–3 hours, avoid long walks between stops, and mention family/child tickets. For children aged 0–3 add stroller/nap tips; for teenagers prefer interactive and active places.
- "budget": realistic ESTIMATES in EUR for the WHOLE group per day (entry tickets for the planned stops, food incl. the meals, local transport, parking only when travelling by car, paid activities, other). Numbers only, no text. Match the budget level.
- Write all human-readable text in ${LANG[p.lang]}. Keep notes short (1–2 sentences) and practical (tickets, best time, queues).
- Reply with JSON only, no markdown.`;

  const user = `City: ${place.name}, ${place.country}
Days: ${p.days}
${dates.length ? `Dates: ${dates.map((dt, i) => `day ${i + 1} = ${WD[dt.getUTCDay()]} ${isoDay(dt)}`).join(", ")}\n` : ""}Daily time window: ${p.start}–${p.end}
Pace: ${{ qete: "relaxed (3-4 sights/day)", normal: "normal (5-6 sights/day)", intensiv: "intensive (7-8 sights/day)" }[p.pace]}
Getting around: ${{ kembe: "on foot", publik: "on foot + public transport", vetura: "car" }[p.transport]}
Budget: ${{ ulet: "low", mesem: "medium", larte: "high" }[p.budget]}
Interests: ${p.interests.map(i => INTEREST_NAMES[i]).join(", ") || "general highlights"}
Travellers: ${p.adults} adult${p.adults === 1 ? "" : "s"}${p.kids ? ` + ${p.kids} child${p.kids === 1 ? "" : "ren"}${p.kidAges.length ? " (ages " + p.kidAges.join(", ") + ")" : ""}` : ""}
${p.notes ? "Extra wishes: " + p.notes : ""}

Places (id|name|type|zone|lat,lon|popularity|...):
${list}

Return this JSON shape:
{"title": "...", "summary": "2 sentences", "days": [{"day": 1, "theme": "short title", "area": "neighbourhood name", "stops": [{"poi": "P1", "name": "display name", "type": "visit|meal|break|walk", "start": "09:00", "duration_min": 90, "travel_min": 10, "note": "...", "tip": "..."}]}], "tips": ["3-5 general tips: transport ticket, city card, safety, etc."], "budget": {"currency": "EUR", "days": [{"day": 1, "tickets": 0, "food": 0, "transport": 0, "parking": 0, "activities": 0, "other": 0}], "free": ["2-4 free things to do in this city, preferably places from the list"]}, "cost_estimate": "rough daily cost in EUR excluding hotel${p.adults + p.kids > 1 ? ", for the whole group (say so)" : " per person"}"}`;

  // Provo deri në 2 herë: nëse përgjigja vjen e prerë ose jo si JSON, kërkohet përsëri
  let plan = null, d = null; const total = {};
  for (let attempt = 0; attempt < 2 && !plan; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, system, messages: [{ role: "user", content: attempt ? user + "\n\nIMPORTANT: reply with ONE complete, valid JSON object only. Keep notes short." : user }] }),
    });
    d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || "Claude API " + r.status);
    for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) total[k] = (total[k] || 0) + (d.usage?.[k] || 0);
    const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const parsed = parseJson(text);
    if (parsed && Array.isArray(parsed.days) && parsed.days.length) plan = parsed;
  }
  if (!plan) throw new Error(M.badplan);
  plan.usage = total;
  return plan;
}

function parseJson(t) {
  t = String(t || "").replace(/```(?:json)?/gi, "");
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e < s) return null;
  const raw = t.slice(s, e + 1);
  try { return JSON.parse(raw); } catch {}
  // Rregullime të vogla: presje para kllapave mbyllëse, thonjëza "të zgjuara"
  try { return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1").replace(/[\u201C\u201D]/g, '\\"')); } catch { return null; }
}

function hav(la1, lo1, la2, lo2) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}


// ================== FAZA 2: oraret, rrugët, kufijt, kostot ==================

// ---- Kostoja e Claude (USD për 1M tokenë, kërkesa deri 100K tokenë) ----
const PRICE = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10] };
function aiCost(model, usage) {
  const [pi, po] = PRICE[model] || [0, 0];
  const inT = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
  const outT = usage?.output_tokens || 0;
  return { model, in: inT, out: outT, usd: +((inT * pi + outT * po) / 1e6).toFixed(5) };
}

// ---- Kufijt ditorë në Cloudflare KV (global, jo sipas qendrës së të dhënave) ----
// Nëse KV "LIMITS" nuk është lidhur ende, përdoret mënyra e vjetër (Cache API).
async function limitGet(env, cache, key) {
  if (env.LIMITS) { const v = await env.LIMITS.get(key); return v ? JSON.parse(v) : null; }
  const hit = await cache.match(new Request("https://rl.local/" + key));
  return hit ? JSON.parse(await hit.text()) : null;
}
async function limitPut(env, cache, key, val) {
  const s = JSON.stringify(val);
  if (env.LIMITS) return env.LIMITS.put(key, s, { expirationTtl: 86400 * 40 });
  return cache.put(new Request("https://rl.local/" + key), new Response(s, { headers: { "Cache-Control": "max-age=172800" } }));
}

// ---- Datat e udhëtimit ----
const WD = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function tripDates(date, days) {
  if (!date) return [];
  const [y, m, d] = date.split("-").map(Number);
  return Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)));
}
const isoDay = dt => dt.toISOString().slice(0, 10);

// ---- Oraret e hapjes (formati opening_hours i OpenStreetMap, pjesa më e zakonshme) ----
// Kthen null kur formati nuk kuptohet → oraret mbeten "të pakonfirmuara".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const toMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
function ohParse(oh) {
  if (!oh) return null;
  let s = String(oh).replace(/"[^"]*"/g, "").replace(/\|\|/g, ";").replace(/,\s+(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)/g, ",").replace(/\s*-\s*(?=\d{1,2}:\d{2})/g, "-").trim();
  if (/^24\/7$/.test(s)) return [{ days: null, months: null, spans: [[0, 1440]] }];
  const rules = [];
  for (let part of s.split(";")) {
    part = part.trim(); if (!part) continue;
    let months = null;
    const mm = part.match(/^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))?(?:,(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))?)*)(?::)?\s+/);
    if (mm) {
      months = new Set();
      for (const r of mm[1].split(",")) {
        const [a, b] = r.split("-").map(x => MONTHS.indexOf(x));
        if (b == null || b < 0) months.add(a); else for (let i = a; ; i = (i + 1) % 12) { months.add(i); if (i === b) break; }
      }
      part = part.slice(mm[0].length).trim();
    }
    let days = null;
    const dm = part.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)(?:\s+|$)/);
    if (dm) {
      days = new Set(); let onlyHoliday = true;
      for (const r of dm[1].split(",")) {
        if (r === "PH" || r === "SH") continue;
        onlyHoliday = false;
        const [a, b] = r.split("-").map(x => WD.indexOf(x));
        if (b == null || b < 0) days.add(a); else for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; }
      }
      part = part.slice(dm[0].length).trim();
      if (onlyHoliday) continue; // festat zyrtare nuk i dimë: rregulli injorohet
    }
    if (/^(off|closed)$/i.test(part)) { rules.push({ days, months, spans: [] }); continue; }
    if (/^open$/i.test(part) || part === "") { if (part === "" && !days) return null; rules.push({ days, months, spans: [[0, 1440]] }); continue; }
    const spans = [];
    for (const t of part.split(",")) {
      const x = t.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/);
      if (!x) return null;
      let a = toMin(x[1]), b = toMin(x[2]); if (b <= a) b += 1440;
      spans.push([a, b]);
    }
    rules.push({ days, months, spans });
  }
  return rules.length ? rules : null;
}
// Statusi për një datë: { st: "open"|"closed"|"unknown", spans }
function ohOn(rules, dt) {
  if (!rules) return { st: "unknown", spans: null };
  if (!dt) return { st: "unknown", spans: null };
  const wd = dt.getUTCDay(), mo = dt.getUTCMonth();
  let spans = null;
  for (const r of rules) {
    if (r.months && !r.months.has(mo)) continue;
    if (r.days && !r.days.has(wd)) continue;
    spans = r.spans; // rregulli i mëvonshëm mbizotëron
  }
  if (spans == null) return { st: "closed", spans: [] };
  return { st: spans.length ? "open" : "closed", spans };
}
const fmtMin = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const spansText = sp => sp.map(([a, b]) => b - a >= 1440 ? "24h" : `${fmtMin(a)}–${fmtMin(b)}`).join(", ");

// ---- Mënyra e lëvizjes dhe vlerësimet kur nuk ka shërbim rrugësh ----
const ORS_PROFILE = { kembe: "foot-walking", vetura: "driving-car", publik: "foot-walking" };
function estimateLeg(m, transport) {
  const km = m / 1000;
  const walk = Math.max(1, Math.round(km * 1.3 / 4.5 * 60));
  if (transport === "vetura") return { mode: "driving", min: Math.max(3, Math.round(km * 1.4 / 25 * 60) + 5), m: Math.round(m * 1.4), est: true };
  if (transport === "publik" && walk > 15) return { mode: "transit", min: Math.round(10 + km * 3), m: Math.round(m * 1.3), est: true };
  return { mode: "walking", min: walk, m: Math.round(m * 1.3), est: true };
}

// ---- Renditja: 2-opt mbi distancat (rruga e hapur, pika e parë mund të jetë e fiksuar) ----
function twoOpt(pts, fixedFirst) {
  const n = pts.length; if (n < 3) return pts.map((_, i) => i);
  const d = (i, j) => hav(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon);
  let order = pts.map((_, i) => i), improved = true, guard = 0;
  const len = o => o.slice(1).reduce((s, x, k) => s + d(o[k], x), 0);
  let best = len(order);
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = fixedFirst ? 1 : 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const o = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
      const l = len(o); if (l + 1 < best) { best = l; order = o; improved = true; }
    }
  }
  return order;
}
function reorderDay(stops) {
  // Ndalesat me koordinata riorganizohen brenda segmenteve mes vakteve; vaktet mbeten në vend
  const out = []; let seg = [], anchor = null;
  const flush = () => {
    if (seg.length >= 3) {
      const pts = anchor ? [anchor, ...seg] : seg;
      const ord = twoOpt(pts, !!anchor).filter(i => !anchor || i > 0).map(i => pts[i]);
      out.push(...ord);
    } else out.push(...seg);
    if (seg.length) anchor = out[out.length - 1];
    seg = [];
  };
  for (const s of stops) { if (s.lat != null) seg.push(s); else { flush(); out.push(s); } }
  flush();
  return out;
}

// ---- Rrugët reale nga OpenRouteService (opsionale: kërkon ORS_KEY) ----
async function orsRoute(env, pts, transport) {
  if (!env.ORS_KEY || pts.length < 2) return null;
  const profile = ORS_PROFILE[transport] || "foot-walking";
  try {
    const r = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { Authorization: env.ORS_KEY, "Content-Type": "application/json", Accept: "application/geo+json" },
      body: JSON.stringify({ coordinates: pts.map(p => [p.lon, p.lat]), instructions: false }),
    });
    if (!r.ok) return null;
    const f = (await r.json()).features?.[0]; if (!f) return null;
    const coords = f.geometry.coordinates, wp = f.properties.way_points || [];
    const legs = (f.properties.segments || []).map((sg, i) => ({
      min: Math.max(1, Math.round(sg.duration / 60)), m: Math.round(sg.distance),
      line: coords.slice(wp[i], (wp[i + 1] ?? coords.length - 1) + 1),
    }));
    return legs.length === pts.length - 1 ? legs : null;
  } catch { return null; }
}
// Thjeshton vijën: ruan çdo pikë të n-të që dita të mos rëndojë shumë
function thin(line, max = 120) {
  const step = Math.max(1, Math.ceil(line.length / max));
  const out = line.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== line[line.length - 1]) out.push(line[line.length - 1]);
  return out.map(([lo, la]) => [+la.toFixed(5), +lo.toFixed(5)]);
}

// ---- Orari i ditës: koha e nisjes, pritja për hapje, paralajmërimet ----
function schedule(stops, legsByIdx, dayStart, dayEnd, dt) {
  let t = toMin(dayStart), travelTotal = 0; const warn = [];
  const res = stops.map((s, idx) => {
    const c = { ...s };
    if (idx > 0) {
      const leg = legsByIdx.get(idx);
      if (leg) { c.travel_min = leg.min; c.travel_m = leg.m; c.travel_mode = leg.mode; c.travel_est = !!leg.est; }
      t += c.travel_min || 0; travelTotal += c.travel_min || 0;
    }
    let start = t; const dur = Math.max(10, Math.min(300, parseInt(c.duration_min) || 60));
    if (c._earliest != null && start < c._earliest) start = c._earliest; // vaktet nuk dalin më herët se ora e planifikuar
    if (c._oh && dt) {
      const o = ohOn(c._oh, dt);
      if (o.st === "open") {
        const sp = o.spans.find(([a, b]) => start < b) || null;
        if (sp && start < sp[0]) start = sp[0];
        if (!sp || start + Math.min(dur, 45) > sp[1]) { c.hours_warn = "closes"; warn.push(c.name); }
      } else if (o.st === "closed") { c.hours_warn = "closed"; warn.push(c.name); }
    }
    c.start = fmtMin(start); c.duration_min = dur; t = start + dur;
    return c;
  });
  const over = t - toMin(dayEnd);
  return { stops: res, warn, over: over > 30 ? over : 0, travelTotal };
}

// ---- Të dhënat e OpenStreetMap për vendet e zgjedhura, përmes Nominatim (orari, tarifa, adresa) ----
// Overpass nuk arrihet nga Cloudflare, ndaj çdo vend i planit kontrollohet veç e veç (1 kërkesë në sekondë).
async function osmFetch(poi) {
  try {
    const d = 0.02;
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&addressdetails=1&limit=5&bounded=1&accept-language=en&viewbox=${poi.lon - d},${poi.lat + d},${poi.lon + d},${poi.lat - d}&q=${encodeURIComponent(poi.name)}`;
    const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const arr = await r.json();
    const best = arr.find(x => poi.wd && x.extratags?.wikidata === poi.wd) || arr.find(x => hav(poi.lat, poi.lon, +x.lat, +x.lon) < 250);
    if (!best) return {};
    const e = best.extratags || {}, a = best.address || {};
    const street = [a.road || a.pedestrian || a.square || a.footway, a.house_number].filter(Boolean).join(" ");
    const town = [a.postcode, a.city || a.town || a.village].filter(Boolean).join(" ");
    return { m: poi.wd && e.wikidata === poi.wd ? "wikidata" : "near", oh: e.opening_hours, fee: e.fee, charge: e.charge, addr: [street, town].filter(Boolean).join(", ") || undefined };
  } catch { return null; }
}
// Një objekt i vetëm në cache për çdo zonë (~10 km): pak kërkesa për thirrje (Cloudflare lejon 50)
async function enrichPois(list, max = 15) {
  const todo = list.filter(p => p && !p.oh && !p.addr && p.lat != null);
  if (!todo.length) return;
  const key = new Request(`https://cache.udhetimi/osmd2/${todo[0].lat.toFixed(1)},${todo[0].lon.toFixed(1)}`);
  const hit = await caches.default.match(key);
  const map = hit ? await hit.json() : {};
  let fetched = 0, changed = false;
  for (const poi of todo) {
    const id = poi.wd || poi.name;
    let d = map[id];
    if (d === undefined && fetched < max) {
      const t = Date.now();
      if (fetched) await new Promise(r => setTimeout(r, Math.max(0, 1100 - (Date.now() - t))));
      d = await osmFetch(poi); fetched++;
      if (d) { map[id] = d; changed = true; }
    }
    if (d && d.m) Object.assign(poi, { oh: d.oh, fee: poi.fee || d.fee, charge: poi.charge || d.charge, addr: d.addr, osm_match: d.m });
  }
  if (changed) await caches.default.put(key, new Response(JSON.stringify(map), { headers: { "Cache-Control": "max-age=" + 86400 * 30 } }));
}

// ---- Zbatimi mbi planin: verifikimi, renditja, rrugët dhe oraret ----
async function finishPlan(env, plan, p, byId, opts = {}) {
  const dates = tripDates(p.date, p.days);
  const used = [...new Set((plan.days || []).flatMap(d => (d.stops || []).map(s => s.poi)).filter(id => id && byId[id]))].map(id => byId[id]);
  await enrichPois(used, opts.enrichMax ?? 15);
  for (const [i, d] of (plan.days || []).entries()) {
    const dt = dates[i] || null;
    if (dt) { d.date = isoDay(dt); }
    // Lidh vendet me të dhënat e verifikuara nga OSM/Wikidata
    let stops = (d.stops || []).map(s => {
      const poi = s.poi && byId[s.poi];
      if (!poi) return { ...s, poi: null, lat: undefined, lon: undefined, verified: s.type === "meal" ? undefined : false };
      const c = { ...s, lat: poi.lat, lon: poi.lon, wiki: poi.wiki, osm: poi.osm, wd: poi.wd, name: s.name || poi.name, verified: true };
      if (poi.addr) c.address = poi.addr;
      if (poi.fee) c.fee = poi.fee; if (poi.charge) c.price = poi.charge;
      if (poi.oh) {
        c.hours_raw = poi.oh; const rules = ohParse(poi.oh);
        if (rules) { c._oh = rules; const o = ohOn(rules, dt); c.hours = o.st === "unknown" ? null : (o.st === "open" ? spansText(o.spans) : "closed"); c.hours_ok = !!dt; }
      }
      return c;
    });
    // Mos përsërit të njëjtin vend në të njëjtën ditë
    const seen = new Set(); stops = stops.filter(s => !s.poi || (seen.has(s.poi) ? false : seen.add(s.poi)));
    // Renditja: krahaso renditjen e Claude me atë të optimizuar, mbaj më të mirën
    const tryOrder = async (order, useOrs) => {
      const geoIdx = order.map((s, k) => s.lat != null ? k : -1).filter(k => k >= 0);
      const pts = geoIdx.map(k => order[k]);
      const legs = useOrs ? await orsRoute(env, pts, p.transport) : null;
      const legsByIdx = new Map();
      for (let j = 1; j < geoIdx.length; j++) {
        const a = pts[j - 1], b = pts[j];
        let leg = legs ? { ...legs[j - 1], mode: p.transport === "vetura" ? "driving" : "walking", est: false } : estimateLeg(hav(a.lat, a.lon, b.lat, b.lon), p.transport);
        if (legs && p.transport === "publik" && leg.min > 15) leg = { ...estimateLeg(leg.m / 1.3, "publik"), line: null };
        legsByIdx.set(geoIdx[j], leg);
      }
      const sch = schedule(order, legsByIdx, p.start, p.end, dt);
      return { ...sch, legsByIdx, score: sch.warn.length * 120 + sch.over + sch.travelTotal };
    };
    const a = await tryOrder(stops, false);
    const alt = opts.keepOrder ? stops : reorderDay(stops);
    const changed = alt.some((s, k) => s !== stops[k]);
    const b = changed ? await tryOrder(alt, false) : null;
    let best = b && b.score + 5 < a.score ? b : a;
    const optimized = best === b;
    if (env.ORS_KEY) best = await tryOrder(optimized ? alt : stops, true);
    d.stops = best.stops.map(({ _oh, ...s }) => s);
    d.route = [...best.legsByIdx.entries()].filter(([, l]) => l.line).map(([k, l]) => ({ to: k, line: thin(l.line) }));
    d.routed = !!d.route.length;
    if (best.over) d.overtime_min = best.over;
    d.optimized = optimized;
  }
}

// ================== FAZA 4: buxheti ==================
const TR_EN = { kembe: "on foot", publik: "on foot + public transport", vetura: "car" };
const BUD_KEYS = ["tickets", "food", "transport", "parking", "activities", "other"];
function cleanBudget(b, nDays) {
  if (!b || !Array.isArray(b.days)) return null;
  const num = v => Math.max(0, Math.min(20000, Math.round(+v || 0)));
  const days = b.days.slice(0, nDays).map((d, i) => Object.fromEntries([["day", i + 1], ...BUD_KEYS.map(k => [k, num(d?.[k])])]));
  if (!days.length) return null;
  return { currency: /^[A-Z]{3}$/.test(b.currency || "") ? b.currency : "EUR", days, free: (Array.isArray(b.free) ? b.free : []).map(x => String(x).slice(0, 160)).slice(0, 5), estimate: true };
}

// ================== FAZA 3: editori me bisedë dhe "Çfarë të vizitoj tani?" ==================

const bearer = req => (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
async function callClaude(key, system, user, maxTokens = 6000) {
  const total = {}; let out = null;
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: attempt ? user + "\n\nIMPORTANT: reply with ONE valid JSON object only." : user }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || "Claude API " + r.status);
    for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) total[k] = (total[k] || 0) + (d.usage?.[k] || 0);
    out = parseJson((d.content || []).filter(c => c.type === "text").map(c => c.text).join(""));
  }
  return { out, usage: total };
}
async function addDayStat(env, ai) {
  const key = `d/${new Date().toISOString().slice(0, 10)}`;
  const st = (await limitGet(env, caches.default, key)) || { n: 0, in: 0, out: 0, usd: 0 };
  st.calls = (st.calls || 0) + 1; st.in += ai.in; st.out += ai.out; st.usd = +(st.usd + ai.usd).toFixed(5);
  await limitPut(env, caches.default, key, st);
  return st;
}

// Restorante të vërteta afër një pike (OpenStreetMap përmes Nominatim)
async function nearbyFood(lat, lon) {
  const key = new Request(`https://cache.udhetimi/food1/${lat.toFixed(3)},${lon.toFixed(3)}`);
  const hit = await caches.default.match(key); if (hit) return hit.json();
  const d = 0.007, out = [];
  try {
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&addressdetails=1&limit=12&bounded=1&accept-language=en&viewbox=${lon - d},${lat + d},${lon + d},${lat - d}&q=restaurant`;
    const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
    if (r.ok) for (const x of await r.json()) {
      if (!x.name || x.type !== "restaurant") continue;
      const e = x.extratags || {}, a = x.address || {};
      out.push({ name: x.name, lat: +(+x.lat).toFixed(5), lon: +(+x.lon).toFixed(5), kind: "restaurant", cuisine: e.cuisine, oh: e.opening_hours, wd: e.wikidata,
        addr: [[a.road || a.pedestrian || a.square, a.house_number].filter(Boolean).join(" "), [a.postcode, a.city || a.town || a.village].filter(Boolean).join(" ")].filter(Boolean).join(", ") || undefined,
        osm: x.osm_type?.[0] + x.osm_id });
    }
  } catch {}
  await caches.default.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=" + 86400 * 7 } }));
  return out;
}
const FOOD_RE = /restaurant|restorant|ushqim|drek|dark|mëngjes|food|eat|lunch|dinner|essen|mittag|abend|café|kafe|cafe/i;

// ---- /edit: ndryshon vetëm pjesën që kërkon përdoruesi ----
async function handleEdit(q, req, env, ctx, H, M) {
  const token = bearer(req);
  if (!token) return json({ error: M.edit_login, code: "auth" }, 401, H);
  const old = q.plan, msg = String(q.message || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!msg || !old || !Array.isArray(old.days) || !old.days.length || old.days.length > 7 || JSON.stringify(old).length > 400000) return json({ error: M.bad }, 400, H);
  const res = await sbRpc(env, token, "reserve_edit_credit");
  if (!res) return json({ error: M.auth, code: "auth" }, 401, H);
  if (!res.ok) return json({ error: M.edit_limit(res.limit), code: "edit_month" }, 429, H);
  const refund = () => sbRpc(env, token, "refund_edit_credit", { rid: res.rid });
  try {
    const rq = old.request || {};
    const p = sanitize({ ...rq, city: old.city?.name || rq.city || "city", days: old.days.length });
    if (p.error) throw new Error(M.bad);
    p.date = old.days[0]?.date || rq.date || null;
    const lang = LANG[q.lang] ? q.lang : p.lang;

    // Vendet ekzistuese marrin ID (S1_0...), kandidatët e rinj C1..., restorantet R1...
    const byId = {};
    const days = old.days.map((d, di) => ({ ...d, stops: (d.stops || []).slice(0, 15).map((s, si) => {
      const c = { ...s }; delete c._marker;
      if (c.lat != null) { const id = `S${di + 1}_${si}`; c.poi = id; byId[id] = { name: c.name, lat: c.lat, lon: c.lon, wiki: c.wiki, osm: c.osm, wd: c.wd, oh: c.hours_raw, addr: c.address, fee: c.fee, charge: c.price }; }
      else c.poi = null;
      return c;
    }) }));
    const clat = old.city?.lat ?? days.flatMap(d => d.stops).find(s => s.lat != null)?.lat, clon = old.city?.lon ?? days.flatMap(d => d.stops).find(s => s.lon != null)?.lon;
    if (clat == null) throw new Error(M.bad);
    const usedNames = new Set(days.flatMap(d => d.stops.map(s => (s.name || "").toLowerCase())));
    let cands = (await fetchPois(clat, clon, 6000)).filter(x => !usedNames.has(x.name.toLowerCase()));
    await addPopularity(cands); cands.sort((a, b) => b.pop - a.pop); cands = cands.slice(0, 45);
    cands.forEach((x, i) => { x.id = "C" + (i + 1); byId[x.id] = x; });
    let food = [];
    if (FOOD_RE.test(msg)) {
      const centers = days.map(d => { const g = d.stops.filter(s => s.lat != null); return g.length ? [g.reduce((a, s) => a + s.lat, 0) / g.length, g.reduce((a, s) => a + s.lon, 0) / g.length] : null; }).filter(Boolean);
      for (const [la, lo] of centers.slice(0, 2)) food.push(...(await nearbyFood(la, lo)));
      food = food.filter((x, i, a) => a.findIndex(y => y.name === x.name) === i).slice(0, 20);
      food.forEach((x, i) => { x.id = "R" + (i + 1); byId[x.id] = x; });
    }

    const planTxt = days.map((d, di) => `Day ${di + 1}${d.date ? " (" + d.date + ")" : ""} "${d.theme || ""}":\n` + d.stops.map((s, si) =>
      `  [${si}] ${s.start || "?"} ${s.name} (${s.type || "visit"}, ${s.duration_min || 60} min${s.lat != null ? `, ${s.lat},${s.lon}` : ""}${s.hours_warn ? ", WARNING " + s.hours_warn : ""})`).join("\n")).join("\n");
    const candTxt = cands.map(x => `${x.id}|${x.name}|${x.kind}|${x.lat},${x.lon}|pop ${Math.round(x.pop || 0)}`).join("\n");
    const foodTxt = food.map(x => `${x.id}|${x.name}|restaurant${x.cuisine ? " " + x.cuisine : ""}|${x.lat},${x.lon}${x.oh ? "|hours " + x.oh.slice(0, 60) : ""}`).join("\n");
    const system = `You edit an existing city itinerary. Change ONLY what the traveller asks; keep every other stop, time and text exactly as it is.
Rules:
- New sights may come ONLY from the candidate list (ids C1, C2...). New restaurants ONLY from the restaurant list (ids R1...). Never invent places, addresses or coordinates.
- If the request cannot be done with these lists, return no ops and explain briefly in "reply".
- Stops are referenced by day number (1-based) and index [n] as shown.
- Times are recalculated automatically after your changes, so do not worry about them.
- Write "reply" and any note/tip in ${LANG[lang]}; reply = 1–2 sentences saying exactly what changed.
- Reply with JSON only.`;
    const user = `Traveller request: "${msg}"
Travellers: ${p.adults} adult(s)${p.kids ? ` + ${p.kids} child(ren)${p.kidAges.length ? " ages " + p.kidAges.join(",") : ""}` : ""}. Daily window ${p.start}–${p.end}. Getting around: ${TR_EN[p.transport] || "on foot"}.

Current itinerary:
${planTxt}

Candidate sights (id|name|type|lat,lon|popularity):
${candTxt || "(none)"}
${food.length ? "\nRestaurants nearby (id|name|type|lat,lon|hours):\n" + foodTxt : ""}

Allowed ops:
{"op":"remove","day":1,"idx":2}
{"op":"replace","day":1,"idx":2,"id":"C4","duration_min":60,"note":"...","tip":"..."}
{"op":"add","day":1,"after":2,"id":"C7","duration_min":45,"note":"..."}   (after -1 = at the start; restaurants: "id":"R2")
{"op":"move","day":1,"idx":3,"to_day":2,"after":1}
{"op":"duration","day":1,"idx":0,"minutes":45}
{"op":"break","day":1,"after":2,"name":"...","duration_min":30,"note":"..."}   (rest, coffee or generic meal without a specific place)
{"op":"theme","day":1,"theme":"..."}

Current budget estimate (EUR, whole group): ${old.budget ? JSON.stringify({ days: old.budget.days }) : "none"}
After your changes ALWAYS return "budget" for the whole updated itinerary: {"currency":"EUR","days":[{"day":1,"tickets":0,"food":0,"transport":0,"parking":0,"activities":0,"other":0}],"free":["2-4 free things to do nearby"]} (whole group, realistic estimates; keep unchanged days as they were).

Return: {"ops":[...],"reply":"...","budget":{...}}`;
    const { out, usage } = await callClaude(env.ANTHROPIC_API_KEY, system, user, 4000);
    if (!out || !Array.isArray(out.ops)) throw new Error(M.badplan);
    const ai = aiCost(MODEL, usage);

    // Zbato ndryshimet mbi objektet origjinale (indekset i referohen planit para ndryshimit)
    const at = (d, i) => days[d - 1]?.stops?.[i];
    const mk = (id, op) => {
      const x = byId[id]; if (!x || !/^[CR]\d+$/.test(id)) return null;
      return { poi: id, name: x.name, type: x.kind === "restaurant" ? "meal" : "visit", duration_min: Math.max(10, Math.min(300, parseInt(op.duration_min) || 60)),
        note: String(op.note || "").slice(0, 300), tip: String(op.tip || "").slice(0, 200), cuisine: x.cuisine };
    };
    const ops = out.ops.slice(0, 30).map(o => ({ ...o, _t: o.idx != null ? at(o.day, o.idx) : null, _a: o.after != null && o.after >= 0 ? at(o.op === "move" ? o.to_day : o.day, o.after) : null }));
    let applied = 0;
    const insertAfter = (dn, ref, s) => { const arr = days[dn - 1]?.stops; if (!arr || !s) return; const k = ref ? arr.indexOf(ref) : -1; arr.splice(k + 1, 0, s); applied++; };
    for (const o of ops) {
      const arr = days[(o.day || 0) - 1]?.stops;
      if (o.op === "remove" && o._t) { o._t._del = true; applied++; }
      else if (o.op === "replace" && o._t && arr) { const s = mk(o.id, o); const k = arr.indexOf(o._t); if (s && k >= 0) { arr[k] = s; applied++; } }
      else if (o.op === "add") insertAfter(o.day, o._a, mk(o.id, o));
      else if (o.op === "break") insertAfter(o.day, o._a, { poi: null, type: "break", name: String(o.name || "Pause").slice(0, 80), duration_min: Math.max(10, Math.min(180, parseInt(o.duration_min) || 30)), note: String(o.note || "").slice(0, 300) });
      else if (o.op === "duration" && o._t) { o._t.duration_min = Math.max(10, Math.min(300, parseInt(o.minutes) || o._t.duration_min)); applied++; }
      else if (o.op === "move" && o._t && days[(o.to_day || 0) - 1]) { const k = arr ? arr.indexOf(o._t) : -1; if (k >= 0) { arr.splice(k, 1); insertAfter(o.to_day, o._a, o._t); } }
      else if (o.op === "theme" && days[o.day - 1]) { days[o.day - 1].theme = String(o.theme || "").slice(0, 80); applied++; }
    }
    const changedStops = applied;
    const nb = cleanBudget(out.budget, days.length);
    if (nb && !applied && !old.budget) applied++; // vetëm buxheti (plan i vjetër pa buxhet)
    days.forEach(d => { d.stops = d.stops.filter(s => !s._del); d.stops.forEach(s => { delete s._del; if (changedStops) delete s.start; }); });
    const plan = { ...old, days };
    delete plan.usage;
    if (nb) plan.budget = { ...nb, my: old.budget?.my };
    if (changedStops) await finishPlan(env, plan, p, byId, { enrichMax: 8, keepOrder: !/rend|organi|order|ordn|optimi|shkurt|distanc|kürz|weg/i.test(msg) });
    plan.days.forEach(d => d.stops.forEach(s => { if (s.poi && /^S\d/.test(s.poi)) s.poi = null; }));
    plan.ai_edits = { n: (old.ai_edits?.n || 0) + 1, usd: +((old.ai_edits?.usd || 0) + ai.usd).toFixed(5) };
    ctx.waitUntil(addDayStat(env, ai));
    if (!applied) await refund();
    return json({ plan: applied ? plan : null, reply: String(out.reply || "").slice(0, 400), applied, ai, edits: { used: applied ? res.used : res.used - 1, limit: res.limit } }, 200, H);
  } catch (e) {
    await refund();
    return json({ error: M.fail + (e.message || e) }, 502, H);
  }
}

// ---- /now: "Çfarë të vizitoj tani?" ----
async function weatherNow(lat, lon) {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code&timezone=auto`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const c = (await r.json()).current; if (!c) return null;
    return { temp: Math.round(c.temperature_2m), rain: c.precipitation > 0.1 || [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(c.weather_code), snow: [71, 73, 75, 77, 85, 86].includes(c.weather_code), code: c.weather_code };
  } catch { return null; }
}
async function reverseName(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lon}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
    const j = await r.json(); const a = j.address || {};
    return { name: a.city || a.town || a.village || a.county || j.name || "", country: a.country || "" };
  } catch { return { name: "", country: "" }; }
}
async function handleNow(q, req, env, ctx, H, M) {
  const cache = caches.default, day = new Date().toISOString().slice(0, 10);
  const token = bearer(req);
  const who = token ? "u" + (await sha(token.split(".")[1] || token)).slice(0, 24) : "ip" + (await sha("vianto|" + (req.headers.get("CF-Connecting-IP") || "anon") + "|" + day)).slice(0, 24);
  const nKey = `n/${day}/${who}`, used = (await limitGet(env, cache, nKey)) || 0, maxN = token ? 6 : 2;
  if (used >= maxN) return json({ error: M.now_limit(maxN), code: token ? "now_day" : "guest" }, 429, H);
  const stat = (await limitGet(env, cache, `d/${day}`)) || { n: 0 };
  if ((stat.n || 0) + (stat.calls || 0) >= GLOBAL_DAILY_LIMIT * 2) return json({ error: M.busy }, 429, H);

  let lat = parseFloat(q.lat), lon = parseFloat(q.lon), place = null;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
    const where = String(q.place || "").trim().slice(0, 100);
    if (where.length < 2) return json({ error: M.now_where }, 400, H);
    place = await geocode(where);
    if (!place) return json({ error: M.nocity(where) }, 404, H);
    lat = place.lat; lon = place.lon;
  }
  const minutes = Math.max(60, Math.min(480, parseInt(q.minutes) || 180));
  const time = /^\d{2}:\d{2}$/.test(q.time || "") ? q.time : "14:00";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : day;
  const lang = LANG[q.lang] ? q.lang : "sq";
  const transport = ["kembe", "publik", "vetura"].includes(q.transport) ? q.transport : "kembe";
  const interests = (Array.isArray(q.interests) ? q.interests : []).filter(i => INTERESTS.includes(i)).slice(0, 8);
  const budget = ["ulet", "mesem", "larte"].includes(q.budget) ? q.budget : "mesem";
  const maxDist = { kembe: 1800, publik: 4000, vetura: 8000 }[transport] * Math.min(1.5, minutes / 180);

  await limitPut(env, cache, nKey, used + 1);
  try {
    const [pois0, wx, rn] = await Promise.all([fetchPois(+lat.toFixed(3), +lon.toFixed(3), 3000), weatherNow(lat, lon), place ? Promise.resolve(place) : reverseName(lat, lon)]);
    let pois = pois0.map(x => ({ ...x, dist: hav(lat, lon, x.lat, x.lon) })).filter(x => x.dist <= maxDist);
    if (pois.length < 3) { await limitPut(env, cache, nKey, used); return json({ error: M.few }, 404, H); }
    await addPopularity(pois);
    pois.sort((a, b) => (b.pop || 0) / (1 + b.dist / 800) - (a.pop || 0) / (1 + a.dist / 800));
    pois = pois.slice(0, 24);
    await enrichPois(pois.slice(0, 12), 10);
    const [y, mo, dd] = date.split("-").map(Number), dt = new Date(Date.UTC(y, mo - 1, dd)), now = toMin(time);
    const open = [];
    for (const x of pois) {
      const rules = ohParse(x.oh), o = ohOn(rules, dt);
      if (o.st === "closed") continue;
      if (o.st === "open") { const sp = o.spans.find(([a, b]) => now < b - 30); if (!sp) continue; x.now = sp[0] > now ? `opens ${fmtMin(sp[0])}` : `open until ${fmtMin(sp[1])}`; }
      else x.now = "hours unknown";
      open.push(x);
    }
    if (open.length < 2) { await limitPut(env, cache, nKey, used); return json({ error: M.few }, 404, H); }
    open.forEach((x, i) => { x.id = "C" + (i + 1); });
    const list = open.map(x => `${x.id}|${x.name}|${x.kind}|${Math.round(x.dist)} m away|pop ${Math.round(x.pop || 0)}|${x.now}${x.fee ? "|fee " + x.fee : ""}`).join("\n");
    const system = `You recommend what to visit RIGHT NOW. Pick 3–5 places ONLY from the list (by id), in a sensible walking order starting near the traveller, that fit in the free time including travel. Never invent places. Prefer "open until" places; use "hours unknown" places only if needed and say to check hours. ${wx?.rain || wx?.snow ? "It is raining/snowing: prefer indoor places." : ""}
Write text in ${LANG[lang]}. Reply JSON only: {"title":"...","summary":"1 sentence","stops":[{"id":"C1","duration_min":45,"note":"why now, 1 sentence","tip":"..."}]}`;
    const user = `Local time ${time}, date ${date} (${WD[dt.getUTCDay()]}). Free time: ${minutes} min. Getting around: ${TR_EN[transport] || "on foot"}. Budget: ${{ ulet: "low", mesem: "medium", larte: "high" }[budget]}. Interests: ${interests.map(i => INTEREST_NAMES[i]).join(", ") || "highlights"}.${wx ? ` Weather: ${wx.temp}°C${wx.rain ? ", rain" : ""}${wx.snow ? ", snow" : ""}.` : ""}
Places (id|name|type|distance|popularity|hours now):
${list}`;
    const { out, usage } = await callClaude(env.ANTHROPIC_API_KEY, system, user, 2500);
    if (!out || !Array.isArray(out.stops) || !out.stops.length) throw new Error(M.badplan);
    const byId = Object.fromEntries(open.map(x => [x.id, x]));
    const stops = out.stops.filter(s => byId[s.id]).slice(0, 6).map(s => ({ poi: s.id, name: byId[s.id].name, type: "visit", duration_min: Math.max(10, Math.min(180, parseInt(s.duration_min) || 45)), note: String(s.note || "").slice(0, 300), tip: String(s.tip || "").slice(0, 200) }));
    if (!stops.length) throw new Error(M.badplan);
    const end = fmtMin(Math.min(23 * 60 + 59, now + minutes));
    const p = { days: 1, date, start: time, end, transport, lang, interests, budget, adults: 1, kids: 0, kidAges: [], city: rn.name };
    const plan = { kind: "now", title: String(out.title || "").slice(0, 120), summary: String(out.summary || "").slice(0, 300), days: [{ day: 1, theme: String(out.title || "").slice(0, 80), stops }], tips: [], city: { name: rn.name, country: rn.country, lat, lon }, request: p, weather: wx };
    await finishPlan(env, plan, p, byId, { enrichMax: 4 });
    plan.ai = aiCost(MODEL, usage); plan.v = 2;
    ctx.waitUntil(addDayStat(env, plan.ai));
    return json(plan, 200, H);
  } catch (e) {
    await limitPut(env, cache, nKey, used);
    return json({ error: M.fail + (e.message || e) }, 502, H);
  }
}

// ================== FAZA 7: Smart Replanning ==================
// Ndryshon vetëm pjesën e mbetur të një dite. Ndalesat para "idx" dhe ditët e tjera nuk preken kurrë.
const RP_LIMIT = { user: 20, guest: 10, ai: 10 };
const INDOOR_RE = /museum|gallery|church|cathedral|basilica|chapel|mosque|synagogue|temple|palace|theatre|theater|opera|library|aquarium|market hall|shopping|arcade|planetarium|exhibition|concert hall|castle|abbey/i;
async function sbUser(env, token) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null; const u = await r.json(); return u?.id || null;
  } catch { return null; }
}
// Orari i pjesës së mbetur: nis te "T" (minuta), me kalimin nga ndalesa e fundit e ruajtur ("anchor")
async function scheduleRest(env, anchor, rest, T, p, dt, useOrs) {
  const order = anchor ? [{ ...anchor, duration_min: 10, _oh: undefined }, ...rest] : rest;
  const geoIdx = order.map((s, k) => s.lat != null ? k : -1).filter(k => k >= 0);
  const pts = geoIdx.map(k => order[k]);
  const legs = useOrs ? await orsRoute(env, pts, p.transport) : null;
  const legsByIdx = new Map();
  for (let j = 1; j < geoIdx.length; j++) {
    const a = pts[j - 1], b = pts[j];
    let leg = legs ? { ...legs[j - 1], mode: p.transport === "vetura" ? "driving" : "walking", est: false } : estimateLeg(hav(a.lat, a.lon, b.lat, b.lon), p.transport);
    if (legs && p.transport === "publik" && leg.min > 15) leg = { ...estimateLeg(leg.m / 1.3, "publik"), line: null };
    legsByIdx.set(geoIdx[j], leg);
  }
  const sch = schedule(order, legsByIdx, fmtMin(Math.max(0, anchor ? T - 10 : T)), p.end, dt);
  const off = anchor ? 1 : 0;
  return {
    stops: sch.stops.slice(off).map(({ _oh, _earliest, ...s }) => s), over: sch.over, warn: sch.warn,
    lines: [...legsByIdx.entries()].filter(([k, l]) => l.line && k >= off).map(([k, l]) => ({ k: k - off, line: thin(l.line) })),
  };
}
function candStop(x, o, dt) {
  const s = { poi: null, name: x.name, type: "visit", duration_min: Math.max(15, Math.min(240, parseInt(o.duration_min) || 60)),
    note: String(o.note || "").slice(0, 300), tip: String(o.tip || "").slice(0, 200), lat: x.lat, lon: x.lon, wiki: x.wiki, osm: x.osm, wd: x.wd, verified: true, replanned: true };
  if (x.addr) s.address = x.addr; if (x.fee) s.fee = x.fee; if (x.charge) s.price = x.charge;
  if (x.oh) { s.hours_raw = x.oh; const r = ohParse(x.oh); if (r) { const st = ohOn(r, dt); s.hours = st.st === "unknown" ? null : (st.st === "open" ? spansText(st.spans) : "closed"); s.hours_ok = !!dt; } }
  return s;
}
// Kandidatë të verifikuar afër një pike, të hapur rreth orës "T" të asaj dite
async function replanCands(center, usedNames, p, dt, T, filter) {
  const maxD = { kembe: 1500, publik: 4000, vetura: 8000 }[p.transport] || 1500;
  let c = (await fetchPois(+center.lat.toFixed(3), +center.lon.toFixed(3), 3000))
    .filter(x => !usedNames.has(String(x.name).toLowerCase()) && (!filter || filter(x)))
    .map(x => ({ ...x, dist: hav(center.lat, center.lon, x.lat, x.lon) })).filter(x => x.dist <= maxD);
  c.sort((a, b) => (b.pop || 0) / (1 + b.dist / 600) - (a.pop || 0) / (1 + a.dist / 600));
  c = c.slice(0, 14);
  await enrichPois(c.slice(0, 8), 6);
  return c.filter(x => {
    const r = ohParse(x.oh); if (!r || !dt) { x.now = "hours unknown"; return true; }
    const o = ohOn(r, dt); if (o.st === "closed") return false;
    if (o.st === "open") { const sp = o.spans.find(([a, b]) => T + 30 < b); if (!sp) return false; x.now = `open ${spansText(o.spans)}`; }
    return true;
  }).slice(0, 10);
}
async function dayForecast(lat, lon, date) {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${date}&end_date=${date}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null; const d = (await r.json()).daily; if (!d?.time?.length) return null;
    return `max ${Math.round(d.temperature_2m_max[0])}°C, min ${Math.round(d.temperature_2m_min[0])}°C, rain ${d.precipitation_sum[0]} mm, code ${d.weather_code[0]}`;
  } catch { return null; }
}
async function handleReplan(q, req, env, ctx, H, M) {
  const reason = String(q.reason || "");
  if (!["late", "closed", "weather", "remove", "add"].includes(reason)) return json({ error: M.bad }, 400, H);
  const old = q.plan, di = parseInt(q.day) - 1, idx = parseInt(q.idx);
  if (!old || !Array.isArray(old.days) || old.days.length > 7 || JSON.stringify(old).length > 400000) return json({ error: M.bad }, 400, H);
  const d = old.days[di];
  if (!d || !Array.isArray(d.stops) || !d.stops.length || d.stops.length > 20 || !(idx >= 0 && (idx < d.stops.length || (reason === "add" && idx === d.stops.length)))) return json({ error: M.bad }, 400, H);
  const needAI = reason === "closed" || reason === "weather";
  const token = bearer(req);
  const uid = token ? await sbUser(env, token) : null;
  if (needAI && !uid) return json({ error: M.rp_login, code: "auth" }, 401, H);
  if (needAI && !env.ANTHROPIC_API_KEY) return json({ error: M.nokey }, 500, H);

  // Kufijtë ditorë: të gjitha riplanifikimet + ato me AI veçmas
  const cache = caches.default, today = new Date().toISOString().slice(0, 10);
  const who = uid ? "u" + (await sha(uid)).slice(0, 24) : "ip" + (await sha("viaro|" + (req.headers.get("CF-Connecting-IP") || "anon") + "|" + today)).slice(0, 24);
  const rKey = `rp/${today}/${who}`, aKey = `rpa/${today}/${who}`;
  const used = (await limitGet(env, cache, rKey)) || 0, usedAI = needAI ? (await limitGet(env, cache, aKey)) || 0 : 0;
  const maxR = uid ? RP_LIMIT.user : RP_LIMIT.guest;
  if (used >= maxR) return json({ error: M.rp_limit(maxR), code: "rp_day" }, 429, H);
  if (needAI && usedAI >= RP_LIMIT.ai) return json({ error: M.rp_limit(RP_LIMIT.ai), code: "rp_ai_day" }, 429, H);
  if (needAI) {
    const stat = (await limitGet(env, cache, `d/${today}`)) || { n: 0 };
    if ((stat.n || 0) + (stat.calls || 0) >= GLOBAL_DAILY_LIMIT * 2) return json({ error: M.busy }, 429, H);
  }

  try {
    const rq = old.request || {};
    const p = sanitize({ ...rq, city: old.city?.name || rq.city || "city", days: old.days.length });
    if (p.error) return json({ error: M.bad }, 400, H);
    const lang = LANG[q.lang] ? q.lang : p.lang;
    const dt = /^\d{4}-\d{2}-\d{2}$/.test(d.date || "") ? new Date(d.date + "T00:00:00Z") : null;
    const nowMin = /^\d{2}:\d{2}$/.test(q.now || "") ? toMin(q.now) : null;
    const stops = d.stops.map(s => { const c = { ...s }; delete c._marker; return c; });
    const locked = stops.slice(0, idx);
    let rest = stops.slice(idx);
    const anchor = [...locked].reverse().find(s => s.lat != null) || null;
    const last = locked[locked.length - 1];
    let T = last?.start ? toMin(last.start) + (parseInt(last.duration_min) || 60) : toMin(rest[0]?.start || p.start);
    const lateMin = reason === "late" ? Math.max(5, Math.min(240, parseInt(q.minutes) || 30)) : 0;
    T += lateMin;
    if (nowMin != null) T = Math.max(T, nowMin);
    const changed = [], dropped = [];
    let reply = "", ai = null;
    const usedNames = new Set(old.days.flatMap(x => (x.stops || []).map(s => String(s.name || "").toLowerCase())));

    if (reason === "remove") { changed.push(rest[0].name); rest = rest.slice(1); }
    else if (reason === "add") {
      // Vendi vjen nga lista /near ose nga asistenti (të dyja të verifikuara). Pastrohet dhe kontrollohet afërsia me ditën.
      const x = q.place || {}, la = parseFloat(x.lat), lo = parseFloat(x.lon), nm = String(x.name || "").trim().slice(0, 120);
      const geo = stops.filter(s => s.lat != null);
      const near = geo.length ? Math.min(...geo.map(s => hav(la, lo, s.lat, s.lon))) : (old.city?.lat != null ? hav(la, lo, old.city.lat, old.city.lon) : 0);
      if (!nm || isNaN(la) || isNaN(lo) || near > 15000 || !(x.wd || x.osm || x.wiki)) return json({ error: M.add_bad }, 400, H);
      const kind = String(x.kind || "");
      const s = { poi: null, name: nm, type: kind === "restaurant" ? "meal" : "visit", duration_min: Math.max(15, Math.min(240, parseInt(x.duration_min) || (kind === "restaurant" ? 60 : kind === "cafe" ? 30 : 45))),
        lat: +la.toFixed(5), lon: +lo.toFixed(5), verified: true, added: true };
      for (const k of ["wiki", "wd", "osm", "cuisine"]) if (x[k]) s[k] = String(x[k]).slice(0, 200);
      if (x.addr) s.address = String(x.addr).slice(0, 200);
      if (x.hours_raw) s.hours_raw = String(x.hours_raw).slice(0, 200);
      if (x.fee === "yes" || x.fee === "no") s.fee = x.fee; if (x.price) s.price = String(x.price).slice(0, 80);
      if (s.hours_raw && dt) { const r = ohParse(s.hours_raw); if (r) { const o = ohOn(r, dt); s.hours = o.st === "unknown" ? null : (o.st === "open" ? spansText(o.spans) : "closed"); s.hours_ok = true; } }
      // Vendi më i mirë: aty ku shton më pak rrugë (pas idx)
      const pts = [anchor, ...rest].map(v => v && v.lat != null ? v : null);
      let best = rest.length, bestCost = Infinity;
      for (let k = 0; k <= rest.length; k++) {
        const prev = [anchor, ...rest.slice(0, k)].reverse().find(v => v && v.lat != null), next = rest.slice(k).find(v => v.lat != null);
        const c = (prev ? hav(prev.lat, prev.lon, la, lo) : 0) + (next ? hav(la, lo, next.lat, next.lon) : 0) - (prev && next ? hav(prev.lat, prev.lon, next.lat, next.lon) : 0);
        if (c < bestCost - 1) { bestCost = c; best = k; }
      }
      if (q.asap) best = 0;
      rest.splice(best, 0, s); changed.push(nm);
    }
    else if (needAI) {
      const geo = rest.filter(s => s.lat != null);
      const center = reason === "closed" ? (rest[0].lat != null ? rest[0] : anchor || old.city) : geo.length ? { lat: geo.reduce((a, s) => a + s.lat, 0) / geo.length, lon: geo.reduce((a, s) => a + s.lon, 0) / geo.length } : anchor || old.city;
      if (!center || center.lat == null) return json({ error: M.rp_none }, 404, H);
      const cands = await replanCands(center, usedNames, p, dt, T, reason === "weather" ? x => INDOOR_RE.test(x.kind || "") || INDOOR_RE.test(x.name || "") : null);
      if (!cands.length) return json({ error: M.rp_none }, 404, H);
      cands.forEach((x, i) => { x.id = "C" + (i + 1); });
      const byId = Object.fromEntries(cands.map(x => [x.id, x]));
      const candTxt = cands.map(x => `${x.id}|${x.name}|${x.kind}|${Math.round(x.dist)} m|pop ${Math.round(x.pop || 0)}|${x.now}${x.fee ? "|fee " + x.fee : ""}`).join("\n");
      const restTxt = rest.map((s, k) => `[${idx + k}] ${s.start || "?"} ${s.name} (${s.type || "visit"}, ${s.duration_min || 60} min)`).join("\n");
      const who2 = `${p.adults} adult(s)${p.kids ? ` + ${p.kids} child(ren)` : ""}; interests: ${p.interests.join(", ") || "general"}; budget: ${{ ulet: "low", mesem: "medium", larte: "high" }[p.budget]}; getting around: ${TR_EN[p.transport] || "on foot"}`;
      let system, user;
      if (reason === "closed") {
        system = `A place in a traveller's day plan turned out to be closed. Pick ONE replacement ONLY from the candidate list (by id). Prefer something similar in spirit, close by and popular. Never invent places. Write "note" (1 sentence, why this one), "tip" (optional) and "reply" (1 sentence saying what changed) in ${LANG[lang]}. Reply JSON only: {"id":"C1","duration_min":60,"note":"...","tip":"...","reply":"..."}`;
        user = `Closed: ${rest[0].name}. Arrival around ${fmtMin(T)}. Travellers: ${who2}.\nRest of the day:\n${restTxt}\n\nCandidates (id|name|type|distance|popularity|hours):\n${candTxt}`;
      } else {
        const wk = ["rain", "hot", "cold"].includes(q.weather) ? q.weather : "rain";
        const fc = dt ? await dayForecast(center.lat, center.lon, d.date) : null;
        system = `The weather changed during a traveller's day (${wk}). Adapt ONLY the remaining stops listed. Replace outdoor stops that suffer in this weather (parks, gardens, viewpoints, walks, squares, bridges, open-air sites) with indoor places ONLY from the candidate list (by id). Keep indoor stops, meals and anything still fine exactly as they are. Never invent places. Change as little as possible. Write "note" and "reply" (1–2 sentences saying what changed) in ${LANG[lang]}. Reply JSON only: {"ops":[{"op":"replace","idx":3,"id":"C1","duration_min":60,"note":"..."},{"op":"duration","idx":4,"minutes":30}],"reply":"..."}`;
        user = `Weather: ${wk}${fc ? " (forecast: " + fc + ")" : ""}. Travellers: ${who2}.\nRemaining stops (only these may change):\n${restTxt}\n\nIndoor candidates (id|name|type|distance|popularity|hours):\n${candTxt}`;
      }
      await limitPut(env, cache, aKey, usedAI + 1);
      const r = await callClaude(env.ANTHROPIC_API_KEY, system, user, 1200);
      ai = aiCost(MODEL, r.usage); ctx.waitUntil(addDayStat(env, ai));
      const out = r.out;
      if (!out) throw new Error(M.badplan);
      reply = String(out.reply || "").slice(0, 400);
      if (reason === "closed") {
        const x = byId[out.id];
        if (!x) { await limitPut(env, cache, aKey, usedAI); return json({ error: M.rp_none }, 404, H); }
        changed.push(rest[0].name); rest[0] = candStop(x, out, dt);
      } else {
        const ops = (Array.isArray(out.ops) ? out.ops : []).slice(0, rest.length * 2);
        const tgt = ops.map(o => ({ ...o, _s: rest[parseInt(o.idx) - idx] }));
        const usedC = new Set();
        for (const o of tgt) {
          if (!o._s) continue; // jashtë pjesës së lejuar: injorohet
          const k = rest.indexOf(o._s); if (k < 0) continue;
          if (o.op === "replace" && byId[o.id] && !usedC.has(o.id)) { usedC.add(o.id); changed.push(rest[k].name); rest[k] = candStop(byId[o.id], o, dt); }
          else if (o.op === "duration") { rest[k].duration_min = Math.max(10, Math.min(300, parseInt(o.minutes) || rest[k].duration_min)); }
          else if (o.op === "remove" && rest[k].type !== "meal") { changed.push(rest[k].name); rest[k]._del = true; }
        }
        rest = rest.filter(s => !s._del);
        if (!changed.length && !ops.length) return json({ day: null, reply: reply || M.rp_nochange, changed, dropped }, 200, H);
      }
    }

    // Orari i ri, me oraret e hapjes të rilidhura
    rest = rest.map(s => { const c = { ...s }; if (c.type === "meal" && /^\d{2}:\d{2}$/.test(c.start || "")) c._earliest = toMin(c.start); delete c.start; delete c.hours_warn; delete c.travel_min; delete c.travel_m; delete c.travel_mode; delete c.travel_est;
      if (c.hours_raw) { const r = ohParse(c.hours_raw); if (r) c._oh = r; } return c; });
    let sch = await scheduleRest(env, anchor, rest, T, p, dt, false);
    // Kur dita nuk mjafton: hiqen vizitat e fundit (jo vaktet), maksimumi 4
    for (let g = 0; reason === "late" && sch.over > 30 && g < 4; g++) {
      let k = -1;
      for (let j = rest.length - 1; j >= 0; j--) if (rest[j].type !== "meal" && rest[j].type !== "break" && sch.stops[j]?.hours_warn) { k = j; break; }
      if (k < 0) for (let j = rest.length - 1; j >= 0; j--) if (rest[j].type !== "meal" && rest[j].type !== "break") { k = j; break; }
      if (k < 0 || rest.length <= 1) break;
      dropped.push(rest[k].name); rest.splice(k, 1);
      sch = await scheduleRest(env, anchor, rest, T, p, dt, false);
    }
    if (env.ORS_KEY && rest.some(s => s.lat != null)) sch = await scheduleRest(env, anchor, rest, T, p, dt, true);

    const day = { ...d, stops: [...locked, ...sch.stops] };
    delete day.overtime_min;
    if (sch.over) day.overtime_min = sch.over;
    day.route = [...(Array.isArray(d.route) ? d.route.filter(r => r.to < idx) : []), ...sch.lines.map(l => ({ to: idx + l.k, line: l.line }))];
    day.routed = !!day.route.length;
    day.replans = (d.replans || 0) + 1;
    await limitPut(env, cache, rKey, used + 1);
    return json({ day, di, reply, changed, dropped, late: lateMin, start: fmtMin(T), ai, left: { all: maxR - used - 1, ai: needAI ? RP_LIMIT.ai - usedAI - 1 : undefined } }, 200, H);
  } catch (e) {
    if (needAI) await limitPut(env, cache, aKey, usedAI);
    return json({ error: M.fail + (e.message || e) }, 502, H);
  }
}
Object.assign(MSG.sq, { rp_login: "Hyr në llogari që AI të gjejë alternativa.", rp_limit: n => `Sot e ke arritur kufirin prej ${n} ndryshimesh. Provo nesër.`, rp_none: "Nuk gjeta alternativë të verifikuar afër. Provo ta heqësh ndalesën.", rp_nochange: "Plani i mbetur i përshtatet këtij moti; nuk ndryshova asgjë." });
Object.assign(MSG.en, { rp_login: "Log in so AI can find alternatives.", rp_limit: n => `You've reached today's limit of ${n} changes. Try again tomorrow.`, rp_none: "I couldn't find a verified alternative nearby. Try removing the stop.", rp_nochange: "The rest of your plan already suits this weather; nothing changed." });
Object.assign(MSG.de, { rp_login: "Melde dich an, damit die KI Alternativen findet.", rp_limit: n => `Du hast heute das Limit von ${n} Änderungen erreicht. Versuch es morgen wieder.`, rp_none: "Keine geprüfte Alternative in der Nähe gefunden. Entferne den Stopp stattdessen.", rp_nochange: "Der Rest deines Plans passt schon zu diesem Wetter; nichts geändert." });

// ================== FAZA 8: Live Travel Assistant ==================
// Bisedë me kontekstin e planit. AI përdor VETËM vendet e planit dhe listat e verifikuara që i jepen.
const CHAT_LIMIT = 20;
const CHAT_FOOD_RE = /(^|[\s,.!?])(ha|hamë|hash|ngrënë|pi|pije|kafe|kafene|pizza|byrek|snack|coffee|drink|bar|essen|trinken|kaffee|imbiss)([\s,.!?]|$)/i;
const NEAR_RE = /afër|aty pran|rreth|këtu|tani|now|near|nearby|around|here|close|jetzt|nähe|hier|in der nähe|umgebung|bëj|do now|was tun|vizitoj|visit|besuch/i;
async function handleChat(q, req, env, ctx, H, M) {
  const token = bearer(req);
  const uid = token ? await sbUser(env, token) : null;
  if (!uid) return json({ error: M.chat_login, code: "auth" }, 401, H);
  if (!env.ANTHROPIC_API_KEY) return json({ error: M.nokey }, 500, H);
  const old = q.plan, msg = String(q.message || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!msg || !old || !Array.isArray(old.days) || !old.days.length || old.days.length > 7 || JSON.stringify(old).length > 400000) return json({ error: M.bad }, 400, H);
  const cache = caches.default, today = new Date().toISOString().slice(0, 10);
  const who = "u" + (await sha(uid)).slice(0, 24), key = `ch/${today}/${who}`;
  const used = (await limitGet(env, cache, key)) || 0;
  if (used >= CHAT_LIMIT) return json({ error: M.chat_limit(CHAT_LIMIT), code: "chat_day" }, 429, H);
  const stat = (await limitGet(env, cache, `d/${today}`)) || { n: 0 };
  if ((stat.n || 0) + (stat.calls || 0) >= GLOBAL_DAILY_LIMIT * 2) return json({ error: M.busy }, 429, H);
  await limitPut(env, cache, key, used + 1);
  try {
    const rq = old.request || {};
    const p = sanitize({ ...rq, city: old.city?.name || rq.city || "city", days: old.days.length });
    const lang = LANG[q.lang] ? q.lang : p.lang;
    const di = Math.max(0, Math.min(old.days.length - 1, parseInt(q.day) || 0));
    const d = old.days[di];
    const now = /^\d{2}:\d{2}$/.test(q.now || "") ? q.now : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : today;
    const isToday = d.date === date;
    let lat = parseFloat(q.lat), lon = parseFloat(q.lon);
    const hasGeo = Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !isNaN(lat) && !isNaN(lon);
    // Pika e referencës: vendndodhja, përndryshe ndalesa e radhës sot, përndryshe qendra e qytetit
    const stops = (d.stops || []).slice(0, 20);
    const nowM = now ? toMin(now) : null;
    let nextIdx = isToday && nowM != null ? stops.findIndex(s => s.start && toMin(s.start) + (parseInt(s.duration_min) || 0) > nowM) : -1;
    const ref = hasGeo ? { lat, lon } : (nextIdx >= 0 && stops[nextIdx].lat != null ? stops[nextIdx] : stops.find(s => s.lat != null) || old.city);
    if (!ref || ref.lat == null) throw new Error(M.bad);
    const rlat = +(+ref.lat).toFixed(3), rlon = +(+ref.lon).toFixed(3);

    const wantFood = FOOD_RE.test(msg) || CHAT_FOOD_RE.test(msg), wantNear = hasGeo || NEAR_RE.test(msg);
    const used2 = new Set(old.days.flatMap(x => (x.stops || []).map(s => String(s.name || "").toLowerCase())));
    const dt = new Date(date + "T00:00:00Z");
    const [wx, food, sights] = await Promise.all([
      isToday ? weatherNow(rlat, rlon) : null,
      wantFood ? nearbyFood(rlat, rlon).catch(() => []) : [],
      wantNear ? fetchPois(rlat, rlon, 2500).catch(() => []) : [],
    ]);
    const list = [];
    const add = (x, kind, i) => {
      const dist = hav(rlat, rlon, x.lat, x.lon); if (dist > 2500) return;
      let open = "hours unknown";
      const r = ohParse(x.oh); if (r) { const o = ohOn(r, dt); open = o.st === "closed" ? "closed today" : o.st === "open" ? spansText(o.spans) : open; }
      if (open === "closed today") return;
      list.push({ id: kind + (i + 1), name: x.name, kind: kind === "R" ? "restaurant" : (x.kind || kind), cuisine: x.cuisine, lat: x.lat, lon: x.lon, addr: x.addr, wiki: x.wiki, wd: x.wd, osm: x.osm, hours_raw: x.oh, open, dist: Math.round(dist), walk: Math.max(1, Math.round(dist * 1.3 / 75)), pop: x.pop || 0 });
    };
    food.slice(0, 12).forEach((x, i) => add(x, "R", i));
    sights.filter(x => !used2.has(String(x.name).toLowerCase())).map(x => ({ ...x, _d: hav(rlat, rlon, x.lat, x.lon) }))
      .sort((a, b) => (b.pop || 0) / (1 + b._d / 600) - (a.pop || 0) / (1 + a._d / 600)).slice(0, 10).forEach((x, i) => add(x, "C", i));
    const byId = Object.fromEntries(list.map(x => [x.id, x]));

    const dayTxt = stops.map((s, k) => `[${k}] ${s.start || "?"} ${s.name} (${s.type || "visit"}, ${s.duration_min || 60} min${s.address ? ", " + s.address : ""}${s.hours ? ", hours " + s.hours : ""}${s.price ? ", price " + s.price : ""}${s.hours_warn ? ", WARNING " + s.hours_warn : ""})`).join("\n");
    const others = old.days.map((x, k) => k === di ? null : `Day ${k + 1}${x.date ? " " + x.date : ""}: ` + (x.stops || []).filter(s => s.type !== "meal").map(s => s.name).join(", ")).filter(Boolean).join("\n");
    const listTxt = list.map(x => `${x.id}|${x.name}|${x.kind}${x.cuisine ? " " + x.cuisine : ""}|${x.dist} m (~${x.walk} min walk)|${x.open}`).join("\n");
    const hist = (Array.isArray(q.history) ? q.history : []).slice(-6).map(h => `${h.role === "ai" ? "Assistant" : "Traveller"}: ${String(h.text || "").slice(0, 300)}`).join("\n");
    const budget = old.budget ? `Planned budget (EUR, group): ${old.budget.days.map(b => BUD_KEYS.reduce((a, k) => a + (b[k] || 0), 0)).join(" / ")} per day${old.budget.my ? `; own limit ${old.budget.my}` : ""}` : "";

    const system = `You are Viaro, a friendly travel assistant helping a traveller DURING their trip in ${old.city?.name || p.city}. Be short, concrete and practical: 1–4 sentences, no lists longer than 3 items.
Hard rules:
- Recommend places ONLY from the traveller's plan or the verified list (ids R1.. = restaurants, C1.. = sights). Never invent places, addresses, opening hours or prices. If a price or time is not given, don't guess; say it is not known.
- Mention a listed place by name and put its id in "places" (max 3). Distances/walk times are given; use them.
- If the traveller wants to change today's plan (late, a place closed, bad weather, skip a stop), do NOT change it yourself: propose an "action" of type "replan" and say that they can confirm it.
- For "how do I get to X" questions about a stop in the plan, use action "directions" with that stop index.
- If the traveller asks about something you cannot know (live transport, tickets availability), say so briefly and suggest what to check.
- Reply in ${LANG[lang]}. JSON only: {"reply":"...","places":["R1"],"action":null}
Actions: {"type":"replan","reason":"late|closed|weather|remove","idx":2,"minutes":30,"weather":"rain|hot|cold"} or {"type":"directions","idx":3}`;
    const user = `${isToday ? `Today is ${date} (${WD[dt.getUTCDay()]}), local time ${now || "unknown"}. The traveller is on day ${di + 1} of the plan.` : `Today is ${date}. The traveller is looking at day ${di + 1}${d.date ? " (" + d.date + ")" : ""}, which is not today.`}
${hasGeo ? "The traveller shared their current location; distances below are from there." : `Distances below are from ${nextIdx >= 0 ? "the next stop (" + stops[nextIdx].name + ")" : "the day's first stop or city centre"}.`}
${wx ? `Weather now: ${wx.temp}°C${wx.rain ? ", raining" : ""}${wx.snow ? ", snow" : ""}.` : ""}
Travellers: ${p.adults} adult(s)${p.kids ? ` + ${p.kids} child(ren)` : ""}; budget level ${{ ulet: "low", mesem: "medium", larte: "high" }[p.budget]}; getting around ${TR_EN[p.transport] || "on foot"}; interests ${p.interests.join(", ") || "general"}.
${budget}
Day ${di + 1} plan${nextIdx >= 0 ? ` (next/current stop is [${nextIdx}])` : ""}:
${dayTxt}
${others ? "Other days:\n" + others : ""}
${list.length ? "Verified places nearby (id|name|type|distance|hours today):\n" + listTxt : "No nearby place list was loaded for this question."}
${hist ? "\nConversation so far:\n" + hist : ""}

Traveller: ${msg}`;
    const { out, usage } = await callClaude(env.ANTHROPIC_API_KEY, system, user, 700);
    const ai = aiCost(MODEL, usage); ctx.waitUntil(addDayStat(env, ai));
    if (!out || typeof out.reply !== "string") throw new Error(M.badplan);
    const places = (Array.isArray(out.places) ? out.places : []).map(id => byId[id]).filter(Boolean).slice(0, 3)
      .map(({ id, pop, ...x }) => x);
    let action = null; const a = out.action;
    if (a && a.type === "replan" && ["late", "closed", "weather", "remove"].includes(a.reason) && parseInt(a.idx) >= 0 && parseInt(a.idx) < stops.length)
      action = { type: "replan", reason: a.reason, idx: parseInt(a.idx), minutes: Math.max(5, Math.min(240, parseInt(a.minutes) || 30)), weather: ["rain", "hot", "cold"].includes(a.weather) ? a.weather : "rain" };
    else if (a && a.type === "directions" && parseInt(a.idx) >= 0 && parseInt(a.idx) < stops.length && stops[parseInt(a.idx)].lat != null)
      action = { type: "directions", idx: parseInt(a.idx) };
    return json({ reply: out.reply.slice(0, 700), places, action, day: di, left: CHAT_LIMIT - used - 1 }, 200, H);
  } catch (e) {
    await limitPut(env, cache, key, used);
    return json({ error: M.fail + (e.message || e) }, 502, H);
  }
}
Object.assign(MSG.sq, { chat_login: "Hyr në llogari për të biseduar me asistentin.", chat_limit: n => `Sot i ke përdorur të ${n} mesazhet me asistentin. Provo nesër.` });
Object.assign(MSG.en, { chat_login: "Log in to chat with the assistant.", chat_limit: n => `You've used all ${n} assistant messages today. Try again tomorrow.` });
Object.assign(MSG.de, { chat_login: "Melde dich an, um mit dem Assistenten zu chatten.", chat_limit: n => `Du hast heute alle ${n} Nachrichten an den Assistenten genutzt. Versuch es morgen wieder.` });

// ================== FAZA 9: Explore Around Me ==================
// Lista e vendeve të verifikuara afër (pa AI, pa kosto Claude). Kategoritë: see | food | cafe
const NEAR_LIMIT = { user: 40, guest: 15 };
const INT_RE = { histori: /histor|castle|fort|ruin|monument|memorial|archaeolog|palace|old town|medieval|roman|ancient/i, muze: /museum/i, art: /art|gallery|sculpture|fresco/i,
  arkitekture: /architect|building|tower|bridge|cathedral|palace|basilica/i, natyre: /park|garden|lake|river|beach|forest|nature|hill|mount/i, pamje: /viewpoint|view|tower|hill|panoram|terrace/i,
  blerje: /market|shopping|bazaar|mall|street/i, nate: /theatre|theater|opera|concert|club|bar/i, femije: /zoo|aquarium|park|playground|children|science/i, fe: /church|cathedral|basilica|mosque|synagogue|temple|monastery|abbey|chapel/i, fotografi: /viewpoint|square|bridge|fountain|tower/i };
async function nearbyKind(lat, lon, kind) {
  if (kind === "restaurant") return nearbyFood(lat, lon);
  const key = new Request(`https://cache.udhetimi/${kind}1/${lat.toFixed(3)},${lon.toFixed(3)}`);
  const hit = await caches.default.match(key); if (hit) return hit.json();
  const d = 0.007, out = [];
  try {
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&addressdetails=1&limit=12&bounded=1&accept-language=en&viewbox=${lon - d},${lat + d},${lon + d},${lat - d}&q=${kind}`;
    const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
    if (r.ok) for (const x of await r.json()) {
      if (!x.name || x.type !== kind) continue;
      const e = x.extratags || {}, a = x.address || {};
      out.push({ name: x.name, lat: +(+x.lat).toFixed(5), lon: +(+x.lon).toFixed(5), kind, cuisine: e.cuisine, oh: e.opening_hours, wd: e.wikidata,
        addr: [[a.road || a.pedestrian || a.square, a.house_number].filter(Boolean).join(" "), [a.postcode, a.city || a.town || a.village].filter(Boolean).join(" ")].filter(Boolean).join(", ") || undefined,
        osm: x.osm_type?.[0] + x.osm_id });
    }
  } catch {}
  await caches.default.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=" + 86400 * 7 } }));
  return out;
}
async function handleNear(q, req, env, ctx, H, M) {
  const cat = ["see", "food", "cafe"].includes(q.cat) ? q.cat : "see";
  let lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || isNaN(lat) || isNaN(lon)) return json({ error: M.now_where }, 400, H);
  const token = bearer(req), uid = token ? await sbUser(env, token) : null;
  const cache = caches.default, today = new Date().toISOString().slice(0, 10);
  const who = uid ? "u" + (await sha(uid)).slice(0, 24) : "ip" + (await sha("viaro|" + (req.headers.get("CF-Connecting-IP") || "anon") + "|" + today)).slice(0, 24);
  const key = `nr/${today}/${who}`, used = (await limitGet(env, cache, key)) || 0, max = uid ? NEAR_LIMIT.user : NEAR_LIMIT.guest;
  if (used >= max) return json({ error: M.near_limit(max), code: "near_day" }, 429, H);
  await limitPut(env, cache, key, used + 1);
  const minutes = Math.max(30, Math.min(480, parseInt(q.minutes) || 120));
  const transport = ["kembe", "publik", "vetura"].includes(q.transport) ? q.transport : "kembe";
  const interests = (Array.isArray(q.interests) ? q.interests : []).filter(i => INTERESTS.includes(i)).slice(0, 8);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : today;
  const now = /^\d{2}:\d{2}$/.test(q.time || "") ? toMin(q.time) : null;
  const dt = new Date(date + "T00:00:00Z");
  // Distanca maksimale: rreth 1/4 e kohës së lirë për të shkuar (pjesa tjetër për vizitën dhe kthimin)
  const maxDist = Math.min({ kembe: 2500, publik: 5000, vetura: 9000 }[transport], Math.max(600, { kembe: 75, publik: 250, vetura: 500 }[transport] * minutes / 4));
  const rl = +lat.toFixed(3), ro = +lon.toFixed(3);
  try {
    let raw = cat === "see" ? await fetchPois(rl, ro, Math.min(5000, Math.max(1500, maxDist))) : await nearbyKind(rl, ro, cat === "food" ? "restaurant" : "cafe");
    let list = raw.map(x => ({ ...x, dist: Math.round(hav(lat, lon, x.lat, x.lon)) })).filter(x => x.dist <= maxDist);
    if (cat === "see") {
      const boost = x => interests.some(i => INT_RE[i]?.test(`${x.kind} ${x.name}`)) ? 2 : 1;
      list.sort((a, b) => (b.pop || 0) * boost(b) / (1 + b.dist / 500) - (a.pop || 0) * boost(a) / (1 + a.dist / 500));
      list = list.slice(0, 14);
      await enrichPois(list.slice(0, 8), 5);
    } else list.sort((a, b) => a.dist - b.dist);
    const out = [];
    for (const x of list) {
      let open = null, status = "unknown";
      const r = ohParse(x.oh);
      if (r) {
        const o = ohOn(r, dt);
        if (o.st === "closed") { status = "closed"; }
        else if (o.st === "open") {
          open = spansText(o.spans);
          if (now != null) { const sp = o.spans.find(([a, b]) => now < b - 20); status = !sp ? "closed" : sp[0] > now ? "opens" : "open"; if (sp && sp[0] > now) open = `${fmtMin(sp[0])}–${fmtMin(sp[1])}`; }
          else status = "open";
        }
      }
      if (status === "closed") continue;
      const leg = estimateLeg(x.dist, transport);
      out.push({ name: x.name, kind: cat === "see" ? x.kind : cat === "food" ? "restaurant" : "cafe", cuisine: x.cuisine, lat: x.lat, lon: x.lon, addr: x.addr, wiki: x.wiki, wd: x.wd, osm: x.osm,
        hours_raw: x.oh, open, status, fee: x.fee, price: x.charge, dist: x.dist, min: leg.min, mode: leg.mode });
      if (out.length >= 12) break;
    }
    if (!out.length) await limitPut(env, cache, key, used);
    return json({ cat, places: out, maxDist: Math.round(maxDist), left: max - used - 1 }, 200, H);
  } catch (e) {
    await limitPut(env, cache, key, used);
    return json({ error: M.fail + (e.message || e) }, 502, H);
  }
}
Object.assign(MSG.sq, { near_limit: n => `Sot e ke kërkuar ${n} herë vende afër. Provo nesër.`, add_bad: "Ky vend nuk mund të shtohet." });
Object.assign(MSG.en, { near_limit: n => `You've searched nearby places ${n} times today. Try again tomorrow.`, add_bad: "This place can't be added." });
Object.assign(MSG.de, { near_limit: n => `Du hast heute ${n}-mal nach Orten in der Nähe gesucht. Versuch es morgen wieder.`, add_bad: "Dieser Ort kann nicht hinzugefügt werden." });
