# Gemini + Orchestration Layer (Person 3)

Status as of 2026-09-19. Owner: Person 3.
- Branch `gemini`: the main work is committed and pushed in `6ceff34`. The Linq tapback handling (§2) and this doc update are **not committed yet**.
- **Not yet merged with `linq`**, and Person 2's Zip service doesn't exist yet: **all purchase data is mock data** (§6).

> **Gemini interprets. Our code validates and decides. Zip executes.**
> Nothing is ever written to Zip unless a *later* message confirms a plan that our code built and saved.

---

## 1. Quick start

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run (99 tests)
```

### Settings (`.env`)

| Setting | Effect |
|---|---|
| `GEMINI_MODE=mock` | Offline keyword parser (`src/gemini/intent.mock.ts`). **Zero API calls.** Use this for everyday testing. |
| `GEMINI_MODE=live` | Real Gemini via `GEMINI_API_KEY`. One API call per typed message. Tapbacks cost none. |
| `GEMINI_MODEL=` | Optional. Default: **`gemini-2.5-flash`**, the fastest and most reliable in live tests. |
| `GEMINI_FALLBACK=off` | Turns off the live-mode offline fallback (below). On by default. |

- **Local `.env`** (git-ignored, confirmed with `git check-ignore`): has the real key, `GEMINI_MODE=mock` and `GEMINI_MODEL=gemini-2.5-flash`. The key appears nowhere else in the repo.
- **`.env.example`** documents every variable with no secrets.
- **Tests never call Gemini,** whatever the mode: every test mocks it or forces the mode explicitly.

### Automatic fallback in live mode
With `GEMINI_MODE=live`, every typed message goes to Gemini first. The offline parser is used only when Gemini **fails**, and only for **that one message**:
- **Counts as a failure:** 503/429 after the retry, a timeout (10 s), a network error, or broken/invalid output.
- **Doesn't change the setting:** the next message tries Gemini again.
- **Gemini's own "unknown" is respected:** if Gemini works and says it doesn't understand, there's no fallback.
- **Just as safe:** the fallback's output goes through the same validation, and any action still needs a later "yes" or 👍.

> **Deviation from the original spec (approved by Person 3):** section 7 of the spec said a Gemini failure should become `UNKNOWN`. That is still the behaviour with `GEMINI_FALLBACK=off`.

---

## 2. Integration points

### Person 1 (Linq)

**The contract.** Linq's code (`src/linq/linq.routes.ts` on branch `origin/linq`) already calls exactly this:

```ts
import { handleMessage } from "../orchestration/agent";

const response = await handleMessage(incomingMessage); // IncomingMessage in
// response is a string that Linq sends back as an iMessage
```

- **Input:** `IncomingMessage { conversationId, sender, text }`.
- **Output:** `Promise<string>`. It **never rejects**; internal errors become a friendly reply.
- **Pending plans are stored per `conversationId`.** Linq uses the Linq chat ID, which stays the same for each chat.

**What the Linq branch already handles** (read on 2026-09-19, commit `96cdf98`):
- `conversationId` is the Linq `chat.id`, and `sender` is the sender's phone number or email.
- The webhook is acknowledged immediately and processed afterwards. Duplicate deliveries are dropped by `webhook-id`.
- A typing bubble shows while `handleMessage` runs.
- `src/config/env.ts` loads `.env`.

**Tapbacks (added in our layer).** Linq turns a reaction on one of the bot's messages into a plain message:

| Tapback | Linq sends text | Our handling |
|---|---|---|
| 👍 like / ❤️ love | `approve` | **CONFIRM**: runs the pending plan, or "nothing waiting" if there is none |
| 👎 dislike | `reject` | **CANCEL**: clears the pending plan. It **never denies** anything, so a tapback can't start a Zip write by itself. |

- **Only an exact match counts:** the whole message must be `approve` or `reject` (ignoring case and spaces). This check happens in `agent.ts` **before** Gemini, so it costs no API call.
- **Longer messages still go to Gemini:** "approve the Figma request" is handled normally.
- **Typed words count too:** Linq sends tapbacks as plain text, so typing the single word "approve" behaves exactly like a 👍.

**How to merge with `linq` (not done yet).** Two files conflict:

| File | Resolution |
|---|---|
| `src/orchestration/agent.ts` | Linq's version is a placeholder that replies "hello back", with a note saying "PERSON 3: overwrite this whole file". **Keep ours.** |
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
| `getPendingRequests()` | Once at the start of every **typed** message (not tapbacks), to give Gemini the real vendor and category names and to reuse the data. Retried once if it fails. |
| `getRequestById(id)` | Only for INVESTIGATE on a request ID that isn't in the pending list. |
| `executeAction(action)` | **Only** on CONFIRM (typed "yes" or 👍), for each action in the saved plan, run in parallel with `Promise.allSettled`. A thrown error or rejected call becomes a failed `ActionResult`. |

The shared types in `src/types/index.ts` are **unchanged**. They were verified identical to the agreed contract.

---

## 3. Testing from a phone (after the Linq merge)

You text the Linq number and get the bot's replies in iMessage. What's needed:

1. **Merge `linq`** as described in §2.
2. **Fill in `.env`** with Person 1's values: `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET` and `LINQ_BASE_URL`. `LINQ_FROM_NUMBER` is only needed if the bot sends the first message.
3. **Start the server:** `npm run dev`. It serves `POST /webhooks/linq` on `PORT` (default 3000).
4. **Make it reachable from the internet:** open a tunnel (ngrok or cloudflared) to port 3000.
5. **Point Linq at it:** the Linq webhook subscription must target `https://<tunnel>/webhooks/linq`. Person 1 has likely pointed it at *their* machine, so either run the merged code there or re-point it at yours (see L6).
6. **Choose the Gemini mode:** set `GEMINI_MODE=live` to test real Gemini, or `mock` to save quota.

