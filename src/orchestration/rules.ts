import type { ActionPlan, AttentionItem, PurchaseRequest, UserIntent } from "../types";
import { detectAggregateSpend } from "./anomaly";
import { formatMoney, formatRequestAmount, knownCurrencies, normalizeName } from "./format";
import type { RuleEvaluation } from "./orchestration.types";

/** Exact trimmed, case-insensitive vendor-name match. No fuzzy matching. */
export function findVendorMatches(requests: PurchaseRequest[], vendor: string): PurchaseRequest[] {
  const target = normalizeName(vendor);
  return requests.filter((request) => normalizeName(request.vendor.name) === target);
}

function categoryIn(category: string, list: string[]): boolean {
  const target = normalizeName(category);
  return list.some((entry) => normalizeName(entry) === target);
}

function fail(request: PurchaseRequest, type: AttentionItem["type"], reason: string): RuleEvaluation {
  return { qualifies: false, attention: { requestIds: [request.id], type, reason } };
}

/**
 * Checks one request against the user's constraints. Unknown data never counts as
 * satisfying a constraint — it produces MISSING_DATA instead.
 */
export function evaluateRequest(request: PurchaseRequest, intent: UserIntent): RuleEvaluation {
  const vendor = request.vendor.name.trim();

  if (intent.maxAmount !== undefined) {
    if (!Number.isFinite(request.amount)) {
      return fail(request, "MISSING_DATA", `${vendor} has no valid amount, so I can't check it against your limit.`);
    }
    if (request.amount >= intent.maxAmount) {
      const relation = request.amount > intent.maxAmount ? "above" : "not under";
      return fail(
        request,
        "OVER_LIMIT",
        `${vendor} is ${formatRequestAmount(request)}, ${relation} your ${formatMoney(intent.maxAmount, request.currency)} limit.`
      );
    }
  }

  if (intent.existingVendorsOnly) {
    if (request.existingVendor === false) {
      return fail(request, "NEW_VENDOR", `${vendor} is a new vendor.`);
    }
    if (request.existingVendor !== true) {
      return fail(request, "MISSING_DATA", `${vendor}: I don't know whether it's an existing vendor.`);
    }
  }

  const excluded = intent.excludedCategories ?? [];
  const included = intent.includedCategories ?? [];
  if (excluded.length > 0 || included.length > 0) {
    const category = request.category?.trim();
    if (!category) {
      return fail(request, "MISSING_DATA", `${vendor} has no category, so I can't check it against your category rules.`);
    }
    const excludedByCategory = categoryIn(category, excluded);
    const excludedByVendor = excluded.some((term) =>
      normalizeName(vendor).includes(normalizeName(term))
    );

    if (excludedByCategory || excludedByVendor) {
      const matched = excluded.find(
        (term) =>
          normalizeName(category) === normalizeName(term) ||
          normalizeName(vendor).includes(normalizeName(term))
      );

      return fail(
        request,
        "EXCLUDED_CATEGORY",
        `${vendor} matches your "${matched}" exclusion.`
      );
    }
    if (included.length > 0 && !categoryIn(category, included)) {
      return fail(request, "EXCLUDED_CATEGORY", `${vendor} is in ${category}, outside the categories you asked for.`);
    }
  }

  return { qualifies: true };
}

/**
 * The user's amount limit carries no currency. When pending requests use more than
 * one currency, only the dominant currency (requests with no currency count as it)
 * is compared; everything else is flagged. With no clear dominant currency, all are flagged.
 */
function currencyConflicts(pending: PurchaseRequest[], intent: UserIntent): Map<string, AttentionItem> {
  const conflicts = new Map<string, AttentionItem>();
  if (intent.maxAmount === undefined || knownCurrencies(pending).length <= 1) return conflicts;

  const counts = new Map<string, number>();
  for (const request of pending) {
    const code = request.currency?.trim().toUpperCase();
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const highest = Math.max(...counts.values());
  const leaders = [...counts].filter(([, count]) => count === highest);
  const dominant = leaders.length === 1 ? leaders[0]![0] : undefined;

  for (const request of pending) {
    const code = request.currency?.trim().toUpperCase();
    const matchesDominant = dominant !== undefined && (!code || code === dominant);
    if (!matchesDominant) {
      conflicts.set(request.id, {
        requestIds: [request.id],
        type: "OTHER",
        reason: `${request.vendor.name.trim()} is ${formatRequestAmount(request)}; your requests are in mixed currencies, so I can't compare it to your limit safely.`,
      });
    }
  }
  return conflicts;
}

/**
 * Deterministic BULK_REVIEW plan. Qualifying requests become proposed APPROVE actions,
 * except requests in a flagged vendor group (aggregate spend always overrides routine approval).
 * If the intent names a vendor, only that vendor's requests are considered.
 */
export function buildBulkReviewPlan(pending: PurchaseRequest[], intent: UserIntent): ActionPlan {
  const candidates = intent.vendor ? findVendorMatches(pending, intent.vendor) : pending;
  const candidateIds = new Set(candidates.map((request) => request.id));

  // Aggregates are computed over ALL pending requests, then scoped to the candidates.
  const aggregateItems = detectAggregateSpend(pending).filter((item) =>
    item.requestIds.some((id) => candidateIds.has(id))
  );
  const flaggedIds = new Set(aggregateItems.flatMap((item) => item.requestIds));
  const conflicts = currencyConflicts(pending, intent);

  const attentionItems: AttentionItem[] = [];
  const proposedActions: ActionPlan["proposedActions"] = [];

  for (const request of candidates) {
    const conflict = conflicts.get(request.id);
    if (conflict) {
      attentionItems.push(conflict);
      continue;
    }
    const evaluation = evaluateRequest(request, intent);
    if (!evaluation.qualifies) {
      attentionItems.push(evaluation.attention);
      continue;
    }
    if (!flaggedIds.has(request.id)) {
      proposedActions.push({ type: "APPROVE", requestId: request.id });
    }
  }

  return {
    proposedActions,
    // Aggregate flags first: they are the headline items and must survive list truncation.
    attentionItems: [...aggregateItems, ...mergeIdenticalItems(attentionItems)],
    requiresConfirmation: proposedActions.length > 0,
  };
}

/** Collapses items with the same type and reason (e.g. six "OpenAI is in AI" lines) into one. */
function mergeIdenticalItems(items: AttentionItem[]): AttentionItem[] {
  const merged = new Map<string, AttentionItem>();
  for (const item of items) {
    const key = `${item.type}|${item.reason}`;
    const existing = merged.get(key);
    if (existing) existing.requestIds.push(...item.requestIds);
    else merged.set(key, { ...item, requestIds: [...item.requestIds] });
  }
  return [...merged.values()];
}
