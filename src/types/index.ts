export interface IncomingMessage {
  conversationId: string;
  sender: string;
  text: string;

  /**
   * Set when the user sent a voice memo instead of typing. `text` is then "" and the
   * orchestration layer transcribes the audio. Optional: text-only messages are unchanged.
   */
  audio?: {
    url: string;
    mimeType?: string;
    sizeBytes?: number;
  };
}

export interface OutgoingMessage {
  conversationId: string;
  text: string;
}

export type IntentType =
  | "GET_PENDING"
  | "BULK_REVIEW"
  | "APPROVE"
  | "DENY"
  | "INVESTIGATE"
  | "CONFIRM"
  | "CANCEL"
  | "UNKNOWN";

export interface UserIntent {
  intent: IntentType;
  maxAmount?: number;
  existingVendorsOnly?: boolean;
  excludedCategories?: string[];
  includedCategories?: string[];
  vendor?: string;
  requestId?: string;
}

export interface PurchaseRequest {
  id: string;
  vendor: {
    id?: string;
    name: string;
  };
  amount: number;
  currency?: string;
  status: string;
  existingVendor?: boolean;
  category?: string;
  requester?: {
    id?: string;
    name?: string;
    department?: string;
  };
  createdAt?: string;
}

export type ActionType =
  | "APPROVE"
  | "DENY"
  | "ESCALATE";

export interface ProposedAction {
  type: ActionType;
  requestId: string;
}

export interface ActionResult {
  requestId: string;
  action: ActionType;
  success: boolean;
  error?: string;
}

export interface AttentionItem {
  requestIds: string[];
  reason: string;
  type:
    | "OVER_LIMIT"
    | "NEW_VENDOR"
    | "EXCLUDED_CATEGORY"
    | "AGGREGATE_SPEND"
    | "MISSING_DATA"
    | "OTHER";
}

export interface ActionPlan {
  proposedActions: ProposedAction[];
  attentionItems: AttentionItem[];
  requiresConfirmation: boolean;
}

export interface ConversationState {
  conversationId: string;
  status: "IDLE" | "AWAITING_CONFIRMATION";
  pendingPlan?: ActionPlan;
}