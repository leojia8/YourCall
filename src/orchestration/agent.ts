import { parseIntent } from "../gemini/intent.parser";
import type { IntentContext } from "../gemini/gemini.types";
import type {
  ActionPlan,
  ActionResult,
  ActionType,
  IncomingMessage,
  ProposedAction,
  PurchaseRequest,
  UserIntent,
} from "../types";
import { AGGREGATE_SPEND_THRESHOLD, detectAggregateSpend, groupByVendor } from "./anomaly";
import {
  clearConversation,
  getPendingPlan,
  savePendingPlan,
  takePendingPlan,
} from "./conversation.store";
import {
  capitalize,
  countWord,
  describeTotal,
  formatMoney,
  formatRequestAmount,
  normalizeName,
  plural,
} from "./format";
import type { PendingPlanRecord } from "./orchestration.types";
import { buildBulkReviewPlan, findVendorMatches } from "./rules";
import * as zip from "./zip.client";

const HELP_TEXT =
  "I didn't quite understand that. You can ask me to show pending requests, review purchases under a limit, investigate a vendor, or act on a specific request.";
const ZIP_READ_FAILED =
  "I couldn't load your purchase requests from Zip right now, so I didn't change anything. Please try again in a moment.";
const INTERNAL_ERROR = "Sorry, something went wrong on my end. Please try again.";
const MAX_LIST_LINES = 8;

const VERBS: Record<ActionType, { base: string; past: string }> = {
  APPROVE: { base: "approve", past: "approved" },
  DENY: { base: "deny", past: "denied" },
  ESCALATE: { base: "escalate", past: "escalated" },
};

/**
 * The single entry point for Person 1 (Linq). Takes a normalized IncomingMessage,
 * returns the reply text. Never throws and never executes a Zip write unless the
 * message is a CONFIRM for a plan saved by an earlier message.
 */
export async function handleMessage(message: IncomingMessage): Promise<string> {
  try {
    return await route(message);
  } catch (error) {
    console.error("[agent] unhandled error:", error);
    return INTERNAL_ERROR;
  }
}

async function route({ conversationId, text }: IncomingMessage): Promise<string> {
  // Read-only fetch up front so Gemini can be told the real vendor/category names.
  const prefetched = await tryGetPending();
  const intent = await parseIntent(text, buildIntentContext(prefetched));

  switch (intent.intent) {
    case "CONFIRM":
      return handleConfirm(conversationId);
    case "CANCEL":
      return handleCancel(conversationId);
    case "UNKNOWN":
      return withPendingNote(conversationId, HELP_TEXT);
  }

  const pending = prefetched ?? (await tryGetPending());

  switch (intent.intent) {
    case "GET_PENDING":
      return pending ? handleGetPending(conversationId, intent, pending) : withPendingNote(conversationId, ZIP_READ_FAILED);
    case "BULK_REVIEW":
      return pending ? handleBulkReview(conversationId, intent, pending) : withPendingNote(conversationId, ZIP_READ_FAILED);
    case "APPROVE":
    case "DENY":
      return pending
        ? handleSingleAction(conversationId, intent, pending, intent.intent)
        : withPendingNote(conversationId, ZIP_READ_FAILED);
    case "INVESTIGATE":
      return handleInvestigate(conversationId, intent, pending);
  }
}

// ---------------------------------------------------------------------------
// Zip reads
// ---------------------------------------------------------------------------

async function tryGetPending(): Promise<PurchaseRequest[] | null> {
  try {
    const requests = await zip.getPendingRequests();
    return Array.isArray(requests) ? requests : null;
  } catch (error) {
    console.error("[agent] getPendingRequests failed:", error);
    return null;
  }
}

function buildIntentContext(pending: PurchaseRequest[] | null): IntentContext | undefined {
  if (!pending || pending.length === 0) return undefined;
  const vendors = new Set<string>();
  const categories = new Set<string>();
  for (const request of pending) {
    vendors.add(request.vendor.name.trim());
    if (request.category?.trim()) categories.add(request.category.trim());
  }
  return { knownVendors: [...vendors], knownCategories: [...categories] };
}

