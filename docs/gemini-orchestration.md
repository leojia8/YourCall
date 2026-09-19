# Gemini + Orchestration Layer (Person 3)

---

# 🚨 DEMO DAY — READ THIS FIRST

## 1. The one real limit: Gemini free tier = **20 requests per day, per model**

- **Resets at midnight Pacific time** (3:00 AM Eastern). A demo at 8 AM starts with a full 20.
- **Each message you type costs 1 request.** A normal demo run is 4–6.
- **These cost NOTHING** (never call Gemini): `yes`, `no`, 👍, 👎, greetings ("hello"), "thanks", "help".
- **Default model:** `gemini-3.5-flash-lite` (~1 s). Set in `.env` as `GEMINI_MODEL`.
- **If you run out:** switch `GEMINI_MODEL` to another model (each has its own 20) and restart the server. Good choices: `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.1-flash-lite`. Avoid the big "thinking" models (e.g. `gemini-3.5-flash`): they can exceed the 10 s timeout.
- **Running out is NOT fatal.** The offline keyword parser answers instead, using no quota. Plain wording still works; very casual wording may get "I didn't quite understand that".

## 2. Before you start

1. `git pull` on branch `gemini` (it contains Linq + this layer).
2. In `.env`: `GEMINI_MODE=live` (or `mock` to use zero quota).
3. Terminal 1: `npm run dev` → wait for `Server listening on port 3000`.
4. Terminal 2: `ngrok http 3000`.
5. Terminal 3: `npx tsx scripts/linq-webhook.ts on` → expect `✓ server reachable` and `ON  https://…`.
6. Text the Linq number (the one in `.env` as `LINQ_FROM_NUMBER`).

## 3. During the demo — BE CAREFUL OF THESE

| ⚠️ | Why it matters |
|---|---|
| **Leave a few seconds between texts** | Fast bursts can trip the rate limit; that message then falls back to keywords |
| **NEVER save a code file while demoing** | `npm run dev` restarts, which wipes the waiting plan and resets the sample data mid-conversation |
| **Confirm with 👍 or "yes"** | Free, instant, and it's the moment that proves the human-approval design |
| **Say the whole request in one message** | The bot doesn't remember its own question: answering "Which request?" with just "datadog" won't work. Send "deny the Datadog request" |
| **👍 only counts on the bot's latest message** | A 👍 on an older message is ignored by Linq, so nothing happens |
| **The data is sample data** | Zip isn't connected yet. Notion's approval **always fails on purpose**, which demos partial-failure reporting |
| **Don't restart ngrok** unless you must | A new URL means rerunning `npx tsx scripts/linq-webhook.ts on` |

## 4. A demo script that works (5 Gemini calls)

1. `what's on my plate right now?` → 15 requests, $25,760, OpenAI flagged.
2. `I'm boarding. Handle everything under five grand from vendors we already use, but don't touch AI stuff` → 4 routine requests + 7 attention items + "Want me to approve these 4?"
3. `why did you flag OpenAI?` → six requests totalling $5,560 vs the $5,000 threshold; the plan is kept.
4. **👍** (free) → "Done — 3 requests were approved… I couldn't approve Notion's $600 request."
5. `kill the Datadog one` → "Datadog's request is $7,200. Deny it?"
6. **👎** (free) → "Cancelled. I didn't make any changes."

## 5. If something goes wrong

| Symptom | Do this |
|---|---|
| No reply at all | Check ngrok shows `POST /webhooks/linq`. If not: `npx tsx scripts/linq-webhook.ts on` |
| ngrok shows 401 | `LINQ_WEBHOOK_SECRET` doesn't match the subscription |
| "I didn't quite understand that" on a normal request | Quota or a hiccup: the terminal shows `Gemini failed …`. Wait ~10 s and resend, or rephrase plainly ("deny the Datadog request") |
| Terminal says `daily free-tier quota reached` | Switch `GEMINI_MODEL` and restart the server (§1) |
| Everything looks stuck | Restart the server. It clears waiting plans and resets the sample data — fine *between* runs, never mid-run |

## 6. After the demo

1. `npx tsx scripts/linq-webhook.ts off`
2. Set `GEMINI_MODE=mock` in `.env`
3. Ctrl+C the server and ngrok

---

