# Gemini + Orchestration Layer (Person 3)

Status as of 2026-09-19. Branch: `gemini` (uncommitted). Owner: Person 3.

> **Gemini interprets. Our code validates and decides. Zip executes.**
> Nothing is ever written to Zip unless a *later* message confirms a plan that our code built and saved.

---

## 1. Quick start

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run (94 tests)
```

### Gemini on/off switch (`.env`)

| Setting | Effect |
|---|---|
| `GEMINI_MODE=mock` | **Default for local testing.** Offline keyword parser (`src/gemini/intent.mock.ts`). Zero API calls, no quota used. |
| `GEMINI_MODE=live` | Calls the real Gemini API with `GEMINI_API_KEY`. Each message costs one request. |
| `GEMINI_MODEL=` | Optional model override. Default: `gemini-2.5-flash` (fastest and most reliable in live tests). |
| `GEMINI_FALLBACK=off` | Turns off the offline fallback (see below). On by default. |

- `.env` is git-ignored (`.gitignore` line 4, confirmed with `git check-ignore`). The real key lives only there.
- `.env.example` documents the variables with no secret values.
- **Tests never call Gemini, whatever the mode.** Every test mocks it or forces the mode explicitly.

### Automatic fallback in live mode
With `GEMINI_MODE=live`, every message goes to Gemini first. The offline keyword parser is used only when Gemini **fails**, and only for **that one message**:
- **Counts as a failure:** 503/429 after the retry, a timeout (10 s), a network error, or broken/invalid output.
- **Doesn't change the setting:** the next message tries Gemini again.
- **Gemini's own "unknown" is respected:** if Gemini works and says it doesn't understand, there's no fallback.
- **Just as safe:** the fallback's output goes through the same validation, and any action still needs a later "yes".

> **Deviation from the original spec (approved by Person 3):** section 7 of the spec said a Gemini failure should become `UNKNOWN`. That is still the behaviour with `GEMINI_FALLBACK=off`.

---

## 2. Integration points

### Person 1 (Linq): the only function you need

```ts
import { handleMessage } from "../orchestration/agent";