// ---------------------------------------------------------------------------
// Read-only flows (never touch the pending plan)
// ---------------------------------------------------------------------------

function handleGetPending(conversationId: string, intent: UserIntent, pending: PurchaseRequest[]): string {
  const scope = intent.vendor ? findVendorMatches(pending, intent.vendor) : pending;
  const label = intent.vendor ? ` from ${scope[0]?.vendor.name.trim() ?? intent.vendor}` : "";

  if (scope.length === 0) {
    return withPendingNote(conversationId, `You have no pending purchase requests${label}.`);
  }

  const lines = [
    `You have ${scope.length} pending purchase ${plural(scope.length, "request")}${label} totaling ${describeTotal(scope)}.`,
  ];

  const groups = [...groupByVendor(scope).values()].sort((a, b) => b.length - a.length);
  if (groups.length > 1) {
    lines.push("");
    lines.push(
      ...capList(
        groups.map((group) => {
          const name = group[0]!.vendor.name.trim();
          return group.length === 1
            ? `• ${name} — ${formatRequestAmount(group[0]!)}`
            : `• ${name} — ${group.length} requests, ${describeTotal(group)}`;
        }),
        "vendors"
      )
    );
  }

  const scopeIds = new Set(scope.map((request) => request.id));
  const flagged = detectAggregateSpend(pending).filter((item) => item.requestIds.some((id) => scopeIds.has(id)));
  if (flagged.length > 0) {
    lines.push("", "Worth a look:", ...flagged.map((item) => `• ${item.reason}`));
  }

  return withPendingNote(conversationId, lines.join("\n"));
}

async function handleInvestigate(
  conversationId: string,
  intent: UserIntent,
  pending: PurchaseRequest[] | null
): Promise<string> {
  const record = getPendingPlan(conversationId);

  if (intent.requestId) {
    let request = pending?.find((candidate) => candidate.id === intent.requestId) ?? null;
    const isPending = request !== null;
    if (!request) {
      try {
        request = await zip.getRequestById(intent.requestId);
      } catch (error) {
        console.error("[agent] getRequestById failed:", error);
      }
    }
    if (!request) {
      return withPendingNote(
        conversationId,
        pending ? `I couldn't find a request with ID ${intent.requestId}.` : ZIP_READ_FAILED
      );
    }
    if (!isPending && pending) {
      return withPendingNote(
        conversationId,
        `${describeRequest(request)} (${request.id}) isn't pending. Its status is "${request.status}".`
      );
    }
    return withPendingNote(conversationId, explainRequests([request], pending ?? [request], record));
  }

  if (intent.vendor) {
    if (!pending) return withPendingNote(conversationId, ZIP_READ_FAILED);
    const matches = findVendorMatches(pending, intent.vendor);
    if (matches.length === 0) {
      return withPendingNote(
        conversationId,
        `I don't see any pending requests from ${intent.vendor}, so nothing is flagged for them right now.`
      );
    }
    return withPendingNote(conversationId, explainRequests(matches, pending, record));
  }

  if (record && record.plan.attentionItems.length > 0) {
    return withPendingNote(
      conversationId,
      ["Here's what's flagged in your current plan:", ...capList(record.plan.attentionItems.map((i) => `• ${i.reason}`), "items")].join("\n")
    );
  }
  return withPendingNote(conversationId, "Which vendor or request should I look into?");
}

