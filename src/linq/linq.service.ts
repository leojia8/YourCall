import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { env } from "../config/env";
import type { IncomingMessage } from "../types";
import type {
  LinqCreateChatRequest,
  LinqErrorEnvelope,
  LinqOutboundPart,
  LinqSendMessageRequest,
} from "./linq.types";

// Everything Linq-specific lives in this file and linq.types.ts.
// Docs: https://docs.linqapp.com/channel/imessage/

// ---------------------------------------------------------------------------
// Errors: let the route tell "bad input" apart from "our problem" without
// knowing anything about Linq.
// ---------------------------------------------------------------------------

/** The webhook body is not something we can interpret (respond 400). */
export class MalformedLinqWebhookError extends Error {
  override name = "MalformedLinqWebhookError";
}

/** A valid Linq event that needs no reply, e.g. a delivery receipt (respond 200). */
export class IgnoredLinqEventError extends Error {
  override name = "IgnoredLinqEventError";
}

/** Webhook signature missing, wrong, or too old (respond 401). */
export class LinqSignatureError extends Error {
  override name = "LinqSignatureError";
}

/** Required Linq env vars are missing. */
export class LinqConfigError extends Error {
  override name = "LinqConfigError";
}

/** Linq's API answered with a non-2xx status. */
export class LinqApiError extends Error {
  override name = "LinqApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly traceId?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Inbound: verify + de-duplicate + normalize
// ---------------------------------------------------------------------------

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60; // Linq: reject if older than 5 minutes

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * Verifies a Linq webhook (Standard Webhooks scheme): HMAC-SHA256 over
 * `{webhook-id}.{webhook-timestamp}.{rawBody}` with the base64-decoded
 * `whsec_...` secret, compared against the `v1,<base64>` entries in
 * `webhook-signature`. Must be given the RAW body, not re-serialized JSON.
 *
 * Throws LinqSignatureError on any failure, LinqConfigError if no secret is set.
 */
export function verifyLinqSignature(
  rawBody: string,
  headers: IncomingHttpHeaders,
  nowMs: number = Date.now(),
): void {
  if (env.LINQ_WEBHOOK_SECRET === "") {
    throw new LinqConfigError("LINQ_WEBHOOK_SECRET must be set in .env");
  }

  const id = headerValue(headers, "webhook-id");
  const timestamp = headerValue(headers, "webhook-timestamp");
  const signature = headerValue(headers, "webhook-signature");
  if (id === "" || timestamp === "" || signature === "") {
    throw new LinqSignatureError("missing webhook-id, webhook-timestamp or webhook-signature header");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new LinqSignatureError("invalid webhook-timestamp");
  }
  if (Math.abs(nowMs / 1000 - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new LinqSignatureError("webhook-timestamp outside the allowed tolerance");
  }

  const secret = env.LINQ_WEBHOOK_SECRET.replace(/^whsec_/, "");
  const expected = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  const matches = signature.split(" ").some((entry) => {
    if (!entry.startsWith("v1,")) return false;
    const candidate = Buffer.from(entry.slice(3), "base64");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!matches) {
    throw new LinqSignatureError("signature does not match");
  }
}

// Linq delivers at-least-once, so the same event can arrive twice. In-memory is
// enough: duplicates arrive within Linq's ~25 minute retry window.
const DEDUPE_TTL_MS = 60 * 60 * 1000;
const seenWebhookIds = new Map<string, number>();

/** Returns true if this webhook-id was already accepted; otherwise records it. */
export function isDuplicateWebhook(webhookId: string, nowMs: number = Date.now()): boolean {
  for (const [id, seenAt] of seenWebhookIds) {
    if (nowMs - seenAt > DEDUPE_TTL_MS) seenWebhookIds.delete(id);
  }
  if (seenWebhookIds.has(webhookId)) return true;
  seenWebhookIds.set(webhookId, nowMs);
  return false;
}

// ---------------------------------------------------------------------------
// Reactions: a tapback on a message WE sent becomes a plain IncomingMessage
// ("yes" / "no"), so orchestration needs no new contract. The words are the ones
// orchestration already treats as CONFIRM / CANCEL for a saved plan.
// ---------------------------------------------------------------------------

// Map, not an object: `{}["constructor"]` would be truthy.
const REACTION_TEXT = new Map([
  ["like", "yes"],
  ["love", "yes"],
  ["dislike", "no"],
]);

// Only reactions to messages we sent count, otherwise a thumbs-up on any old
// message (or on the user's own text) would read as a confirmation. In-memory,
// so it is empty after a restart; a manager may react hours later, hence 24h.
const SENT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_MESSAGES = 1000;
const sentMessageIds = new Map<string, number>();

function rememberSentMessage(id: string, nowMs: number = Date.now()): void {
  sentMessageIds.set(id, nowMs);
  // Map iterates oldest-first: drop expired entries and anything over the cap.
  for (const [oldId, sentAt] of sentMessageIds) {
    if (sentMessageIds.size <= MAX_REMEMBERED_MESSAGES && nowMs - sentAt <= SENT_MESSAGE_TTL_MS) break;
    sentMessageIds.delete(oldId);
  }
}

function wasSentByUs(id: string, nowMs: number = Date.now()): boolean {
  const sentAt = sentMessageIds.get(id);
  return sentAt !== undefined && nowMs - sentAt <= SENT_MESSAGE_TTL_MS;
}

// "yes" can execute a saved plan, so a thumbs-up is a much bigger deal than a
// thumbs-down. It only counts on the messages of our LATEST send in that chat
// (one send can be several messages, e.g. text + link card): a casual tap on an
// old message can never confirm anything. A thumbs-down ("no" = cancel) is safe
// on any message we sent.
const latestSendByChat = new Map<string, { ids: Set<string>; at: number }>();

/** Records everything one send put into a chat, replacing the chat's previous latest send. */
function rememberSend(chatId: string, messageIds: string[], nowMs: number = Date.now()): void {
  for (const id of messageIds) rememberSentMessage(id, nowMs);
  // Recorded even when empty: if we sent something we could not track, an older
  // prompt is no longer the latest, so a thumbs-up on it must not count.
  latestSendByChat.delete(chatId); // re-insert so Map order stays oldest-first
  latestSendByChat.set(chatId, { ids: new Set(messageIds), at: nowMs });
  while (latestSendByChat.size > MAX_REMEMBERED_MESSAGES) {
    const oldest = latestSendByChat.keys().next().value;
    if (oldest === undefined) break;
    latestSendByChat.delete(oldest);
  }
}

function isInLatestSend(chatId: string, messageId: string, nowMs: number = Date.now()): boolean {
  const latest = latestSendByChat.get(chatId);
  return latest !== undefined && nowMs - latest.at <= SENT_MESSAGE_TTL_MS && latest.ids.has(messageId);
}

/**
 * reaction.added -> IncomingMessage with text "yes" (like/love, only on our
 * latest reply) or "no" (dislike, on any message we sent). Field mapping (from
 * Linq's OpenAPI spec):
 *   conversationId <- data.chat_id
 *   sender         <- data.from_handle.handle
 * Everything else (other tapbacks, our own reactions, reactions on messages we
 * did not send) is ignored. reaction.removed is never subscribed to or acted on.
 */
function normalizeLinqReaction(payload: Record<string, unknown>): IncomingMessage {
  const data = payload.data;
  if (!isRecord(data) || !isRecord(data.from_handle)) {
    throw new MalformedLinqWebhookError("reaction.added is missing data or data.from_handle");
  }
  if (data.is_from_me === true || data.from_handle.is_me === true) {
    throw new IgnoredLinqEventError("reaction was not from the user");
  }
  const decision = typeof data.reaction_type === "string" ? REACTION_TEXT.get(data.reaction_type) : undefined;
  if (decision === undefined) {
    throw new IgnoredLinqEventError(`reaction type is not approve or reject: ${String(data.reaction_type)}`);
  }
  if (typeof data.message_id !== "string" || !wasSentByUs(data.message_id)) {
    throw new IgnoredLinqEventError("reaction is not on a message we sent");
  }
  const message = buildIncomingMessage(data.chat_id, data.from_handle.handle, decision);
  if (decision === "yes" && !isInLatestSend(message.conversationId, data.message_id)) {
    throw new IgnoredLinqEventError("a thumbs-up only counts on our latest reply in the chat");
  }
  return message;
}

/**
 * Validates already-extracted values and builds the shared IncomingMessage.
 */
export function buildIncomingMessage(
  conversationId: unknown,
  sender: unknown,
  text: unknown,
  audio?: IncomingMessage["audio"],
): IncomingMessage {
  if (typeof conversationId !== "string" || conversationId.trim() === "") {
    throw new MalformedLinqWebhookError("missing or invalid conversationId");
  }
  if (typeof sender !== "string" || sender.trim() === "") {
    throw new MalformedLinqWebhookError("missing or invalid sender");
  }
  // A voice memo carries no text: orchestration transcribes the audio instead.
  if (typeof text !== "string" || (text.trim() === "" && !audio)) {
    throw new MalformedLinqWebhookError("missing or empty text");
  }
  return audio ? { conversationId, sender, text, audio } : { conversationId, sender, text };
}

/** First audio attachment on the message, if any (voice memos arrive as media parts). */
function findAudioPart(parts: unknown[]): IncomingMessage["audio"] | undefined {
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const mimeType = typeof part.mime_type === "string" ? part.mime_type : "";
    if (!mimeType.startsWith("audio/") || typeof part.url !== "string" || part.url === "") continue;
    return {
      url: part.url,
      mimeType,
      ...(typeof part.size_bytes === "number" ? { sizeBytes: part.size_bytes } : {}),
    };
  }
  return undefined;
}

/**
 * Turns a parsed Linq webhook body into the shared IncomingMessage.
 *
 * Only `message.received` events from other people, and `reaction.added`
 * approvals/rejections on our own messages, are turned into messages.
 * Field mapping (from the Linq docs):
 *   conversationId <- data.chat.id
 *   sender         <- data.sender_handle.handle
 *   text           <- data.parts[] where type === "text", joined with newlines
 *
 * Throws:
 *  - MalformedLinqWebhookError  body is not the expected shape
 *  - IgnoredLinqEventError      valid event that needs no reply (receipts, our
 *                               own echoed messages, media-only messages, ...)
 */
export function normalizeLinqWebhook(payload: unknown): IncomingMessage {
  if (!isRecord(payload)) {
    throw new MalformedLinqWebhookError("webhook body must be a JSON object");
  }

  const eventType = payload.event_type;
  if (typeof eventType !== "string") {
    throw new MalformedLinqWebhookError("missing event_type");
  }
  if (eventType === "reaction.added") {
    return normalizeLinqReaction(payload);
  }
  if (eventType !== "message.received") {
    throw new IgnoredLinqEventError(`not an inbound message event: ${eventType}`);
  }

  const data = payload.data;
  if (!isRecord(data) || !isRecord(data.chat) || !isRecord(data.sender_handle) || !Array.isArray(data.parts)) {
    throw new MalformedLinqWebhookError("message.received is missing data.chat, data.sender_handle or data.parts");
  }

  // Never answer ourselves (would loop).
  if (data.direction !== "inbound" || data.sender_handle.is_me === true) {
    throw new IgnoredLinqEventError("message was not sent by the user");
  }

  const text = data.parts
    .filter(
      (part): part is { type: "text"; value: string } =>
        isRecord(part) && part.type === "text" && typeof part.value === "string",
    )
    .map((part) => part.value)
    .join("\n");

  // A voice memo has no text parts; other media-only messages (photos, ...) stay ignored.
  const audio = text.trim() === "" ? findAudioPart(data.parts) : undefined;
  if (text.trim() === "" && !audio) {
    // Logged so an unexpected voice-memo shape is visible instead of silently ignored.
    const shapes = data.parts
      .map((part) => (isRecord(part) ? `${String(part.type)}/${String(part.mime_type ?? "?")}` : typeof part))
      .join(", ");
    throw new IgnoredLinqEventError(`message has no text parts (parts: ${shapes || "none"})`);
  }

  return buildIncomingMessage(data.chat.id, data.sender_handle.handle, text, audio);
}

// ---------------------------------------------------------------------------
// Outbound: conversationId + text -> Linq -> iMessage
// ---------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 10_000; // Linq limit for one text part
const SEND_TIMEOUT_MS = 10_000;

/** Splits text into pieces Linq will accept, preferring line breaks. */
function splitText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_LENGTH) {
    const lineBreak = rest.lastIndexOf("\n", MAX_TEXT_LENGTH);
    const cut = lineBreak > 0 ? lineBreak : MAX_TEXT_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  chunks.push(rest);
  return chunks;
}

async function toApiError(res: Response): Promise<LinqApiError> {
  let envelope: Partial<LinqErrorEnvelope> | undefined;
  try {
    envelope = JSON.parse(await res.text()) as Partial<LinqErrorEnvelope>;
  } catch {
    // Non-JSON error body; fall through with the status only.
  }
  const error = envelope?.error;
  return new LinqApiError(
    `Linq API ${res.status}${error?.code ? ` (code ${error.code})` : ""}: ${error?.message ?? res.statusText}`,
    res.status,
    error?.code,
    envelope?.trace_id,
    error?.retry_after,
  );
}

const MAX_LINK_LENGTH = 2048; // Linq limit for one link part

/** The URL if the line is nothing but one http(s) URL, otherwise undefined. */
function asLinkLine(line: string): string | undefined {
  const candidate = line.trim();
  if (candidate.length > MAX_LINK_LENGTH || !/^https?:\/\/\S+$/i.test(candidate)) return undefined;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Turns reply text into the messages to send, in order. Linq only shows a
 * rich preview card for a `link` part that is the ONLY part of its message, so
 * a line that is just a URL becomes its own link message and the text around
 * it becomes text messages. URLs inside a sentence stay plain text. Text with
 * no such line is sent exactly as given.
 */
function toParts(text: string): LinqOutboundPart[] {
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => asLinkLine(line) !== undefined)) {
    return splitText(text).map((value): LinqOutboundPart => ({ type: "text", value }));
  }

