import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  LINQ_API_KEY: "test-api-key-123",
  LINQ_BASE_URL: "https://api.linqapp.com/api/partner/v3/",
  LINQ_WEBHOOK_SECRET: "",
  LINQ_FROM_NUMBER: "+16462049058",
}));
vi.mock("../src/config/env", () => ({ env: mockEnv }));

import { LinqApiError, LinqConfigError, normalizeLinqWebhook, sendMessage, startConversation } from "../src/linq/linq.service";

const CHAT = "8f392755-6865-4b18-880a-227f9d8b458f";
const NEW_CHAT = "94c6bf33-31d9-40e3-a0e9-f94250ecedb9";

interface Call {
  url: string;
  method: string;
  body: any;
}

let calls: Call[];
let counter = 0;
let respond: (call: Call) => Response;

/** Default Linq: creating a chat -> { chat: { id, message: { id } } }, sending -> { chat_id, message: { id } }. */
const defaultRespond = (call: Call): Response => {
  const id = `msg-${++counter}`;
  if (call.url.endsWith("/chats")) {
    return new Response(JSON.stringify({ chat: { id: NEW_CHAT, message: { id } } }), { status: 201 });
  }
  return new Response(JSON.stringify({ chat_id: CHAT, message: { id } }), { status: 200 });
};

const apiError = (status: number) =>
  new Response(JSON.stringify({ success: false, error: { status, code: 1005, message: "nope" }, trace_id: "t" }), { status });