/** Explanation grounded only in the given request data and the saved plan. */
function explainRequests(
  requests: PurchaseRequest[],
  pending: PurchaseRequest[],
  record: PendingPlanRecord | undefined
): string {
  const vendor = requests[0]!.vendor.name.trim();
  const ids = new Set(requests.map((request) => request.id));
  const lines: string[] = [];

  if (requests.length === 1) {
    const request = requests[0]!;
    lines.push(`${describeRequest(request)} (${request.id})${describeDetails(request)}.`);
  } else {
    lines.push(`${vendor} has ${countWord(requests.length)} pending requests totaling ${describeTotal(requests)}.`);
  }

  const reasons: string[] = [];
  for (const item of detectAggregateSpend(pending)) {
    if (!item.requestIds.some((id) => ids.has(id))) continue;
    let reason = `It's flagged because ${lowerFirst(item.reason)}`;
    if (item.type === "AGGREGATE_SPEND") {
      const largest = requests.reduce((max, r) => (r.amount > max.amount ? r : max));
      reason += ` That's above the ${formatMoney(AGGREGATE_SPEND_THRESHOLD, largest.currency)} combined-spend threshold, even though the largest single request is ${formatRequestAmount(largest)}.`;
    }
    reasons.push(reason);
  }

  for (const item of record?.plan.attentionItems ?? []) {
    if (item.type === "AGGREGATE_SPEND") continue; // already explained from live data
    if (item.requestIds.some((id) => ids.has(id))) reasons.push(`From your last review: ${item.reason}`);
  }

  const planned = record?.plan.proposedActions.filter((action) => ids.has(action.requestId)) ?? [];
  if (planned.length > 0) {
    reasons.push(`Your pending plan would ${VERBS[planned[0]!.type].base} ${planned.length === 1 ? "it" : `${planned.length} of them`}.`);
  }

  if (reasons.length === 0) reasons.push("Nothing about it is flagged in the current data.");
  return [...lines, ...reasons].join("\n");
}

// ---------------------------------------------------------------------------
// Consequential flows (build + save a plan, never execute)
// ---------------------------------------------------------------------------

function handleBulkReview(conversationId: string, intent: UserIntent, pending: PurchaseRequest[]): string {
  if (pending.length === 0) {
    return withPendingNote(conversationId, "You have no pending purchase requests, so there's nothing to review.");
  }

  const scope = intent.vendor ? findVendorMatches(pending, intent.vendor) : pending;
  if (scope.length === 0) {
    return withPendingNote(conversationId, `I couldn't find any pending requests from ${intent.vendor}.`);
  }

  const plan = buildBulkReviewPlan(pending, intent);
  const byId = new Map(pending.map((request) => [request.id, request]));
  const actionCount = plan.proposedActions.length;
  const attentionCount = plan.attentionItems.length;
  const label = intent.vendor ? ` from ${scope[0]!.vendor.name.trim()}` : "";

  const lines = [`I found ${scope.length} pending ${plural(scope.length, "request")}${label}.`];

  if (actionCount > 0) {
    lines.push(
      "",
      `${actionCount} routine ${plural(actionCount, "request")} ${actionCount === 1 ? "matches" : "match"} your instructions:`,
      ...capList(
        plan.proposedActions.map((action) => {
          const request = byId.get(action.requestId)!;
          const category = request.category?.trim() ? ` (${request.category.trim()})` : "";
          return `• ${request.vendor.name.trim()} — ${formatRequestAmount(request)}${category}`;
        }),
        "requests"
      )
    );
  }

  if (attentionCount > 0) {
    lines.push(
      "",
      `${capitalize(countWord(attentionCount))} ${plural(attentionCount, "thing")} ${attentionCount === 1 ? "needs" : "need"} your attention:`,
      ...capList(plan.attentionItems.map((item) => `• ${item.reason}`), "items")
    );
  }

  if (actionCount === 0) {
    lines.push("", "Nothing can be handled automatically under those instructions, so I haven't set anything up.");
    return withPendingNote(conversationId, lines.join("\n"));
  }

  const replacing = getPendingPlan(conversationId) !== undefined;
  savePendingPlan(conversationId, plan, pending);

  lines.push(
    "",
    actionCount === 1
      ? "Want me to approve it? Reply yes to confirm or cancel to stop."
      : `Want me to approve these ${actionCount}? Reply yes to confirm or cancel to stop.`
  );
  if (replacing) lines.push("(This replaces your earlier plan.)");
  return lines.join("\n");
}