Status as of 2026-09-19. Owner: Person 3.
- **Branch `gemini` is pushed and contains Linq.** `main` (with Linq, PR #1) was merged into `gemini` in `7b1e166`. The server now runs Linq and this layer together.
- **`main` itself still has Linq's placeholder `agent.ts`** until a PR from `gemini` to `main` is merged (L8).
- **Person 2's Zip service doesn't exist yet,** so **all purchase data is mock data** (§3).

> **Gemini interprets. Our code validates and decides. Zip executes.**
> Nothing is ever written to Zip unless a *later* message confirms a plan that our code built and saved.

---

## 1. Quick start

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run (329 tests: 205 ours + 124 Linq)
```

### Settings (`.env`)

| Setting | Effect |
|---|---|
| `GEMINI_MODE=mock` | Offline keyword parser (`src/gemini/intent.mock.ts`). **Zero API calls.** Use this for everyday testing. |
| `GEMINI_MODE=live` | Real Gemini via `GEMINI_API_KEY`. One API call per message, except a bare "yes"/"no" (typed or tapback) and greetings, thanks or "help", which cost none. |
| `GEMINI_MODEL=` | Optional. Default: **`gemini-3.5-flash-lite`** (about 1 s, correct in tests). **The free tier allows only 20 requests per day, per model** — see §6 *Model choice and quota*. |
| `GEMINI_FALLBACK=off` | Turns off the live-mode offline fallback (below). On by default. |

- **Local `.env`** (git-ignored, confirmed with `git check-ignore`): has the real key, `GEMINI_MODE=mock` and `GEMINI_MODEL=gemini-2.5-flash`. The key appears nowhere else in the repo.
- **`.env.example`** documents every variable with no secrets.
- **Tests never call Gemini,** whatever the mode: every test mocks it or forces the mode explicitly.

### Automatic fallback in live mode
With `GEMINI_MODE=live`, every message except a bare "yes"/"no" goes to Gemini first. The offline parser is used only when Gemini **fails**, and only for **that one message**:
- **Counts as a failure:** 503/429 after the retry, a timeout (10 s), a network error, or broken/invalid output.
- **Doesn't change the setting:** the next message tries Gemini again.
- **Gemini's own "unknown" is respected:** if Gemini works and says it doesn't understand, there's no fallback.
- **Just as safe:** the fallback's output goes through the same validation, and any action still needs a later "yes" or 👍.

> **Deviation from the original spec (approved by Person 3):** section 7 of the spec said a Gemini failure should become `UNKNOWN`. That is still the behaviour with `GEMINI_FALLBACK=off`.

---

## 2. Integration points

### Person 1 (Linq)

**The contract.** Linq's code (`src/linq/linq.routes.ts`, now on `main`) already calls exactly this:

```ts
import { handleMessage } from "../orchestration/agent";

const response = await handleMessage(incomingMessage); // IncomingMessage in
// response is a string that Linq sends back as an iMessage
```

- **Input:** `IncomingMessage { conversationId, sender, text }`.
- **Output:** `Promise<string>`. It **never rejects**; internal errors become a friendly reply.
- **Pending plans are stored per `conversationId`.** Linq uses the Linq chat ID, which stays the same for each chat.

**What Linq already handles** (read on 2026-09-19 from `main`, which includes Linq's latest commit `753c1e3`):
- `conversationId` is the Linq `chat.id`, and `sender` is the sender's phone number or email.
- The webhook is acknowledged immediately and processed afterwards. Duplicate deliveries are dropped by `webhook-id`.
- A typing bubble shows while `handleMessage` runs.
- `src/config/env.ts` loads `.env`.
- **A 👍 only counts on the bot's latest reply.** Linq ignores a 👍 on an older message, so it can never confirm a plan by accident. A 👎 counts on any bot message, which is safe because it only cancels.

**Tapbacks and bare "yes"/"no" (handled in our layer).** Linq turns a reaction on one of the bot's messages into a plain message:

| Tapback | Linq sends text | Our handling |
|---|---|---|
| 👍 like / ❤️ love (latest bot reply only) | `yes` | **CONFIRM**: runs the pending plan, or "nothing waiting" if there is none |
| 👎 dislike (any bot message) | `no` | **CANCEL**: clears the pending plan. It **never denies** anything, so it can't start a Zip write. |

- **Only an exact match counts:** the whole message must be `yes` or `no` (ignoring case and spaces). This check happens in `agent.ts` **before** the Zip read and Gemini, so it costs no API call.
- **Typing works the same way:** a typed "yes" or "no" behaves exactly like 👍 or 👎.
- **Everything else goes to Gemini:** "yeah do it", "never mind" and "yes approve the Figma request" are handled normally.
- **History:** Linq first sent `approve`/`reject`, then switched to `yes`/`no` in `753c1e3`. We now match `yes`/`no` only; a bare "approve" or "reject" is ordinary text for Gemini.

**Merging (done into `gemini`, `7b1e166`).** `main` was merged into `gemini` and the conflicts were resolved as below. Typecheck is clean and all 220 tests pass (ours plus Linq's).

A smoke test ran the real server against a fake local Linq API, with Gemini in mock mode:
- A signed "approve the Figma request" webhook got the reply "Figma's request is $1,200. Approve it?"
- A signed "yes" webhook got "Done — Figma's $1,200 request was approved."
- An unsigned webhook was rejected with 401.

**Remaining step:** open a PR from `gemini` to `main`. Conflicts that were resolved:

| File | Resolution |
|---|---|
| `src/orchestration/agent.ts` | `main` has Linq's placeholder that replies "hello back", with a note saying "PERSON 3: overwrite this whole file". **Keep ours.** |
| `.env.example` | Both branches added lines. **Keep both sets.** |

Nothing else overlaps: we never touched `server.ts`, `config/env.ts` or `src/linq/`.

### Person 2 (Zip): one swap file

All Zip access goes through **`src/orchestration/zip.client.ts`**:

```ts
export { getPendingRequests, getRequestById, executeAction } from "./mock.zip";
```

To go live, change `"./mock.zip"` to `"../zip/zip.service"`, renaming if their exports differ. **No schema changes are needed**, because both sides use the shared `PurchaseRequest`, `ProposedAction` and `ActionResult` types.

Where each function is called (all in `src/orchestration/agent.ts`):

| Function | When |
|---|---|
| `getPendingRequests()` | Once at the start of every message except a bare "yes"/"no", to give Gemini the real vendor and category names and to reuse the data. Retried once if it fails. |
| `getRequestById(id)` | Only for INVESTIGATE on a request ID that isn't in the pending list. |
| `executeAction(action)` | **Only** on CONFIRM ("yes", 👍 or another confirmation Gemini recognises), for each action in the saved plan, run in parallel with `Promise.allSettled`. A thrown error or rejected call becomes a failed `ActionResult`. |

The shared types in `src/types/index.ts` are **unchanged**. They were verified identical to the agreed contract.

---

## 3. Testing from a phone

Verified end to end on 2026-09-19, texting from an iPhone in both mock and live mode (§6, test 8).

### One-time setup (done for Person 3's own Linq account)
In `.env`, which is git-ignored:

| Variable | Where it comes from |
|---|---|
| `LINQ_API_KEY` | From your Linq representative |
| `LINQ_BASE_URL` | `https://api.linqapp.com/api/partner/v3` |
| `LINQ_FROM_NUMBER` | The number Linq assigned to the account, from `GET /phone_numbers`. **This is the number you text.** |
| `LINQ_WEBHOOK_SECRET`, `LINQ_WEBHOOK_SUBSCRIPTION_ID` | From `POST /webhook-subscriptions` with events `message.received` and `reaction.added`, filtered to that number. The secret is shown **only once**. |

You also need ngrok installed and logged in (`ngrok config add-authtoken <token>`).

### Start a session (three terminals, from the project folder)
1. **Pick the Gemini mode.** In `.env`: `GEMINI_MODE=mock` (free, offline keyword parser) or `GEMINI_MODE=live` (real Gemini).
2. **Terminal 1, the server:** `npm run dev`. Wait for `Server listening on port 3000`.
3. **Terminal 2, the tunnel:** `ngrok http 3000`.
4. **Terminal 3, switch the webhook on:** `npx tsx scripts/linq-webhook.ts on`.
   - It finds the ngrok URL by itself and checks the server is reachable through it.
   - It then points Linq at `<ngrok>/webhooks/linq` and activates the webhook.
   - It should print `✓ server reachable` and `ON  https://…/webhooks/linq`.
5. **Text the Linq number from your phone.**

**Switching mode mid-session:** change `GEMINI_MODE` in `.env`, then restart only the server (Ctrl+C, `npm run dev`). ngrok and the webhook can stay on. `npm run dev` does **not** reload by itself when `.env` changes. Restarting also resets the mock data and clears any waiting plan.

### Example texts
The mock data is the same in both modes, so the expected replies are too. Approvals change the mock data until the server restarts.

**Mock mode** (keyword parser, so wording matters):

| Text | Expected reply |
|---|---|
| `hello` | A greeting with example texts (no Gemini call, in either mode) |
| `show me my pending purchases` | 15 requests, $25,760; OpenAI flagged at $5,560 |
| `handle everything under 5k from existing vendors but don't touch AI` | 4 routine requests (Figma, Adobe, AWS, Notion) and 7 attention items, then "Want me to approve these 4?" |
| `why did you flag OpenAI?` | Explains the $5,560 total vs the $5,000 threshold; the waiting plan is kept |
| `yes` or 👍 on the **latest** reply | 3 approved; Notion fails on purpose ("no longer awaiting approval") |
| `deny the Datadog request` | "Datadog's request is $7,200. Deny it?" |
| `no` or 👎 | "Cancelled. I didn't make any changes." |
| `approve the OpenAI request` | Lists 6 request IDs: "I won't guess which one" |
| `approve openai_3` | "$940. Approve it?" plus a heads-up about the $5,560 total |

**Live mode** (real Gemini). A minimal quota-saving set of **5 Gemini calls**, worded casually to show understanding the keyword parser can't do:

| Text | Gemini calls |
|---|---|
| `what's on my plate right now?` | 1 |
| `I'm boarding. Handle everything under five grand from vendors we already use, but don't touch AI stuff` | 1 |
| `yes` | 0 |
| `hold on, what's the deal with OpenAI?` | 1 |
| `kill the Datadog one` | 1 |
| 👎 | 0 |
| `nah forget it, just show me what's left` | 1 |

**Quota:**
- **Free, never reach Gemini:** a bare `yes`/`no`, 👍/👎, and greetings, thanks or "help".
- **Everything else** costs one Gemini call (rarely two, if Google returns 503 and we retry).
- **If Gemini fails,** the `npm run dev` terminal prints `[intent.parser] Gemini failed (...); using offline parser for this message`. No such line means Gemini answered.

### What happens with texts it can't handle
Nothing crashes, and nothing is approved or denied without "yes" or 👍.

| Situation | Reply |
|---|---|
| Unrelated text ("monkey") | "I didn't quite understand that. You can ask me to…" A waiting plan is kept, and the reply reminds you of it. |
| `yes` with nothing waiting | "There's nothing waiting for confirmation." |
| Unknown vendor (`approve Salesforce`) | "I couldn't find a pending request from Salesforce." Then it lists real pending vendors. |
| No target (`approve`) | "Which request should I approve? Tell me the vendor or request ID." |
| Made-up ID (`approve req_99`) | "I couldn't find a pending request with ID req_99…" |
| Nothing qualifies (`handle everything under 100`) | Lists what needs attention; **no plan is set up** |
| 👍 on an **older** bot message | Ignored by Linq, so no reply (on purpose) |
| A bare vendor name replying to "Which request…?" | "Didn't understand": follow-up answers aren't supported (G11) |
| Internal error | "Sorry, something went wrong on my end. Please try again." |

**Offline parser scope** (mock mode, and the live fallback). Its vocabulary was widened on 2026-09-19 so a Gemini outage still leaves a usable bot:
- **Understood:** "kill / nuke / reject / turn down the X one"; "green light / sign off on / authorize X"; "take care of / deal with / knock out / triage / clear out" for bulk review; "what's on my plate", "catch me up", "the rundown", "how many are open" for the summary; "what's the deal with X", "look into X", "tell me about X" for questions; word amounts ("five grand", "two thousand"); leading filler ("hey can you…", "i want to…", "actually…").
- **Still not understood:** vendor-name typos ("datadlg"), and anything outside those keywords, which gives "I didn't quite understand that" (safe).
- **Safety rule:** a message naming a vendor or request ID is a command about *that* request, never a yes/no about a different saved plan. "ok approve figma" proposes approving Figma; it can't execute an unrelated waiting plan.
- **Deny never becomes bulk review:** "deny everything under 5k" asks which request, because a bulk plan proposes *approvals*.

### Stop a session, in this order
1. **Stop Linq sending:** `npx tsx scripts/linq-webhook.ts off` (check with `npx tsx scripts/linq-webhook.ts status`).
2. **Return to mock:** set `GEMINI_MODE=mock` in `.env`, so the next session doesn't use quota by accident.
3. **Stop the server:** Ctrl+C in the `npm run dev` terminal.
4. **Stop the tunnel:** Ctrl+C in the ngrok terminal.

Next time: `npm run dev`, then `ngrok http 3000`, then `npx tsx scripts/linq-webhook.ts on`. A new ngrok URL is picked up automatically.

### Troubleshooting
| Symptom | Cause / fix |
|---|---|
| ngrok shows no `POST /webhooks/linq` | The webhook is off or points at an old URL: run `… linq-webhook.ts on` |
| ngrok shows `401` | `LINQ_WEBHOOK_SECRET` doesn't match the subscription |
| `200` but no reply | Look for errors in the `npm run dev` terminal |
| `linq-webhook.ts on` says "ngrok isn't running" | Start `ngrok http 3000` first |

### Linq API quirks found
- Updating a subscription uses **PUT**; PATCH returns 405, despite the docs.
- `is_active:false` is ignored when creating a subscription.
- Each ngrok restart gives a new URL on the free plan; rerun `on`.

## 3b. Voice memos (branch `voice-input`)

A voice memo sent from iMessage is transcribed and acted on like a typed message.

**Flow:** Linq delivers a media part with `mime_type: audio/*` and a pre-signed URL → our layer downloads the clip → **one Gemini call** returns the transcript *and* the intent → the normal rules, plan and confirmation steps run unchanged. The reply starts with what was heard:

> 🎤 "approve the Figma request"
>
> Figma's request is $1,200. Approve it?

**Key points:**
- **Costs 1 Gemini request**, the same as a typed message. Transcript and intent come back together.
- **Voice needs Gemini.** The offline keyword parser can't hear, so if Gemini fails, the quota is gone or `GEMINI_MODE=mock`, the reply is: *"I couldn't make out that voice message. Could you send it as text instead?"* Nothing is executed and a waiting plan is left untouched.
- **Mock mode never spends quota on audio:** it asks for text instead of calling the API.
- **The transcript is echoed** so a mishearing is visible *before* the user confirms. A misheard clip can still only produce a proposal, never an action.
- **Other media is still ignored:** photos and files behave exactly as before.
- **Size limit:** clips over 8 MB are refused without downloading. A voice memo is far smaller.

**Shared contract change:** `IncomingMessage` gained an optional `audio?: { url, mimeType?, sizeBytes? }`. It is optional, so text messages and all existing code are unaffected — but it is a team contract, so tell Person 1 and Person 2 before merging.

**Files:** `src/gemini/voice.parser.ts` (prompt, schema, validation), `src/orchestration/voice.ts` (download + the seam), `src/gemini/intent.schema.ts` (intent rules/validator shared by both parsers), plus small changes in `linq.service.ts`, `gemini.service.ts`, `agent.ts` and `src/types/index.ts`.

**Swapping in a speech-to-text service later:** `src/orchestration/voice.ts` is the seam. Replace the `parseVoiceIntent` call with a provider (Whisper, Deepgram, AssemblyAI…) and feed the transcript to `parseIntent()`. Voice would then survive a Gemini outage, since the offline parser could handle the transcript. Estimated 1–2 hours.

**Not yet tested with real audio:** iMessage voice memos may arrive in a format Gemini rejects (`audio/amr`, `audio/x-caf`). If so, convert with ffmpeg before sending. This needs one live test with a real voice memo.

---

## 4. What was built

### Files created
| File | Purpose |
|---|---|
| `src/gemini/intent.mock.ts` | Offline keyword parser, used in mock mode and as the live fallback |
| `src/orchestration/format.ts` | Money formatting, currency-safe totals, name matching |
| `src/orchestration/mock.zip.ts` | **Temporary** mock Zip: 15 fixture requests plus in-memory execution |
| `src/orchestration/zip.client.ts` | The single file that picks mock or real Zip |
| `scripts/linq-webhook.ts` | Switches the Linq webhook `on` / `off` / `status` for phone testing (§3) |
| `tests/agent.test.ts`, `tests/anomaly.test.ts`, `tests/milestones.test.ts`, `tests/gemini.service.test.ts` | Tests |
| `docs/gemini-orchestration.md` | This document |

### Files filled in (they were empty stubs)
`src/gemini/{gemini.service,gemini.types,intent.parser}.ts`, `src/orchestration/{agent,rules,anomaly,conversation.store,orchestration.types}.ts`, `tests/{intent,rules}.test.ts`

### Other files touched
- `.env.example` gained the `GEMINI_MODE`, `GEMINI_MODEL`, `GEMINI_FALLBACK` and `LINQ_WEBHOOK_SUBSCRIPTION_ID` lines.
- `.env` was created locally and is git-ignored.

### Files intentionally NOT touched
`src/types/index.ts`, everything in `src/zip/` and `src/linq/`, `src/server.ts`, `src/config/env.ts`, `package.json`, `package-lock.json`.

### Module summary

**`src/gemini/`**
- `gemini.service.ts`: `generateJson(prompt, schema)` uses native `fetch` to call Gemini `generateContent`.
  - Temperature 0 and JSON-only output.
  - The key is sent in the `x-goog-api-key` header, never in the URL.
  - 10 s timeout.
  - **Retries once after 1 s on 503 (overloaded) or 429 (rate-limited)**; any other error is not retried.
  - Loads `.env` itself as a fallback.
- `intent.parser.ts`: `parseIntent(text, hints?)` converts a message to a validated `UserIntent` and never throws.
  - **Mock mode:** uses the offline parser.
  - **Live mode:** asks Gemini, and on failure uses the offline parser for that message (or returns UNKNOWN if `GEMINI_FALLBACK=off`).
  - **Schema:** every field is required but nullable, so Gemini has to decide on each condition instead of silently dropping it.
  - **Name hints:** the prompt includes the real vendor and category names from Zip, so Gemini can use Zip's exact spelling.
  - **Validation:** `validateIntent(raw)` treats all output as untrusted:
    - `intent` must be one of the 8 allowed values.
    - `maxAmount` must be a finite number ≥ 0.
    - Every other field must have the right type.
    - `null` or placeholder strings (`"none"`, `"N/A"`…) are treated as absent, and unknown keys are dropped.
    - Any wrong type makes the whole result UNKNOWN.
- `intent.mock.ts`: a predictable keyword parser. Its output goes through the same `validateIntent`.

**`src/orchestration/`**
- `rules.ts`:
  - `evaluateRequest`: deterministic checks, in order: amount, then vendor status, then category.
  - `buildBulkReviewPlan`: builds the ActionPlan.
  - `findVendorMatches`: exact vendor matching, trimmed and case-insensitive, never fuzzy.
- `anomaly.ts`: `detectAggregateSpend`, with `AGGREGATE_SPEND_THRESHOLD = 5000` and `AGGREGATE_MIN_REQUESTS = 2`.
- `conversation.store.ts`: a `Map<string, ConversationState>` plus a request snapshot per plan. `takePendingPlan` reads the plan and clears it in one synchronous step.
- `agent.ts`: `handleMessage` plus the bare "yes"/"no" shortcut, small talk (greetings, thanks, help), the per-intent flows and deterministic reply text.

### Behaviour per message

"Reads Zip" means one `getPendingRequests()` call at the start of the message, which also supplies Gemini's name hints.

| Message | Reads Zip | Writes Zip | Effect on the pending plan |
|---|---|---|---|
| Bare `yes` (typed, or 👍/❤️) | no | **yes**, runs the pending plan | taken and cleared *before* executing |
| Bare `no` (typed, or 👎) | no | never | cleared |
| Greeting / thanks / help (e.g. `hello`, `thank you`, `what can you do?`) | no | never | kept (reply reminds you it's waiting) |
| GET_PENDING | yes | never | kept (reply reminds you it's waiting) |
| INVESTIGATE | yes | never | kept |
| UNKNOWN | yes | never | kept |
| BULK_REVIEW | yes | never | **replaced only if** the new plan has ≥1 action; otherwise the old one stays |
| APPROVE / DENY | yes | never | **replaced only if** exactly one request matches |
| CONFIRM from Gemini (e.g. "yeah do it") | yes | **yes, only here and on bare "yes"** | taken and cleared *before* executing |
| CANCEL from Gemini (e.g. "never mind") | yes | never | cleared |

---

## 5. Decisions (approved 2026-09-19)

1. **Strict limits:** "Under $5k" means `amount < 5000`; a request of exactly $5,000 doesn't qualify.
2. **Missing data is never assumed.**
   - `existingVendor` undefined while "existing vendors only" is required: MISSING_DATA.
   - Category undefined when a category rule applies: MISSING_DATA.
3. **Categories and vendors match exactly** (trimmed, case-insensitive), with no synonyms. The Gemini name hints reduce mismatches. Confirmation messages show each item's category so the user can catch mistakes.
4. **Heavy vendor spend:** a vendor with **≥ 2** pending requests totaling **> $5,000** is flagged. Those requests are **removed** from any bulk approval. Flags are listed first so they survive the 8-line cutoff.
5. **Currencies are never added together.**
   - A vendor group in mixed currencies gets an OTHER flag and isn't approved.
   - With a limit and mixed currencies, requests outside the most common currency get an OTHER flag.
   - Requests with no currency count as the sandbox currency.
6. **Multiple matches are never guessed.** The reply lists request IDs with amounts, and the user answers with an ID.
7. **A request ID from Gemini** is used only if it appears in the live pending list.
8. **Double "yes" is harmless:** the plan is removed before any Zip call, so a repeat, a double 👍 or a webhook retry finds nothing.
9. **Explicitly approving one request from a flagged vendor** is allowed, with a "Heads up" line in the confirmation.
10. **Old plans are visible:** when an old plan is still waiting, every reply says so.
11. **A named vendor limits the review:** BULK_REVIEW with a vendor only considers that vendor.
12. **Plans are cleared after execution,** even on partial failure. ESCALATE is never produced.
13. **Similar reasons are merged:** identical attention reasons become one line with the request IDs combined.
14. **Offline fallback** when Gemini fails in live mode (§1). This is a deviation from the spec, approved.
15. **Bare "yes"/"no":** these arrive typed or as tapbacks (👍/❤️ means "yes", 👎 means "no"). They mean CONFIRM/CANCEL, skip Gemini, and "no" never denies anything (§2).
16. **Gemini settings:** default model `gemini-2.5-flash`, 10 s timeout, one retry on 503/429.
17. **Offline vocabulary is free to extend:** the fallback runs locally, so more synonyms cost nothing at runtime. Two safety rules hold it in place: deny words never fall through to bulk review (a bulk plan proposes approvals), and a message naming a vendor or request is always a command, never a yes/no.
18. **Small talk handled locally:** the shared `IntentType` has no greeting intent, and adding one would need team approval. So a message that is *only* a greeting, thanks or help request gets a fixed friendly reply with example texts, before Gemini is called: free, instant, and no contract change. "hi, show me pending" still goes to Gemini.

---

## 6. Live Gemini tests (2026-09-19)

**Tests 1–4:** the input was *"handle everything under 5k from existing vendors but don't touch AI"*.
Expected: `{"intent":"BULK_REVIEW","maxAmount":5000,"existingVendorsOnly":true,"excludedCategories":["AI"]}`

| # | Setup | Result | Latency |
|---|---|---|---|
| 1 | Original prompt, all fields optional (`gemini-flash-latest`) | `{"intent":"BULK_REVIEW","maxAmount":5000,"vendor":"none","requestId":"none"}`: invented placeholders and **missed 2 of 3 conditions** | ~11.7 s |
| 2 | Placeholder filtering + stronger prompt | **503 from Google** (model overloaded). Safely became UNKNOWN; nothing executed. | 0.7 s |
| 3 | Same as #2, plus retry once on 503/429 | `{"intent":"BULK_REVIEW","maxAmount":5000}`: no placeholders, but **still missed `existingVendorsOnly` and `excludedCategories`**. The plan would have proposed AcmeAI (new vendor) and Jasper (AI). | 2.8 s |
| 4 | Every field required + nullable, fixed field order | **Exact match.** The plan approves Figma, Adobe, AWS and Notion, identical to milestone 1. | 2.7 s |

**Tests 5–6:** a three-message conversation through `handleMessage`: *"approve the Figma request"*, then *"why did you flag OpenAI?"*, then *"yes"*. (In test 6 the "yes" went through Gemini; a bare "yes" now skips Gemini, §2.)

| # | Setup | Result | Latency |
|---|---|---|---|
| 5 | `gemini-flash-latest`, no fallback yet | **Google overloaded**: 503 + timeout on 2 of 3 calls. All failed safely (UNKNOWN, nothing executed); the retry recovered "yes". This led to adding the offline fallback and switching models. | 7–19 s |
| 6 | **`gemini-2.5-flash`**, fallback enabled | **All 3 answered by Gemini** (no fallback). The approve saved the plan and asked to confirm; the question explained the $5,560 total and kept the plan; "yes" executed it: "Done — Figma's $1,200 request was approved." | 1.5–1.8 s |

**Test 7:** the remaining untested cases, each run once as one conversation on `gemini-2.5-flash`, with the fallback enabled but never used.

| Message | Result | Latency |
|---|---|---|
| "handle everything under 5k from existing vendors but don't touch AI" | Correct bulk plan: approve Figma, Adobe, AWS and Notion; 7 attention items. Identical to milestone 1. | 1.9 s |
| "show me my pending purchases" | Correct summary: 15 requests, $25,760, OpenAI flagged. **The plan was kept** and the reply reminded the user of it. | 1.0 s |
| "deny the Datadog request" | "Datadog's request is $7,200. Deny it?" The new plan replaced the old one, and nothing executed. | 1.5 s |
| "never mind" | "Cancelled. I didn't make any changes." The plan was cleared and nothing executed. | 1.4 s |

**Confirmed live:**
- The key works on both models.
- A 503 fails safely.
- The required+nullable schema extracts all three bulk conditions (test 4).
- The full approve → investigate → confirm flow works (test 6).
- Bulk review on `gemini-2.5-flash`, GET_PENDING keeping the plan, DENY replacing it, and a typed CANCEL (test 7).
- **Every intent the bot uses has now worked live at least once.**

### Model choice and quota

**The free tier allows 20 `generateContent` requests per day, per model** (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, quotaValue 20), confirmed from Google's own 429 details on 2026-09-19. This is the single most important operational limit.

- **The cap is per model,** so switching `GEMINI_MODEL` gives a fresh 20 for the day.
- **Nothing breaks when it runs out:** the offline parser answers instead, and the terminal logs `daily free-tier quota reached for this model`. A daily 429 is not retried, since a retry would waste another call.
- **Free messages:** a bare "yes"/"no", 👍/👎, greetings, thanks and "help" never call Gemini.

**Models measured on the same demo sentence** ("…under five grand from vendors we already use, but don't touch AI stuff"):

| Model | Result | Speed | Notes |
|---|---|---|---|
| **`gemini-3.5-flash-lite`** | correct | **~1.0 s** | **Current default.** Quota untouched as of 2026-09-19. |
| `gemini-2.5-flash` | correct | 1.5–2.8 s | Previous default; **daily quota used up on 2026-09-19 by testing**. |
| `gemini-3.5-flash` | not returned in time | >10 s timeout | A "thinking" model: too slow for the 10 s limit, so it fell back. |
| `gemini-flash-latest` | correct | 2.7–11.7 s | Alias for the newest Flash; slower, and overloaded (503) twice. |

Other models the key can use include `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.1-flash-lite` and `gemini-2.5-pro`. **If a demo runs out of quota, set `GEMINI_MODEL` to another model and restart the server.** Prefer "lite" models: the bigger ones think longer and risk the 10 s timeout.

Older names such as `gemini-2.0-flash` and `gemini-2.5-flash-lite` now return 404: they have been retired.

**Test 10: full re-verification, 2026-09-19.** 23 scripted conversations in mock mode after the vocabulary expansion, plus targeted live checks.
- **23/23 mock scenarios correct** after one fix: "clear the queue under 5k" was being read as an approval, because "clear the" appeared in both the approve and bulk-review word lists. Approve is checked first, so bulk review never ran. The overlap is removed and a precedence test now guards it.
- **Live safety check (the important one):** with a saved plan to deny Datadog, the message "ok approve figma" was answered by Gemini as "Figma's request is $1,200. Approve it?". It did **not** execute the Datadog plan, and nothing was written. Both requests stayed pending.
- **The daily quota was hit during testing,** which is how the 20/day limit was discovered. Every affected message still got a sensible reply through the offline parser.

**Not yet tried live:** real Zip.

---

## 7. Open issues and placeholders

### Placeholders to remove or replace
| # | Placeholder | When |
|---|---|---|
| P1 | `src/orchestration/zip.client.ts` points at `./mock.zip` | When Person 2's service is ready (Z1) |
| P2 | `src/orchestration/mock.zip.ts`: 15 fake requests. **`req_9` (Notion) always fails on purpose** to demo partial failure. | Delete after P1, or keep only for tests |
| P3 | `.env` has `GEMINI_MODE=mock` | Switch to `live` for the real demo |
| P4 | ~~`.env` has no Linq values yet~~ **Done** for Person 3's own Linq account (§3). | — |
| P5 | `main` still has Linq's placeholder `agent.ts` ("hello back"). `gemini` has the real one. | Replaced when the `gemini` → `main` PR is merged (L8) |

### Person 3 (me) before the demo
| # | Item |
|---|---|
| G1 | ~~Try the untested phrasings live~~ **Resolved** by live test 7 (§6): every intent has now worked live on `gemini-2.5-flash`. |
| G2 | **Latency:** `gemini-2.5-flash` took 1.5–1.8 s; `gemini-flash-latest` took 2.7–11.7 s and was overloaded once. Google can still be overloaded during the demo; the fallback covers that, but the reply can then take ~12 s. |
| G3 | **Rotate the Gemini key** after the hackathon. It was pasted into a chat session. |
| G4 | **State is in memory only:** a server restart (including `npm run dev` reloading after an edit) wipes pending plans and resets mock data. Don't edit code during a demo conversation. |
| G5 | Every message except a bare "yes"/"no" makes one Zip read *before* Gemini, even "never mind" or "yeah do it". This small latency cost buys the name hints. With real Zip, a slow Zip slows every reply. |
| G6 | Plans never expire, and Zip isn't re-checked right before execution. A stale plan could run on changed data, and Zip would then return failures, which are reported accurately. |
| G7 | "Approve all the OpenAI ones" can't be expressed: the shared `UserIntent` has no "all" field. Single approve/deny requires exactly one match, and a bulk review of OpenAI is blocked by the vendor-spend flag. |
| G8 | **Offline parser limits** (mock mode and live fallback). Its vocabulary is now wide (§3): casual verbs, word amounts and leading filler all parse. It is still keyword-based, so vendor-name typos and unusual phrasings return UNKNOWN (safe), and a missed condition would produce a **broader** bulk plan than intended. The confirmation list, showing vendor, amount and category, is the backstop, and nothing runs without "yes" or 👍. |
| G9 | Spec required-test #18 ("malformed Gemini output becomes UNKNOWN") now holds only with `GEMINI_FALLBACK=off`. By default, malformed output goes to the offline parser (decision 14). Both behaviours are tested. |
| G10 | **Model retirement:** `gemini-2.5-flash` is a June 2025 release. If Google retires it, the bot falls back to the offline parser until `GEMINI_MODEL` is changed (§6 *Model choice*). |
| G11 | **No follow-up answers.** Each message is read on its own, so answering "Which request should I deny?" with just "datadog" gets "didn't understand"; the user must resend "deny datadog". Fixing it would mean remembering the half-finished request per conversation. Not needed for the demo, just phrase requests in full. |
| G12 | **Gemini free tier: 20 requests per day, per model** (§6). Testing used up `gemini-2.5-flash` on 2026-09-19; the default is now `gemini-3.5-flash-lite`, which has its own fresh 20. **Before the demo, check how many calls are left**, and know the fallback model to switch to. Running out is not fatal: the offline parser answers instead. |

### To settle with Person 2 (Zip)
| # | Question | Why it matters |
|---|---|---|
| Z1 | **Final export names/signatures** in `src/zip/zip.service.ts` (assumed `getPendingRequests`, `getRequestById`, `executeAction`) | The one-line swap in `zip.client.ts` |
| Z2 | Does `getPendingRequests()` return **only** requests that can be approved or denied? | We don't filter on the `status` text |
| Z3 | Zip's real **category names** (is it "AI"? "Artificial Intelligence"? "Software/AI"?) | Exact matching; a synonym could let an AI request be proposed (the confirmation step is the backstop) |
| Z4 | Zip's real **vendor names** ("Figma" vs "Figma, Inc.") | "approve Figma" finds nothing if the name differs |
| Z5 | Are `existingVendor`, `category` and `currency` actually filled in by the mapper? | Missing values become MISSING_DATA, so sparse data means nothing gets approved |
| Z6 | Request ID format | Long UUIDs make "reply with the request ID" clunky in iMessage |
| Z7 | Does `executeAction` throw, or return `success:false`? Are error strings user-readable? | Both are handled; the error text is shown to the user as-is |
| Z8 | Does Zip require a **reason to deny**? | `ProposedAction` has no field for one, so that would need **team approval to change the contract** |
| Z9 | Sandbox currency | Amounts with no currency or USD display as `$` |
| Z10 | Is ESCALATE used at all? | We never produce it |
| Z11 | How fast is `getPendingRequests()`? | It runs on every typed message (G5) |

### To settle with Person 1 (Linq)
| # | Item | Status |
|---|---|---|
| L1 | Stable `conversationId` per chat | **Resolved:** it's the Linq `chat.id` |
| L2 | Who loads `.env` | **Resolved:** `src/config/env.ts` (`dotenv/config`) |
| L3 | Webhook retries and duplicates | **Resolved:** Linq acknowledges immediately and drops duplicate `webhook-id`s; a double "yes" or 👍 is also safe on our side |
| L4 | **Group chats are unsupported:** there's no per-sender permission check, so anyone in a group chat could confirm or 👍 | Open; fine for a 1:1 demo |
| L5 | Reply length: bulk-review replies can be ~15 lines | Open: check it looks OK in iMessage |
| L6 | **Where the webhook points:** only one server receives Linq webhooks. Agree whose machine or tunnel hosts the merged app for phone testing and the demo. | Open |
| L7 | A 👍 on an old bot message could confirm the plan pending *now* | **Resolved** by Linq `753c1e3`: a 👍 only counts on the bot's latest reply. A 👎 on any bot message still cancels, which is safe. |
| L8 | Merge Linq with our layer | **Merged into `gemini`** (`7b1e166`): 220 tests pass and the smoke test works. **Still open:** PR `gemini` to `main`. |
| L9 | Tapback words: we match Linq's current `yes`/`no`. If Linq changes them again, `TAPBACK_INTENTS` in `agent.ts` must change too. Otherwise tapbacks still work through Gemini, but cost an API call each. | Agreed words: keep in sync |

### Deferred by the spec (unchanged; revisit only if they become blockers)
- Time window for vendor-spend detection.
- Richer vendor and category normalization.
- Compound language ("exclude only NEW AI vendors").
- Whether `ActionResult` should carry vendor and amount context.
- Re-fetching from Zip before executing.

---

## 8. Test coverage (205 of ours + 124 Linq = 329, all passing)

**All 21 required cases:**
1. qualify below the limit
2. over the limit
3. new vendor
4. unknown vendor status
5. excluded category
6. missing category
7. vendor-spend flag detected
8. flagged requests aren't proposed
9. CANCEL clears the plan
10. CONFIRM with no plan does nothing
11. APPROVE waits for confirmation
12. DENY waits for confirmation
13. CONFIRM executes the saved action
14. partial failures summarized
15. GET_PENDING makes no writes
16. GET_PENDING keeps the plan
17. a valid new plan replaces the old one
18. malformed Gemini output becomes UNKNOWN (with the fallback off; see G9)
19. multiple matches aren't guessed
20. no match means no execution
21. mixed currencies aren't combined

**Plus:**
- Both spec milestones end to end against the mock Zip.
- Concurrent double confirmation.
- A made-up request ID is rejected.
- A failed Zip read.
- `handleMessage` never throws.
- A thrown `executeAction` error is reported as a failure.
- Placeholder-string handling, using the real live output.
- The offline parser phrases.
- The mock/live mode switch.
- Gemini retry: one retry on 503/429, no retry otherwise, and the key sent in a header rather than the URL.
- The required+nullable output shape.
- The offline fallback: on Gemini error, on malformed output and on an invalid shape; a genuine UNKNOWN is respected; the next message retries Gemini; `GEMINI_FALLBACK=off` restores UNKNOWN.
- **Bare "yes"/"no" (typed or tapback):**
  - "yes" confirms without Gemini.
  - "no" cancels without Gemini and never writes to Zip.
  - "yes" with nothing pending does nothing.
  - "no" on a pending DENY cancels it rather than denying.
  - The old `approve`/`reject` words go to Gemini like any text.
  - Longer messages still go to Gemini.
  - Words like "constructor" aren't mistaken for tapbacks.
  - Spec milestone 2's literal "yes" now skips Gemini.
- **Offline parser vocabulary:** deny/approve/bulk/summary/question synonyms, word amounts, leading filler, longer cancels, and the safety rules (a named vendor is a command, not a yes/no; "deny everything" never becomes a bulk approval).
- **Small talk:** greetings get examples without Gemini or Zip; thanks and help replies; a greeting keeps the waiting plan; "hi, show me my pending purchases" still goes to Gemini.
