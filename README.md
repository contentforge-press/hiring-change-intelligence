# Hiring Change Intelligence

> Track which companies are hiring — and where the roles are. Hiring-growth signals for **investors, recruiters and sales teams**, delivered over HTTP and MCP, paid by AI agents in **USDC on Base** via **x402**.

Reads the public job boards that companies already publish (Greenhouse / Lever / Ashby). No cards, no signup, no processor.

**Endpoint (MCP, Streamable HTTP):** `https://hiring-intel.contentforge-press.workers.dev/mcp`

## Target syntax
- `gh:<handle>` — Greenhouse (alias `greenhouse:`)
- `lever:<handle>` — Lever
- `ashby:<handle>` — Ashby
- bare handle, e.g. `airbnb` — auto-detect across all three

Examples: `gh:airbnb`, `lever:spotify`, `ashby:ashby`.

## Tools & pricing
| Tool | Price | What it returns |
|---|---|---|
| `hiring_snapshot` | Free | Current openings: count, departments, locations |
| `hiring_changes` | $0.05 | Roles opened / closed vs history |
| `hiring_intel_report` | $0.50 | Hiring-growth report: focus teams, geography, takeaways |
| `hiring_batch_scan` | $0.03 / company | Scan up to 50 companies in one call |
| `hiring_landscape` | $5 | Hiring landscape across up to 10 companies |

## Subscriptions
Continuous monitoring from a dashboard, with alerts when roles open/close:
- **Pro $99/month** — 25 companies, alerts, weekly digest
- **Business $499/month** — 150 companies, 10 seats, landscape reports
- **Enterprise $2000/month** — unlimited, custom signals, SLA

See `/pricing`. Access keys are delivered instantly after USDC payment.

## HTTP examples
```bash
# free
curl "https://hiring-intel.contentforge-press.workers.dev/v1/snapshot?company=gh:airbnb"

# paid (returns 402 + PAYMENT-REQUIRED; an x402 agent settles USDC and retries)
curl "https://hiring-intel.contentforge-press.workers.dev/v1/lchanges?company=lever:spotify"
```

## Install via npx
```bash
npx hiring-change-intelligence
```

## Legal
[Privacy](https://hiring-intel.contentforge-press.workers.dev/privacy) · [Terms](https://hiring-intel.contentforge-press.workers.dev/terms) · [Contact](https://hiring-intel.contentforge-press.workers.dev/contact)

License: MIT.
