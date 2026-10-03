# 🧑‍💼 Hiring Change Intelligence

![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-7c3aed)
![x402](https://img.shields.io/badge/x402-v1%20%2B%20v2-6938ef)
![USDC](https://img.shields.io/badge/settle-USDC%20on%20Base-1f6feb)
![price](https://img.shields.io/badge/from-%240.05%2Fcall-2ea043)

Track which companies are hiring — and where the roles are — from the job boards they already publish.

Agents pay **peer-to-peer in USDC on Base** using the native **x402** protocol — no platform account, no payment processor, **0% commission**. You can also use a monthly key. One key works across the [whole Change Intelligence family](https://pixharvest.com).

- **Hosted service:** https://s-hiring.pixharvest.com
- **MCP endpoint:** `https://s-hiring.pixharvest.com/mcp`
- **Official MCP Registry:** `io.github.contentforge-press/hiring-intel`
- **npm:** [`hiring-change-intelligence`](https://www.npmjs.com/package/hiring-change-intelligence)

## Try it now

Open a **free, no-key snapshot**: https://s-hiring.pixharvest.com/v1/snapshot?company=airbnb

Target format: `?company=airbnb` or a board handle like `?company=gh:airbnb` (Greenhouse / Lever / Ashby)

## Tools

| Tool | Price | Returns |
|---|---|---|
| `hiring_snapshot` | Free | Open roles, teams, locations and remote count for one company |
| `hiring_changes` | $0.05 | New / removed roles and team shifts since last fetch |
| `hiring_intel_report` | $0.50 | Hiring-growth summary by team and location |
| `hiring_batch_scan` | $0.03 / company | Scan up to 50 companies |
| `hiring_landscape` | $5 | Rank up to 10 companies on hiring momentum |

## One-call install for MCP clients

The npm wrapper prints ready-to-paste MCP config:

```bash
npx -y hiring-change-intelligence
```

Or Add the remote server manually to any MCP client (Claude Desktop, Cursor, Windsurf, …):

```json
{
  "mcpServers": {
    "hiring-intel": {
      "url": "https://s-hiring.pixharvest.com/mcp"
    }
  }
}
```

Anonymous `initialize` / `tools/list` are free; paid tool calls return an `x402` challenge.

## Pay-per-call (x402)

Call a paid route without payment and you receive `402 Payment Required` with a machine-readable `PAYMENT-REQUIRED` header (x402 v2) plus a v1 JSON body. The agent signs a USDC authorization, retries with the payment header, and the request settles on Base.

## Monthly plans

Same four tiers on every product — the same access key unlocks all five feeds:

| Hobby | Pro | Business | Enterprise |
|---|---|---|---|
| $9/mo | $99/mo | $499/mo | $2000/mo |

> 💳 **Card (auto-billed, no crypto):** Standard **$19/mo** · Pro **$79/mo** · Business **$199/mo** · Enterprise **$499/mo** — billed via Dodo, checkout links at [pixharvest.com/pricing](https://pixharvest.com/pricing).
> ⛓️ **USDC (x402, peer-to-peer):** Standard $9/mo · Pro $99/mo · Business $499/mo · Enterprise $2000/mo — paid in USDC on Base, 0% commission.

One plan unlocks one access key for all five feeds; your key works across Shopify, GitHub, App Store, Hiring and HN.

Get a key from the [pricing page](https://s-hiring.pixharvest.com/pricing), then pass it as `?key=...` on any call.

## HTTP quick start

```bash
# free snapshot
curl "https://s-hiring.pixharvest.com/v1/snapshot?company=REPLACE_TARGET"

# paid call — returns 402 with the x402 challenge
curl -i "https://s-hiring.pixharvest.com/v1/changes?company=REPLACE_TARGET"
```

## Links

- Company hub: https://pixharvest.com
- GitHub: https://github.com/contentforge-press
- Contact: contentforge.press@outlook.com

## License

MIT — self-host, modify and run it yourself. The hosted service and its data are provided as-is.
