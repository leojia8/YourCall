// Types private to orchestration. Shared team contracts live in src/types.
import type { ActionPlan, AttentionItem, PurchaseRequest } from "../types";

/** Outcome of checking one request against the user's BULK_REVIEW constraints. */
export type RuleEvaluation =
  | { qualifies: true }
  | { qualifies: false; attention: AttentionItem };

/**
 * A saved plan plus the requests it was built from. The snapshot is only used to
 * describe results (vendor/amount) — it is never sent to Zip.
 */
export interface PendingPlanRecord {
  plan: ActionPlan;
  requests: Map<string, PurchaseRequest>;
}

/** Sum of amounts that is only produced when every known currency agrees. */
export type CurrencyTotal =
  | { ok: true; total: number; currency?: string }
  | { ok: false; currencies: string[] };
