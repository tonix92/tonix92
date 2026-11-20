// Vianto — Cloudflare Worker
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
      return new Response("Vianto API OK", { headers: H });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: H });
    let q;
    try { q = await req.json(); } catch { return json({ error: MSG.sq.bad }, 400, H); }
    const M = MSG[q?.ui] || MSG[q?.lang] || MSG.sq;
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
    sq: { t: (d, c) => `${d} ditë në ${c}`, def: "Plan udhëtimi", desc: "Shiko këtë plan udhëtimi ditë për ditë, krijuar me Vianto.", by: a => ` — nga ${a}`, open: "Po hapet plani…", click: "Kliko këtu nëse nuk hapet" },
    en: { t: (d, c) => `${d} days in ${c}`, def: "Travel plan", desc: "See this day-by-day travel plan, made with Vianto.", by: a => ` — by ${a}`, open: "Opening the plan…", click: "Click here if it doesn't open" },
    de: { t: (d, c) => `${d} Tage in ${c}`, def: "Reiseplan", desc: "Sieh dir diesen Tag-für-Tag-Reiseplan an, erstellt mit Vianto.", by: a => ` — von ${a}`, open: "Plan wird geöffnet…", click: "Hier klicken, falls er sich nicht öffnet" },
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
<meta property="og:site_name" content="Vianto">
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
  const key = new Request(`https://cache.udhetimi/pois3/${lat.toFixed(3)},${lon.toFixed(3)},${R}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  let out = [];
  let osmOk = true;
  try { out = await fetchPoisLive(lat, lon, R); } catch (e) { out = []; osmOk = false; }
  if (out.length < 15) {
    if (out.length < 5) osmOk = false;
    const wiki = await fetchWikiPois(lat, lon, R).catch(() => []);
    const seen = new Set(out.map(x => x.wd));
    out = out.concat(wiki.filter(x => !seen.has(x.wd)));
  }
  // Nga OSM ruhet 30 ditë; kur u përdor vetëm Wikipedia (OSM ra), vetëm 1 ditë
  if (out.length >= 5) await caches.default.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=" + 86400 * (osmOk ? 30 : 1) } }));
  return out;
}

async function fetchPoisLive(lat, lon, R) {
  const a = `(around:${R},${lat},${lon})`;
  const query = `[out:json][timeout:25];
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
  let data; const timer = setTimeout(() => ctrl.abort(), 20000);
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

async function addPopularity(pois) {
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
{"title": "...", "summary": "2 sentences", "days": [{"day": 1, "theme": "short title", "area": "neighbourhood name", "stops": [{"poi": "P1", "name": "display name", "type": "visit|meal|break|walk", "start": "09:00", "duration_min": 90, "travel_min": 10, "note": "...", "tip": "..."}]}], "tips": ["3-5 general tips: transport ticket, city card, safety, etc."], "cost_estimate": "rough daily cost in EUR excluding hotel${p.adults + p.kids > 1 ? ", for the whole group (say so)" : " per person"}"}`;

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
  let s = String(oh).replace(/"[^"]*"/g, "").replace(/\|\|/g, ";").trim();
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

// ---- Zbatimi mbi planin: verifikimi, renditja, rrugët dhe oraret ----
async function finishPlan(env, plan, p, byId) {
  const dates = tripDates(p.date, p.days);
  for (const [i, d] of (plan.days || []).entries()) {
    const dt = dates[i] || null;
    if (dt) { d.date = isoDay(dt); }
    // Lidh vendet me të dhënat e verifikuara nga OSM/Wikidata
    let stops = (d.stops || []).map(s => {
      const poi = s.poi && byId[s.poi];
      if (!poi) return { ...s, poi: null, lat: undefined, lon: undefined, verified: s.type === "meal" ? undefined : false };
      const c = { ...s, lat: poi.lat, lon: poi.lon, wiki: poi.wiki, osm: poi.osm, name: s.name || poi.name, verified: true };
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
    const tryOrder = async order => {
      const geoIdx = order.map((s, k) => s.lat != null ? k : -1).filter(k => k >= 0);
      const pts = geoIdx.map(k => order[k]);
      const legs = await orsRoute(env, pts, p.transport);
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
    const a = await tryOrder(stops);
    const alt = reorderDay(stops);
    const changed = alt.some((s, k) => s !== stops[k]);
    const b = changed ? await tryOrder(alt) : null;
    const best = b && b.score + 5 < a.score ? b : a;
    d.stops = best.stops.map(({ _oh, ...s }) => s);
    d.route = [...best.legsByIdx.entries()].filter(([, l]) => l.line).map(([k, l]) => ({ to: k, line: thin(l.line) }));
    d.routed = !!d.route.length;
    if (best.over) d.overtime_min = best.over;
    d.optimized = best === b;
  }
}