const response = await handleMessage(incomingMessage); // IncomingMessage in
// response is a string: send it back through Linq
```

- **Input:** `IncomingMessage { conversationId, sender, text }`.
- **Output:** `Promise<string>`. It **never rejects**; internal errors become a friendly reply.
- **Requirement:** each user's chat must always use the **same `conversationId`**, because pending plans are stored under it.

### Person 2 (Zip): one swap file

All Zip access goes through **`src/orchestration/zip.client.ts`**:

```ts
export { getPendingRequests, getRequestById, executeAction } from "./mock.zip";
```

To go live, change `"./mock.zip"` to `"../zip/zip.service"`, renaming if their exports differ. **No schema changes are needed**, because both sides use the shared `PurchaseRequest`, `ProposedAction` and `ActionResult` types.

Where each function is called (all in `src/orchestration/agent.ts`):

| Function | When |
|---|---|
| `getPendingRequests()` | Once at the start of **every** message, to give Gemini the real vendor and category names and to reuse the data. Retried once if it fails. |
| `getRequestById(id)` | Only for INVESTIGATE on a request ID that isn't in the pending list. |
| `executeAction(action)` | **Only** inside CONFIRM, for each action in the saved plan, run in parallel with `Promise.allSettled`. A thrown error or rejected call becomes a failed `ActionResult`. |

The shared types in `src/types/index.ts` are **unchanged**. They were verified identical to the agreed contract.

---

## 3. What was built

### Files created
| File | Purpose |
|---|---|
| `src/gemini/intent.mock.ts` | Offline keyword parser for `GEMINI_MODE=mock` |
| `src/orchestration/format.ts` | Money formatting, currency-safe totals, name matching |
| `src/orchestration/mock.zip.ts` | **Temporary** mock Zip: 15 fixture requests plus in-memory execution |
| `src/orchestration/zip.client.ts` | The single file that picks mock or real Zip |
| `tests/agent.test.ts`, `tests/anomaly.test.ts`, `tests/milestones.test.ts`, `tests/gemini.service.test.ts` | Tests |
| `docs/gemini-orchestration.md` | This document |

### Files filled in (they were empty stubs)
`src/gemini/{gemini.service,gemini.types,intent.parser}.ts`, `src/orchestration/{agent,rules,anomaly,conversation.store,orchestration.types}.ts`, `tests/{intent,rules}.test.ts`

### Other files touched
`.env.example` gained the `GEMINI_MODE` and `GEMINI_MODEL` lines. `.env` was created locally and is git-ignored.

### Files intentionally NOT touched
`src/types/index.ts`, everything in `src/zip/` and `src/linq/`, `src/server.ts`, `src/config/env.ts`, `package.json`, `package-lock.json`.

### Module summary

**`src/gemini/`**
- `gemini.service.ts`: `generateJson(prompt, schema)` uses native `fetch` to call Gemini `generateContent`. Temperature 0, JSON-only output, the key sent in the `x-goog-api-key` header (never in the URL), 10 s timeout. **Retries once after 1 s on 503 (overloaded) or 429 (rate-limited)**; any other error is not retried. Loads `.env` itself as a fallback.
- `intent.parser.ts`:
  - `parseIntent(text, hints?)` converts a message to a validated `UserIntent`. It never throws; anything bad becomes `{ intent: "UNKNOWN" }`.
  - The response schema makes **every field required but nullable**, so Gemini has to decide on each condition instead of silently dropping it.
  - `validateIntent(raw)` treats model output as untrusted:
    - `intent` must be one of the 8 allowed values.
    - `maxAmount` must be a finite number ≥ 0.
    - Every other field must have the right type.
    - `null` or placeholder strings (`"none"`, `"N/A"`…) are treated as absent, and unknown keys are dropped.
    - Any wrong type makes the whole result UNKNOWN.
  - The prompt includes real vendor and category names from Zip as hints, so Gemini can use Zip's exact spelling.
- `intent.mock.ts`: a predictable keyword parser used in mock mode **and as the live-mode fallback**. Its output goes through the same `validateIntent`.

**`src/orchestration/`**
- `rules.ts`:
  - `evaluateRequest`: deterministic checks, in order: amount, then vendor status, then category.
  - `buildBulkReviewPlan`: builds the ActionPlan.
  - `findVendorMatches`: exact vendor matching, trimmed and case-insensitive, never fuzzy.
- `anomaly.ts`: `detectAggregateSpend`, with `AGGREGATE_SPEND_THRESHOLD = 5000` and `AGGREGATE_MIN_REQUESTS = 2`.
- `conversation.store.ts`: a `Map<string, ConversationState>` plus a request snapshot per plan. `takePendingPlan` reads the plan and clears it in one synchronous step.
- `agent.ts`: `handleMessage` plus the per-intent flows and deterministic reply text.

### Behaviour per intent

| Intent | Reads Zip | Writes Zip | Effect on the pending plan |
|---|---|---|---|
| GET_PENDING | yes | never | kept (reply reminds you it's waiting) |
| INVESTIGATE | yes | never | kept |
| UNKNOWN | — | never | kept |
| BULK_REVIEW | yes | never | **replaced only if** the new plan has ≥1 action; otherwise the old one stays |
| APPROVE / DENY | yes | never | **replaced only if** exactly one request matches |
| CONFIRM | — | **yes, only here** | taken and cleared *before* executing |
| CANCEL | — | never | cleared |

---

## 4. Decisions (approved 2026-09-19)

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
8. **Double "yes" is harmless:** the plan is removed before any Zip call, so a repeat or a webhook retry finds nothing.
9. **Explicitly approving one request from a flagged vendor** is allowed, with a "Heads up" line in the confirmation.
10. **Old plans are visible:** when an old plan is still waiting, every reply says so.
11. **A named vendor limits the review:** BULK_REVIEW with a vendor only considers that vendor.
12. **Plans are cleared after execution,** even on partial failure. ESCALATE is never produced.
13. **Similar reasons are merged:** identical attention reasons become one line with the request IDs combined.

---

## 5. Live Gemini tests (2026-09-19)

Input every time: *"handle everything under 5k from existing vendors but don't touch AI"*
Expected: `{"intent":"BULK_REVIEW","maxAmount":5000,"existingVendorsOnly":true,"excludedCategories":["AI"]}`

| # | Setup | Result | Latency |
|---|---|---|---|
| 1 | Original prompt, all fields optional | `{"intent":"BULK_REVIEW","maxAmount":5000,"vendor":"none","requestId":"none"}`: invented placeholders and **missed 2 of 3 conditions** | ~11.7 s |
| 2 | Placeholder filtering + stronger prompt | **503 from Google** (model overloaded). Safely became UNKNOWN; nothing executed. | 0.7 s |
| 3 | Same as #2, plus retry once on 503/429 | `{"intent":"BULK_REVIEW","maxAmount":5000}`: no placeholders, but **still missed `existingVendorsOnly` and `excludedCategories`**. The plan would have proposed AcmeAI (new vendor) and Jasper (AI). | 2.8 s |
| 4 | Every field required + nullable, fixed field order (`gemini-flash-latest`) | `{"intent":"BULK_REVIEW","maxAmount":5000,"existingVendorsOnly":true,"excludedCategories":["AI"]}`: **exact match**. The plan approves Figma, Adobe, AWS and Notion, identical to milestone 1. | 2.7 s |
| 5 | Conversation: approve Figma → why OpenAI → yes (`gemini-flash-latest`) | **Google overloaded**: 503 + timeout on 2 of 3 calls. All failed safely (UNKNOWN, nothing executed); the retry recovered "yes". This led to adding the offline fallback and switching models. | 7–19 s |
| 6 | Same conversation, **`gemini-2.5-flash`**, fallback enabled | **All 3 answered by Gemini** (no fallback). "approve the Figma request" saved the plan and asked to confirm; "why did you flag OpenAI?" explained the $5,560 total and kept the plan; "yes" executed it: "Done — Figma's $1,200 request was approved." | 1.5–1.8 s |

**What was confirmed:**
- The key and `gemini-flash-latest` work.
- A 503 fails safely.
- Placeholder strings are gone.
- **All three conditions are now extracted correctly** (test 4).

**Verified live:** bulk review with three conditions (test 4) and the full approve → investigate → confirm conversation (test 6).

**Fix applied after test 3, verified live by test 4:**
- The schema now makes every field **required + nullable**, with a fixed field order.
- The prompt examples now show the full object with explicit `null`s.
- This is the standard way to stop Gemini's structured output from dropping optional fields. The validator already treats `null` as absent, and a test covers this shape.

---

## 6. Open issues and placeholders

### Before the demo (Person 3)
| # | Item |
|---|---|
| G1 | ~~Verify Gemini extracts every condition and handles the demo phrasings~~ **Resolved** by live tests 4 and 6. Not yet tried live: DENY, GET_PENDING, CANCEL, and bulk review on `gemini-2.5-flash` (test 4 used `gemini-flash-latest`). |
| G2 | **Latency:** `gemini-2.5-flash` took 1.5–1.8 s; `gemini-flash-latest` took 2.7–11.7 s and was overloaded once. The default is now `gemini-2.5-flash`. Google can still be overloaded during the demo; the fallback covers that. |
| G3 | **Rotate the Gemini key** after the hackathon. It was pasted into a chat session. |
| G4 | Switch `.env` to `GEMINI_MODE=live` for the real demo. |
| G5 | **Placeholder:** `mock.zip.ts` fixtures, including `req_9` (Notion), which **always fails on purpose** to demo partial failure. Delete or ignore it once real Zip is wired in. |
| G6 | **Placeholder:** `zip.client.ts` still points at the mock. |
| G7 | Every message makes one Zip read *before* Gemini, even "yes" and "cancel". This small latency cost buys the name hints. |
| G8 | Plans never expire, and Zip isn't re-checked right before execution. A stale plan could run on changed data, and Zip would then return failures, which are reported accurately. |
| G9 | "Approve all the OpenAI ones" can't be expressed: the shared `UserIntent` has no "all" field. Single approve/deny requires exactly one match, and a bulk review of OpenAI is blocked by the vendor-spend flag. |
| G10 | The offline parser (mock mode and live fallback) is a simple keyword parser; it handles demo-style phrasing but not everything Gemini would. Word amounts like "five grand" don't parse, though "5k" does. If Gemini fails on an unusual phrasing, the fallback may return UNKNOWN (safe). |

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

### To settle with Person 1 (Linq)
| # | Question |
|---|---|
| L1 | Confirm a **stable `conversationId`** per user chat. |
| L2 | Who loads `.env` in `src/server.ts`? `gemini.service.ts` loads it itself as a fallback, so this isn't blocking. |
| L3 | Webhook retries or duplicates: a double "yes" is already safe on our side. Does Linq need its own dedupe for other messages? |
| L4 | **Group chats are unsupported:** there's no per-sender permission check, so anyone in a group chat could confirm. |
| L5 | Reply length: BULK_REVIEW replies can be ~15 lines. Check that it's fine for iMessage and Linq limits. |

### Deferred by the spec (unchanged; revisit only if they become blockers)
- Time window for vendor-spend detection.
- Richer vendor and category normalization.
- Compound language ("exclude only NEW AI vendors").
- Whether `ActionResult` should carry vendor and amount context.
- Re-fetching from Zip before executing.

---

## 7. Test coverage (94 tests, all passing)

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
18. malformed Gemini output becomes UNKNOWN
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
