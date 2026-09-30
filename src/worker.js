// Hiring Change Intelligence — independent Cloudflare Worker, x402 paywall.
// Tracks public job boards (Greenhouse / Lever / Ashby): hiring growth signals
// for investors, recruiters and sales teams. Zero runtime dependencies.

// ---- Config ----------------------------------------------------------------
const PAY_TO = '0x4873108b2280b7f3EF8cD70cEca3aaBD385f8D6C';
const FACILITATOR = 'https://x402.org/facilitator';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK = 'base';
const CHAIN_ID = 8453;

const PRICE_CHANGES_USD = 0.05;
const PRICE_INTEL_USD = 0.50;
const PRICE_PER_COMPANY_USD = 0.03;
const BATCH_MAX = 50;
const PRICE_LANDSCAPE_USD = 5;
const LANDSCAPE_MAX = 10;
const ADMIN_KEY = 'ba951afdb936eecd4ffb9ddfb1b44b25f47bbab1dfc391ac';

const json = (obj, status = 200, extra = {}) =>
    new Response(JSON.stringify(obj), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
    });

const b64encode = (o) => btoa(typeof o === 'string' ? o : JSON.stringify(o));
const b64decode = (s) => JSON.parse(atob(s));

// ---- Security: block internal/private targets ------------------------------
function safeHandle(h) {
    if (typeof h !== 'string') return '';
    let x = h.trim().toLowerCase();
    x = x.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\?.*$/, '');
    if (!x) return '';
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.', '10.', '192.168.', '[::1]', 'metadata.google', 'metadata'];
    if (blocked.some((b) => x.startsWith(b) || x.includes(b))) return '';
    if (/[^a-z0-9._-]/.test(x)) return '';
    return x.slice(0, 120);
}

// ---- Job board fetching & normalization ------------------------------------
function normJob(raw, platform) {
    if (platform === 'greenhouse') {
        const loc = raw.location || {};
        return {
            jobId: `gh_${raw.id}`,
            title: raw.title || '',
            department: raw.departments?.[0]?.name || '',
            location: loc.name || '',
            employmentType: '',
            remote: /remote/i.test(loc.name || ''),
            url: raw.absolute_url || '',
            publishedAt: raw.first_published || raw.updated_at || '',
        };
    }
    if (platform === 'lever') {
        const cats = raw.categories || {};
        return {
            jobId: `lv_${raw.id}`,
            title: raw.text || '',
            department: cats.team || cats.department || '',
            location: cats.location || '',
            employmentType: cats.commitment || '',
            remote: /remote/i.test((cats.location || '') + (raw.text || '')),
            url: raw.hostedUrl || '',
            publishedAt: raw.createdAt || '',
        };
    }
    // ashby
    return {
        jobId: `as_${raw.id}`,
        title: raw.title || '',
        department: raw.department || '',
        location: raw.location || '',
        employmentType: raw.employmentType || '',
        remote: !!raw.isRemote,
        url: raw.jobUrl || raw.applyUrl || '',
        publishedAt: raw.publishedAt || '',
    };
}

async function fetchPlatform(platform, handle) {
    let url;
    if (platform === 'greenhouse') url = `https://boards-api.greenhouse.io/v1/boards/${handle}/jobs`;
    else if (platform === 'lever') url = `https://api.lever.co/v0/postings/${handle}?mode=json`;
    else url = `https://api.ashbyhq.com/posting-api/job-board/${handle}`;

    const res = await fetch(url, {
        headers: { 'user-agent': 'hiring-intel/1.0 (+https://x402.org)' },
        cf: { cacheTtl: 300 },
    });
    if (!res.ok) throw new Error(`${platform}_${res.status}`);

    if (platform === 'greenhouse') {
        const d = await res.json();
        return (d.jobs || []).map((j) => normJob(j, 'greenhouse'));
    }
    if (platform === 'lever') {
        const d = await res.json();
        return Array.isArray(d) ? d.map((j) => normJob(j, 'lever')) : [];
    }
    const d = await res.json();
    return (d.jobs || []).map((j) => normJob(j, 'ashby'));
}

// Accept "gh:airbnb", "lever:spotify", "ashby:ashby" or a bare handle (auto-detect).
function parseTarget(input) {
    if (typeof input !== 'string') return null;
    const raw0 = input.trim().toLowerCase();
    const m = raw0.match(/^(gh|greenhouse|lever|ashby)[:.](.+)$/);
    if (m) {
        const platform = m[1] === 'gh' || m[1] === 'greenhouse' ? 'greenhouse' : m[1];
        const handle = safeHandle(m[2]);
        return handle ? { platform, handle } : null;
    }
    const handle = safeHandle(raw0);
    return handle ? { platform: 'auto', handle } : null;
}

