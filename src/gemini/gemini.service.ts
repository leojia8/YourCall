import dotenv from "dotenv";
import type { GeminiGenerateContentResponse, GeminiSchema } from "./gemini.types";

// Harmless if the server already loaded .env; never overrides existing vars.
dotenv.config({ quiet: true });

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const REQUEST_TIMEOUT_MS = 10_000;

// Overloaded (503) or rate-limited (429) responses are usually transient: retry once.
const RETRYABLE_STATUSES = new Set([429, 503]);
export const RETRY_DELAY_MS = 1_000;

/**
 * Calls Gemini and returns the raw JSON text of the first candidate.
 * Retries once on 429/503; throws on any other transport/API failure.
 * Callers must treat the result as untrusted.
 */
export async function generateJson(
  prompt: string,
  responseSchema: GeminiSchema
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const send = () =>
    fetch(`${GEMINI_BASE_URL}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let response = await send();
  if (RETRYABLE_STATUSES.has(response.status)) {
    console.warn(`[gemini] status ${response.status}, retrying once in ${RETRY_DELAY_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    response = await send();
  }

  if (!response.ok) {
    throw new Error(`Gemini request failed with status ${response.status}`);
  }

  const body = (await response.json()) as GeminiGenerateContentResponse;
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Gemini returned no content");
  }
  return text;
}
