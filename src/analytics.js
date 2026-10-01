// 零依赖访客分析（Cloudflare Workers + KV）
// 客户端极小 beacon，服务端按日聚合：页面 PV、流量来源、漏斗事件、当日 UV。
// 不设第三方 Cookie、不采集 PII；_uid 仅为本站随机计数标识。

const DAY = 86400;
const hk = (date, kind) => `__an_${kind}__:${date}`;

function today(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

// 原子地给某个 hash-key 的计数 map +n（KV 单值，读改写；规模小可接受）。
async function bump(kv, key, field, n = 1) {
    let obj = {};
    const raw = await kv.get(key, 'json');
    if (raw && typeof raw === 'object') obj = raw;
    obj[field] = (obj[field] || 0) + n;
    await kv.put(key, JSON.stringify(obj), { expirationTtl: 62 * DAY });
}

// 处理一次上报。payload: { type:'pv'|'event', path, ref, name, uid }
export async function recordAnalytics(kv, payload, cookieHeader) {
    if (!kv || !payload) return false;
    const d = today();
    try {
        // 每日 UV：用随机 _uid 去重（集合存当天出现过的 uid）
        if (payload.uid) {
            const ukey = hk(d, 'uids');
            let set = [];
            const r = await kv.get(ukey, 'json');
            if (Array.isArray(r)) set = r;
            if (!set.includes(payload.uid)) {
                if (set.length < 50000) set.push(payload.uid);
                await kv.put(ukey, JSON.stringify(set), { expirationTtl: 40 * DAY });
                await bump(kv, hk(d, 'stat'), 'uv', 1);
            }
        }
        if (payload.type === 'pv') {
            const path = (payload.path || '/').split('?')[0].slice(0, 120) || '/';
            await bump(kv, hk(d, 'pv'), path, 1);
            // 来源：取 referrer 的注册域名，过滤掉本站/无来源
            const ref = (payload.ref || '').toLowerCase();
            if (ref) {
                let dom = '';
                try { dom = new URL(ref).hostname.replace(/^www\./, ''); } catch {}
                if (dom && !dom.endsWith('pixharvest.com') && !dom.endsWith('workers.dev')) {
                    await bump(kv, hk(d, 'ref'), dom, 1);
                }
            }
            await bump(kv, hk(d, 'stat'), 'pv', 1);
        } else if (payload.type === 'event') {
            const name = String(payload.name || 'unknown').slice(0, 60);
            await bump(kv, hk(d, 'ev'), name, 1);
        }
        return true;
    } catch (e) {
        return false; // 分析失败绝不影响主请求
    }
}

// 汇总最近 days 天（管理端用）
export async function readAnalytics(kv, days = 7) {
    const out = { days, totals: { pv: 0, uv: 0 }, perDay: [], pages: {}, refs: {}, events: {} };
    const merge = (dst, src) => {
        if (!src || typeof src !== 'object') return;
        for (const k in src) dst[k] = (dst[k] || 0) + src[k];
    };
    for (let i = 0; i < days; i++) {
        const dt = new Date(Date.now() - i * DAY);
        const d = today(dt);
        const stat = (await kv.get(hk(d, 'stat'), 'json')) || {};
        const pv = (await kv.get(hk(d, 'pv'), 'json')) || {};
        const ref = (await kv.get(hk(d, 'ref'), 'json')) || {};
        const ev = (await kv.get(hk(d, 'ev'), 'json')) || {};
        out.perDay.push({ date: d, pv: stat.pv || 0, uv: stat.uv || 0 });
        out.totals.pv += stat.pv || 0;
        out.totals.uv += stat.uv || 0;
        merge(out.pages, pv); merge(out.refs, ref); merge(out.events, ev);
    }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 15);
    out.topPages = top(out.pages);
    out.topRefs = top(out.refs);
    out.topEvents = top(out.events);
    return out;
}

// 注入到每个 HTML 页面的客户端脚本（极小、零依赖）。
export const ANALYTICS_JS = `
(function(){
 try{
  var uid=document.cookie.match(/(?:^|; )_uid=([^;]+)/);
  if(!uid){uid='a'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
   document.cookie='_uid='+uid+';path=/;max-age=31536000;SameSite=Lax';}else uid=uid[1];
  function send(o){o.uid=uid;
   try{navigator.sendBeacon&&navigator.sendBeacon('/__beacon',new Blob([JSON.stringify(o)],{type:'application/json'}));}
   catch(e){try{fetch('/__beacon',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify(o)});}catch(_){}}}
  send({type:'pv',path:location.pathname+location.search,ref:document.referrer||''});
  // 漏斗事件：点击定价/升级/下单相关元素
  document.addEventListener('click',function(e){
   var t=e.target.closest&&e.target.closest('a,button');if(!t)return;
   var label=t.getAttribute('data-funnel');
   var href=(t.getAttribute('href')||'').toLowerCase();
   if(label){send({type:'event',name:'click_'+label});}
   else if(href.indexOf('/pricing')===0||href.indexOf('pricing')>=0){send({type:'event',name:'go_pricing'});}
   else if(href.indexOf('/dashboard')===0){send({type:'event',name:'go_dashboard'});}
  },true);
 }catch(e){}
})();`;
