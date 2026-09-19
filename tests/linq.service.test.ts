import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  LINQ_API_KEY: "test-api-key-123",
  LINQ_BASE_URL: "https://api.linqapp.com/api/partner/v3/",
  LINQ_WEBHOOK_SECRET: "",
}));
vi.mock("../src/config/env", () => ({ env: mockEnv }));

import {
  buildIncomingMessage,
  IgnoredLinqEventError,
  isDuplicateWebhook,
  LinqApiError,
  LinqConfigError,
  LinqSignatureError,
  MalformedLinqWebhookError,
  normalizeLinqWebhook,
  sendMessage,
  verifyLinqSignature,
} from "../src/linq/linq.service";

// Payloads mirror the examples in https://docs.linqapp.com/channel/imessage/guides/webhooks/events/
const chat = { id: "8f392755-6865-4b18-880a-227f9d8b458f", is_group: false };
const inbound = (overrides: Record<string, unknown> = {}) => ({
  api_version: "v3",
  event_type: "message.received",
  event_id: "2915e81c-5068-4796-ace2-21d2c94ad298",
  data: {
    chat,
    id: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
    direction: "inbound",
    sender_handle: { handle: "+12025559876", is_me: false },
    parts: [{ type: "text", value: "Hello!" }],
    ...overrides,
  },
});

describe("normalizeLinqWebhook", () => {
  it("maps message.received to the shared IncomingMessage", () => {
    expect(normalizeLinqWebhook(inbound())).toEqual({
      conversationId: chat.id,
      sender: "+12025559876",
      text: "Hello!",
    });
  });

  it("joins multiple text parts and skips media parts", () => {
    const parts = [
      { type: "text", value: "line one" },
      { type: "media", url: "https://cdn.linqapp.com/x.jpg" },
      { type: "text", value: "line two" },
    ];
    expect(normalizeLinqWebhook(inbound({ parts })).text).toBe("line one\nline two");
  });

  it.each(["message.sent", "message.delivered", "message.read", "chat.created"])(
    "ignores %s events",
    (event_type) => {
      expect(() => normalizeLinqWebhook({ ...inbound(), event_type })).toThrow(IgnoredLinqEventError);
    },
  );

  it("ignores our own messages (avoids reply loops)", () => {
    expect(() => normalizeLinqWebhook(inbound({ direction: "outbound" }))).toThrow(IgnoredLinqEventError);
    expect(() =>
      normalizeLinqWebhook(inbound({ sender_handle: { handle: "+12025551234", is_me: true } })),
    ).toThrow(IgnoredLinqEventError);
  });

  it("ignores messages with no text (e.g. photo only)", () => {
    const parts = [{ type: "media", url: "https://cdn.linqapp.com/x.jpg" }];
    expect(() => normalizeLinqWebhook(inbound({ parts }))).toThrow(IgnoredLinqEventError);
  });

  it.each([
    ["a string", "hi"],
    ["an array", []],
    ["null", null],
    ["no event_type", { data: {} }],
    ["no data", { event_type: "message.received" }],
    ["no chat", { event_type: "message.received", data: { ...inbound().data, chat: undefined } }],
    ["no chat id", inbound({ chat: { is_group: false } })],
    ["no sender handle", inbound({ sender_handle: { is_me: false } })],
  ])("rejects malformed payload: %s", (_label, payload) => {
    expect(() => normalizeLinqWebhook(payload)).toThrow(MalformedLinqWebhookError);
  });
});

describe("buildIncomingMessage", () => {
  it.each([
    [undefined, "+1", "hi"],
    ["conv_1", "", "hi"],
    ["conv_1", "+1", "   "],
    ["conv_1", "+1", 42],
  ])("rejects invalid input (%s, %s, %s)", (id, sender, text) => {
    expect(() => buildIncomingMessage(id, sender, text)).toThrow(MalformedLinqWebhookError);
  });
});

