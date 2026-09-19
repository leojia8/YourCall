import { describe, expect, it } from "vitest";
import { IgnoredLinqEventError, normalizeLinqWebhook } from "../src/linq/linq.service";

function webhook(parts: unknown[]): unknown {
  return {
    event_type: "message.received",
    data: {
      chat: { id: "chat_1" },
      sender_handle: { handle: "+15195551234", is_me: false },
      direction: "inbound",
      parts,
    },
  };
}

const VOICE_PART = {
  type: "media",
  mime_type: "audio/mp4",
  url: "https://cdn.linqapp.com/attachments/abc/voice.m4a?signature=x",
  size_bytes: 12_345,
  filename: "voice.m4a",
};

describe("inbound voice memos", () => {
  it("becomes an IncomingMessage with empty text and the audio attached", () => {
    expect(normalizeLinqWebhook(webhook([VOICE_PART]))).toEqual({
      conversationId: "chat_1",
      sender: "+15195551234",
      text: "",
      audio: {
        url: VOICE_PART.url,
        mimeType: "audio/mp4",
        sizeBytes: 12_345,
      },
    });
  });

  it("text still wins when a message has both", () => {
    const message = normalizeLinqWebhook(webhook([{ type: "text", value: "approve Figma" }, VOICE_PART]));
    expect(message.text).toBe("approve Figma");
    expect(message.audio).toBeUndefined();
  });

  it("non-audio media is still ignored", () => {
    const photo = { type: "media", mime_type: "image/jpeg", url: "https://cdn.linqapp.com/p.jpg" };
    expect(() => normalizeLinqWebhook(webhook([photo]))).toThrow(IgnoredLinqEventError);
  });

  it("an audio part without a url is ignored", () => {
    expect(() => normalizeLinqWebhook(webhook([{ type: "media", mime_type: "audio/mp4" }]))).toThrow(
      IgnoredLinqEventError
    );
  });

  it("works when the audio part reports no size", () => {
    const { size_bytes, ...noSize } = VOICE_PART;
    expect(normalizeLinqWebhook(webhook([noSize])).audio).toEqual({ url: VOICE_PART.url, mimeType: "audio/mp4" });
  });
});
