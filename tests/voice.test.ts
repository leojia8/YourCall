import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gemini/gemini.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gemini/gemini.service")>();
  return { ...actual, generateJson: vi.fn() };
});
vi.mock("../src/orchestration/zip.client", () => ({
  getPendingRequests: vi.fn(),
  getRequestById: vi.fn(),
  executeAction: vi.fn(),
}));

import { generateJson } from "../src/gemini/gemini.service";
import { buildVoicePrompt, parseVoiceIntent } from "../src/gemini/voice.parser";
import { handleMessage } from "../src/orchestration/agent";
import { getConversation, resetConversations } from "../src/orchestration/conversation.store";
import { downloadAudio } from "../src/orchestration/voice";
import * as zip from "../src/orchestration/zip.client";
import type { IncomingMessage, PurchaseRequest } from "../src/types";

const mockGenerate = vi.mocked(generateJson);
const mockPending = vi.mocked(zip.getPendingRequests);
const mockExecute = vi.mocked(zip.executeAction);
const mockFetch = vi.fn<typeof fetch>();

const PENDING: PurchaseRequest[] = [
  { id: "figma_001", vendor: { name: "Figma" }, amount: 1200, currency: "USD", status: "pending", existingVendor: true, category: "Design" },
  { id: "datadog_001", vendor: { name: "Datadog" }, amount: 7200, currency: "USD", status: "pending", existingVendor: true, category: "Infrastructure" },
];

const CONV = "conv_voice";
const AUDIO: NonNullable<IncomingMessage["audio"]> = {
  url: "https://cdn.linqapp.com/attachments/abc/voice.m4a?signature=x",
  mimeType: "audio/mp4",
  sizeBytes: 12_345,
};

function audioResponse(bytes = Buffer.from("fake-audio-bytes"), type = "audio/mp4"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": type } });
}

function voiceMessage(audio: IncomingMessage["audio"] = AUDIO): IncomingMessage {
  return { conversationId: CONV, sender: "+15195551234", text: "", audio };
}

