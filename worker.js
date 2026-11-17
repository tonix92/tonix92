const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, OPTIONS"};
const LIVE=/^\/v2\/(point\/-?[\d.]+\/-?[\d.]+\/\d+|callsign\/\w+|hex\/\w+)$/, INFO=/^\/v0\/(callsign|aircraft)\/\w+$/;
async function get(url){return fetch(url,{headers:{"User-Agent":"radar-fluturimesh"}});}
export default{async fetch(req,env,ctx){
if(req.method==="OPTIONS")return new Response(null,{headers:CORS});
const u=new URL(req.url),p=u.pathname,cache=caches.default,key=new Request(u.origin+p);
let hit=await cache.match(key);if(hit)return hit;
let r;
if(LIVE.test(p)){r=await get("https://api.adsb.lol"+p);if(r.status===429||r.status>=500)r=await get("https://api.airplanes.live"+p);}
else if(INFO.test(p)){r=await get("https://api.adsbdb.com"+p);}
else return new Response("Radar proxy OK v3",{headers:CORS});
const res=new Response(await r.arrayBuffer(),{status:r.status,headers:{...CORS,"Content-Type":"application/json","Cache-Control":"public, max-age="+(p.startsWith("/v0")?3600:8)}});
if(r.ok)ctx.waitUntil(cache.put(key,res.clone()));
return res;}};
