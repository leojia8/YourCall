// Linq-specific types ONLY. Do NOT put IncomingMessage / OutgoingMessage here;
// they live in src/types/index.ts.
// Source: https://docs.linqapp.com/channel/imessage/ (API v3)

/** One piece of a message. Only `text` parts are read or written by this app. */
export interface LinqMessagePart {
  type: string; // "text" | "media" | "link" | ...
  value?: string; // present on text parts
}

/** POST {base}/chats/{chatId}/messages */
export interface LinqSendMessageRequest {
  message: {
    parts: Array<{ type: "text"; value: string }>;
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
