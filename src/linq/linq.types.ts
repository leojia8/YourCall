// Linq-specific types ONLY. Do NOT put IncomingMessage / OutgoingMessage here;
// they live in src/types/index.ts.
// Source: https://docs.linqapp.com/channel/imessage/ (API v3)

/** One piece of a message. Only `text` parts are read or written by this app. */
export interface LinqMessagePart {
  type: string; // "text" | "media" | "link" | ...
  value?: string; // present on text parts
}

/**
 * A part we send. A `link` part is delivered as a rich preview card and must be
 * the ONLY part in its message (Linq rule), so every message we send has one part.
 */
export type LinqOutboundPart = { type: "text"; value: string } | { type: "link"; value: string };

/** POST {base}/chats/{chatId}/messages */
export interface LinqSendMessageRequest {
  message: {
    parts: LinqOutboundPart[];
  };
}

/** POST {base}/chats — starts a new chat with an initial message. */
export interface LinqCreateChatRequest {
  from: string; // E.164 number we send from
  to: string[]; // recipient handles (E.164 phone number or email)
  message: {
    parts: LinqOutboundPart[];
  };
}

/** Error envelope returned by every failing Linq API call. */
export interface LinqErrorEnvelope {
  success: false;
  error: {
    status: number;
    code: number;
    message: string;
    doc_url?: string;
    retry_after?: number; // 429 only, seconds
  };
  trace_id?: string;
}
