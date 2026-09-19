// Offline placeholder for Gemini (GEMINI_MODE=mock). Simple keyword rules so the full
// bot can be exercised without spending API quota. Not meant to be smart — just predictable.
import type { UserIntent } from "../types";
import type { IntentContext } from "./gemini.types";

const CONFIRM = /^(yes|yeah|yep|yup|y|ok|okay|sure|confirm|do it|go ahead|sounds good)\b/;
const CANCEL = /^(no|nope|nah|cancel|never ?mind|nvm|stop|don'?t)\b/;
const REQUEST_ID = /\b([a-z0-9]+_[a-z0-9_]+)\b/i;
const AMOUNT = /(?:under|below|less than|up to|max|<)\s*\$?\s*(\d+(?:\.\d+)?)\s*(k|grand|thousand)?/i;
const EXCLUDE = /(?:don'?t touch|do not touch|exclude|excluding|except|skip|but not|no)\s+(?:any\s+)?([a-z][a-z0-9&/-]*)/gi;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findKnown(text: string, names: string[] | undefined): string | undefined {
  return names?.find((name) => new RegExp(`\\b${escapeRegex(name.toLowerCase())}\\b`).test(text));
}

export function parseIntentOffline(message: string, context?: IntentContext): UserIntent {
  const text = message.trim().toLowerCase();
  if (text === "") return { intent: "UNKNOWN" };

  if (CANCEL.test(text) && text.split(/\s+/).length <= 4) return { intent: "CANCEL" };
  if (CONFIRM.test(text) && text.split(/\s+/).length <= 5) return { intent: "CONFIRM" };

  const vendor = findKnown(text, context?.knownVendors);
  const requestId = message.match(REQUEST_ID)?.[1];
  const target: Partial<UserIntent> = {};
  if (vendor) target.vendor = vendor;
  if (requestId) target.requestId = requestId;

  if (/\b(why|explain|investigate|flag(ged)?|what'?s up with)\b/.test(text)) return { intent: "INVESTIGATE", ...target };
  if (/\b(deny|reject|decline)\b/.test(text)) return { intent: "DENY", ...target };
  if (/\bapprove\b/.test(text) && !/\b(everything|all)\b/.test(text)) return { intent: "APPROVE", ...target };

  if (/\b(handle|process|clear|review|approve)\b/.test(text)) {
    const intent: UserIntent = { intent: "BULK_REVIEW" };
    const amount = text.match(AMOUNT);
    if (amount?.[1]) intent.maxAmount = Number(amount[1]) * (amount[2] ? 1000 : 1);
    if (/\b(existing|already use|current) vendors?\b|\bvendors we (already )?use\b/.test(text)) {
      intent.existingVendorsOnly = true;
    }
    const excluded = [...text.matchAll(EXCLUDE)]
      .map((match) => match[1]!)
      .filter((word) => !["new", "the", "a", "any"].includes(word))
      .map((word) => findKnown(word, context?.knownCategories) ?? word.toUpperCase());
    if (excluded.length > 0) intent.excludedCategories = [...new Set(excluded)];
    if (vendor) intent.vendor = vendor;
    return intent;
  }

  if (/\b(pending|show|list|what do i have|queue|outstanding)\b/.test(text)) {
    return vendor ? { intent: "GET_PENDING", vendor } : { intent: "GET_PENDING" };
  }

  return { intent: "UNKNOWN" };
}