**What you'll see:**
- **Fake data:** the 15 mock requests. Approvals only change that in-memory list, not Zip.
- **Resets on restart:** restarting the server (including `npm run dev` reloading after a file change) wipes all pending plans and resets the mock data.

---

## 4. What was built

### Files created
| File | Purpose |
|---|---|
| `src/gemini/intent.mock.ts` | Offline keyword parser, used in mock mode and as the live fallback |
| `src/orchestration/format.ts` | Money formatting, currency-safe totals, name matching |
| `src/orchestration/mock.zip.ts` | **Temporary** mock Zip: 15 fixture requests plus in-memory execution |
| `src/orchestration/zip.client.ts` | The single file that picks mock or real Zip |
| `tests/agent.test.ts`, `tests/anomaly.test.ts`, `tests/milestones.test.ts`, `tests/gemini.service.test.ts` | Tests |
| `docs/gemini-orchestration.md` | This document |

### Files filled in (they were empty stubs)
`src/gemini/{gemini.service,gemini.types,intent.parser}.ts`, `src/orchestration/{agent,rules,anomaly,conversation.store,orchestration.types}.ts`, `tests/{intent,rules}.test.ts`

### Other files touched
- `.env.example` gained the `GEMINI_MODE`, `GEMINI_MODEL` and `GEMINI_FALLBACK` lines.
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
- `agent.ts`: `handleMessage` plus tapback handling, the per-intent flows and deterministic reply text.

### Behaviour per message

"Reads Zip" means one `getPendingRequests()` call at the start of the message, which also supplies Gemini's name hints.

