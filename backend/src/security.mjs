// Atomic counters shared by all Worker instances. Only trusted Cloudflare IPs are used.
export async function consumeLimit(env,key,limit,period,fail,now=Date.now()){
 const window=Math.floor(now/period),expires=now+period*2;
 const result=await env.DB.prepare(`INSERT INTO request_limits(key,window,hits,expires_at) VALUES(?,?,1,?)
 ON CONFLICT(key) DO UPDATE SET window=excluded.window,
 hits=CASE WHEN request_limits.window=excluded.window THEN request_limits.hits+1 ELSE 1 END,
 expires_at=excluded.expires_at WHERE request_limits.window!=excluded.window OR request_limits.hits<?`).bind(key,window,expires,limit).run();
 if(!result.meta.changes){const e=Object.assign(new Error('Слишком много запросов. Попробуйте немного позже.'),{status:429,code:'RATE',retryAfter:Math.max(1,Math.ceil(((window+1)*period-now)/1000))});fail(e)}
}
export async function entryLimit(request,env,fail){
 await consumeLimit(env,'entry:global',1200,60000,fail);
 const ip=request.headers.get('CF-Connecting-IP');
 if(ip){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip));
  const key=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
  await consumeLimit(env,'entry:ip:'+key,180,60000,fail);
 }
}
