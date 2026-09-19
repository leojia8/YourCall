import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gemini/intent.parser", () => ({ parseIntent: vi.fn() }));
vi.mock("../src/orchestration/zip.client", () => ({
  getPendingRequests: vi.fn(),
  getRequestById: vi.fn(),
  executeAction: vi.fn(),
}));

import { parseIntent } from "../src/gemini/intent.parser";
import { handleMessage } from "../src/orchestration/agent";
import { getConversation, getPendingPlan, resetConversations } from "../src/orchestration/conversation.store";
import * as zip from "../src/orchestration/zip.client";
import type { PurchaseRequest, UserIntent } from "../src/types";

const mockParse = vi.mocked(parseIntent);
const mockPending = vi.mocked(zip.getPendingRequests);
const mockExecute = vi.mocked(zip.executeAction);
const mockById = vi.mocked(zip.getRequestById);

function req(id: string, vendor: string, amount: number, extra: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return { id, vendor: { name: vendor }, amount, currency: "USD", status: "pending", existingVendor: true, category: "Design", ...extra };
}

const PENDING: PurchaseRequest[] = [
  req("figma_001", "Figma", 1200),
  req("adobe_001", "Adobe", 2300),
  req("datadog_001", "Datadog", 7200, { category: "Infrastructure" }),
  ...[920, 870, 940, 980, 890, 960].map((amount, i) => req(`openai_${i + 1}`, "OpenAI", amount, { category: "AI" })),
];

const CONV = "conv_test";

async function say(intent: UserIntent, text = "msg"): Promise<string> {
  mockParse.mockResolvedValueOnce(intent);
  return handleMessage({ conversationId: CONV, sender: "+15195551234", text });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetConversations();
  mockPending.mockResolvedValue(PENDING.map((r) => ({ ...r })));
  mockExecute.mockImplementation(async (action) => ({ requestId: action.requestId, action: action.type, success: true }));
  mockById.mockResolvedValue(null);
});