async function fetchJobs(target) {
    if (target.platform !== 'auto') {
        return { platform: target.platform, handle: target.handle, jobs: await fetchPlatform(target.platform, target.handle) };
    }
    // Probe platforms in order; use the first that returns roles.
    const order = ['greenhouse', 'lever', 'ashby'];
    let lastErr;
    for (const p of order) {
        try {
            const jobs = await fetchPlatform(p, target.handle);
            if (jobs.length) return { platform: p, handle: target.handle, jobs };
            lastErr = new Error(`${p}_empty`);
        } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('company_not_found');
}

// ---- Diff ------------------------------------------------------------------
function diffJobs(prevList, currList) {
    const changes = [];
    const prevMap = new Map(prevList.map((j) => [j.jobId, j]));
    const currMap = new Map(currList.map((j) => [j.jobId, j]));

    for (const j of currList) {
        if (!prevMap.has(j.jobId)) {
            changes.push({ changeType: 'new_opening', title: j.title, department: j.department, location: j.location, url: j.url });
        }
    }
    for (const j of prevList) {
        if (!currMap.has(j.jobId)) {
            changes.push({ changeType: 'opening_closed', title: j.title, department: j.department, location: j.location, url: j.url });
        }
    }
    for (const curr of currList) {
        const prev = prevMap.get(curr.jobId);
        if (!prev) continue;
        if (prev.department && curr.department && curr.department !== prev.department) {
            changes.push({ changeType: 'team_changed', title: curr.title, from: prev.department, to: curr.department, url: curr.url });
        }
        if (prev.location && curr.location && curr.location !== prev.location) {
            changes.push({ changeType: 'location_changed', title: curr.title, from: prev.location, to: curr.location, url: curr.url });
        }
    }
    return changes;
}

function groupCount(jobs, key) {
    const m = new Map();
    for (const j of jobs) {
        const v = j[key] || 'Unknown';
        m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

function median(nums) {
    const a = [...nums].sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---- Intel report ----------------------------------------------------------
function buildIntel(platform, handle, jobs, changes, fetchedAt) {
    const openings = changes.filter((c) => c.changeType === 'new_opening').length;
    const closed = changes.filter((c) => c.changeType === 'opening_closed').length;
    const byDept = groupCount(jobs, 'department');
    const byLoc = groupCount(jobs, 'location');
    const byType = groupCount(jobs, 'employmentType');
    const remote = jobs.filter((j) => j.remote).length;

    const takeaways = [];
    if (openings > closed) takeaways.push(`Net hiring: +${openings - closed} role(s) (${openings} opened, ${closed} closed) — expanding.`);
    else if (closed > openings) takeaways.push(`Net contraction: ${closed - openings} more role(s) closed than opened.`);
    else takeaways.push(`Headcount plan flat (${openings} opened, ${closed} closed).`);
    if (byDept[0]) takeaways.push(`Hiring concentrated in ${byDept.slice(0, 2).map((d) => `${d.name} (${d.count})`).join(', ')}.`);
    if (byLoc[0]) takeaways.push(`Top locations: ${byLoc.slice(0, 3).map((l) => l.name).join(', ')}.`);
    if (remote) takeaways.push(`${remote} of ${jobs.length} roles flagged remote.`);

    return {
        company: handle,
        platform,
        fetchedAt,
        totalOpenings: jobs.length,
        remoteRoles: remote,
        byDepartment: byDept.slice(0, 15),
        byLocation: byLoc.slice(0, 15),
        byEmploymentType: byType.slice(0, 10),
        changeSummary: { opened: openings, closed, net: openings - closed, totalChanges: changes.length },
        takeaways,
        changes: changes.slice(0, 60),
    };
}

function buildLandscape(companies, perCompany, anchor, at) {
    const rows = perCompany.map((c) => ({
        company: c.handle,
        platform: c.platform,
        openings: c.jobs.length,
        netChange: c.jobs.length - c.prevCount,
        topDepartments: groupCount(c.jobs, 'department').slice(0, 3).map((d) => d.name),
        remote: c.jobs.filter((j) => j.remote).length,
    })).sort((a, b) => b.openings - a.openings);

    const total = rows.reduce((n, r) => n + r.openings, 0);
    const growing = rows.filter((r) => r.netChange > 0).length;
    return {
        generatedAt: at,
        anchor: anchor || (companies[0] || ''),
        companies: rows,
        totalOpenings: total,
        companiesGrowing: growing,
        insights: [
            `${total} openings across ${rows.length} companies; ${growing} expanding vs last snapshot.`,
            `Largest hiring program: ${rows[0]?.company || 'n/a'} (${rows[0]?.openings || 0}).`,
        ],
    };
}

// ---- x402 ------------------------------------------------------------------
function buildRequirements(resource, priceUsd, description) {
    const atomic = BigInt(Math.round(priceUsd * 1_000_000)).toString();
    return {
        scheme: 'exact', network: NETWORK, maxAmountRequired: atomic,
        resource, description, mimeType: 'application/json',
        payTo: PAY_TO, maxTimeoutSeconds: 600, asset: USDC_BASE,
    };
}

const paymentRequired = (requirements) =>
    json({ x402Version: 1, error: 'payment_required', accepts: [requirements] }, 402, {
        'PAYMENT-REQUIRED': b64encode(requirements),
    });

async function verifyAndSettle(paymentHeader, requirements) {
    const paymentPayload = b64decode(paymentHeader);
    const body = { paymentPayload, paymentRequirements: requirements };
    const verifyRes = await fetch(`${FACILITATOR}/verify`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const verify = await verifyRes.json();
    if (!verify.isValid) return { ok: false, reason: verify.invalidReason || 'invalid_payment' };
    const settleRes = await fetch(`${FACILITATOR}/settle`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const settle = await settleRes.json();
    if (!settle.success) return { ok: false, reason: settle.errorReason || 'unexpected_settle_error' };
    return { ok: true, payer: settle.payer, transaction: settle.transaction };
}

async function requirePaid(request, resource, priceUsd, description) {
    const paymentHeader = request.headers.get('PAYMENT') || request.headers.get('X-PAYMENT');
    const requirements = buildRequirements(resource, priceUsd, description);
    if (!paymentHeader) return { paid: false, response: paymentRequired(requirements) };
    let settlement;
    try {
        settlement = await verifyAndSettle(paymentHeader, requirements);
    } catch (err) {
        return { paid: false, response: json({ error: 'unexpected_verify_error', detail: String(err?.message || err) }, 502) };
    }
    if (!settlement.ok) return { paid: false, response: json({ x402Version: 1, error: settlement.reason }, 402) };
    return { paid: true, settlement };
}

const snapshotStore = (kv, handle, platform, jobs) =>
    kv ? kv.put(`snapshot-${platform}-${handle}`, JSON.stringify({ savedAt: new Date().toISOString(), handle, platform, jobs })).catch(() => {}) : null;

async function readPrev(kv, platform, handle) {
    if (!kv) return null;
    const raw = await kv.get(`snapshot-${platform}-${handle}`);
    return raw ? JSON.parse(raw) : null;
}

// ---- Handlers --------------------------------------------------------------
async function handleSnapshot(url, request, env) {
    const target = parseTarget(url.searchParams.get('company') || url.searchParams.get('handle'));
    if (!target) return json({ error: 'invalid_company' }, 400);
    let data;
    try {
        data = await fetchJobs(target);
    } catch (e) {
        return json({ error: 'fetch_failed', detail: String(e.message || e) }, 502);
    }
    snapshotStore(env.INTEL_KV, data.handle, data.platform, data.jobs);
    return json({
        company: data.handle, platform: data.platform,
        fetchedAt: new Date().toISOString(), totalOpenings: data.jobs.length,
        byDepartment: groupCount(data.jobs, 'department').slice(0, 10),
        jobs: data.jobs.slice(0, 200),
    });
}

async function handleChanges(url, request, env) {
    const target = parseTarget(url.searchParams.get('company'));
    if (!target) return json({ error: 'invalid_company' }, 400);
    const pay = await requirePaid(request, url.href, PRICE_CHANGES_USD, 'Hiring changes for one company');
    if (!pay.paid) return pay.response;

    const data = await fetchJobs(target);
    const prev = await readPrev(env.INTEL_KV, data.platform, data.handle);
    const changes = prev ? diffJobs(prev.jobs, data.jobs) : [];
    snapshotStore(env.INTEL_KV, data.handle, data.platform, data.jobs);
    return json({
        company: data.handle, platform: data.platform,
        fetchedAt: new Date().toISOString(), baselineAt: prev?.savedAt || null,
        changeCount: changes.length, changes,
        settlement: { payer: pay.settlement.payer, transaction: pay.settlement.transaction },
    });
}

async function handleIntel(url, request, env) {
    const target = parseTarget(url.searchParams.get('company'));
    if (!target) return json({ error: 'invalid_company' }, 400);
    const pay = await requirePaid(request, url.href, PRICE_INTEL_USD, 'Hiring intelligence report for one company');
    if (!pay.paid) return pay.response;

    const data = await fetchJobs(target);
    const prev = await readPrev(env.INTEL_KV, data.platform, data.handle);
    const changes = prev ? diffJobs(prev.jobs, data.jobs) : [];
    snapshotStore(env.INTEL_KV, data.handle, data.platform, data.jobs);
    const report = buildIntel(data.platform, data.handle, data.jobs, changes, new Date().toISOString());
    report.settlement = { payer: pay.settlement.payer, transaction: pay.settlement.transaction };
    return json(report);
}

async function readBody(request) {
    try { return await request.json(); } catch { return {}; }
}

async function handleBatch(url, request, env) {
    let companies = [];
    if (request.method === 'POST') {
        const b = await readBody(request);
        companies = Array.isArray(b.companies) ? b.companies : [];
    } else {
        companies = (url.searchParams.get('companies') || '').split(',').filter(Boolean);
    }
    companies = [...new Set(companies)];
    if (!companies.length) return json({ error: 'missing_companies' }, 400);
    if (companies.length > BATCH_MAX) return json({ error: 'too_many', max: BATCH_MAX }, 400);

    const pay = await requirePaid(request, url.href, companies.length * PRICE_PER_COMPANY_USD, `Batch hiring scan of ${companies.length} companies`);
    if (!pay.paid) return pay.response;

    const results = await Promise.all(companies.map(async (c) => {
        const target = parseTarget(c);
        if (!target) return { company: c, error: 'invalid_company' };
        try {
            const data = await fetchJobs(target);
            const prev = await readPrev(env.INTEL_KV, data.platform, data.handle);
            const changes = prev ? diffJobs(prev.jobs, data.jobs) : [];
            snapshotStore(env.INTEL_KV, data.handle, data.platform, data.jobs);
            return { company: data.handle, platform: data.platform, openings: data.jobs.length, changeCount: changes.length };
        } catch (e) {
            return { company: c, error: String(e.message || e) };
        }
    }));
    return json({ fetchedAt: new Date().toISOString(), results, settlement: { payer: pay.settlement.payer } });
}

async function handleLandscape(url, request, env) {
    let companies = [];
    if (request.method === 'POST') {
        const b = await readBody(request);
        companies = Array.isArray(b.companies) ? b.companies : [];
        var anchor = b.anchor || '';
    } else {
        companies = (url.searchParams.get('companies') || '').split(',').filter(Boolean);
        anchor = url.searchParams.get('anchor') || '';
    }
    companies = [...new Set(companies)];
    if (!companies.length) return json({ error: 'missing_companies' }, 400);
    if (companies.length > LANDSCAPE_MAX) return json({ error: 'too_many', max: LANDSCAPE_MAX }, 400);

    const pay = await requirePaid(request, url.href, PRICE_LANDSCAPE_USD, `Hiring landscape across ${companies.length} companies`);
    if (!pay.paid) return pay.response;

    const perCompany = await Promise.all(companies.map(async (c) => {
        const target = parseTarget(c);
        if (!target) return { handle: c, platform: '', jobs: [], prevCount: 0 };
        try {
            const data = await fetchJobs(target);
            const prev = await readPrev(env.INTEL_KV, data.platform, data.handle);
            snapshotStore(env.INTEL_KV, data.handle, data.platform, data.jobs);
            return { handle: data.handle, platform: data.platform, jobs: data.jobs, prevCount: prev ? prev.jobs.length : data.jobs.length };
        } catch (e) {
            return { handle: c, platform: '', jobs: [], prevCount: 0, error: String(e.message || e) };
        }
    }));

    const safeAnchor = safeHandle(anchor);
    return json(buildLandscape(perCompany.map((p) => p.handle), perCompany, safeAnchor, new Date().toISOString()));
}

// include UI / subscriptions / cron in part 2

// ---- Static discovery ------------------------------------------------------
const LLMS_TXT = "# Hiring Change Intelligence\n\n> Track public job boards (Greenhouse / Lever / Ashby): hiring growth signals for investors, recruiters and sales teams. Free snapshot; paid change intel in USDC via x402 on Base.\n\n- Endpoint (MCP, Streamable HTTP): https://hiring-intel.contentforge-press.workers.dev/mcp\n- Free snapshot: https://hiring-intel.contentforge-press.workers.dev/v1/snapshot?company=gh:airbnb\n\n## Tools (MCP)\n- hiring_snapshot: free — current openings by department/location\n- hiring_changes: $0.05 — opened/closed roles vs history\n- hiring_intel_report: $0.50 — hiring growth report with takeaways\n- hiring_batch_scan: $0.03 per company — scan up to 50 companies\n- hiring_landscape: $5 — hiring landscape across up to 10 companies\n\nTarget syntax: gh:<handle>, lever:<handle>, ashby:<handle>, or bare handle (auto-detect).\nPaid tools settle USDC on Base using x402.\n";

const ROBOTS_TXT = "User-agent: *\nAllow: /\n";
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://hiring-intel.contentforge-press.workers.dev/</loc></url>
<url><loc>https://hiring-intel.contentforge-press.workers.dev/pricing</loc></url>
<url><loc>https://hiring-intel.contentforge-press.workers.dev/dashboard</loc></url>
</urlset>`;

function renderGlama() {
    return json({
        $schema: 'https://glama.ai/mcp/schemas/connector.json',
        maintainers: [{ email: 'contentforge.press@outlook.com' }],
    });
}

function renderWellKnown() {
    return json({
        x402Version: 1,
        network: NETWORK,
        chainId: CHAIN_ID,
        asset: USDC_BASE,
        payTo: PAY_TO,
        facilitator: FACILITATOR,
        pricing: {
            changes: PRICE_CHANGES_USD,
            intel: PRICE_INTEL_USD,
            batchPerCompany: PRICE_PER_COMPANY_USD,
            landscape: PRICE_LANDSCAPE_USD,
        },
    });
}

const PAGE_CSS = `
:root{--bg:#0b0e14;--card:#141925;--line:#222a3a;--fg:#e8ecf4;--mut:#8b95a7;--acc:#5b8cff}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:920px;margin:0 auto;padding:48px 22px}
h1{font-size:30px;margin:0 0 6px}
.sub{color:var(--mut);font-size:15px;margin-bottom:22px}
a{color:#9db8ff}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
label{display:block;font-size:13px;color:var(--mut);margin-bottom:8px}
.row{display:flex;gap:10px;flex-wrap:wrap}
input{flex:1;min-width:220px;background:#0d1119;border:1px solid var(--line);border-radius:9px;color:var(--fg);padding:11px 13px;font-size:14px}
button{padding:11px 18px;border-radius:9px;border:1px solid var(--acc);background:var(--acc);color:#fff;font-weight:600;cursor:pointer;font-size:14px}
button.ghost{background:transparent;color:#cdd9ff}
code{background:#0d1119;border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-size:12.5px}
pre{background:#0d1119;border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font-size:12.5px;color:#cdd6e6;max-height:300px}
.muted{color:var(--mut);font-size:13px}
.pill{display:inline-block;background:#0d1119;border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:12px;margin:3px}
@media(max-width:760px){.grid{grid-template-columns:1fr}}
`;

function renderHome() {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hiring Change Intelligence — x402</title><style>${PAGE_CSS}</style></head>
<body><div class="wrap">
<h1>Hiring Change Intelligence</h1>
<p class="sub">Track which companies are hiring (and where). Free snapshot &nbsp;·&nbsp; hiring-growth signals paid by AI agents in <b>USDC on Base</b> via <b>x402</b> — no signup, no processor.</p>

<div class="card">
<label for="c">Try it free — company (Greenhouse / Lever / Ashby handle)</label>
<div class="row">
<input id="c" value="gh:airbnb" placeholder="gh:airbnb · lever:spotify · ashby:ashby" />
<button onclick="run()">Get free snapshot</button>
</div>
<p class="muted" style="margin:12px 0 0">Syntax: <code>gh:&lt;handle&gt;</code> <code>lever:&lt;handle&gt;</code> <code>ashby:&lt;handle&gt;</code>, or a bare handle (auto-detect).</p>
<pre id="out">// result will appear here</pre>
</div>

<div class="grid">
<div class="card"><b>Free</b><p class="muted">Current openings — count, departments, locations</p><code>GET /v1/snapshot?company=…</code></div>
<div class="card"><b>Data · $0.05 USDC</b><p class="muted">Opened / closed roles vs history</p><code>GET /v1/lchanges?company=…</code></div>
<div class="card" style="border-color:var(--acc)"><b>Answer · $0.50 USDC ⭐</b><p class="muted">Hiring-growth report: focus teams, geography, takeaways</p><code>GET /v1/lintel?company=…</code></div>
</div>

<div class="card">
<b>For funds &amp; recruiters scanning many companies</b>
<p class="muted"><code>$0.03 / company</code> batch (up to ${BATCH_MAX}) &nbsp;·&nbsp; <code>$5</code> strategic landscape (up to ${LANDSCAPE_MAX} companies) with growth ranking.</p>
<code>POST /v1/lbatch {"companies":["gh:airbnb","lever:spotify"]}</code>
</div>

<div class="card" style="border-color:var(--acc);background:linear-gradient(180deg,rgba(91,140,255,.10),var(--card))">
<b>Continuous hiring signals?</b>
<p class="muted">Watch a portfolio of companies, get alerts when roles open/close. Plans from <b>$99/month</b> — pay in USDC, key delivered instantly.</p>
<div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
<a href="/pricing" style="text-decoration:none"><button type="button">See plans</button></a>
<a href="/dashboard" style="text-decoration:none"><button type="button" class="ghost">Open dashboard</button></a>
</div>
</div>

<div class="card">
<b>How agents pay</b>
<p class="muted">Unpaid call returns <code>402</code> with <code>PAYMENT-REQUIRED</code>; an x402 agent settles USDC on Base and retries — P2P, 0% commission.</p>
<span class="pill">network · Base (${CHAIN_ID})</span><span class="pill">asset · USDC</span><span class="pill">payout · ${PAY_TO.slice(0,6)}…${PAY_TO.slice(-4)}</span>
</div>

<p class="muted"><a href="/pricing">pricing</a> · <a href="/dashboard">dashboard</a> · <a href="/health">health</a> · <a href="/llms.txt">llms.txt</a> · <a href="/terms">terms</a> · <a href="/privacy">privacy</a> · <a href="/contact">contact</a></p>
</div>
<script>
async function run(){
 const out=document.getElementById('out');
 const c=encodeURIComponent(document.getElementById('c').value.trim());
 out.textContent='// loading…';
 try{
  const r=await fetch('/v1/snapshot?company='+c);
  const d=await r.json();
  out.textContent=JSON.stringify({company:d.company,platform:d.platform,totalOpenings:d.totalOpenings,byDepartment:d.byDepartment},null,2);
 }catch(e){out.textContent='// error: '+e;}
}
</script>
</body></html>`;
}

// ---- Legal pages -----------------------------------------------------------
const LEGAL_CSS = PAGE_CSS;
function legalPage(title, bodyHtml) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Hiring Change Intelligence</title><style>${LEGAL_CSS}</style></head>
<body><div class="wrap" style="max-width:820px">
<h1>${title}</h1>
<p class="muted">Last updated: 2026-10-01 · <a href="/">Home</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/contact">Contact</a></p>
${bodyHtml}
<hr><p class="muted">Hiring Change Intelligence — public job-board monitoring for AI agents. <a href="/">Back to home</a></p>
</div></body></html>`;
}
function renderPrivacy() {
    return legalPage('Privacy Policy', `
<h2>What we collect</h2>
<ul><li><b>Queries:</b> the public company handle you request and job metadata (titles, departments, locations) already published on public job boards.</li>
<li><b>Technical logs:</b> timestamps, client type, status codes, for rate limiting and reliability.</li>
<li><b>Payments:</b> settled peer-to-peer in USDC on Base via x402. We do not collect cards, bank details or passwords.</li></ul>
<h2>What we do not do</h2>
<ul><li>We do not sell personal data, run ad trackers, or require accounts for API use. We only read data already public.</li></ul>
<p>Data requests: <a href="mailto:contentforge.press@outlook.com">contentforge.press@outlook.com</a>.</p>`);
}
function renderTerms() {
    return legalPage('Terms of Service', `
<p>Hiring Change Intelligence monitors data published on <b>public job boards</b> (Greenhouse / Lever / Ashby), over HTTP and MCP. Paid tiers are pay-per-result; free tiers as-is.</p>
<ul><li>Use lawfully; no unauthorized access, circumvention of limits/payments, or extraction of non-public data.</li></ul>
<p>All data is sourced from third parties and provided "as is". You are responsible for decisions using it. Paid requests settle in USDC on Base via x402 and are generally non-refundable once delivered. Questions: <a href="mailto:contentforge.press@outlook.com">contentforge.press@outlook.com</a>.</p>`);
}
function renderContact() {
    return legalPage('Contact & Abuse', `
<p>General, security or abuse reports: <a href="mailto:contentforge.press@outlook.com">contentforge.press@outlook.com</a></p>
<p>Include the company, endpoint and issue description. We investigate legitimate abuse reports promptly.</p>`);
}

// ---- Subscription plans ----------------------------------------------------
const PLANS = {
    pro: { id: 'pro', name: 'Pro', price: 99, days: 30, tagline: 'For recruiters & sales watching target accounts',
        features: ['Track up to 25 companies', 'Hiring change alerts (opened/closed roles)', 'Weekly portfolio digest', 'All paid MCP tools included', 'Email + webhook notifications'] },
    business: { id: 'business', name: 'Business', price: 499, days: 30, tagline: 'For recruiting & research teams',
        features: ['Track up to 150 companies', 'Up to 10 team seats', 'Higher batch & API limits', 'Landscape reports included', 'Priority support'] },
    enterprise: { id: 'enterprise', name: 'Enterprise', price: 2000, days: 30, tagline: 'For funds & enterprise intelligence',
        features: ['Unlimited companies & seats', 'Custom signals & private data feeds', 'Dedicated landscape reports', 'SLA & onboarding', 'SSO & advanced controls'] },
};

function renderPricing() {
    const cards = Object.values(PLANS).map((p, i) => `
<div class="plan${i === 1 ? ' hl' : ''}">
${i === 1 ? '<div class="pop">Most popular</div>' : ''}
<div class="pname">${p.name}</div>
<div class="price"><span class="amt">$${p.price}</span><span class="per">/month</span></div>
<div class="tag">${p.tagline}</div>
<ul>${p.features.map(f => `<li>${f}</li>`).join('')}</ul>
<button class="cta" data-plan="${p.id}">Choose ${p.name}</button>
</div>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pricing · Hiring Change Intelligence</title>
<style>
${PAGE_CSS}
.wrap{max-width:1080px}
.grid2{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.plan{position:relative;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px 22px;display:flex;flex-direction:column}
.plan.hl{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc),0 18px 50px -20px rgba(91,140,255,.5)}
.pop{position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--acc);color:#fff;font-size:11px;font-weight:600;padding:4px 12px;border-radius:999px;text-transform:uppercase}
.pname{font-size:14px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
.price{margin:8px 0 2px}.amt{font-size:40px;font-weight:700}.per{color:var(--mut);font-size:14px}
.tag{color:#aab4c6;font-size:13.5px;min-height:40px;margin-bottom:14px}
ul{list-style:none;padding:0;margin:0 0 20px;flex:1}
li{padding:8px 0 8px 26px;position:relative;color:#c6cdda;font-size:14px;border-bottom:1px solid rgba(255,255,255,.04)}
li:before{content:"✓";position:absolute;left:0;color:var(--acc);font-weight:700}
.cta{margin-top:auto;width:100%;padding:12px;border-radius:10px;border:1px solid var(--acc);background:transparent;color:#cdd9ff;font-size:15px;font-weight:600;cursor:pointer}
.plan.hl .cta{background:var(--acc);color:#fff}
.foot{margin-top:26px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;display:none}.foot.show{display:block}
@media(max-width:860px){.grid2{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<h1 style="text-align:center">Plans &amp; pricing</h1>
<p class="sub" style="text-align:center">Start free pay-per-result, or get continuous hiring signals. Billed in <b>USDC on Base</b> — no card.</p>
<div class="grid2">${cards}</div>
<div class="foot" id="paybox"><h3 id="paytitle" style="margin:0 0 8px">Complete subscription</h3><pre id="payjson">Loading…</pre></div>
<p class="muted" style="text-align:center;margin-top:24px">Only a few calls? <a href="/">Pay per result</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>
</div>
<script>
let payTimer=null;
document.querySelectorAll('.cta').forEach(b=>b.onclick=async()=>{
 const box=document.getElementById('paybox');box.classList.add('show');
 document.getElementById('paytitle').textContent='Setting up '+b.dataset.plan+'…';
 document.getElementById('payjson').textContent='Loading…';
 clearInterval(payTimer);
 try{
  const r=await fetch('/v1/order?plan='+b.dataset.plan);
  const o=await r.json();
  if(o.error){document.getElementById('payjson').textContent=o.error;return;}
  document.getElementById('paytitle').textContent='Send exactly '+o.amountUsd+' USDC on Base';
  document.getElementById('payjson').textContent='To: '+o.payTo+'\\nNetwork: Base (ERC-20)\\nExact amount: '+o.amountUsd+' USDC\\n\\nSend from any exchange/wallet. Order expires in 60 min. Waiting for confirmation…';
  payTimer=setInterval(async()=>{
   const c=await (await fetch('/v1/order/check?id='+o.orderId)).json();
   if(c.status==='paid'){clearInterval(payTimer);document.getElementById('paytitle').textContent='✓ Payment confirmed';document.getElementById('payjson').textContent='Access key: '+c.accessKey+'\\nPlan: '+c.plan+'\\nSave this key and use it at your dashboard.';}
   else if(c.status==='expired'){clearInterval(payTimer);document.getElementById('payjson').textContent='Order expired. Please start again.';}
  },6000);
 }catch(e){document.getElementById('payjson').textContent='Error: '+e;}
});
</script></body></html>`;
}

function newAccessKey() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return 'sci_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Human direct-pay（唯一金额识别，Base RPC核验，自动发key）----
async function findDirectPayment(expectUnits, windowBlocks = 1900) {
    const hb = await (await fetch('https://mainnet.base.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json();
    const head = parseInt(hb.result, 16);
    const fromBlock = '0x' + Math.max(0, head - windowBlocks).toString(16);
    const padded = PAY_TO.slice(2).toLowerCase().padStart(64, '0');
    const lr = await (await fetch('https://mainnet.base.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{ address: USDC_BASE, fromBlock, toBlock: 'latest', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', null, '0x' + padded] }] }) })).json();
    if (!Array.isArray(lr.result)) return null;
    for (const log of lr.result) if (log.data && BigInt(log.data) === BigInt(expectUnits)) {
        return { tx: log.transactionHash, from: '0x' + (log.topics[1] || '').slice(26) };
    }
    return null;
}
async function createDirectOrder(plan, kv) {
    const salt = crypto.getRandomValues(new Uint8Array(2));
    const extra = ((salt[0] << 8 | salt[1]) % 900 + 100);
    const amountUsd = +(plan.price + extra / 1e6).toFixed(6);
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    const orderId = 'ord_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const order = { orderId, plan: plan.id, planName: plan.name, amountUsd, amountUnits: String(Math.round(amountUsd * 1e6)), payTo: PAY_TO, network: 'base', asset: USDC_BASE, status: 'awaiting', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60e3).toISOString() };
    if (kv) await kv.put(`order-${orderId}`, JSON.stringify(order), { expirationTtl: 5400 });
    return order;
}
async function checkDirectOrder(order, kv, skv) {
    if (order.status === 'paid') return order;
    if (new Date(order.expiresAt).getTime() < Date.now()) { order.status = 'expired'; return order; }
    const found = await findDirectPayment(order.amountUnits);
    if (!found) return order;
    order.status = 'paid'; order.tx = found.tx; order.payer = found.from; order.paidAt = new Date().toISOString();
    const plan = PLANS[order.plan];
    const expiresAt = new Date(Date.now() + plan.days * 86400e3).toISOString();
    const accessKey = newAccessKey();
    order.accessKey = accessKey;
    if (kv) await (skv || kv).put(`sub-${accessKey}`, JSON.stringify({ accessKey, plan: plan.id, payer: found.from || '', startedAt: new Date().toISOString(), expiresAt, priceUsd: plan.price, source: 'direct', orderId: order.orderId }));
    if (kv) await kv.put(`order-${order.orderId}`, JSON.stringify(order));
    return order;
}

async function handleSubscribe(url, request, env) {
    const plan = PLANS[url.searchParams.get('plan')];
    if (!plan) return json({ error: 'invalid_plan', plans: Object.keys(PLANS) }, 400);
    const origin = new URL(url).origin;
    const resource = `${origin}/v1/lsubscribe?plan=${plan.id}`;
    const pay = await requirePaid(request, resource, plan.price, `Hiring Intel ${plan.name} subscription (${plan.days} days)`);
    if (!pay.paid) return pay.response;

    const now = Date.now();
    const expiresAt = new Date(now + plan.days * 86400_000).toISOString();
    const accessKey = newAccessKey();
    const record = { accessKey, plan: plan.id, payer: pay.settlement.payer, startedAt: new Date(now).toISOString(), expiresAt, transaction: pay.settlement.transaction, priceUsd: plan.price };
    const shared = env.SHARED_KV || env.INTEL_KV;
    if (env.INTEL_KV) {
        await shared.put(`sub-${accessKey}`, JSON.stringify(record));
        await env.INTEL_KV.put(`subpayer-${pay.settlement.payer}`, accessKey);
    }
    return json({ ok: true, accessKey, plan: plan.id, payer: pay.settlement.payer, startedAt: record.startedAt, expiresAt, transaction: pay.settlement.transaction });
}

// ---- Dashboard & watchlist -------------------------------------------------
const LIMITS = { pro: 25, business: 150, enterprise: 100000 };

async function loadSubscription(kv, accessKey, skv) {
    if (!accessKey) return null;
    const raw = await (skv || kv)?.get(`sub-${accessKey}`);
    if (!raw) return null;
    const sub = JSON.parse(raw);
    sub.active = new Date(sub.expiresAt).getTime() > Date.now();
    return sub;
}
async function getWatchlist(kv, key) {
    const raw = await kv.get(`watch-${key}`);
    return raw ? JSON.parse(raw) : { companies: [], webhookUrl: '', alertEmail: '', updatedAt: null };
}
async function watchView(kv, key, skv) {
    const sub = await loadSubscription(kv, key, skv);
    if (!sub) return { error: 'invalid_key', status: 401 };
    const wl = await getWatchlist(kv, key);
    return { accessKey: key, plan: sub.plan, active: sub.active, expiresAt: sub.expiresAt, storeLimit: LIMITS[sub.plan] || 0, companies: wl.companies, webhookUrl: wl.webhookUrl || '', alertEmail: wl.alertEmail || '' };
}

function renderDashboard() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard · Hiring Change Intelligence</title>
<style>
${PAGE_CSS}
.wrap{max-width:980px}
.login{display:flex;gap:10px;flex-wrap:wrap}
.app{display:none}.app.on{display:block}
.bar{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;margin-bottom:14px}
.badge{background:#0d1119;border:1px solid var(--line);border-radius:999px;padding:5px 13px;font-size:12.5px}
.addrow{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
.company{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 16px;margin:10px 0}
.c-top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}
.changes{margin-top:10px;display:none}.changes.on{display:block}
.chg{padding:5px 0;font-size:13px;color:#c6cdda;border-top:1px solid rgba(255,255,255,.05)}
.pill2{font-size:11px;padding:2px 9px;border-radius:999px;background:rgba(91,140,255,.15);color:#9db8ff}
.settings{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:20px}
.settings input{margin-top:6px;width:100%}
</style></head><body><div class="wrap">
<h1>Hiring signals dashboard</h1>
<p class="sub">Watch companies, get alerts when roles open/close. <a href="/pricing">Plans</a> · <a href="/">Home</a></p>

<div id="loginview">
<div class="login"><input id="key" placeholder="Paste access key (sci_)" style="flex:1;min-width:240px"><button onclick="connect()">Open dashboard</button></div>
<p class="sub" id="loginerr" style="color:#ff6b6b"></p>
<p class="sub">No key? <a href="/pricing">Get a subscription</a>.</p>
</div>

<div class="app" id="appview">
<div class="bar"><div>
<span class="badge">Plan <b id="plan"></b></span>
<span class="badge">Expires <b id="exp"></b></span>
<span class="badge"><b id="cnt"></b> companies</span>
</div><button onclick="refreshAll()" id="rbtn">Refresh all</button></div>
<p class="sub" id="apperr" style="color:#ff6b6b"></p>
<div class="addrow"><input id="newc" placeholder="gh:company · lever:company · ashby:company" style="flex:1;min-width:200px"><button onclick="addCo()">Add company</button></div>
<div id="list"></div>
<div class="settings">
<b>Alert webhook</b><input id="webhook" placeholder="https://hooks.example.com/...">
<b style="display:block;margin-top:12px">Email alerts</b><input id="aemail" placeholder="you@company.com">
<div style="margin-top:10px"><button class="ghost" onclick="saveSettings()">Save</button></div>
</div>
</div>
</div>
<script>
let st=null;const $=id=>document.getElementById(id);
function connect(){
 const key=$('key').value.trim();$('loginerr').textContent='';
 if(!key){$('loginerr').textContent='Enter a key.';return;}
 fetch('/v1/lwatch?key='+encodeURIComponent(key)).then(r=>r.json()).then(d=>{
  if(d.error){$('loginerr').textContent=d.error;return;}
  st=d;$('loginview').style.display='none';$('appview').classList.add('on');render();
 });
}
const LABELS={new_opening:'Opened',opening_closed:'Closed',team_changed:'Team',location_changed:'Location'};
function chgHtml(c){let t=(LABELS[c.changeType]||c.changeType)+' · '+(c.title||'');if(c.from)t+=': '+c.from+' → '+c.to;return '<div class="chg">'+t+'</div>';}
function render(){
 $('plan').textContent=st.plan;$('exp').textContent=(st.active?'':'EXPIRED ')+st.expiresAt.slice(0,10);$('cnt').textContent=st.companies.length;
 $('webhook').value=st.webhookUrl||'';$('aemail').value=st.alertEmail||'';
 $('list').innerHTML=st.companies.length?st.companies.map(s=>'<div class="company"><div class="c-top"><div><b>'+s.company+'</b><div class="muted">'+(s.lastChecked||'not checked')+'</div></div><div><span class="pill2">'+(s.lastChanges||[]).length+' changes</span> <button class="ghost" onclick="toggle(this)">Show</button> <button class="ghost" onclick="refreshOne(\\''+s.company+'\\')">Check</button> <button class="ghost" onclick="removeCo(\\''+s.company+'\\')">Remove</button></div></div><div class="changes">'+((s.lastChanges||[]).map(chgHtml).join('')||'<div class="muted">No changes.</div>')+'</div></div>').join(''):'<p class="muted">Add your first company.</p>';
}
function toggle(b){const x=b.closest('.company').querySelector('.changes');x.classList.toggle('on');b.textContent=x.classList.contains('on')?'Hide':'Show';}
function post(p,body){return fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());}
function addCo(){const company=$('newc').value.trim();if(!company)return;post('/v1/lwatch/add?key='+encodeURIComponent(st.accessKey),{company}).then(d=>{if(d.error){$('apperr').textContent=d.error;return;}st=d;$('newc').value='';render();});}
function removeCo(company){post('/v1/lwatch/remove?key='+encodeURIComponent(st.accessKey),{company}).then(d=>{if(d.error){$('apperr').textContent=d.error;return;}st=d;render();});}
function refreshOne(company){$('rbtn').textContent='Checking…';fetch('/v1/lwatch/refresh?key='+encodeURIComponent(st.accessKey)+'&company='+encodeURIComponent(company)).then(r=>r.json()).then(d=>{if(!d.error)st=d;render();}).finally(()=>$('rbtn').textContent='Refresh all');}
function refreshAll(){$('rbtn').textContent='Refreshing…';fetch('/v1/lwatch/refresh?key='+encodeURIComponent(st.accessKey)).then(r=>r.json()).then(d=>{if(!d.error)st=d;render();}).finally(()=>$('rbtn').textContent='Refresh all');}
function saveSettings(){post('/v1/lwatch/settings?key='+encodeURIComponent(st.accessKey),{webhookUrl:$('webhook').value.trim(),alertEmail:$('aemail').value.trim()}).then(d=>{if(d.error){$('apperr').textContent=d.error;return;}st=d;$('apperr').textContent='Saved ✓';});}
</script></body></html>`;
}

async function readJsonBody(request){try{return await request.json();}catch{return{};}}

async function hWatchGet(url,request,env){const v=await watchView(env.INTEL_KV,url.searchParams.get('key'),env.SHARED_KV);return json(v,v.status||200);}

async function hWatchAdd(url,request,env){
 const kv=env.INTEL_KV,skv=env.SHARED_KV||kv,key=url.searchParams.get('key');
 const sub=await loadSubscription(kv,key,skv);if(!sub)return json({error:'invalid_key'},401);if(!sub.active)return json({error:'subscription_expired'},402);
 const body=await readJsonBody(request);const target=parseTarget(body.company);
 if(!target)return json({error:'invalid_company'},400);
 const wl=await getWatchlist(kv,key);
 if(wl.companies.length>=(LIMITS[sub.plan]||0))return json({error:'plan_limit'},400);
 if(wl.companies.some(c=>c.company===target.handle&&c.platform_target===target.platform))return json({error:'already_added'},400);
 wl.companies.push({company:target.handle,platform_target:target.platform,addedAt:new Date().toISOString(),lastChecked:null,lastChanges:[]});
 await kv.put(`watch-${key}`,JSON.stringify(wl));
 return json(await watchView(kv,key,skv));
}
async function hWatchRemove(url,request,env){
 const kv=env.INTEL_KV,skv=env.SHARED_KV||kv,key=url.searchParams.get('key');
 if(!(await loadSubscription(kv,key,skv)))return json({error:'invalid_key'},401);
 const body=await readJsonBody(request);
 const wl=await getWatchlist(kv,key);
 wl.companies=wl.companies.filter(c=>c.company!==safeHandle(body.company));
 await kv.put(`watch-${key}`,JSON.stringify(wl));
 return json(await watchView(kv,key,skv));
}
async function hWatchSettings(url,request,env){
 const kv=env.INTEL_KV,skv=env.SHARED_KV||kv,key=url.searchParams.get('key');
 if(!(await loadSubscription(kv,key,skv)))return json({error:'invalid_key'},401);
 const body=await readJsonBody(request);
 const webhookUrl=(body.webhookUrl||'').trim().slice(0,500);
 const alertEmail=(body.alertEmail||'').trim().slice(0,200);
 if(webhookUrl&&!/^https:\/\//.test(webhookUrl))return json({error:'webhook_https'},400);
 if(alertEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail))return json({error:'invalid_email'},400);
 const wl=await getWatchlist(kv,key);
 wl.webhookUrl=webhookUrl;wl.alertEmail=alertEmail;
 await kv.put(`watch-${key}`,JSON.stringify(wl));
 return json(await watchView(kv,key,skv));
}

async function dispatchHiringAlerts(wl,alerts){
 if(!alerts.length)return;
 if(wl.webhookUrl)for(const a of alerts)try{await fetch(wl.webhookUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'hiring-change-intelligence',...a})});}catch{}
 // email requires RESEND_API_KEY secret (optional)
 if(wl.alertEmail&&typeof RESEND_API_KEY!=='undefined'&&RESEND_API_KEY){
  try{
   const total=alerts.reduce((n,a)=>n+a.changes.length,0);
   await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+RESEND_API_KEY,'content-type':'application/json'},body:JSON.stringify({from:'Hiring Intel <alerts@mail.contentforge.press>',to:[wl.alertEmail],subject:`💼 ${total} hiring change(s)`,html:alerts.map(a=>'<h3>'+a.company+'</h3>'+a.changes.slice(0,20).map(c=>'<div>• '+(c.changeType==='new_opening'?'Opened':'Closed')+' — '+(c.title||'')+'</div>').join('')).join('')})});
  }catch{}
 }
}

async function hWatchRefresh(url,request,env){
 const kv=env.INTEL_KV,skv=env.SHARED_KV||kv,key=url.searchParams.get('key');
 const sub=await loadSubscription(kv,key,skv);if(!sub)return json({error:'invalid_key'},401);if(!sub.active)return json({error:'subscription_expired'},402);
 const wl=await getWatchlist(kv,key);
 const only=safeHandle(url.searchParams.get('company'));
 const targets=only?wl.companies.filter(c=>c.company===only):wl.companies;
 const alerts=[];
 await Promise.all(targets.map(async entry=>{
  try{
   const t={platform:entry.platform_target==='auto'?'auto':entry.platform_target,handle:entry.company};
   const data=await fetchJobs(t.platform==='auto'?{platform:'auto',handle:entry.company}:t);
   const prev=await readPrev(kv,data.platform,data.handle);
   const changes=prev?diffJobs(prev.jobs,data.jobs):[];
   snapshotStore(kv,data.handle,data.platform,data.jobs);
   entry.lastChecked=new Date().toISOString();entry.lastChanges=changes.slice(0,100);
   if(changes.length)alerts.push({company:data.handle,changes:changes.slice(0,50),checkedAt:entry.lastChecked});
  }catch(e){entry.lastChecked=new Date().toISOString();entry.error=String(e.message||e);}
 }));
 await kv.put(`watch-${key}`,JSON.stringify(wl));
 await dispatchHiringAlerts(wl,alerts);
 return json(await watchView(kv,key,skv));
}

async function scheduledScan(env){
 const kv=env.INTEL_KV,skv=env.SHARED_KV||kv;let cursor,scanned=0,refreshed=0;
 do{
  const l=await kv.list({prefix:'watch-',cursor,limit:100});
  for(const it of l.keys){
   const key=it.name.slice(6);if(!key.startsWith('sci_'))continue;scanned++;
   try{
    const sub=await loadSubscription(kv,key,skv);if(!sub||!sub.active)continue;
    const wl=await getWatchlist(kv,key);if(!wl.companies.length)continue;
    const alerts=[];
    await Promise.all(wl.companies.map(async entry=>{
     try{
      const data=await fetchJobs({platform:entry.platform_target==='auto'?'auto':entry.platform_target,handle:entry.company});
      const prev=await readPrev(kv,data.platform,data.handle);
      const changes=prev?diffJobs(prev.jobs,data.jobs):[];
      snapshotStore(kv,data.handle,data.platform,data.jobs);
      entry.lastChecked=new Date().toISOString();entry.lastChanges=changes.slice(0,100);
      if(changes.length)alerts.push({company:data.handle,changes:changes.slice(0,50),checkedAt:entry.lastChecked});
     }catch(e){entry.lastChecked=new Date().toISOString();}
    }));
    await kv.put(`watch-${key}`,JSON.stringify(wl));
    await dispatchHiringAlerts(wl,alerts);refreshed++;
   }catch(e){}
  }
  cursor=l.cursor;if(scanned>=500)break;
 }while(cursor);
 console.log('scheduled',scanned,refreshed);
}

// ---- MCP -------------------------------------------------------------------
const MCP_TOOLS = [
    { name: 'hiring_snapshot', description: 'FREE. Current job openings / who is hiring at one company right now, with teams (departments), locations, remote and employment type. Use for "what jobs is X hiring for", open roles, talent demand, headcount signals. Sources Greenhouse/Lever/Ashby. Target: gh:<h>, lever:<h>, ashby:<h> or bare company handle.',
      inputSchema: { type: 'object', properties: { company: { type: 'string' } }, required: ['company'] } },
    { name: 'hiring_changes', description: 'PAID ($0.05 USDC on Base via x402). Hiring change detection vs history: newly opened roles, roles removed/closed (layoff or hiring freeze signal), team and location changes. Use for "did X just start/stop hiring", new job postings, recruiting trends, expansion or downsizing alerts.',
      inputSchema: { type: 'object', properties: { company: { type: 'string' } }, required: ['company'] } },
    { name: 'hiring_intel_report', description: 'PAID ($0.50 USDC on Base via x402). Highest-value workforce-intelligence report: hiring growth rate, which teams are scaling, geographic footprint, headcount estimate and executive takeaways for investors/recruiters/sales. Use to gauge if a company is expanding, for account research, competitive talent analysis, sourcing priorities.',
      inputSchema: { type: 'object', properties: { company: { type: 'string' } }, required: ['company'] } },
    { name: 'hiring_batch_scan', description: 'PAID ($0.03 USDC per company via x402, max 50). Track hiring across a whole portfolio or target-account list in one call; per-company counts of new openings and closures. Use for recruitment agency monitoring, VC portfolio talent tracking, sales prospecting signals, sector hiring trends.',
      inputSchema: { type: 'object', properties: { companies: { type: 'array', items: { type: 'string' } } }, required: ['companies'] } },
    { name: 'hiring_landscape', description: 'PAID ($5 USDC on Base via x402, up to 10 companies). Strategic hiring landscape: ranks an anchor company against peers by hiring volume and growth, shows which competitor is scaling fastest, team/geography shifts and talent-war signals. Use for competitive intelligence, market mapping, employer benchmarking.',
      inputSchema: { type: 'object', properties: { companies: { type: 'array', items: { type: 'string' } }, anchor: { type: 'string' } }, required: ['companies'] } },
];

async function handleMcp(request, env) {
    if (request.method === 'GET') return json({ jsonrpc: '2.0', error: { code: -32000, message: 'POST expected' } }, 405);
    let msg;
    try { msg = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }
    const { id } = msg;
    const reply = (result) => json({ jsonrpc: '2.0', id, result });
    const rerr = (code, message) => json({ jsonrpc: '2.0', id, error: { code, message } });
    const ttext = (text, isError = false, extra = {}) => json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } }, 200, extra);

    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hiring-change-intelligence', version: '1.0.0' } });
    if (msg.method === 'tools/list') return reply({ tools: MCP_TOOLS });

    if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        const a = msg.params?.arguments || {};
        const kv = env.INTEL_KV;
        const payFor = (price, desc) => {
            const requirements = buildRequirements(new URL(request.url).href, price, desc);
            const paymentHeader = request.headers.get('PAYMENT') || request.headers.get('X-PAYMENT');
            if (!paymentHeader) return { need: ttext(JSON.stringify({ x402Version: 1, error: 'payment_required', accepts: [requirements] }), true, { 'PAYMENT-REQUIRED': b64encode(requirements) }) };
            return { requirements, paymentHeader };
        };

        if (name === 'hiring_snapshot') {
            const target = parseTarget(a.company);
            if (!target) return ttext('invalid company target', true);
            try {
                const data = await fetchJobs(target);
                snapshotStore(kv, data.handle, data.platform, data.jobs);
                return ttext(JSON.stringify({ company: data.handle, platform: data.platform, totalOpenings: data.jobs.length, byDepartment: groupCount(data.jobs, 'department').slice(0, 15), byLocation: groupCount(data.jobs, 'location').slice(0, 15) }, null, 2));
            } catch (e) { return ttext('error: ' + e.message, true); }
        }

        if (name === 'hiring_changes') {
            const target = parseTarget(a.company);
            if (!target) return ttext('invalid company target', true);
            const p = payFor(PRICE_CHANGES_USD, `Hiring changes for ${a.company}`);
            if (p.need) return p.need;
            let settlement;
            try { settlement = await verifyAndSettle(p.paymentHeader, p.requirements); } catch (e) { return ttext('verify error: ' + e.message, true); }
            if (!settlement.ok) return ttext('payment rejected: ' + settlement.reason, true);
            try {
                const data = await fetchJobs(target);
                const prev = await readPrev(kv, data.platform, data.handle);
                const changes = prev ? diffJobs(prev.jobs, data.jobs) : [];
                snapshotStore(kv, data.handle, data.platform, data.jobs);
                return ttext(JSON.stringify({ company: data.handle, baselineAt: prev?.savedAt || null, changeCount: changes.length, changes, settlement: { payer: settlement.payer, transaction: settlement.transaction } }, null, 2));
            } catch (e) { return ttext('error: ' + e.message, true); }
        }

        if (name === 'hiring_intel_report') {
            const target = parseTarget(a.company);
            if (!target) return ttext('invalid company target', true);
            const p = payFor(PRICE_INTEL_USD, `Hiring intel for ${a.company}`);
            if (p.need) return p.need;
            let settlement;
            try { settlement = await verifyAndSettle(p.paymentHeader, p.requirements); } catch (e) { return ttext('verify error: ' + e.message, true); }
            if (!settlement.ok) return ttext('payment rejected: ' + settlement.reason, true);
            try {
                const data = await fetchJobs(target);
                const prev = await readPrev(kv, data.platform, data.handle);
                const changes = prev ? diffJobs(prev.jobs, data.jobs) : [];
                snapshotStore(kv, data.handle, data.platform, data.jobs);
                const report = buildIntel(data.platform, data.handle, data.jobs, changes, new Date().toISOString());
                report.settlement = { payer: settlement.payer, transaction: settlement.transaction };
                return ttext(JSON.stringify(report, null, 2));
            } catch (e) { return ttext('error: ' + e.message, true); }
        }

        if (name === 'hiring_batch_scan') {
            const companies = [...new Set(a.companies || [])];
            if (!companies.length) return ttext('missing companies', true);
            if (companies.length > BATCH_MAX) return ttext(`max ${BATCH_MAX} companies`, true);
            const p = payFor(companies.length * PRICE_PER_COMPANY_USD, `Batch scan of ${companies.length}`);
            if (p.need) return p.need;
            let settlement;
            try { settlement = await verifyAndSettle(p.paymentHeader, p.requirements); } catch (e) { return ttext('verify error: ' + e.message, true); }
            if (!settlement.ok) return ttext('payment rejected: ' + settlement.reason, true);
            const results = await Promise.all(companies.map(async (c) => {
                const target = parseTarget(c);
                if (!target) return { company: c, error: 'invalid' };
                try {
                    const data = await fetchJobs(target);
                    const prev = await readPrev(kv, data.platform, data.handle);
                    snapshotStore(kv, data.handle, data.platform, data.jobs);
                    return { company: data.handle, platform: data.platform, openings: data.jobs.length, changeCount: prev ? diffJobs(prev.jobs, data.jobs).length : 0 };
                } catch (e) { return { company: c, error: e.message }; }
            }));
            return ttext(JSON.stringify({ results, settlement: { payer: settlement.payer } }, null, 2));
        }

        if (name === 'hiring_landscape') {
            const companies = [...new Set(a.companies || [])];
            if (!companies.length) return ttext('missing companies', true);
            if (companies.length > LANDSCAPE_MAX) return ttext(`max ${LANDSCAPE_MAX} companies`, true);
            const p = payFor(PRICE_LANDSCAPE_USD, `Hiring landscape of ${companies.length}`);
            if (p.need) return p.need;
            let settlement;
            try { settlement = await verifyAndSettle(p.paymentHeader, p.requirements); } catch (e) { return ttext('verify error: ' + e.message, true); }
            if (!settlement.ok) return ttext('payment rejected: ' + settlement.reason, true);
            const perCompany = await Promise.all(companies.map(async (c) => {
                const target = parseTarget(c);
                if (!target) return { handle: c, platform: '', jobs: [], prevCount: 0 };
                try {
                    const data = await fetchJobs(target);
                    const prev = await readPrev(kv, data.platform, data.handle);
                    snapshotStore(kv, data.handle, data.platform, data.jobs);
                    return { handle: data.handle, platform: data.platform, jobs: data.jobs, prevCount: prev ? prev.jobs.length : data.jobs.length };
                } catch (e) { return { handle: c, platform: '', jobs: [], prevCount: 0, error: e.message }; }
            }));
            return ttext(JSON.stringify(buildLandscape(perCompany.map(x => x.handle), perCompany, safeHandle(a.anchor), new Date().toISOString()), null, 2));
        }

        return rerr(-32601, `Unknown tool: ${name}`);
    }

    return rerr(-32601, `Method not found: ${msg.method}`);
}

// ---- Stats -----------------------------------------------------------------
async function handleStats(url, request, env) {
    const auth = request.headers.get('x-admin-key') || url.searchParams.get('key');
    if (auth !== ADMIN_KEY) return json({ error: 'forbidden' }, 403);
    const n = Math.min(Number(url.searchParams.get('days')) || 7, 30);
    const days = [];
    for (let i = 0; i < n; i++) {
        const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        const raw = await env.INTEL_KV.get(`stats-${d}`);
        if (raw) days.push({ day: d, ...JSON.parse(raw) });
    }
    return json({ days });
}

async function recordHit(request, response, env) {
    try {
        if (!env.INTEL_KV) return;
        const d = new Date().toISOString().slice(0, 10);
        const key = `stats-${d}`;
        const s = JSON.parse((await env.INTEL_KV.get(key)) || '{"hits":0,"c402":0,"clients":{}}');
        s.hits = (s.hits || 0) + 1;
        if (response.status === 402) s.c402 = (s.c402 || 0) + 1;
        const ua = (request.headers.get('user-agent') || 'unknown').slice(0, 60);
        s.clients[ua] = (s.clients[ua] || 0) + 1;
        await env.INTEL_KV.put(key, JSON.stringify(s));
    } catch {}
}

function withSecurity(response) {
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
}

// ---- Router ----------------------------------------------------------------
async function handle(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/') return new Response(renderHome(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/health') return json({ ok: true, time: new Date().toISOString() });
    if (pathname === '/mcp') return handleMcp(request, env);
    if (pathname === '/llms.txt') return new Response(LLMS_TXT, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (pathname === '/robots.txt') return new Response(ROBOTS_TXT, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (pathname === '/sitemap.xml') return new Response(SITEMAP_XML, { headers: { 'content-type': 'application/xml' } });
    if (pathname === '/.well-known/x402') return renderWellKnown();
    if (pathname === '/.well-known/glama.json') return renderGlama();

    if (pathname === '/pricing') return new Response(renderPricing(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/dashboard') return new Response(renderDashboard(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/privacy') return new Response(renderPrivacy(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/terms') return new Response(renderTerms(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/contact') return new Response(renderContact(), { headers: { 'content-type': 'text/html; charset=utf-8' } });

    if (pathname === '/v1/snapshot') return handleSnapshot(url, request, env);
    if (pathname === '/v1/lchanges') return handleChanges(url, request, env);
    if (pathname === '/v1/lintel') return handleIntel(url, request, env);
    if (pathname === '/v1/lbatch') return handleBatch(url, request, env);
    if (pathname === '/v1/llandscape') return handleLandscape(url, request, env);
    if (pathname === '/v1/lsubscribe') return handleSubscribe(url, request, env);
    if (pathname === '/v1/order') {
        const plan = PLANS[url.searchParams.get('plan')];
        if (!plan) return json({ error: 'invalid_plan', plans: Object.keys(PLANS) }, 400);
        return json(await createDirectOrder(plan, env.INTEL_KV));
    }
    if (pathname === '/v1/order/check') {
        const id = url.searchParams.get('id');
        const raw = id && env.INTEL_KV ? await env.INTEL_KV.get(`order-${id}`) : null;
        if (!raw) return json({ error: 'order_not_found' }, 404);
        return json(await checkDirectOrder(JSON.parse(raw), env.INTEL_KV, env.SHARED_KV));
    }
    if (pathname === '/v1/lwatch') return hWatchGet(url, request, env);
    if (pathname === '/v1/lwatch/add') return hWatchAdd(url, request, env);
    if (pathname === '/v1/lwatch/remove') return hWatchRemove(url, request, env);
    if (pathname === '/v1/lwatch/settings') return hWatchSettings(url, request, env);
    if (pathname === '/v1/lwatch/refresh') return hWatchRefresh(url, request, env);
    if (pathname === '/v1/admin/stats') return handleStats(url, request, env);

    return json({ error: 'not_found' }, 404);
}

export default {
    async fetch(request, env) {
        try {
            const response = withSecurity(await handle(request, env));
            if (request.method !== 'OPTIONS') recordHit(request, response, env);
            return response;
        } catch (err) {
            console.error('unhandled:', String(err?.message || err));
            return withSecurity(json({ error: 'internal_error' }, 500));
        }
    },
    async scheduled(event, env, ctx) {
        ctx.waitUntil(scheduledScan(env));
    },
};
