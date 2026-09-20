# Procurement Assistant over iMessage

*Hack the North 2026*

Approve, deny and review company purchase requests by texting, from anywhere.

> **Manager:** I'm boarding. Handle everything under $5k from vendors we already use. Don't touch AI purchases.
>
> **Assistant:** I found 15 pending requests.
> 4 routine requests match your instructions: Figma — $1,200, Adobe — $2,300, AWS — $3,800, Notion — $600.
> Seven things need your attention: six OpenAI requests total $5,560 · Datadog is $7,200, above your $5,000 limit · AcmeAI is a new vendor · …
> Want me to approve these 4? Reply yes to confirm or cancel to stop.
>
> **Manager:** 👍
>
> **Assistant:** Done — 3 requests were approved: Figma ($1,200), Adobe ($2,300), AWS ($3,800).
> I couldn't approve Notion's $600 request: Request is no longer awaiting approval.

## How it works

```
iMessage ──► Linq webhook ──► IncomingMessage ──► handleMessage()
                                                      │
                    Gemini: text → structured intent  │  (interprets only)
                    Rules engine: what qualifies      │  (deterministic TypeScript)
                    Spend check: vendor totals        │
                    Plan saved, user asked to confirm │
                                                      ▼
iMessage ◄── Linq send ◄──────────── reply text ◄── Zip executes (only after "yes")
```

**Gemini interprets. Our code validates and decides. Zip executes.**

- **Gemini** only turns a message into a small, validated intent (for example: bulk review, limit $5,000, existing vendors only, exclude "AI"). It never decides what gets approved, and its output is treated as untrusted.
- **The rules engine** applies the user's constraints deterministically. Missing data is never assumed: an unknown vendor status or category is flagged, not approved.
- **The spend check** flags vendors whose pending requests add up to more than $5,000, even when each request is small, and keeps them out of automatic approval.
- **Nothing is written to Zip without explicit confirmation** in a later message: "yes" or a 👍 tapback. "no" or 👎 cancels.
- **Replies report partial failures accurately.** If one approval fails, the assistant says which one and why.

## Tech stack

TypeScript (Node ≥ 20) · Express · Gemini API (structured JSON output, via `fetch`) · Linq iMessage API · Zip procurement API · Vitest

## Project structure

```
src/
  server.ts            Express app: /health and the Linq webhook route
  config/env.ts        Environment variables
  types/index.ts       Shared contracts between the three layers
  linq/                iMessage transport: webhooks, signatures, sending, tapbacks
  gemini/              Message → validated intent (plus an offline parser)
  orchestration/       handleMessage(): rules, spend check, plans, confirmation
  zip/                 Zip procurement integration
scripts/
  linq-webhook.ts      Turn the Linq webhook on/off for local testing
  send-alert.ts        Send a proactive message
docs/
  gemini-orchestration.md   Detailed design, testing guide and open issues for the AI layer
```

## Getting started

```bash
npm ci
cp .env.example .env     # then fill in the values below
npm run dev              # starts the server on PORT (default 3000)
```

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `GEMINI_API_KEY` | Gemini API key |
| `GEMINI_MODE` | `live` = real Gemini, `mock` = offline keyword parser (no API calls) |
| `GEMINI_MODEL` | Optional; default `gemini-3.5-flash-lite` (free tier: 20 requests/day per model) |
| `GEMINI_FALLBACK` | `on` (default): if Gemini fails, that message uses the offline parser |
| `LINQ_API_KEY` | Linq API key |
| `LINQ_BASE_URL` | `https://api.linqapp.com/api/partner/v3` |
| `LINQ_WEBHOOK_SECRET` | Signing secret from your Linq webhook subscription |
| `LINQ_WEBHOOK_SUBSCRIPTION_ID` | That subscription's id (used by `scripts/linq-webhook.ts`) |
| `LINQ_FROM_NUMBER` | Your Linq number, needed for proactive messages |
| `ZIP_API_KEY`, `ZIP_API_URL` | Zip API credentials |

Never commit `.env`; it's git-ignored.

### Try it from your phone
1. `npm run dev`
2. `ngrok http 3000`
3. `npx tsx scripts/linq-webhook.ts on`: points your Linq webhook at the tunnel and activates it.
4. Text your Linq number, for example:
   - "show me my pending purchases"
   - "handle everything under 5k from existing vendors, but don't touch AI"
   - "why did you flag OpenAI?"
5. When done: `npx tsx scripts/linq-webhook.ts off`.

See [`docs/gemini-orchestration.md`](docs/gemini-orchestration.md) for the full testing guide, example texts and troubleshooting.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

Tests never call the real Gemini or Zip APIs.

## Status

- **Working end to end over iMessage:** Linq integration, Gemini intent parsing, rules, spend detection and the confirmation flow.
- **Zip is connected:** confirmed approvals and denials are written back to Zip, and open-ended questions ("why does this need me?") are answered through Zip's MCP interface in read-only mode.

## Team

Built at Hack the North 2026 by a team of three:
- iMessage / Linq integration
- Zip procurement integration
- AI + orchestration layer