beforeEach(() => {
  mockEnv.LINQ_API_KEY = "test-api-key-123";
  mockEnv.LINQ_FROM_NUMBER = "+16462049058";
  calls = [];
  respond = defaultRespond;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      return respond(call);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** What each request sent: "text:<value>" or "link:<value>". */
const sent = () => calls.map((c) => c.body.message.parts.map((p: any) => `${p.type}:${p.value}`).join("|"));

describe("sendMessage: rich link previews", () => {
  it("sends a URL on its own line as a link message, in order with the text around it", async () => {
    await sendMessage(CHAT, "Order approved.\nhttps://zip.example/po/123\nAnything else?");

    expect(sent()).toEqual(["text:Order approved.", "link:https://zip.example/po/123", "text:Anything else?"]);
    expect(calls.every((c) => c.body.message.parts.length === 1)).toBe(true); // a link must be the only part
  });

  it("sends a reply that is just a URL as one link message", async () => {
    await sendMessage(CHAT, "  https://zip.example/po/123  ");
    expect(sent()).toEqual(["link:https://zip.example/po/123"]);
  });

  it("keeps several links in order and drops the blank lines around them", async () => {
    await sendMessage(CHAT, "Two POs:\n\nhttps://zip.example/po/1\n\nhttps://zip.example/po/2\n\nDone.");
    expect(sent()).toEqual([
      "text:Two POs:",
      "link:https://zip.example/po/1",
      "link:https://zip.example/po/2",
      "text:Done.",
    ]);
  });

  it("handles Windows line endings", async () => {
    await sendMessage(CHAT, "Here:\r\nhttps://zip.example/po/1\r\nBye");
    expect(sent()).toEqual(["text:Here:", "link:https://zip.example/po/1", "text:Bye"]);
  });

  it.each([
    ["a URL inside a sentence", "See https://zip.example/po/1 for details"],
    ["a URL followed by words", "https://zip.example/po/1 is the link"],
    ["a non-http scheme", "ftp://zip.example/file"],
    ["an incomplete URL", "https://"],
    ["a bare domain", "zip.example/po/1"],
  ])("leaves %s as ordinary text, byte for byte", async (_label, text) => {
    await sendMessage(CHAT, text);
    expect(sent()).toEqual([`text:${text}`]);
  });

  it("does not turn an over-long URL into a link (Linq limit 2048)", async () => {
    const long = `https://zip.example/${"a".repeat(2100)}`;
    await sendMessage(CHAT, long);
    expect(sent()).toEqual([`text:${long}`]);
  });

  it("falls back to plain text when Linq refuses the preview, so the URL is never lost", async () => {
    respond = (call) => (call.body.message.parts[0].type === "link" ? apiError(400) : defaultRespond(call));

    await sendMessage(CHAT, "PO ready\nhttps://zip.example/po/1");

    expect(sent()).toEqual(["text:PO ready", "link:https://zip.example/po/1", "text:https://zip.example/po/1"]);
  });

  it("does not hide other failures behind the fallback", async () => {
    respond = () => apiError(500);
    await expect(sendMessage(CHAT, "https://zip.example/po/1")).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a rejected TEXT message as anything else", async () => {
    respond = () => apiError(400);
    await expect(sendMessage(CHAT, "hello")).rejects.toBeInstanceOf(LinqApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("startConversation (proactive alert)", () => {
  it("creates a chat from our number to the recipient and returns the new conversationId", async () => {
    const id = await startConversation("+14155559876", "3 requests need your approval.");

    expect(id).toBe(NEW_CHAT);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.linqapp.com/api/partner/v3/chats",
      method: "POST",
      body: {
        from: "+16462049058",
        to: ["+14155559876"],
        message: { parts: [{ type: "text", value: "3 requests need your approval." }] },
      },
    });
  });

  it("never overrides a recipient's opt-out", async () => {
    await startConversation("+14155559876", "hi");
    expect(calls[0]!.body).not.toHaveProperty("override_optout");
  });

  it("sends links as follow-ups in the new chat, since the first message can't contain one", async () => {
    const id = await startConversation("+14155559876", "PO #123 needs you.\nhttps://zip.example/po/123\nReact 👍 to approve.");

    expect(id).toBe(NEW_CHAT);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.linqapp.com/api/partner/v3/chats",
      `https://api.linqapp.com/api/partner/v3/chats/${NEW_CHAT}/messages`,
      `https://api.linqapp.com/api/partner/v3/chats/${NEW_CHAT}/messages`,
    ]);
    expect(sent()).toEqual(["text:PO #123 needs you.", "link:https://zip.example/po/123", "text:React 👍 to approve."]);
  });

  it.each([
    ["starts with a link line", "https://zip.example/po/1\nneeds you"],
    ["has a URL in the first sentence", "Approve https://zip.example/po/1 now"],
    ["has a www address", "Approve www.zip.example now"],
  ])("refuses, without calling Linq, when the first message %s", async (_label, text) => {
    await expect(startConversation("+14155559876", text)).rejects.toThrow(/cannot contain a link/);
    expect(calls).toHaveLength(0);
  });

  it("still returns the id (and logs) if a follow-up fails after the chat was created", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respond = (call) => (call.url.endsWith("/messages") ? apiError(500) : defaultRespond(call));

    await expect(startConversation("+14155559876", "Alert\nhttps://zip.example/po/1")).resolves.toBe(NEW_CHAT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(NEW_CHAT), expect.any(String));
  });

  it("throws LinqApiError (e.g. recipient opted out) and never leaks the API key", async () => {
    respond = () => apiError(403);

    const err = await startConversation("+14155559876", "hi").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LinqApiError);
    expect(err).toMatchObject({ status: 403, traceId: "t" });
    expect(String((err as Error).message)).not.toContain("test-api-key-123");
  });

  it("throws if Linq answers without a chat id", async () => {
    respond = () => new Response(JSON.stringify({ chat: {} }), { status: 201 });
    await expect(startConversation("+14155559876", "hi")).rejects.toBeInstanceOf(LinqApiError);
  });

  it("needs LINQ_FROM_NUMBER and LINQ_API_KEY, and calls nothing without them", async () => {
    mockEnv.LINQ_FROM_NUMBER = "";
    await expect(startConversation("+14155559876", "hi")).rejects.toBeInstanceOf(LinqConfigError);
    mockEnv.LINQ_FROM_NUMBER = "+16462049058";
    mockEnv.LINQ_API_KEY = "";
    await expect(startConversation("+14155559876", "hi")).rejects.toBeInstanceOf(LinqConfigError);
    expect(calls).toHaveLength(0);
  });

  it("rejects empty input without calling Linq", async () => {
    await expect(startConversation("", "hi")).rejects.toThrow();
    await expect(startConversation("+14155559876", "  ")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("makes a 👍 / 👎 on the alert count as approve / reject (the alert is remembered as ours)", async () => {
    respond = (call) =>
      call.url.endsWith("/chats")
        ? new Response(JSON.stringify({ chat: { id: NEW_CHAT, message: { id: "alert-msg-1" } } }), { status: 201 })
        : defaultRespond(call);
    await startConversation("+14155559876", "Approve the $4,200 laptop order?");

    const react = (reaction_type: string) =>
      normalizeLinqWebhook({
        event_type: "reaction.added",
        data: {
          chat_id: NEW_CHAT,
          message_id: "alert-msg-1",
          reaction_type,
          is_from_me: false,
          from_handle: { handle: "+14155559876", is_me: false },
        },
      });

    expect(react("like")).toEqual({ conversationId: NEW_CHAT, sender: "+14155559876", text: "approve" });
    expect(react("dislike").text).toBe("reject");
  });
});
