import type { AttentionItem, PurchaseRequest } from "../types";
import { capitalize, countWord, formatMoney, knownCurrencies, normalizeName, totalAmount } from "./format";

/** A vendor's pending requests are flagged when their combined total is above this. */
export const AGGREGATE_SPEND_THRESHOLD = 5000;

/** A single request is never an "aggregate" — it is covered by the amount limit instead. */
export const AGGREGATE_MIN_REQUESTS = 2;

/** Groups requests by trimmed, case-insensitive vendor name. */
export function groupByVendor(requests: PurchaseRequest[]): Map<string, PurchaseRequest[]> {
  const groups = new Map<string, PurchaseRequest[]>();
  for (const request of requests) {
    const key = normalizeName(request.vendor.name);
    const group = groups.get(key);
    if (group) group.push(request);
    else groups.set(key, [request]);
  }
  return groups;
}

/**
 * Simple, explainable heuristic (no ML/statistics): flag any vendor with at least
 * AGGREGATE_MIN_REQUESTS pending requests totalling more than AGGREGATE_SPEND_THRESHOLD.
 * A vendor group in mixed currencies is never totalled; it is flagged as OTHER instead.
 */
export function detectAggregateSpend(pending: PurchaseRequest[]): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const group of groupByVendor(pending).values()) {
    if (group.length < AGGREGATE_MIN_REQUESTS) continue;
    const vendorName = group[0]!.vendor.name.trim();
    const requestIds = group.map((request) => request.id);

    const total = totalAmount(group);
    if (!total.ok) {
      items.push({
        requestIds,
        type: "OTHER",
        reason: `${capitalize(countWord(group.length))} ${vendorName} requests are in different currencies (${knownCurrencies(group).join(", ")}), so I can't total them safely.`,
      });
      continue;
    }

    if (total.total > AGGREGATE_SPEND_THRESHOLD) {
      items.push({
        requestIds,
        type: "AGGREGATE_SPEND",
        reason: `${capitalize(countWord(group.length))} ${vendorName} requests total ${formatMoney(total.total, total.currency)}.`,
      });
    }
  }

  return items;
}
