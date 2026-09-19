// TEMPORARY stand-in for Person 2's src/zip/zip.service.ts.
// Uses only the shared normalized contracts, so the real service can replace it
// via zip.client.ts without any schema changes.
import type { ActionResult, ProposedAction, PurchaseRequest } from "../types";

const OPENAI_AMOUNTS = [920, 870, 940, 980, 890, 960]; // total $5,560

export const MOCK_REQUESTS: readonly PurchaseRequest[] = [
  { id: "req_1", vendor: { id: "vendor_figma", name: "Figma" }, amount: 1200, currency: "USD", status: "pending", existingVendor: true, category: "Design", requester: { name: "Priya Shah", department: "Design" } },
  { id: "req_2", vendor: { id: "vendor_datadog", name: "Datadog" }, amount: 7200, currency: "USD", status: "pending", existingVendor: true, category: "Infrastructure", requester: { name: "Marcus Lee", department: "Platform" } },
  { id: "req_3", vendor: { id: "vendor_adobe", name: "Adobe" }, amount: 2300, currency: "USD", status: "pending", existingVendor: true, category: "Design", requester: { name: "Priya Shah", department: "Design" } },
  { id: "req_4", vendor: { id: "vendor_aws", name: "AWS" }, amount: 3800, currency: "USD", status: "pending", existingVendor: true, category: "Infrastructure", requester: { name: "Marcus Lee", department: "Platform" } },
  // Known new vendor
  { id: "req_5", vendor: { id: "vendor_acmeai", name: "AcmeAI" }, amount: 1500, currency: "USD", status: "pending", existingVendor: false, category: "AI", requester: { name: "Dana Kim", department: "Research" } },
  // Existing vendor in the AI category
  { id: "req_6", vendor: { id: "vendor_jasper", name: "Jasper" }, amount: 2000, currency: "USD", status: "pending", existingVendor: true, category: "AI", requester: { name: "Leah Park", department: "Marketing" } },
  // Missing existingVendor
  { id: "req_7", vendor: { id: "vendor_slack", name: "Slack" }, amount: 900, currency: "USD", status: "pending", category: "Communication", requester: { name: "Tom Reyes", department: "Operations" } },
  // Missing category
  { id: "req_8", vendor: { id: "vendor_zoom", name: "Zoom" }, amount: 700, currency: "USD", status: "pending", existingVendor: true, requester: { name: "Tom Reyes", department: "Operations" } },
  // Fails on execution (partial-failure demo)
  { id: "req_9", vendor: { id: "vendor_notion", name: "Notion" }, amount: 600, currency: "USD", status: "pending", existingVendor: true, category: "Productivity", requester: { name: "Leah Park", department: "Marketing" } },
  // Aggregate spend: six small OpenAI requests (also multiple matches for "approve OpenAI")
  ...OPENAI_AMOUNTS.map(
    (amount, index): PurchaseRequest => ({
      id: `openai_${index + 1}`,
      vendor: { id: "vendor_openai", name: "OpenAI" },
      amount,
      currency: "USD",
      status: "pending",
      existingVendor: true,
      category: "AI",
      requester: { name: "Dana Kim", department: "Research" },
      createdAt: `2026-09-1${index}T15:00:00Z`,
    })
  ),
];

const DEFAULT_FAILURES: Record<string, string> = {
  req_9: "Request is no longer awaiting approval.",
};

let requests: PurchaseRequest[] = [];
let failures: Record<string, string> = {};

/** Restores the fixture data (also used by tests). */
export function resetMockZip(): void {
  requests = MOCK_REQUESTS.map((request) => structuredClone(request));
  failures = { ...DEFAULT_FAILURES };
}
resetMockZip();

export async function getPendingRequests(): Promise<PurchaseRequest[]> {
  return requests.filter((request) => request.status === "pending").map((request) => structuredClone(request));
}

export async function getRequestById(id: string): Promise<PurchaseRequest | null> {
  const request = requests.find((candidate) => candidate.id === id);
  return request ? structuredClone(request) : null;
}

export async function executeAction(action: ProposedAction): Promise<ActionResult> {
  const request = requests.find((candidate) => candidate.id === action.requestId);
  const failure = failures[action.requestId];
  if (!request) {
    return { requestId: action.requestId, action: action.type, success: false, error: "Request not found." };
  }
  if (failure || request.status !== "pending") {
    return {
      requestId: action.requestId,
      action: action.type,
      success: false,
      error: failure ?? "Request is no longer awaiting approval.",
    };
  }
  request.status = action.type === "APPROVE" ? "approved" : action.type === "DENY" ? "denied" : "escalated";
  return { requestId: action.requestId, action: action.type, success: true };
}
