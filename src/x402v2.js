// x402 v2 dual-protocol helper.
// Emits v2 PaymentRequired (PAYMENT-REQUIRED header, CAIP-2 network, atomic amounts)
// while keeping a v1 body for legacy clients. Accepts payment from either
// PAYMENT-SIGNATURE (v2) or PAYMENT / X-PAYMENT (v1) headers.

const b64url = (o) => {
    let s = btoa(JSON.stringify(o));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(atob(s));
};
// tolerate standard base64 too
const decodeToken = (s) => {
    s = s.trim();
    s = s.replace(/^Bearer\s+/i, '');
    try { return fromB64url(s); } catch {}
    try { return JSON.parse(atob(s)); } catch {}
    return null;
};

const USDC_DECIMALS = 6;

// Build one v2 PaymentRequired document for a resource.
// priceUsd decimal -> atomic units (1 USDC = 1e6)
export function buildV2Required({ resource, description, priceUsd, cfg }) {
    const network = cfg.NETWORK_V2 || 'eip155:8453';
    const amount = String(Math.round(priceUsd * (10 ** USDC_DECIMALS)));
    const accept = {
        scheme: 'exact',
        network,
        amount,
        asset: cfg.USDC_BASE,
        payTo: cfg.PAY_TO,
        maxTimeoutSeconds: cfg.MAX_TIMEOUT_SECONDS || 60,
    };
    return {
        x402Version: 2,
        error: 'payment_required',
        resource: {
            url: resource,
            description: description || '',
            mimeType: 'application/json',
        },
        accepts: [accept],
    };
}

// 402 response carrying BOTH protocols:
//  - v2 clients read the PAYMENT-REQUIRED header (base64url list)
//  - legacy clients read the v1 JSON body
export function paymentRequiredResponse({ resource, description, priceUsd, cfg, v1Requirements }) {
    const v2 = buildV2Required({ resource, description, priceUsd, cfg });
    const headers = {
        'PAYMENT-REQUIRED': b64url([v2.accepts[0]]),
        'X-PAYMENT-REQUIRED': b64url(v2),
        'content-type': 'application/json; charset=utf-8',
    };
    const body = { x402Version: 1, error: 'payment_required', accepts: v1Requirements ? [v1Requirements] : [], v2 };
    return new Response(JSON.stringify(body), { status: 402, headers });
}

function readPaymentHeader(request) {
    return request.headers.get('PAYMENT-SIGNATURE')
        || request.headers.get('PAYMENT')
        || request.headers.get('X-PAYMENT')
        || null;
}

async function postJson(url, body) {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    let j = null;
    try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, j };
}

// Verify + settle an incoming payment. Auto-detects v2 vs v1 wire format
// and routes to the matching facilitator.
export async function verifySettleDual({ request, resource, amount, priceUsd, cfg, v1Verify }) {
    const raw = readPaymentHeader(request);
    if (!raw) return { ok: false, reason: 'payment_required' };
    const payload = decodeToken(raw);

    // --- v2 path ---
    if (payload && (payload.x402Version === 2 || payload.scheme || payload.network)) {
        const fac = cfg.FACILITATOR_V2 || cfg.FACILITATOR;
        const atomic = String(Math.round(priceUsd * 1e6));
        const baseBody = {
            x402Version: 2, kind: 'exact',
            payment: payload, payload,
            resource, amount: atomic, network: payload.network || (cfg.NETWORK_V2 || 'eip155:8453'),
        };
        const v = await postJson(fac + '/verify', baseBody);
        const valid = v.j && (v.j.isValid === true || v.j?.verifyResponse?.isValid === true || v.j?.verifyResponse?.valid === true || v.j.valid === true);
        if (!v.ok || !valid) {
            const reason = (v.j && (v.j.invalidReason || v.j?.verifyResponse?.invalidReason)) || 'invalid_payment';
            return { ok: false, reason };
        }
        const s = await postJson(fac + '/settle', {
            ...baseBody,
            verifyResponse: v.j,
            paymentParameters: v.j.paymentParameters,
        });
        const success = s.j && (s.j.success === true || s.j?.settleResponse?.success === true);
        if (!s.ok || !success) return { ok: false, reason: 'settle_failed' };
        return { ok: true, version: 2, settlement: s.j.settleResponse || s.j, payer: payload?.payload?.from || null };
    }

    // --- v1 fallback ---
    if (typeof v1Verify === 'function') {
        return v1Verify(raw);
    }
    return { ok: false, reason: 'invalid_payment' };
}
