import type { ActionPlan, ConversationState, PurchaseRequest } from "../types";
import type { PendingPlanRecord } from "./orchestration.types";

// In-memory only (hackathon MVP). One conversationId = one user.
const conversations = new Map<string, ConversationState>();
// Request snapshots used to describe results; kept alongside, never in the shared type.
const planRequests = new Map<string, Map<string, PurchaseRequest>>();

export function getConversation(conversationId: string): ConversationState {
  return conversations.get(conversationId) ?? { conversationId, status: "IDLE" };
}

export function getPendingPlan(conversationId: string): PendingPlanRecord | undefined {
  const state = conversations.get(conversationId);
  if (state?.status !== "AWAITING_CONFIRMATION" || !state.pendingPlan) return undefined;
  return { plan: state.pendingPlan, requests: planRequests.get(conversationId) ?? new Map() };
}

/** Saves (or replaces) the pending plan. Callers must only pass a fully built, valid plan. */
export function savePendingPlan(
  conversationId: string,
  plan: ActionPlan,
  requests: PurchaseRequest[]
): void {
  const referenced = new Set(plan.proposedActions.map((action) => action.requestId));
  const snapshot = new Map(
    requests.filter((request) => referenced.has(request.id)).map((request) => [request.id, request])
  );
  conversations.set(conversationId, { conversationId, status: "AWAITING_CONFIRMATION", pendingPlan: plan });
  planRequests.set(conversationId, snapshot);
}

/**
 * Returns the pending plan and clears it in the same synchronous step, so a duplicate
 * "yes" (or a retried webhook) can never execute the same plan twice.
 */
export function takePendingPlan(conversationId: string): PendingPlanRecord | undefined {
  const record = getPendingPlan(conversationId);
  clearConversation(conversationId);
  return record;
}

export function clearConversation(conversationId: string): void {
  conversations.delete(conversationId);
  planRequests.delete(conversationId);
}

/** Test helper. */
export function resetConversations(): void {
  conversations.clear();
  planRequests.clear();
}
