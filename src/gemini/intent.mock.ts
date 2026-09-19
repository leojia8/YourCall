// Offline parser (GEMINI_MODE=mock, and the live fallback when Gemini fails).
// Simple keyword rules so the full bot works without API quota. Not meant to be smart —
// just predictable, and deliberately conservative: anything it can't place becomes UNKNOWN,
// and a request that would act on something always needs a later confirmation anyway.
import type { UserIntent } from "../types";
import type { IntentContext } from "./gemini.types";

// Answers to our last question, in two tiers.
// EXACT: words that are only an answer when they are the whole message ("go" alone means yes,
// but "go through the queue" does not). PREFIX: phrases unambiguous enough to start a message.
const CONFIRM_EXACT =
  /^(y|ya|yes|yea|yeah|yep|yup|yessir|ok|okay|kk|k|sure|fine|alright|all right|right|correct|confirm|confirmed|affirmative|roger|deal|perfect|great|good|go|do|proceed|continue|approved|lgtm|\+1|💯|👍|✅)$/;
const CONFIRM_PREFIX =
  /^(yes|yeah|yep|yup|ok|okay|sure|confirm|do it|just do it|go ahead|go for it|run it|send it|ship it|make it so|let'?s do it|sounds (good|great)|works for me|please do|yes please|approve it|approve them|approve all|handle it|take care of it|thumbs up)\b/;
const CANCEL_EXACT =
  /^(n|no|nope|nah|naw|negative|cancel|cancelled|stop|halt|abort|wait|undo|nvm|nm|👎|❌)$/;
const CANCEL_PREFIX =
  /^(no|nope|nah|cancel|stop|abort|hold on|hold off|hold up|never ?mind|nvm|forget (it|that)|scratch that|disregard|ignore that|leave it|not now|not yet|don'?t|do not|dont|back out|no thanks|no thank you)\b/;

const REQUEST_ID = /\b([a-z0-9]+_[a-z0-9_]+)\b/i;

// "under 5k", "below $5,000", "no more than five grand", "max 2000"
const LIMIT_PREFIX =
  "(?:under|below|beneath|less than|lower than|cheaper than|no more than|not more than|at most|up to|max(?:imum)?(?: of)?|cap(?:ped)? at|limit(?:ed)? to|within|<=?)";
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, twentyfive: 25, thirty: 30, forty: 40, fifty: 50, hundred: 100,
};
const AMOUNT_DIGITS = new RegExp(`${LIMIT_PREFIX}\\s*\\$?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k|g|grand|thousand)?`, "i");
const AMOUNT_WORDS = new RegExp(`${LIMIT_PREFIX}\\s*(${Object.keys(NUMBER_WORDS).join("|")})\\s*(k|g|grand|thousand)?`, "i");

const EXISTING_VENDORS =
  /\b(existing|current|known|usual|regular|repeat|previous|prior|approved|preferred|established|trusted|on-?boarded|vendors we (?:already )?(?:use|work with|have)|already use|we (?:already )?work with|not new)\b.{0,20}\bvendors?\b|\bvendors?\b.{0,20}\b(we (?:already )?(?:use|work with)|are existing|we know)\b|\bexisting vendors? only\b/;

// "don't touch AI", "no AI stuff", "except marketing", "leave design alone"
const EXCLUDE = new RegExp(
  "(?:don'?t touch|do not touch|dont touch|stay away from|steer clear of|keep away from|hands off|leave|avoid|exclude|excluding|except(?: for)?|other than|apart from|skip|ignore|but not|not the|no more|nothing|nothing in|no)\\s+" +
    "(?:(?:any|anything|everything|all|some|the|my|of|in|that is|thats|that'?s)\\s+)*" +
    "([a-z][a-z0-9&/+-]*)",
  "gi"
);
const EXCLUDE_STOPWORDS = new Set([
  "new", "the", "a", "an", "any", "anything", "everything", "something", "all", "one", "ones", "thing", "things",
  "stuff", "it", "them", "that", "this", "those", "more", "than", "other", "else", "vendor", "vendors",
  "request", "requests", "purchase", "purchases", "changes", "worries", "now", "yet", "today",
]);

// Openers that carry no meaning; stripping them lets the rules below see the real command.
const FILLER_PREFIX =
  /^(?:(?:actually|ok(?:ay)?|so|well|um+|uh+|hmm+|hey|hi|hello|yo|please|pls|just|maybe|quick(?:ly)?|also|and|but|then|now|can you|could you|would you|will you|i want(?: to)?|i'?d like(?: to)?|i need(?: to)?|let'?s|lets|go ahead and|help me)[\s,]+)+/;

const INVESTIGATE =
  /\b(why|how come|what'?s the deal|whats the deal|what'?s up with|whats up with|what happened|(?:what'?s|whats) going on with|going on with|explain|investigate|look into|dig into|details?|more info|information|context|tell me (?:more )?about|what do you know|reason|flagged?|flag|concern|suspicious|weird|breakdown of|check on)\b/;
const DENY =
  /\b(deny|denied|decline|declined|reject|rejected|refuse|veto|block|kill|nix|nuke|shut down|shoot down|turn down|say no to|throw out|toss|bin|scrap|no to)\b/;
// No "clear"/"sign" on their own: "clear the queue" is a bulk review, not an approval.
const APPROVE =
  /\b(approve|approved|approving|accept|authorize|authorise|sign off|signoff|green ?light|ok(?:ay)? the|let through|push through|pay|fund|release)\b/;
const BULK =
  /\b(handle|process|review|clear|sort|sort out|take care of|deal with|knock out|run through|go through|triage|batch|sweep|auto[- ]?approve|clean up|clear out|do the|take a pass|work through|action)\b/;
const GET_PENDING =
  /\b(pending|outstanding|waiting|queue|backlog|inbox|plate|open requests?|requests? (?:are |that are )?open|how many|total(?: spend)?|what do i have|what'?s left|whats left|what'?s there|anything (?:new|waiting|else|for me|i need)|need to (?:look|review|see)|show|list|see|view|display|status|summary|summarise|summarize|rundown|overview|catch me up|update me|where (?:are |do )?(?:we|things) (?:at|stand))\b/;
const EVERYTHING = /\b(everything|all of (?:them|it)|all the|all pending|the rest|anything)\b/;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the known name (Zip's spelling) when the text mentions it. */
function findKnown(text: string, names: string[] | undefined): string | undefined {
  return names?.find((name) => new RegExp(`\\b${escapeRegex(name.toLowerCase())}\\b`).test(text));
}

function parseAmount(text: string): number | undefined {
  const digits = text.match(AMOUNT_DIGITS);
  if (digits?.[1]) {
    const value = Number(digits[1].replace(/,/g, ""));
    if (Number.isFinite(value)) return digits[2] ? value * 1000 : value;
  }
  const words = text.match(AMOUNT_WORDS);
  if (words?.[1]) {
    const value = NUMBER_WORDS[words[1].toLowerCase()];
    if (value !== undefined) return words[2] ? value * 1000 : value;
  }
  return undefined;
}

function parseExcluded(text: string, context?: IntentContext): string[] {
  const found = [...text.matchAll(EXCLUDE)]
    .map((match) => match[1]!.toLowerCase())
    .filter((word) => !EXCLUDE_STOPWORDS.has(word))
    .map((word) => findKnown(word, context?.knownCategories) ?? word.toUpperCase());
  return [...new Set(found)];
}

export function parseIntentOffline(message: string, context?: IntentContext): UserIntent {
  const raw = message.trim().toLowerCase();
  if (raw === "") return { intent: "UNKNOWN" };
  const text = raw.replace(FILLER_PREFIX, "") || raw;
  const words = text.split(/\s+/).length;

  const vendor = findKnown(text, context?.knownVendors);
  const requestId = message.match(REQUEST_ID)?.[1];
  const target: Partial<UserIntent> = {};
  if (vendor) target.vendor = vendor;
  if (requestId) target.requestId = requestId;

  // Short answers to our last question. A message carrying any detail of its own is a new
  // command, never a yes/no about a saved plan: "ok approve figma" and "yes everything under
  // 5k" must not execute whatever plan happens to be waiting.
  // CONFIRM is the only one that can write to Zip, so it is the strictest.
  const maxAmount = parseAmount(text);
  const carriesDetail = vendor !== undefined || requestId !== undefined;
  const bare = text.replace(/[!.?,]+$/, "");
  if (!carriesDetail) {
    if (CANCEL_EXACT.test(bare) || (CANCEL_PREFIX.test(text) && words <= 8)) return { intent: "CANCEL" };
    if (
      maxAmount === undefined &&
      !EVERYTHING.test(text) &&
      (CONFIRM_EXACT.test(bare) || (CONFIRM_PREFIX.test(text) && words <= 5))
    ) {
      return { intent: "CONFIRM" };
    }
  }

  if (INVESTIGATE.test(text)) return { intent: "INVESTIGATE", ...target };

  // DENY never falls through to BULK_REVIEW: a bulk plan proposes approvals, so
  // "deny everything" must ask which request rather than propose approving them.
  if (DENY.test(text)) return { intent: "DENY", ...target };

  if (APPROVE.test(text) && !EVERYTHING.test(text)) return { intent: "APPROVE", ...target };

  if (BULK.test(text) || (APPROVE.test(text) && EVERYTHING.test(text))) {
    const intent: UserIntent = { intent: "BULK_REVIEW" };
    if (maxAmount !== undefined) intent.maxAmount = maxAmount;
    if (EXISTING_VENDORS.test(text)) intent.existingVendorsOnly = true;
    const excluded = parseExcluded(text, context);
    if (excluded.length > 0) intent.excludedCategories = excluded;
    if (vendor) intent.vendor = vendor;
    return intent;
  }

  if (GET_PENDING.test(text)) return vendor ? { intent: "GET_PENDING", vendor } : { intent: "GET_PENDING" };

  return { intent: "UNKNOWN" };
}
