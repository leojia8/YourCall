// Voice memo handling: download the clip Linq pointed us at, then interpret it.
//
// SEAM: today one Gemini call does transcription + intent together, so a voice memo needs
// Gemini (the offline keyword parser can't hear). To make voice survive a Gemini outage,
// replace the parseVoiceIntent call below with a speech-to-text provider and feed the
// transcript into parseIntent() instead — the rest of the pipeline is unchanged.
import { isMockMode } from "../gemini/intent.parser";
import { parseVoiceIntent, type VoiceInterpretation } from "../gemini/voice.parser";
import type { IntentContext } from "../gemini/gemini.types";
import type { IncomingMessage } from "../types";

/** Gemini takes audio inline up to ~20 MB per request; a voice memo is far smaller. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

export async function downloadAudio(
  audio: NonNullable<IncomingMessage["audio"]>
): Promise<{ base64: string; mimeType: string } | null> {
  if (audio.sizeBytes !== undefined && audio.sizeBytes > MAX_AUDIO_BYTES) {
    console.warn(`[voice] clip too large: ${audio.sizeBytes} bytes`);
    return null;
  }

  try {
    const response = await fetch(audio.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      console.warn(`[voice] download failed with status ${response.status}`);
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
      console.warn(`[voice] unusable clip size: ${bytes.byteLength} bytes`);
      return null;
    }
    const headerType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const mimeType = headerType?.startsWith("audio/") ? headerType : audio.mimeType;
    if (!mimeType) {
      console.warn("[voice] no audio content type");
      return null;
    }
    return { base64: bytes.toString("base64"), mimeType };
  } catch (error) {
    console.error("[voice] download error:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Null means "couldn't use this clip"; the caller then asks the user to text instead. */
export async function interpretVoiceMessage(
  audio: NonNullable<IncomingMessage["audio"]>,
  context?: IntentContext
): Promise<VoiceInterpretation | null> {
  // GEMINI_MODE=mock must never spend API quota, and the offline parser cannot hear.
  if (isMockMode()) {
    console.warn("[voice] GEMINI_MODE=mock: voice memos need Gemini, asking the user to text instead");
    return null;
  }
  const clip = await downloadAudio(audio);
  if (!clip) return null;
  return parseVoiceIntent(clip, context);
}