| Message | Reads Zip | Writes Zip | Effect on the pending plan |
|---|---|---|---|
| Tapback `approve` (👍/❤️) | no | **yes**, runs the pending plan | taken and cleared *before* executing |
| Tapback `reject` (👎) | no | never | cleared |
| GET_PENDING | yes | never | kept (reply reminds you it's waiting) |
| INVESTIGATE | yes | never | kept |
| UNKNOWN | yes | never | kept |
| BULK_REVIEW | yes | never | **replaced only if** the new plan has ≥1 action; otherwise the old one stays |
| APPROVE / DENY | yes | never | **replaced only if** exactly one request matches |
| CONFIRM (typed) | yes | **yes, only here and on 👍** | taken and cleared *before* executing |
| CANCEL (typed) | yes | never | cleared |

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
15. **Tapbacks:** 👍/❤️ means CONFIRM and 👎 means CANCEL. They skip Gemini, and 👎 never denies anything (§2).
16. **Gemini settings:** default model `gemini-2.5-flash`, 10 s timeout, one retry on 503/429.

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

**Tests 5–6:** a three-message conversation through `handleMessage`: *"approve the Figma request"*, then *"why did you flag OpenAI?"*, then *"yes"*.

| # | Setup | Result | Latency |
|---|---|---|---|
| 5 | `gemini-flash-latest`, no fallback yet | **Google overloaded**: 503 + timeout on 2 of 3 calls. All failed safely (UNKNOWN, nothing executed); the retry recovered "yes". This led to adding the offline fallback and switching models. | 7–19 s |
| 6 | **`gemini-2.5-flash`**, fallback enabled | **All 3 answered by Gemini** (no fallback). The approve saved the plan and asked to confirm; the question explained the $5,560 total and kept the plan; "yes" executed it: "Done — Figma's $1,200 request was approved." | 1.5–1.8 s |

**Confirmed live:**
- The key works on both models.
- A 503 fails safely.
- The required+nullable schema extracts all three bulk conditions (test 4).
- The full approve → investigate → confirm flow works (test 6).

**Not yet tried live:**
- DENY, GET_PENDING and a typed CANCEL.
- The bulk-review sentence on `gemini-2.5-flash` (test 4 used `gemini-flash-latest`).
- Anything through real Linq or real Zip.

---

## 7. Open issues and placeholders

### Placeholders to remove or replace
| # | Placeholder | When |
|---|---|---|
| P1 | `src/orchestration/zip.client.ts` points at `./mock.zip` | When Person 2's service is ready (Z1) |
| P2 | `src/orchestration/mock.zip.ts`: 15 fake requests. **`req_9` (Notion) always fails on purpose** to demo partial failure. | Delete after P1, or keep only for tests |
| P3 | `.env` has `GEMINI_MODE=mock` | Switch to `live` for the real demo |
| P4 | `.env` has no Linq values yet | Before phone testing (§3) |

### Person 3 (me) before the demo
| # | Item |
|---|---|
| G1 | Try the untested phrasings live once (DENY, GET_PENDING, typed CANCEL, bulk review on `gemini-2.5-flash`). See §6. |
| G2 | **Latency:** `gemini-2.5-flash` took 1.5–1.8 s; `gemini-flash-latest` took 2.7–11.7 s and was overloaded once. Google can still be overloaded during the demo; the fallback covers that, but the reply can then take ~12 s. |
| G3 | **Rotate the Gemini key** after the hackathon. It was pasted into a chat session. |
| G4 | **State is in memory only:** a server restart (including `npm run dev` reloading after an edit) wipes pending plans and resets mock data. Don't edit code during a demo conversation. |
| G5 | Every typed message makes one Zip read *before* Gemini, even "yes" and "cancel". This small latency cost buys the name hints. With real Zip, a slow Zip slows every reply. |
| G6 | Plans never expire, and Zip isn't re-checked right before execution. A stale plan could run on changed data, and Zip would then return failures, which are reported accurately. |
| G7 | "Approve all the OpenAI ones" can't be expressed: the shared `UserIntent` has no "all" field. Single approve/deny requires exactly one match, and a bulk review of OpenAI is blocked by the vendor-spend flag. |
| G8 | **Offline parser limits** (mock mode and live fallback). It's a keyword parser: "five grand" doesn't parse ("5k" does), and it can miss a condition phrased unusually. That would produce a **broader** bulk plan than intended. The confirmation list, showing vendor, amount and category, is the backstop, and nothing runs without "yes" or 👍. |
| G9 | Spec required-test #18 ("malformed Gemini output becomes UNKNOWN") now holds only with `GEMINI_FALLBACK=off`. By default, malformed output goes to the offline parser (decision 14). Both behaviours are tested. |

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
| L7 | **A tapback on ANY earlier bot message counts.** Linq checks only that the reaction is on one of *our* messages, not the latest. So a 👍 on an old message confirms whatever plan is pending *now*. Every reply while a plan is waiting says so, which limits confusion. A stricter option is for Linq to forward only reactions on the bot's most recent message. | Open, low risk: decide with Person 1 |
| L8 | Merge `linq` into our branch (or both into `main`), resolving `agent.ts` (keep ours) and `.env.example` (keep both). See §2. | Open: not done yet |

### Deferred by the spec (unchanged; revisit only if they become blockers)
- Time window for vendor-spend detection.
- Richer vendor and category normalization.
- Compound language ("exclude only NEW AI vendors").
- Whether `ActionResult` should carry vendor and amount context.
- Re-fetching from Zip before executing.

---

## 8. Test coverage (99 tests, all passing)

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
- **Tapbacks:**
  - `approve` confirms without Gemini.
  - `reject` cancels without Gemini and never writes to Zip.
  - `approve` with nothing pending does nothing.
  - `reject` on a pending DENY cancels it rather than denying.
  - Longer messages still go to Gemini.