  const parts: LinqOutboundPart[] = [];
  let pending: string[] = [];
  const flush = () => {
    const chunk = pending.join("\n").trim();
    if (chunk !== "") {
      for (const value of splitText(chunk)) parts.push({ type: "text", value });
    }
    pending = [];
  };
  for (const line of lines) {
    const link = asLinkLine(line);
    if (link === undefined) {
      pending.push(line);
    } else {
      flush();
      parts.push({ type: "link", value: link });
    }
  }
  flush();
  return parts;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined; // the request itself succeeded; we just can't read the details
  }
}

/** The id of a sent message from a Linq response, if it has one. */
function sentMessageId(sentMessage: unknown): string | undefined {
  return isRecord(sentMessage) && typeof sentMessage.id === "string" ? sentMessage.id : undefined;
}

/** Returns the sent message's id (undefined if Linq's success body could not be read). */
async function postPart(conversationId: string, part: LinqOutboundPart): Promise<string | undefined> {
  const body: LinqSendMessageRequest = { message: { parts: [part] } };
  const baseUrl = env.LINQ_BASE_URL.replace(/\/+$/, "");

  const res = await fetch(`${baseUrl}/chats/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LINQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw await toApiError(res);
  }
  const sent = await readJson(res);
  return isRecord(sent) ? sentMessageId(sent.message) : undefined;
}

/**
 * Sends each part as its own message, in order. A link Linq refuses to make a
 * preview for (400/422) is sent as plain text instead, so the URL is never lost.
 * Everything sent (plus `alreadySent`, e.g. a new chat's first message) is
 * recorded as this chat's latest send, even if a later part fails.
 */
async function sendParts(conversationId: string, parts: LinqOutboundPart[], alreadySent: string[] = []): Promise<void> {
  const sentIds = [...alreadySent];
  const track = (id: string | undefined) => {
    if (id !== undefined) sentIds.push(id);
  };
  try {
    for (const part of parts) {
      try {
        track(await postPart(conversationId, part));
      } catch (err) {
        const previewRejected = part.type === "link" && err instanceof LinqApiError && (err.status === 400 || err.status === 422);
        if (!previewRejected) throw err;
        track(await postPart(conversationId, { type: "text", value: part.value }));
      }
    }
  } finally {
    rememberSend(conversationId, sentIds);
  }
}

const TYPING_TIMEOUT_MS = 3_000; // cosmetic, so never hold up a reply for long

async function callTyping(conversationId: string, method: "POST" | "DELETE"): Promise<void> {
  if (conversationId.trim() === "") {
    throw new Error("typing indicator requires a non-empty conversationId");
  }
  if (env.LINQ_API_KEY === "") {
    throw new LinqConfigError("LINQ_API_KEY must be set in .env");
  }

  const baseUrl = env.LINQ_BASE_URL.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chats/${encodeURIComponent(conversationId)}/typing`, {
    method,
    headers: { Authorization: `Bearer ${env.LINQ_API_KEY}` },
    signal: AbortSignal.timeout(TYPING_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw await toApiError(res);
  }
  await res.body?.cancel();
}

/**
 * Shows the "..." typing bubble in the chat (iMessage only, best-effort: Linq
 * answers 204 even if it can't display it). It lasts ~85s and is cleared
 * automatically when a message is sent into the chat.
 *
 * Throws LinqConfigError if LINQ_API_KEY is unset, LinqApiError on a non-2xx.
 */
export async function startTyping(conversationId: string): Promise<void> {
  await callTyping(conversationId, "POST");
}

/** Clears the typing bubble without sending a message. Same errors as startTyping. */
export async function stopTyping(conversationId: string): Promise<void> {
  await callTyping(conversationId, "DELETE");
}

/**
 * Sends `text` into the given Linq chat (conversationId is the chat id from
 * the inbound webhook). This is the only function the rest of the app should
 * call to message the user. Text over Linq's 10,000 character limit is sent as
 * several consecutive messages.
 *
 * A line that is only a URL (`https://...`) is delivered as a rich link preview
 * card, in order with the text around it. URLs inside a sentence stay plain text.
 *
 * Throws LinqConfigError if LINQ_API_KEY is unset, LinqApiError on a non-2xx
 * response. Errors never include the API key.
 */
export async function sendMessage(conversationId: string, text: string): Promise<void> {
  if (conversationId.trim() === "" || text.trim() === "") {
    throw new Error("sendMessage requires a non-empty conversationId and text");
  }
  if (env.LINQ_API_KEY === "") {
    throw new LinqConfigError("LINQ_API_KEY must be set in .env");
  }

  await sendParts(conversationId, toParts(text));
}

// Linq rejects a new chat whose first message has a link (error 1005). This
// catches the obvious cases early; Linq stays the final judge (it may also
// object to bare domains like `zip.com/po/1`).
const URL_IN_TEXT = /https?:\/\/|www\./i;

/**
 * Messages `to` FIRST (a proactive alert) and returns the conversationId of the
 * new chat. Use that id with sendMessage() for follow-ups; replies and
 * reactions from the person arrive through the normal webhook with the same
 * conversationId, so store it next to whatever the alert was about.
 *
 * `text` follows the same rules as sendMessage, with one Linq restriction: the
 * first message of a new chat cannot contain a link. Lead with plain text and
 * put links on their own lines after it (they are sent as follow-ups). If such
 * a follow-up fails after the chat exists, the id is still returned and the
 * failure is logged.
 *
 * `to` is an E.164 phone number (or an iMessage email). Sends from
 * LINQ_FROM_NUMBER. Never overrides a recipient's opt-out (Linq answers 403).
 *
 * Throws LinqConfigError if LINQ_API_KEY or LINQ_FROM_NUMBER is unset,
 * LinqApiError on a non-2xx response.
 */
export async function startConversation(to: string, text: string): Promise<string> {
  if (to.trim() === "" || text.trim() === "") {
    throw new Error("startConversation requires a non-empty recipient and text");
  }
  if (env.LINQ_API_KEY === "") {
    throw new LinqConfigError("LINQ_API_KEY must be set in .env");
  }
  if (env.LINQ_FROM_NUMBER === "") {
    throw new LinqConfigError("LINQ_FROM_NUMBER must be set in .env to message someone first");
  }

  const [first, ...followUps] = toParts(text);
  if (first === undefined || first.type === "link" || URL_IN_TEXT.test(first.value)) {
    throw new Error(
      "the first message of a new conversation cannot contain a link: start with plain text and put links on their own lines after it",
    );
  }

  const body: LinqCreateChatRequest = { from: env.LINQ_FROM_NUMBER, to: [to], message: { parts: [first] } };
  const baseUrl = env.LINQ_BASE_URL.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chats`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LINQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw await toApiError(res);
  }

  const created = await readJson(res);
  const chat = isRecord(created) ? created.chat : undefined;
  if (!isRecord(chat) || typeof chat.id !== "string" || chat.id === "") {
    throw new LinqApiError("Linq created a chat but returned no chat id", res.status);
  }
  const conversationId = chat.id;
  const firstId = sentMessageId(chat.message);

  try {
    await sendParts(conversationId, followUps, firstId === undefined ? [] : [firstId]);
  } catch (err) {
    console.warn(
      `[linq] chat ${conversationId} was created but a follow-up message failed:`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }
  return conversationId;
}