function geminiVoiceReply(transcript: string, intent: Record<string, unknown>): string {
  return JSON.stringify({ transcript, ...intent });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerate.mockReset();
  resetConversations();
  vi.stubEnv("GEMINI_MODE", "live");
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockImplementation(async () => audioResponse());
  mockPending.mockResolvedValue(PENDING.map((r) => ({ ...r })));
  mockExecute.mockImplementation(async (action) => ({ requestId: action.requestId, action: action.type, success: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("downloadAudio", () => {
  it("returns base64 bytes and the content type", async () => {
    await expect(downloadAudio(AUDIO)).resolves.toEqual({
      base64: Buffer.from("fake-audio-bytes").toString("base64"),
      mimeType: "audio/mp4",
    });
  });

  it("falls back to the type Linq reported when the header is unhelpful", async () => {
    mockFetch.mockImplementation(async () => audioResponse(Buffer.from("x"), "application/octet-stream"));
    await expect(downloadAudio(AUDIO)).resolves.toMatchObject({ mimeType: "audio/mp4" });
  });

  it.each([
    ["a failed download", () => mockFetch.mockResolvedValue(new Response("", { status: 404 }))],
    ["a network error", () => mockFetch.mockRejectedValue(new Error("socket hang up"))],
    ["an empty clip", () => mockFetch.mockImplementation(async () => audioResponse(Buffer.alloc(0)))],
  ])("returns null on %s", async (_label, arrange) => {
    arrange();
    await expect(downloadAudio(AUDIO)).resolves.toBeNull();
  });

  it("refuses a clip that is too large before downloading it", async () => {
    await expect(downloadAudio({ ...AUDIO, sizeBytes: 50 * 1024 * 1024 })).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("parseVoiceIntent", () => {
  const clip = { base64: "AAAA", mimeType: "audio/mp4" };

  it("sends the clip inline with the prompt and returns transcript + intent", async () => {
    mockGenerate.mockResolvedValue(geminiVoiceReply("approve the Figma request", { intent: "APPROVE", vendor: "Figma" }));
    await expect(parseVoiceIntent(clip)).resolves.toEqual({
      transcript: "approve the Figma request",
      intent: { intent: "APPROVE", vendor: "Figma" },
    });
    expect(mockGenerate).toHaveBeenCalledWith(expect.stringContaining("voice memo"), expect.anything(), clip);
  });

  it("validates the intent like any other model output", async () => {
    mockGenerate.mockResolvedValue(geminiVoiceReply("do something", { intent: "NOT_A_REAL_INTENT" }));
    await expect(parseVoiceIntent(clip)).resolves.toEqual({ transcript: "do something", intent: { intent: "UNKNOWN" } });
  });

  it.each([
    ["Gemini fails", () => mockGenerate.mockRejectedValue(new Error("429 quota"))],
    ["output is malformed", () => mockGenerate.mockResolvedValue("not json")],
    ["the transcript is empty", () => mockGenerate.mockResolvedValue(geminiVoiceReply("   ", { intent: "GET_PENDING" }))],
  ])("returns null when %s", async (_label, arrange) => {
    arrange();
    await expect(parseVoiceIntent(clip)).resolves.toBeNull();
  });

  it("tells Gemini the real vendor names", () => {
    expect(buildVoicePrompt({ knownVendors: ["Figma"], knownCategories: ["AI"] })).toContain('["Figma"]');
  });
});

describe("handleMessage with a voice memo", () => {
  it("echoes the transcript and runs the normal flow", async () => {
    mockGenerate.mockResolvedValue(geminiVoiceReply("approve the Figma request", { intent: "APPROVE", vendor: "Figma" }));

    const reply = await handleMessage(voiceMessage());
    expect(reply).toBe('🎤 "approve the Figma request"\n\nFigma\'s request is $1,200. Approve it?');
    expect(mockExecute).not.toHaveBeenCalled();
    expect(getConversation(CONV).pendingPlan?.proposedActions).toEqual([{ type: "APPROVE", requestId: "figma_001" }]);
  });

  it("a spoken confirmation runs the saved plan", async () => {
    mockGenerate.mockResolvedValue(geminiVoiceReply("approve the Figma request", { intent: "APPROVE", vendor: "Figma" }));
    await handleMessage(voiceMessage());

    mockGenerate.mockResolvedValue(geminiVoiceReply("yes go ahead", { intent: "CONFIRM" }));
    const reply = await handleMessage(voiceMessage());
    expect(reply).toContain("Done — Figma's $1,200 request was approved.");
    expect(mockExecute).toHaveBeenCalledWith({ type: "APPROVE", requestId: "figma_001" });
  });

  it("asks for text when the clip can't be understood, and changes nothing", async () => {
    mockGenerate.mockRejectedValue(new Error("daily quota"));
    const reply = await handleMessage(voiceMessage());
    expect(reply).toContain("I couldn't make out that voice message");
    expect(reply).toContain("send it as text");
    expect(mockExecute).not.toHaveBeenCalled();
    expect(getConversation(CONV).status).toBe("IDLE");
  });

  it("keeps a waiting plan when the clip fails", async () => {
    mockGenerate.mockResolvedValue(geminiVoiceReply("approve the Figma request", { intent: "APPROVE", vendor: "Figma" }));
    await handleMessage(voiceMessage());

    mockGenerate.mockRejectedValue(new Error("network"));
    const reply = await handleMessage(voiceMessage());
    expect(reply).toContain("I couldn't make out that voice message");
    expect(reply).toContain("still waiting");
    expect(getConversation(CONV).status).toBe("AWAITING_CONFIRMATION");
  });

  it("asks for text when the download fails (no Gemini call is made)", async () => {
    mockFetch.mockResolvedValue(new Response("", { status: 403 }));
    const reply = await handleMessage(voiceMessage());
    expect(reply).toContain("I couldn't make out that voice message");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("a message with both text and audio uses the text (no audio download)", async () => {
    mockGenerate.mockResolvedValue(JSON.stringify({ intent: "GET_PENDING" }));
    const reply = await handleMessage({ ...voiceMessage(), text: "show me my pending purchases" });
    expect(reply).toContain("2 pending purchase requests");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("mock mode never spends quota on voice", () => {
  it("asks the user to text instead of calling Gemini", async () => {
    vi.stubEnv("GEMINI_MODE", "mock");
    const reply = await handleMessage(voiceMessage());
    expect(reply).toContain("I couldn't make out that voice message");
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