describe("CONFIRM / CANCEL", () => {
  it("CONFIRM without a pending plan executes nothing", async () => {
    const reply = await say({ intent: "CONFIRM" }, "yes");
    expect(reply).toBe("There's nothing waiting for confirmation.");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("CANCEL clears pending state and does not call Zip writes", async () => {
    await say({ intent: "APPROVE", vendor: "Figma" });
    expect(getConversation(CONV).status).toBe("AWAITING_CONFIRMATION");

    const reply = await say({ intent: "CANCEL" }, "never mind");
    expect(reply).toBe("Cancelled. I didn't make any changes.");
    expect(getConversation(CONV)).toEqual({ conversationId: CONV, status: "IDLE" });
    expect(mockExecute).not.toHaveBeenCalled();

    await say({ intent: "CONFIRM" }, "yes");
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("APPROVE / DENY", () => {
  it("initial APPROVE does not execute before confirmation", async () => {
    const reply = await say({ intent: "APPROVE", vendor: "figma" }, "approve the Figma request");
    expect(reply).toBe("Figma's request is $1,200. Approve it?");
    expect(mockExecute).not.toHaveBeenCalled();
    expect(getConversation(CONV).pendingPlan).toEqual({
      proposedActions: [{ type: "APPROVE", requestId: "figma_001" }],
      attentionItems: [],
      requiresConfirmation: true,
    });
  });

  it("initial DENY does not execute before confirmation", async () => {
    const reply = await say({ intent: "DENY", vendor: "Datadog" });
    expect(reply).toBe("Datadog's request is $7,200. Deny it?");
    expect(mockExecute).not.toHaveBeenCalled();
    expect(getConversation(CONV).pendingPlan?.proposedActions).toEqual([{ type: "DENY", requestId: "datadog_001" }]);
  });

  it("CONFIRM executes the previously saved ProposedAction exactly once", async () => {
    await say({ intent: "APPROVE", vendor: "Figma" });
    const reply = await say({ intent: "CONFIRM" }, "yes");

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith({ type: "APPROVE", requestId: "figma_001" });
    expect(reply).toBe("Done — Figma's $1,200 request was approved.");
    expect(getConversation(CONV).status).toBe("IDLE");

    await say({ intent: "CONFIRM" }, "yes");
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("two concurrent confirmations only execute the plan once", async () => {
    await say({ intent: "APPROVE", vendor: "Figma" });
    await Promise.all([say({ intent: "CONFIRM" }), say({ intent: "CONFIRM" })]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("multiple vendor matches do not cause a guessed action", async () => {
    const reply = await say({ intent: "APPROVE", vendor: "OpenAI" });
    expect(reply).toContain("won't guess");
    expect(reply).toContain("openai_1");
    expect(getPendingPlan(CONV)).toBeUndefined();
    await say({ intent: "CONFIRM" });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("no vendor matches do not cause execution", async () => {
    const reply = await say({ intent: "APPROVE", vendor: "Salesforce" });
    expect(reply).toContain("couldn't find a pending request from Salesforce");
    expect(getPendingPlan(CONV)).toBeUndefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a Gemini-supplied requestId is only used if it exists in real pending data", async () => {
    const reply = await say({ intent: "APPROVE", requestId: "made_up_123" });
    expect(reply).toContain("couldn't find a pending request with ID made_up_123");
    expect(getPendingPlan(CONV)).toBeUndefined();

    await say({ intent: "APPROVE", requestId: "openai_3" });
    expect(getConversation(CONV).pendingPlan?.proposedActions).toEqual([{ type: "APPROVE", requestId: "openai_3" }]);
  });

  it("approving a request in an aggregate-flagged group warns in the confirmation", async () => {
    const reply = await say({ intent: "APPROVE", requestId: "openai_3" });
    expect(reply).toContain("Heads up: Six OpenAI requests total $5,560.");
  });
});

describe("partial failures", () => {
  it("summarizes partial ActionResult failures accurately", async () => {
    await say({ intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true, excludedCategories: ["AI"] });
    expect(getConversation(CONV).pendingPlan?.proposedActions).toHaveLength(2);

    mockExecute.mockImplementation(async (action) =>
      action.requestId === "adobe_001"
        ? { requestId: action.requestId, action: action.type, success: false, error: "Request is no longer awaiting approval." }
        : { requestId: action.requestId, action: action.type, success: true }
    );
    const reply = await say({ intent: "CONFIRM" }, "yes");
    expect(reply).toBe(
      "Done — Figma's $1,200 request was approved.\nI couldn't approve Adobe's $2,300 request: Request is no longer awaiting approval."
    );
  });

  it("a rejected executeAction promise is reported as a failure, not a crash", async () => {
    await say({ intent: "BULK_REVIEW", maxAmount: 5000 });
    mockExecute.mockImplementation(async (action) => {
      if (action.requestId === "figma_001") throw new Error("Zip timeout");
      return { requestId: action.requestId, action: action.type, success: true };
    });
    const reply = await say({ intent: "CONFIRM" }, "yes");
    expect(reply).toContain("Done — Adobe's $2,300 request was approved.");
    expect(reply).toContain("I couldn't approve Figma's $1,200 request: Zip timeout");
  });
});

describe("read-only flows", () => {
  it("GET_PENDING performs no writes", async () => {
    const reply = await say({ intent: "GET_PENDING" }, "show me my pending purchases");
    expect(reply).toMatch(/^You have 9 pending purchase requests totaling \$16,260\./);
    expect(reply).toContain("Six OpenAI requests total $5,560.");
    expect(mockExecute).not.toHaveBeenCalled();
    expect(getPendingPlan(CONV)).toBeUndefined();
  });

  it("read-only GET_PENDING preserves an existing pending plan", async () => {
    await say({ intent: "APPROVE", vendor: "Figma" });
    const before = getConversation(CONV);
    const reply = await say({ intent: "GET_PENDING" });
    expect(getConversation(CONV)).toEqual(before);
    expect(reply).toContain("Your earlier plan to approve Figma's $1,200 request is still waiting.");
  });

  it("INVESTIGATE explains aggregate spend from real data and preserves the plan", async () => {
    await say({ intent: "APPROVE", vendor: "Figma" });
    const reply = await say({ intent: "INVESTIGATE", vendor: "OpenAI" }, "why did you flag OpenAI?");
    expect(reply).toContain("OpenAI has six pending requests totaling $5,560.");
    expect(reply).toContain("It's flagged because six OpenAI requests total $5,560.");
    expect(reply).toContain("the largest single request is $980");
    expect(getPendingPlan(CONV)?.plan.proposedActions).toEqual([{ type: "APPROVE", requestId: "figma_001" }]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("UNKNOWN executes nothing and preserves the plan", async () => {
    await say({ intent: "APPROVE", vendor: "Figma" });
    const reply = await say({ intent: "UNKNOWN" }, "what's the weather");
    expect(reply).toContain("I didn't quite understand that.");
    expect(getPendingPlan(CONV)).toBeDefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("plan replacement", () => {
  it("a successfully built new consequential plan replaces the previous pending plan", async () => {
    await say({ intent: "APPROVE", vendor: "Figma" });
    const reply = await say({ intent: "DENY", vendor: "Adobe" });
    expect(reply).toContain("(This replaces your earlier plan.)");
    expect(getConversation(CONV).pendingPlan?.proposedActions).toEqual([{ type: "DENY", requestId: "adobe_001" }]);

    await say({ intent: "CONFIRM" });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith({ type: "DENY", requestId: "adobe_001" });
  });

  it("a consequential command that fails to build a plan keeps the old plan", async () => {
    await say({ intent: "APPROVE", vendor: "Figma" });
    await say({ intent: "APPROVE", vendor: "OpenAI" }); // ambiguous
    await say({ intent: "BULK_REVIEW", maxAmount: 100 }); // nothing qualifies
    expect(getConversation(CONV).pendingPlan?.proposedActions).toEqual([{ type: "APPROVE", requestId: "figma_001" }]);
  });
});

describe("BULK_REVIEW", () => {
  it("builds the plan deterministically, saves it, and asks for confirmation", async () => {
    const reply = await say({ intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true, excludedCategories: ["AI"] });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(getConversation(CONV).pendingPlan?.proposedActions).toEqual([
      { type: "APPROVE", requestId: "figma_001" },
      { type: "APPROVE", requestId: "adobe_001" },
    ]);
    expect(reply).toContain("• Figma — $1,200 (Design)");
    expect(reply).toContain("Datadog is $7,200, above your $5,000 limit.");
    expect(reply).toContain("Six OpenAI requests total $5,560.");
    expect(reply).toContain("Want me to approve these 2?");
  });

  it("does not save a plan when nothing qualifies", async () => {
    const reply = await say({ intent: "BULK_REVIEW", maxAmount: 100 });
    expect(reply).toContain("Nothing can be handled automatically");
    expect(getPendingPlan(CONV)).toBeUndefined();
  });
});

describe("failures", () => {
  it("a Zip read failure returns a concise message and fabricates nothing", async () => {
    mockPending.mockRejectedValue(new Error("503"));
    const reply = await say({ intent: "GET_PENDING" });
    expect(reply).toContain("couldn't load your purchase requests from Zip");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("handleMessage never throws", async () => {
    mockParse.mockRejectedValueOnce(new Error("boom"));
    await expect(handleMessage({ conversationId: CONV, sender: "x", text: "hi" })).resolves.toBe(
      "Sorry, something went wrong on my end. Please try again."
    );
  });
});