function handleSingleAction(
  conversationId: string,
  intent: UserIntent,
  pending: PurchaseRequest[],
  type: "APPROVE" | "DENY"
): string {
  const verb = VERBS[type];
  let target: PurchaseRequest;

  if (intent.requestId) {
    // A model-supplied ID is only trusted if it is actually in the live pending list.
    const match = pending.find((request) => request.id === intent.requestId);
    if (!match) {
      return withPendingNote(
        conversationId,
        `I couldn't find a pending request with ID ${intent.requestId}, so I didn't set anything up.`
      );
    }
    if (intent.vendor && normalizeName(match.vendor.name) !== normalizeName(intent.vendor)) {
      return withPendingNote(
        conversationId,
        `Request ${match.id} is from ${match.vendor.name.trim()}, not ${intent.vendor}. Which one did you mean?`
      );
    }
    target = match;
  } else if (intent.vendor) {
    const matches = findVendorMatches(pending, intent.vendor);
    if (matches.length === 0) {
      const vendors = [...new Set(pending.map((request) => request.vendor.name.trim()))];
      const hint = vendors.length > 0 ? ` Pending vendors: ${vendors.slice(0, 6).join(", ")}${vendors.length > 6 ? ", …" : ""}.` : "";
      return withPendingNote(conversationId, `I couldn't find a pending request from ${intent.vendor}.${hint}`);
    }
    if (matches.length > 1) {
      const name = matches[0]!.vendor.name.trim();
      return withPendingNote(
        conversationId,
        [
          `There are ${countWord(matches.length)} pending ${name} requests, so I won't guess which one:`,
          ...capList(matches.map((request) => `• ${request.id} — ${formatRequestAmount(request)}${describeWhoWhen(request)}`), "requests"),
          `Reply with the request ID, e.g. "${verb.base} ${matches[0]!.id}".`,
        ].join("\n")
      );
    }
    target = matches[0]!;
  } else {
    return withPendingNote(conversationId, `Which request should I ${verb.base}? Tell me the vendor or request ID.`);
  }

  const headsUp =
    type === "APPROVE" ? detectAggregateSpend(pending).filter((item) => item.requestIds.includes(target.id)) : [];
  const plan: ActionPlan = {
    proposedActions: [{ type, requestId: target.id }],
    attentionItems: headsUp,
    requiresConfirmation: true,
  };

  const replacing = getPendingPlan(conversationId) !== undefined;
  savePendingPlan(conversationId, plan, [target]);

  const lines = [`${target.vendor.name.trim()}'s request is ${formatRequestAmount(target)}. ${capitalize(verb.base)} it?`];
  if (headsUp.length > 0) lines.push(`Heads up: ${headsUp.map((item) => item.reason).join(" ")}`);
  if (replacing) lines.push("(This replaces your earlier plan.)");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Confirmation flows
// ---------------------------------------------------------------------------

async function handleConfirm(conversationId: string): Promise<string> {
  // Taken and cleared before any await, so a duplicate "yes" finds nothing to run.
  const record = takePendingPlan(conversationId);
  if (!record || record.plan.proposedActions.length === 0) {
    return "There's nothing waiting for confirmation.";
  }
  const results = await executeAll(record.plan.proposedActions);
  return summarizeResults(results, record.requests);
}

function handleCancel(conversationId: string): string {
  const hadPlan = getPendingPlan(conversationId) !== undefined;
  clearConversation(conversationId);
  return hadPlan ? "Cancelled. I didn't make any changes." : "There was nothing waiting to cancel. I didn't make any changes.";
}

/** Runs every confirmed action; a rejected call becomes a failed ActionResult instead of crashing. */
async function executeAll(actions: ProposedAction[]): Promise<ActionResult[]> {
  const settled = await Promise.allSettled(actions.map((action) => zip.executeAction(action)));
  return settled.map((outcome, index): ActionResult => {
    const action = actions[index]!;
    if (outcome.status === "rejected") {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : undefined;
      return { requestId: action.requestId, action: action.type, success: false, error: reason };
    }
    const result = outcome.value;
    return {
      requestId: action.requestId,
      action: action.type,
      success: result?.success === true,
      error: typeof result?.error === "string" ? result.error : undefined,
    };
  });
}

function summarizeResults(results: ActionResult[], snapshot: Map<string, PurchaseRequest>): string {
  const succeeded = results.filter((result) => result.success);
  const failed = results.filter((result) => !result.success);
  const lines: string[] = [];

  if (succeeded.length > 0) {
    const parts: string[] = [];
    for (const type of Object.keys(VERBS) as ActionType[]) {
      const ofType = succeeded.filter((result) => result.action === type);
      if (ofType.length === 0) continue;
      if (ofType.length === 1) {
        parts.push(`${describeRef(ofType[0]!.requestId, snapshot)} was ${VERBS[type].past}`);
      } else {
        const names = ofType.map((result) => describeShortRef(result.requestId, snapshot)).join(", ");
        parts.push(`${ofType.length} requests were ${VERBS[type].past}: ${names}`);
      }
    }
    lines.push(`Done — ${parts.join("; ")}.`);
  } else {
    lines.push(results.length === 1 ? "That didn't go through." : `None of the ${results.length} actions went through.`);
  }

  for (const result of failed) {
    const why = result.error ? `: ${result.error.trim()}` : " (Zip didn't give a reason).";
    lines.push(`I couldn't ${VERBS[result.action].base} ${describeRef(result.requestId, snapshot)}${why}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Appends a reminder when an earlier plan is still awaiting confirmation. */
function withPendingNote(conversationId: string, reply: string): string {
  const record = getPendingPlan(conversationId);
  if (!record) return reply;
  return `${reply}\n\nYour earlier plan to ${describePlan(record)} is still waiting. Reply yes to run it or cancel to drop it.`;
}

function describePlan(record: PendingPlanRecord): string {
  const parts: string[] = [];
  for (const type of Object.keys(VERBS) as ActionType[]) {
    const ofType = record.plan.proposedActions.filter((action) => action.type === type);
    if (ofType.length === 0) continue;
    parts.push(
      ofType.length === 1
        ? `${VERBS[type].base} ${describeRef(ofType[0]!.requestId, record.requests)}`
        : `${VERBS[type].base} ${ofType.length} requests`
    );
  }
  return parts.join(" and ");
}

/** "Figma's $1,200 request" when known; otherwise only the ID (vendor names are never guessed). */
function describeRef(requestId: string, snapshot: Map<string, PurchaseRequest>): string {
  const request = snapshot.get(requestId);
  return request ? describeRequest(request) : `request ${requestId}`;
}

function describeShortRef(requestId: string, snapshot: Map<string, PurchaseRequest>): string {
  const request = snapshot.get(requestId);
  return request ? `${request.vendor.name.trim()} (${formatRequestAmount(request)})` : requestId;
}

function describeRequest(request: PurchaseRequest): string {
  return `${request.vendor.name.trim()}'s ${formatRequestAmount(request)} request`;
}

function describeDetails(request: PurchaseRequest): string {
  const details: string[] = [];
  if (request.category?.trim()) details.push(request.category.trim());
  if (request.existingVendor === true) details.push("existing vendor");
  else if (request.existingVendor === false) details.push("new vendor");
  if (request.requester?.name) details.push(`requested by ${request.requester.name}`);
  return details.length > 0 ? `: ${details.join(", ")}` : "";
}

function describeWhoWhen(request: PurchaseRequest): string {
  const details: string[] = [];
  if (request.requester?.name) details.push(request.requester.name);
  if (request.createdAt) details.push(request.createdAt.slice(0, 10));
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function capList(lines: string[], noun: string): string[] {
  if (lines.length <= MAX_LIST_LINES) return lines;
  return [...lines.slice(0, MAX_LIST_LINES), `…and ${lines.length - MAX_LIST_LINES} more ${noun}.`];
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
