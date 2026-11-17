const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, OPTIONS"};
const ROUTES=[[/^\/v2\/(point\/-?[\d.]+\/-?[\d.]+\/\d+|callsign\/\w+|hex\/\w+)$/,"https://api.adsb.lol"],[/^\/v0\/(callsign|aircraft)\/\w+$/,"https://api.adsbdb.com"]];
export default{async fetch(req){
if(req.method==="OPTIONS")return new Response(null,{headers:CORS});
const u=new URL(req.url);const m=ROUTES.find(([re])=>re.test(u.pathname));
if(!m)return new Response("Radar proxy OK v2",{headers:CORS});
const r=await fetch(m[1]+u.pathname,{headers:{"User-Agent":"radar-fluturimesh"}});
return new Response(r.body,{status:r.status,headers:{...CORS,"Content-Type":"application/json","Cache-Control":u.pathname.startsWith("/v0")?"max-age=3600":"max-age=5"}});}};
