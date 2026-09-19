import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/orchestration/agent", () => ({ handleMessage: vi.fn() }));
// Keep the real error classes (the route uses instanceof); mock only the I/O and crypto functions.
vi.mock("../src/linq/linq.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/linq/linq.service")>()),
  verifyLinqSignature: vi.fn(),
  isDuplicateWebhook: vi.fn(),
  normalizeLinqWebhook: vi.fn(),
  sendMessage: vi.fn(),
}));

import { linqRouter } from "../src/linq/linq.routes";
import {
  IgnoredLinqEventError,
  isDuplicateWebhook,
  LinqConfigError,
  LinqSignatureError,
  MalformedLinqWebhookError,
  normalizeLinqWebhook,
  sendMessage,
  verifyLinqSignature,
} from "../src/linq/linq.service";
import { handleMessage } from "../src/orchestration/agent";

const message = { conversationId: "conv_abc123", sender: "+15195551234", text: "hello" };

let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(linqRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/linq`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const post = (body: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": "msg_1" },
    body,
  });

describe("POST /webhooks/linq", () => {
  it("IncomingMessage -> handleMessage() -> string -> sendMessage()", async () => {
    vi.mocked(normalizeLinqWebhook).mockReturnValue(message);
    vi.mocked(handleMessage).mockResolvedValue("hello back");

    const res = await post('{"event_type":"message.received"}');

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith("conv_abc123", "hello back"));
    expect(handleMessage).toHaveBeenCalledWith(message);
  });

  it("verifies the signature against the exact raw body", async () => {
    vi.mocked(normalizeLinqWebhook).mockReturnValue(message);
    vi.mocked(handleMessage).mockResolvedValue("ok");
    const raw = '{ "spacing":   "matters" }';

    await post(raw);

    expect(verifyLinqSignature).toHaveBeenCalledWith(raw, expect.objectContaining({ "webhook-id": "msg_1" }));
  });

  it("returns 401 for a bad signature and does nothing else", async () => {
    vi.mocked(verifyLinqSignature).mockImplementation(() => {
      throw new LinqSignatureError("signature does not match");
    });

    const res = await post("{}");

    expect(res.status).toBe(401);
    expect(normalizeLinqWebhook).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("returns 500 (so Linq retries) when the webhook secret is not configured", async () => {
    vi.mocked(verifyLinqSignature).mockImplementation(() => {
      throw new LinqConfigError("LINQ_WEBHOOK_SECRET must be set in .env");
    });

    expect((await post("{}")).status).toBe(500);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed events and never calls orchestration", async () => {
    vi.mocked(normalizeLinqWebhook).mockImplementation(() => {
      throw new MalformedLinqWebhookError("bad");
    });

    const res = await post("{}");

    expect(res.status).toBe(400);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(normalizeLinqWebhook).not.toHaveBeenCalled();
  });

  it("acknowledges events that need no reply", async () => {
    vi.mocked(normalizeLinqWebhook).mockImplementation(() => {
      throw new IgnoredLinqEventError("receipt");
    });

    const res = await post("{}");

    expect(res.status).toBe(200);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("acknowledges but does not reprocess a duplicate delivery", async () => {
    vi.mocked(normalizeLinqWebhook).mockReturnValue(message);
    vi.mocked(isDuplicateWebhook).mockReturnValue(true);

    const res = await post("{}");

    expect(res.status).toBe(200);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("still answers 200 and tells the user when orchestration fails", async () => {
    vi.mocked(normalizeLinqWebhook).mockReturnValue(message);
    vi.mocked(handleMessage).mockRejectedValue(new Error("gemini down"));

    const res = await post("{}");

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith("conv_abc123", expect.stringMatching(/went wrong/)),
    );
  });

  it("does not send an empty reply", async () => {
    vi.mocked(normalizeLinqWebhook).mockReturnValue(message);
    vi.mocked(handleMessage).mockResolvedValue("   ");

    expect((await post("{}")).status).toBe(200);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("survives sendMessage failing", async () => {
    vi.mocked(normalizeLinqWebhook).mockReturnValue(message);
    vi.mocked(handleMessage).mockResolvedValue("hi");
    vi.mocked(sendMessage).mockRejectedValue(new Error("linq down"));

    expect((await post("{}")).status).toBe(200);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect((await post("{}")).status).toBe(200); // server still up and serving
  });
});
