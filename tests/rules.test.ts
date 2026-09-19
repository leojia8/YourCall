import { describe, expect, it } from "vitest";
import { buildBulkReviewPlan, evaluateRequest, findVendorMatches } from "../src/orchestration/rules";
import type { PurchaseRequest, UserIntent } from "../src/types";

function request(overrides: Partial<PurchaseRequest> & { id: string; vendorName?: string }): PurchaseRequest {
  const { vendorName = "Figma", ...rest } = overrides;
  return {
    vendor: { name: vendorName },
    amount: 1200,
    currency: "USD",
    status: "pending",
    existingVendor: true,
    category: "Design",
    ...rest,
  };
}

const bulk: UserIntent = { intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true, excludedCategories: ["AI"] };

describe("evaluateRequest", () => {
  it("a request below maxAmount qualifies", () => {
    expect(evaluateRequest(request({ id: "req_1", amount: 1200 }), bulk)).toEqual({ qualifies: true });
  });

  it("a request above maxAmount does not qualify", () => {
    const result = evaluateRequest(request({ id: "req_2", vendorName: "Datadog", amount: 7200 }), bulk);
    expect(result).toEqual({
      qualifies: false,
      attention: { requestIds: ["req_2"], type: "OVER_LIMIT", reason: "Datadog is $7,200, above your $5,000 limit." },
    });
  });

  it("a request exactly at maxAmount is not 'under' the limit", () => {
    const result = evaluateRequest(request({ id: "req_x", amount: 5000 }), bulk);
    expect(result.qualifies).toBe(false);
  });

  it("existingVendorsOnly rejects a known-new vendor", () => {
    const result = evaluateRequest(request({ id: "req_5", existingVendor: false }), bulk);
    expect(result.qualifies === false && result.attention.type).toBe("NEW_VENDOR");
  });

  it("existingVendorsOnly treats undefined existingVendor conservatively", () => {
    const result = evaluateRequest(request({ id: "req_7", existingVendor: undefined }), bulk);
    expect(result.qualifies === false && result.attention.type).toBe("MISSING_DATA");
  });

  it("an excluded category does not qualify (trimmed, case-insensitive)", () => {
    const result = evaluateRequest(request({ id: "req_6", category: "  ai " }), bulk);
    expect(result.qualifies === false && result.attention.type).toBe("EXCLUDED_CATEGORY");
  });

  it("does not invent category synonyms", () => {
    const result = evaluateRequest(request({ id: "req_6", category: "Artificial Intelligence" }), bulk);
    expect(result.qualifies).toBe(true);
  });

  it("a missing category is handled conservatively when categories matter", () => {
    const result = evaluateRequest(request({ id: "req_8", category: undefined }), bulk);
    expect(result.qualifies === false && result.attention.type).toBe("MISSING_DATA");
  });

  it("a missing category is fine when no category rule applies", () => {
    const result = evaluateRequest(request({ id: "req_8", category: undefined }), { intent: "BULK_REVIEW", maxAmount: 5000 });
    expect(result.qualifies).toBe(true);
  });

  it("includedCategories only allows listed categories", () => {
    const intent: UserIntent = { intent: "BULK_REVIEW", includedCategories: ["Design"] };
    expect(evaluateRequest(request({ id: "a", category: "design" }), intent).qualifies).toBe(true);
    expect(evaluateRequest(request({ id: "b", category: "Infrastructure" }), intent).qualifies).toBe(false);
  });
});

describe("findVendorMatches", () => {
  it("matches exact vendor names only, trimmed and case-insensitive", () => {
    const pending = [
      request({ id: "1", vendorName: "Figma" }),
      request({ id: "2", vendorName: " figma " }),
      request({ id: "3", vendorName: "Figma Inc" }),
    ];
    expect(findVendorMatches(pending, "FIGMA").map((r) => r.id)).toEqual(["1", "2"]);
  });
});

describe("buildBulkReviewPlan", () => {
  it("proposes APPROVE for qualifying requests and explains the rest", () => {
    const pending = [
      request({ id: "req_1", vendorName: "Figma", amount: 1200 }),
      request({ id: "req_2", vendorName: "Datadog", amount: 7200 }),
      request({ id: "req_5", vendorName: "AcmeAI", existingVendor: false, category: "AI" }),
    ];
    const plan = buildBulkReviewPlan(pending, bulk);
    expect(plan.proposedActions).toEqual([{ type: "APPROVE", requestId: "req_1" }]);
    expect(plan.attentionItems.map((i) => i.type)).toEqual(["OVER_LIMIT", "NEW_VENDOR"]);
    expect(plan.requiresConfirmation).toBe(true);
  });

  it("requests in an aggregate-spend group are NOT proposed for approval", () => {
    const amounts = [920, 870, 940, 980, 890, 960];
    const pending = [
      request({ id: "req_1", vendorName: "Figma" }),
      ...amounts.map((amount, i) => request({ id: `openai_${i + 1}`, vendorName: "OpenAI", amount, category: "Research" })),
    ];
    const plan = buildBulkReviewPlan(pending, { intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true });
    expect(plan.proposedActions).toEqual([{ type: "APPROVE", requestId: "req_1" }]);
    const aggregate = plan.attentionItems.find((i) => i.type === "AGGREGATE_SPEND");
    expect(aggregate?.requestIds).toHaveLength(6);
    const approvedIds = plan.proposedActions.map((a) => a.requestId);
    expect(approvedIds.some((id) => aggregate!.requestIds.includes(id))).toBe(false);
  });

  it("merges identical attention reasons and lists aggregate flags first", () => {
    const pending = [
      request({ id: "req_1", vendorName: "Figma", amount: 1200 }),
      ...[3000, 3000].map((amount, i) => request({ id: `oa_${i}`, vendorName: "OpenAI", amount, category: "AI" })),
    ];
    const plan = buildBulkReviewPlan(pending, bulk);
    expect(plan.attentionItems).toEqual([
      { requestIds: ["oa_0", "oa_1"], type: "AGGREGATE_SPEND", reason: "Two OpenAI requests total $6,000." },
      { requestIds: ["oa_0", "oa_1"], type: "EXCLUDED_CATEGORY", reason: "OpenAI is in AI, which you excluded." },
    ]);
  });

  it("zero qualifying requests produce no actions and no confirmation", () => {
    const plan = buildBulkReviewPlan([request({ id: "req_2", amount: 9000 })], bulk);
    expect(plan.proposedActions).toEqual([]);
    expect(plan.requiresConfirmation).toBe(false);
  });

  it("a vendor-scoped review only considers that vendor", () => {
    const pending = [request({ id: "a", vendorName: "Figma" }), request({ id: "b", vendorName: "Adobe" })];
    const plan = buildBulkReviewPlan(pending, { intent: "BULK_REVIEW", vendor: "adobe" });
    expect(plan.proposedActions).toEqual([{ type: "APPROVE", requestId: "b" }]);
  });

  it("mixed currencies: requests outside the dominant currency are not compared to the limit", () => {
    const pending = [
      request({ id: "usd_1", vendorName: "Figma", currency: "USD" }),
      request({ id: "usd_2", vendorName: "Adobe", currency: "USD" }),
      request({ id: "cad_1", vendorName: "Shopify", currency: "CAD", amount: 4000 }),
    ];
    const plan = buildBulkReviewPlan(pending, { intent: "BULK_REVIEW", maxAmount: 5000 });
    expect(plan.proposedActions.map((a) => a.requestId)).toEqual(["usd_1", "usd_2"]);
    expect(plan.attentionItems).toEqual([expect.objectContaining({ requestIds: ["cad_1"], type: "OTHER" })]);
  });
});