describe("verifyLinqSignature", () => {
  const keyBytes = Buffer.from("super-secret-key-bytes-for-tests");
  const secret = `whsec_${keyBytes.toString("base64")}`;
  const body = JSON.stringify(inbound());
  const now = 1_780_000_000_000;
  const ts = String(now / 1000);
  const sign = (id: string, timestamp: string, payload: string) =>
    `v1,${createHmac("sha256", keyBytes).update(`${id}.${timestamp}.${payload}`).digest("base64")}`;
  const headers = (over: Record<string, string> = {}) => ({
    "webhook-id": "msg_1",
    "webhook-timestamp": ts,
    "webhook-signature": sign("msg_1", ts, body),
    ...over,
  });

  beforeEach(() => {
    mockEnv.LINQ_WEBHOOK_SECRET = secret;
  });

  it("accepts a correctly signed webhook", () => {
    expect(() => verifyLinqSignature(body, headers(), now)).not.toThrow();
  });

  it("accepts when one of several space-separated signatures matches", () => {
    const signature = `v1,${Buffer.from("nope").toString("base64")} ${sign("msg_1", ts, body)}`;
    expect(() => verifyLinqSignature(body, headers({ "webhook-signature": signature }), now)).not.toThrow();
  });

  it("rejects a tampered body", () => {
    expect(() => verifyLinqSignature(body + " ", headers(), now)).toThrow(LinqSignatureError);
  });

  it("rejects a signature made with a different secret", () => {
    const forged = `v1,${createHmac("sha256", "other").update(`msg_1.${ts}.${body}`).digest("base64")}`;
    expect(() => verifyLinqSignature(body, headers({ "webhook-signature": forged }), now)).toThrow(
      LinqSignatureError,
    );
  });

  it("rejects timestamps older than 5 minutes (replay protection)", () => {
    const old = String(now / 1000 - 301);
    const stale = headers({ "webhook-timestamp": old, "webhook-signature": sign("msg_1", old, body) });
    expect(() => verifyLinqSignature(body, stale, now)).toThrow(LinqSignatureError);
  });

  it("rejects missing headers", () => {
    expect(() => verifyLinqSignature(body, {}, now)).toThrow(LinqSignatureError);
  });

  it("fails loudly when no secret is configured", () => {
    mockEnv.LINQ_WEBHOOK_SECRET = "";
    expect(() => verifyLinqSignature(body, headers(), now)).toThrow(LinqConfigError);
  });
});

describe("isDuplicateWebhook", () => {
  it("flags repeats and forgets them after an hour", () => {
    const t = 1_000_000;
    expect(isDuplicateWebhook("evt_a", t)).toBe(false);
    expect(isDuplicateWebhook("evt_a", t + 1000)).toBe(true);
    expect(isDuplicateWebhook("evt_b", t + 1000)).toBe(false);
    expect(isDuplicateWebhook("evt_a", t + 60 * 60 * 1000 + 1)).toBe(false);
  });
});

describe("sendMessage", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockEnv.LINQ_API_KEY = "test-api-key-123";
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{"chat_id":"x"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs a text part to /chats/{id}/messages with a Bearer token", async () => {
    await sendMessage("8f392755-6865-4b18-880a-227f9d8b458f", "hello back");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.linqapp.com/api/partner/v3/chats/8f392755-6865-4b18-880a-227f9d8b458f/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-api-key-123",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ message: { parts: [{ type: "text", value: "hello back" }] } });
  });

  it("URL-encodes the chat id", async () => {
    await sendMessage("a/b c", "hi");
    expect(fetchMock.mock.calls[0]![0]).toContain("/chats/a%2Fb%20c/messages");
  });

  it("splits text over 10,000 characters into several messages", async () => {
    await sendMessage("chat_1", "x".repeat(10_000) + "\n" + "y".repeat(50));

    const sent = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).message.parts[0].value as string);
    expect(sent).toEqual(["x".repeat(10_000), "y".repeat(50)]);
  });

  it("hard-splits long text with no line breaks without losing characters", async () => {
    await sendMessage("chat_1", "z".repeat(25_000));

    const sent = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).message.parts[0].value as string);
    expect(sent.map((s) => s.length)).toEqual([10_000, 10_000, 5_000]);
  });

  it("throws LinqApiError with code and trace id, and never leaks the API key", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { status: 404, code: 2001, message: "Chat not found" },
            trace_id: "trace_abc",
          }),
          { status: 404 },
        ),
    );

    const err = await sendMessage("missing", "hi").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LinqApiError);
    expect(err).toMatchObject({ status: 404, code: 2001, traceId: "trace_abc" });
    expect(String((err as Error).message)).not.toContain("test-api-key-123");
  });

  it("carries retry_after on rate-limit errors", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ success: false, error: { status: 429, code: 1007, message: "slow down", retry_after: 7 } }), {
          status: 429,
        }),
    );
    await expect(sendMessage("chat_1", "hi")).rejects.toMatchObject({ status: 429, retryAfter: 7 });
  });

  it("handles a non-JSON error body", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(sendMessage("chat_1", "hi")).rejects.toMatchObject({ status: 502 });
  });

  it("does not call Linq without an API key", async () => {
    mockEnv.LINQ_API_KEY = "";
    await expect(sendMessage("chat_1", "hi")).rejects.toBeInstanceOf(LinqConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty input without calling Linq", async () => {
    await expect(sendMessage("", "hi")).rejects.toThrow();
    await expect(sendMessage("chat_1", "  ")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
