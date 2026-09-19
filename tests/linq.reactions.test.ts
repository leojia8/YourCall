import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  LINQ_API_KEY: "test-api-key-123",
  LINQ_BASE_URL: "https://api.linqapp.com/api/partner/v3/",
  LINQ_WEBHOOK_SECRET: "",
}));
vi.mock("../src/config/env", () => ({ env: mockEnv }));

import {
  IgnoredLinqEventError,
  MalformedLinqWebhookError,
  normalizeLinqWebhook,
  sendMessage,
} from "../src/linq/linq.service";

// Payload mirrors the reaction.added example in Linq's OpenAPI spec
// (https://cdn.linqapp.com/openapi/linq-api-v3.yaml).
const CHAT_ID = "550e8400-e29b-41d4-a716-446655440000";
const reaction = (data: Record<string, unknown> = {}, event_type = "reaction.added") => ({
  api_version: "v3",
  event_type,
  event_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  data: {
    chat_id: CHAT_ID,
    message_id: "550e8400-e29b-41d4-a716-446655440001",
    part_index: 0,
    reaction_type: "like",
    custom_emoji: null,
    is_from_me: false,
    from: "+14155559876",
    from_handle: { id: "h1", handle: "+14155559876", is_me: false, service: "iMessage" },
    service: "iMessage",
    sticker: null,
    ...data,
  },
});

/** Sends a message through the (mocked) Linq API so Linq "returns" this message id. */
async function sendAs(messageId: string): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ chat_id: CHAT_ID, message: { id: messageId } }), { status: 200 })),
  );
  await sendMessage(CHAT_ID, "Approve the $4,200 laptop order? React 👍 to approve, 👎 to reject.");
}

let n = 0;
let ours: string; // an id of a message we sent, unique per test (module state is shared)

beforeEach(async () => {
  ours = `sent-message-${++n}`;
  await sendAs(ours);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reaction.added on a message we sent", () => {
  it.each([
    ["like", "approve"],
    ["love", "approve"],
    ["dislike", "reject"],
  ])("maps %s to the text %s", (reaction_type, text) => {
    expect(normalizeLinqWebhook(reaction({ message_id: ours, reaction_type }))).toEqual({
      conversationId: CHAT_ID,
      sender: "+14155559876",
      text,
    });
  });

  it.each(["laugh", "emphasize", "question", "custom", "sticker", "constructor", "toString", "", 7, null])(
    "ignores reaction type %s",
    (reaction_type) => {
      expect(() => normalizeLinqWebhook(reaction({ message_id: ours, reaction_type }))).toThrow(IgnoredLinqEventError);
    },
  );

  it("ignores reactions we made ourselves (is_from_me / from_handle.is_me)", () => {
    expect(() => normalizeLinqWebhook(reaction({ message_id: ours, is_from_me: true }))).toThrow(IgnoredLinqEventError);
    expect(() =>
      normalizeLinqWebhook(reaction({ message_id: ours, from_handle: { handle: "+12025551234", is_me: true } })),
    ).toThrow(IgnoredLinqEventError);
  });

  it("stops recognising the message after 24 hours", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    expect(() => normalizeLinqWebhook(reaction({ message_id: ours }))).toThrow(IgnoredLinqEventError);
  });
});

describe("reactions that must NOT count as approval", () => {
  it("ignores a reaction to a message we did not send", () => {
    expect(() => normalizeLinqWebhook(reaction({ message_id: "someone-elses-message" }))).toThrow(IgnoredLinqEventError);
  });

  it("ignores a reaction with no message_id", () => {
    expect(() => normalizeLinqWebhook(reaction({ message_id: undefined }))).toThrow(IgnoredLinqEventError);
  });

  it("ignores reaction.removed (un-liking is not a decision)", () => {
    expect(() => normalizeLinqWebhook(reaction({ message_id: ours }, "reaction.removed"))).toThrow(IgnoredLinqEventError);
  });
});

describe("malformed reaction events", () => {
  // Each case keeps a valid message id so it gets past the "did we send it" check.
  it.each<[string, (messageId: string) => unknown]>([
    ["no data", () => ({ event_type: "reaction.added" })],
    ["no from_handle", (message_id) => reaction({ message_id, from_handle: undefined })],
    ["no chat_id", (message_id) => reaction({ message_id, chat_id: undefined })],
    ["no sender handle", (message_id) => reaction({ message_id, from_handle: { is_me: false } })],
  ])("rejects: %s", (_label, build) => {
    expect(() => normalizeLinqWebhook(build(ours))).toThrow(MalformedLinqWebhookError);
  });
});

describe("sendMessage recording message ids", () => {
  it("still succeeds when Linq's success body has no message id or is not JSON", async () => {
    for (const body of ['{"chat_id":"x"}', "not json", ""]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
      await expect(sendMessage(CHAT_ID, "hi")).resolves.toBeUndefined();
    }
  });

  it("does not treat a message as ours until sendMessage has recorded it", async () => {
    const id = `not-yet-sent-${n}`;
    expect(() => normalizeLinqWebhook(reaction({ message_id: id }))).toThrow(IgnoredLinqEventError);

    await sendAs(id);

    expect(normalizeLinqWebhook(reaction({ message_id: id })).text).toBe("approve");
  });
});
