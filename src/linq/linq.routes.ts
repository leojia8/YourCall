import express, { Router, type ErrorRequestHandler } from "express";
import { handleMessage } from "../orchestration/agent";
import type { IncomingMessage, OutgoingMessage } from "../types";
import {
  IgnoredLinqEventError,
  isDuplicateWebhook,
  LinqApiError,
  LinqSignatureError,
  MalformedLinqWebhookError,
  normalizeLinqWebhook,
  sendMessage,
  startTyping,
  stopTyping,
  verifyLinqSignature,
} from "./linq.service";

const FALLBACK_REPLY = "Sorry, something went wrong on my end. Please try again in a moment.";

function describeError(err: unknown): string {
  if (err instanceof LinqApiError && err.traceId) {
    return `${err.name}: ${err.message} (trace_id ${err.traceId})`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The typing bubble is cosmetic: a failure is logged and must never affect the reply. */
async function tryTyping(action: (conversationId: string) => Promise<void>, conversationId: string): Promise<void> {
  try {
    await action(conversationId);
  } catch (err) {
    console.warn(`[linq] typing indicator failed for ${conversationId}:`, describeError(err));
  }
}

/**
 * Runs after we have already acknowledged the webhook. Orchestration (Gemini +
 * Zip) can be slow, and Linq times out after 10s and retries, which could make
 * the assistant act on the same message twice.
 */
async function processMessage(message: IncomingMessage): Promise<void> {
  // Show "..." while orchestration works. Not awaited yet, so it costs no time.
  const typing = tryTyping(startTyping, message.conversationId);

  let reply: string;
  try {
    reply = await handleMessage(message);
  } catch (err) {
    // Downstream (orchestration) failure, not bad input from Linq.
    console.error(`[linq] handleMessage failed for ${message.conversationId}:`, describeError(err));
    reply = FALLBACK_REPLY;
  }

  // Let "start" settle first: a late one could land after our reply and leave
  // the bubble showing. Sending a message clears it, so no "stop" is needed
  // when we do send.
  await typing;

  if (reply.trim() === "") {
    console.warn(`[linq] handleMessage returned an empty reply for ${message.conversationId}; not sending`);
    await tryTyping(stopTyping, message.conversationId);
    return;
  }

  const outgoing: OutgoingMessage = { conversationId: message.conversationId, text: reply };
  try {
    await sendMessage(outgoing.conversationId, outgoing.text);
  } catch (err) {
    console.error(`[linq] sendMessage failed for ${outgoing.conversationId}:`, describeError(err));
    await tryTyping(stopTyping, outgoing.conversationId);
  }
}

export const linqRouter = Router();

// Raw body: the signature is computed over the exact bytes Linq sent, so we
// verify first and only then parse the JSON ourselves.
linqRouter.post("/webhooks/linq", express.raw({ type: () => true, limit: "1mb" }), (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

  try {
    verifyLinqSignature(rawBody, req.headers);
  } catch (err) {
    if (err instanceof LinqSignatureError) {
      console.warn("[linq] rejected webhook:", describeError(err));
      res.status(401).json({ ok: false, error: "invalid signature" });
    } else {
      console.error("[linq] cannot verify webhooks:", describeError(err));
      res.status(500).json({ ok: false, error: "internal error" });
    }
    return;
  }

  let message: IncomingMessage;
  try {
    message = normalizeLinqWebhook(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof IgnoredLinqEventError) {
      // Logged so an unhandled shape (e.g. an unexpected voice-memo part) is visible.
      console.info("[linq] ignored event:", err.message);
      res.status(200).json({ ok: true, ignored: true });
    } else if (err instanceof MalformedLinqWebhookError || err instanceof SyntaxError) {
      console.warn("[linq] rejected malformed webhook:", describeError(err));
      res.status(400).json({ ok: false, error: "malformed webhook" });
    } else {
      console.error("[linq] unexpected error normalizing webhook:", describeError(err));
      res.status(500).json({ ok: false, error: "internal error" });
    }
    return;
  }

  // Linq delivers at-least-once; never act on the same event twice.
  if (isDuplicateWebhook(req.get("webhook-id") ?? "")) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  res.status(200).json({ ok: true });
  void processMessage(message);
});

// Body-read failures (e.g. payload too large) are input errors, not crashes.
const handleBodyError: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  console.warn("[linq] could not read webhook body:", describeError(err));
  res.status(status).json({ ok: false, error: status === 500 ? "internal error" : "invalid request body" });
};
linqRouter.use(handleBodyError);
