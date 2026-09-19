// End-to-end milestones against the in-memory mock Zip (only Gemini is mocked).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gemini/intent.parser", () => ({ parseIntent: vi.fn() }));

import { parseIntent } from "../src/gemini/intent.parser";
import { handleMessage } from "../src/orchestration/agent";
import { getConversation, resetConversations } from "../src/orchestration/conversation.store";
import { getPendingRequests, resetMockZip } from "../src/orchestration/mock.zip";
import { buildBulkReviewPlan } from "../src/orchestration/rules";

const mockParse = vi.mocked(parseIntent);

beforeEach(() => {
  vi.clearAllMocks();
  resetConversations();
  resetMockZip();
});

describe("milestone 1: intent -> deterministic ActionPlan", () => {
  it("'handle everything under 5k from existing vendors but don't touch AI'", async () => {
    const plan = buildBulkReviewPlan(await getPendingRequests(), {
      intent: "BULK_REVIEW",
      maxAmount: 5000,
      existingVendorsOnly: true,
      excludedCategories: ["AI"],
    });
    expect(plan.proposedActions.map((a) => a.requestId)).toEqual(["req_1", "req_3", "req_4", "req_9"]);
    const summary = plan.attentionItems.map((i) => `${i.type}:${i.requestIds.join(",")}`);
    const openAiIds = "openai_1,openai_2,openai_3,openai_4,openai_5,openai_6";
    expect(summary).toEqual([
      `AGGREGATE_SPEND:${openAiIds}`,
      "OVER_LIMIT:req_2",
      "NEW_VENDOR:req_5",
      "EXCLUDED_CATEGORY:req_6",
      "MISSING_DATA:req_7",
      "MISSING_DATA:req_8",
      `EXCLUDED_CATEGORY:${openAiIds}`,
    ]);
    expect(plan.requiresConfirmation).toBe(true);
  });
});

describe("milestone 2: two-message confirmation flow", () => {
  it("'handle existing vendors under 5k' then 'yes'", async () => {
    mockParse.mockResolvedValueOnce({ intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true });
    const first = await handleMessage({ conversationId: "test_1", sender: "test", text: "handle existing vendors under 5k" });
    expect(first).toContain("6 routine requests match your instructions");
    expect(getConversation("test_1").status).toBe("AWAITING_CONFIRMATION");

    mockParse.mockResolvedValueOnce({ intent: "CONFIRM" });
    const second = await handleMessage({ conversationId: "test_1", sender: "test", text: "yes" });
    expect(second).toContain("Done — 5 requests were approved");
    expect(second).toContain("I couldn't approve Notion's $600 request: Request is no longer awaiting approval.");
    expect(getConversation("test_1").status).toBe("IDLE");

    const stillPending = (await getPendingRequests()).map((r) => r.id);
    expect(stillPending).not.toContain("req_1");
    expect(stillPending).toContain("req_9");
    expect(stillPending).toContain("openai_1");
  });
});
