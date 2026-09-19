import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gemini/gemini.service", () => ({ generateJson: vi.fn() }));

import { generateJson } from "../src/gemini/gemini.service";
import { buildIntentPrompt, parseIntent, validateIntent } from "../src/gemini/intent.parser";

const mockGenerate = vi.mocked(generateJson);

describe("validateIntent", () => {
  it("accepts a well-formed BULK_REVIEW intent", () => {
    expect(
      validateIntent({ intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true, excludedCategories: ["AI"] })
    ).toEqual({ intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true, excludedCategories: ["AI"] });
  });

  it("treats null fields as absent and drops unknown keys", () => {
    expect(validateIntent({ intent: "APPROVE", vendor: " Figma ", requestId: null, approve: true })).toEqual({
      intent: "APPROVE",
      vendor: "Figma",
    });
  });

  it("accepts the all-fields-present shape with nulls (required+nullable schema)", () => {
    expect(
      validateIntent({
        intent: "BULK_REVIEW",
        maxAmount: 5000,
        existingVendorsOnly: true,
        excludedCategories: ["AI"],
        includedCategories: null,
        vendor: null,
        requestId: null,
      })
    ).toEqual({ intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true, excludedCategories: ["AI"] });
  });

  it("drops placeholder strings Gemini emits instead of omitting fields (real live output)", () => {
    expect(validateIntent({ intent: "BULK_REVIEW", maxAmount: 5000, vendor: "none", requestId: "none" })).toEqual({
      intent: "BULK_REVIEW",
      maxAmount: 5000,
    });
    expect(validateIntent({ intent: "BULK_REVIEW", excludedCategories: ["AI", "N/A", " "] })).toEqual({
      intent: "BULK_REVIEW",
      excludedCategories: ["AI"],
    });
  });

  it.each([
    ["non-object", "APPROVE"],
    ["array", [{ intent: "APPROVE" }]],
    ["null", null],
    ["unsupported intent", { intent: "EXECUTE_EVERYTHING" }],
    ["missing intent", { vendor: "Figma" }],
    ["negative maxAmount", { intent: "BULK_REVIEW", maxAmount: -1 }],
    ["non-finite maxAmount", { intent: "BULK_REVIEW", maxAmount: Infinity }],
    ["string maxAmount", { intent: "BULK_REVIEW", maxAmount: "5000" }],
    ["non-boolean existingVendorsOnly", { intent: "BULK_REVIEW", existingVendorsOnly: "yes" }],
    ["non-array categories", { intent: "BULK_REVIEW", excludedCategories: "AI" }],
    ["non-string category entries", { intent: "BULK_REVIEW", includedCategories: [1] }],
    ["non-string vendor", { intent: "APPROVE", vendor: 42 }],
    ["non-string requestId", { intent: "APPROVE", requestId: 7 }],
  ])("returns UNKNOWN for %s", (_label, raw) => {
    expect(validateIntent(raw)).toEqual({ intent: "UNKNOWN" });
  });
});

describe("parseIntent", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.stubEnv("GEMINI_MODE", "live");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the validated intent from Gemini JSON", async () => {
    mockGenerate.mockResolvedValue('{"intent":"CONFIRM"}');
    await expect(parseIntent("yeah do it")).resolves.toEqual({ intent: "CONFIRM" });
  });

  it("malformed Gemini output safely becomes UNKNOWN (fallback off)", async () => {
    vi.stubEnv("GEMINI_FALLBACK", "off");
    mockGenerate.mockResolvedValue("sure! {intent: APPROVE");
    await expect(parseIntent("approve figma")).resolves.toEqual({ intent: "UNKNOWN" });
  });

  it("Gemini failures become UNKNOWN instead of throwing (fallback off)", async () => {
    vi.stubEnv("GEMINI_FALLBACK", "off");
    mockGenerate.mockImplementation(async () => {
      throw new Error("network down");
    });
    await expect(parseIntent("approve figma")).resolves.toEqual({ intent: "UNKNOWN" });
  });

  describe("offline fallback (default on)", () => {
    const context = { knownVendors: ["Figma"], knownCategories: ["AI"] };

    it("a Gemini error falls back to the offline parser for that message", async () => {
      mockGenerate.mockImplementation(async () => {
        throw new Error("Gemini request failed with status 503");
      });
      await expect(parseIntent("approve the Figma request", context)).resolves.toEqual({
        intent: "APPROVE",
        vendor: "Figma",
      });
    });

    it("malformed Gemini output falls back to the offline parser", async () => {
      mockGenerate.mockResolvedValue("sure! {intent: APPROVE");
      await expect(parseIntent("yes", context)).resolves.toEqual({ intent: "CONFIRM" });
    });

    it("an invalid Gemini shape falls back to the offline parser", async () => {
      mockGenerate.mockResolvedValue('{"intent":"EXECUTE_EVERYTHING"}');
      await expect(parseIntent("never mind", context)).resolves.toEqual({ intent: "CANCEL" });
    });

    it("a genuine UNKNOWN from Gemini is respected (no fallback)", async () => {
      mockGenerate.mockResolvedValue('{"intent":"UNKNOWN"}');
      await expect(parseIntent("approve the Figma request", context)).resolves.toEqual({ intent: "UNKNOWN" });
    });

    it("falls back to UNKNOWN when the offline parser can't understand the message either", async () => {
      mockGenerate.mockImplementation(async () => {
        throw new Error("timeout");
      });
      await expect(parseIntent("what's the weather", context)).resolves.toEqual({ intent: "UNKNOWN" });
    });

    it("the next message tries Gemini again", async () => {
      mockGenerate
        .mockImplementationOnce(async () => {
          throw new Error("503");
        })
        .mockResolvedValueOnce('{"intent":"GET_PENDING"}');
      await parseIntent("yes", context);
      await expect(parseIntent("what's pending", context)).resolves.toEqual({ intent: "GET_PENDING" });
      expect(mockGenerate).toHaveBeenCalledTimes(2);
    });
  });

  it("empty messages skip Gemini", async () => {
    await expect(parseIntent("   ")).resolves.toEqual({ intent: "UNKNOWN" });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("passes real vendor/category names to the prompt as hints", () => {
    const prompt = buildIntentPrompt("don't touch AI", {
      knownVendors: ["Figma"],
      knownCategories: ["Artificial Intelligence"],
    });
    expect(prompt).toContain('["Figma"]');
    expect(prompt).toContain('["Artificial Intelligence"]');
    expect(prompt).toContain(JSON.stringify("don't touch AI"));
  });
});

describe("GEMINI_MODE=mock (offline placeholder)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.stubEnv("GEMINI_MODE", "mock");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const context = { knownVendors: ["Figma", "OpenAI", "Datadog"], knownCategories: ["AI", "Design"] };

  it.each([
    ["show me my pending purchases", { intent: "GET_PENDING" }],
    [
      "handle everything under 5k from existing vendors but don't touch AI",
      { intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true, excludedCategories: ["AI"] },
    ],
    ["handle existing vendors under 5k", { intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true }],
    ["approve the Figma request", { intent: "APPROVE", vendor: "Figma" }],
    ["approve openai_3", { intent: "APPROVE", requestId: "openai_3" }],
    ["deny the Datadog request", { intent: "DENY", vendor: "Datadog" }],
    ["why did you flag OpenAI?", { intent: "INVESTIGATE", vendor: "OpenAI" }],
    ["yeah do it", { intent: "CONFIRM" }],
    ["yes", { intent: "CONFIRM" }],
    ["never mind", { intent: "CANCEL" }],
    ["what's the weather", { intent: "UNKNOWN" }],
  ])("%s", async (message, expected) => {
    await expect(parseIntent(message, context)).resolves.toEqual(expected);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("live mode (default) calls Gemini", async () => {
    vi.stubEnv("GEMINI_MODE", "live");
    mockGenerate.mockResolvedValue('{"intent":"GET_PENDING"}');
    await expect(parseIntent("show pending")).resolves.toEqual({ intent: "GET_PENDING" });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("offline parser vocabulary (mock mode / live fallback)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.stubEnv("GEMINI_MODE", "mock");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ctx = {
    knownVendors: ["Figma", "OpenAI", "Datadog", "Notion"],
    knownCategories: ["AI", "Design", "Infrastructure"],
  };
  const parse = (message: string) => parseIntent(message, ctx);

  it.each([
    ["kill the Datadog one", { intent: "DENY", vendor: "Datadog" }],
    ["nuke the datadog request", { intent: "DENY", vendor: "Datadog" }],
    ["reject Datadog", { intent: "DENY", vendor: "Datadog" }],
    ["turn down the Datadog request", { intent: "DENY", vendor: "Datadog" }],
    ["say no to Datadog", { intent: "DENY", vendor: "Datadog" }],
    ["shoot down datadog", { intent: "DENY", vendor: "Datadog" }],
  ])("deny: %s", async (message, expected) => {
    await expect(parse(message)).resolves.toEqual(expected);
  });

  it.each([
    ["green light the Figma request", { intent: "APPROVE", vendor: "Figma" }],
    ["sign off on Figma", { intent: "APPROVE", vendor: "Figma" }],
    ["authorize figma", { intent: "APPROVE", vendor: "Figma" }],
    ["push through the figma one", { intent: "APPROVE", vendor: "Figma" }],
    ["let's pay Notion", { intent: "APPROVE", vendor: "Notion" }],
  ])("approve: %s", async (message, expected) => {
    await expect(parse(message)).resolves.toEqual(expected);
  });

  it.each([
    ["take care of everything under five grand", { intent: "BULK_REVIEW", maxAmount: 5000 }],
    ["deal with anything below $2,500", { intent: "BULK_REVIEW", maxAmount: 2500 }],
    ["knock out everything no more than 750", { intent: "BULK_REVIEW", maxAmount: 750 }],
    ["clear out anything up to ten thousand", { intent: "BULK_REVIEW", maxAmount: 10000 }],
    ["approve everything under 4k", { intent: "BULK_REVIEW", maxAmount: 4000 }],
    [
      "sort out everything under 5k from vendors we already use",
      { intent: "BULK_REVIEW", maxAmount: 5000, existingVendorsOnly: true },
    ],
    [
      "triage anything below 3000 from our existing vendors but stay away from AI",
      { intent: "BULK_REVIEW", maxAmount: 3000, existingVendorsOnly: true, excludedCategories: ["AI"] },
    ],
    [
      "handle everything under 5k, no AI stuff",
      { intent: "BULK_REVIEW", maxAmount: 5000, excludedCategories: ["AI"] },
    ],
    [
      "process anything cheaper than 1k except design",
      { intent: "BULK_REVIEW", maxAmount: 1000, excludedCategories: ["Design"] },
    ],
  ])("bulk review: %s", async (message, expected) => {
    await expect(parse(message)).resolves.toEqual(expected);
  });

  it.each([
    "what's on my plate?",
    "anything waiting for me",
    "catch me up",
    "show me the backlog",
    "what's left",
    "give me a summary",
    "how's the queue looking",
  ])("get pending: %s", async (message) => {
    await expect(parse(message)).resolves.toEqual({ intent: "GET_PENDING" });
  });

  it.each([
    "what's the deal with OpenAI?",
    "tell me about OpenAI",
    "look into OpenAI",
    "why is OpenAI flagged",
    "what happened with openai",
  ])("investigate: %s", async (message) => {
    await expect(parse(message)).resolves.toEqual({ intent: "INVESTIGATE", vendor: "OpenAI" });
  });

  it.each(["send it", "go for it", "sounds good", "lgtm", "perfect", "make it so", "please do"])(
    "confirm: %s",
    async (message) => {
      await expect(parse(message)).resolves.toEqual({ intent: "CONFIRM" });
    }
  );

  it.each(["hold off", "scratch that", "forget it", "not now", "abort", "no thanks", "disregard"])(
    "cancel: %s",
    async (message) => {
      await expect(parse(message)).resolves.toEqual({ intent: "CANCEL" });
    }
  );

  describe("safety: words that must not misfire", () => {
    it("'deny everything under 5k' asks which request; it never becomes a bulk approval", async () => {
      await expect(parse("deny everything under 5k")).resolves.toEqual({ intent: "DENY" });
    });

    it("a question about a denial is investigated, not acted on", async () => {
      await expect(parse("why did you deny the Figma request?")).resolves.toEqual({
        intent: "INVESTIGATE",
        vendor: "Figma",
      });
    });

    it("'don't approve anything' cancels rather than approving", async () => {
      await expect(parse("don't approve anything")).resolves.toEqual({ intent: "CANCEL" });
    });

    it("unrelated text is still UNKNOWN", async () => {
      await expect(parse("what's the weather in Waterloo")).resolves.toEqual({ intent: "UNKNOWN" });
      await expect(parse("monkey")).resolves.toEqual({ intent: "UNKNOWN" });
    });

    it("category words are only taken from exclusion phrases", async () => {
      await expect(parse("handle everything under 5k")).resolves.toEqual({
        intent: "BULK_REVIEW",
        maxAmount: 5000,
      });
    });
  });
});

describe("offline parser: filler, exclusions and command-vs-answer", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.stubEnv("GEMINI_MODE", "mock");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ctx = { knownVendors: ["Figma", "OpenAI", "Datadog"], knownCategories: ["AI", "Design"] };
  const parse = (message: string) => parseIntent(message, ctx);

  it("a message naming a request is a command, never a yes/no about another plan", async () => {
    await expect(parse("ok approve figma")).resolves.toEqual({ intent: "APPROVE", vendor: "Figma" });
    await expect(parse("yes approve figma")).resolves.toEqual({ intent: "APPROVE", vendor: "Figma" });
    await expect(parse("no, deny datadog")).resolves.toEqual({ intent: "DENY", vendor: "Datadog" });
  });

  it("bare answers still work", async () => {
    await expect(parse("approve it")).resolves.toEqual({ intent: "CONFIRM" });
    await expect(parse("yes")).resolves.toEqual({ intent: "CONFIRM" });
    await expect(parse("no")).resolves.toEqual({ intent: "CANCEL" });
  });

  it("leading filler words are ignored", async () => {
    await expect(parse("actually hold on")).resolves.toEqual({ intent: "CANCEL" });
    await expect(parse("hey can you show me what's pending")).resolves.toEqual({ intent: "GET_PENDING" });
    await expect(parse("please approve the figma request")).resolves.toEqual({ intent: "APPROVE", vendor: "Figma" });
    await expect(parse("i want to deny datadog")).resolves.toEqual({ intent: "DENY", vendor: "Datadog" });
  });

  it("longer cancels are understood", async () => {
    await expect(parse("never mind ill do it later")).resolves.toEqual({ intent: "CANCEL" });
  });

  it("exclusions skip filler words before the category", async () => {
    await expect(parse("clear the queue under 5k but skip anything AI")).resolves.toEqual({
      intent: "BULK_REVIEW",
      maxAmount: 5000,
      excludedCategories: ["AI"],
    });
    await expect(parse("handle everything under 5k, no AI stuff")).resolves.toEqual({
      intent: "BULK_REVIEW",
      maxAmount: 5000,
      excludedCategories: ["AI"],
    });
  });

  it("'approve all the <vendor> ones' becomes a vendor-scoped review, not a blind confirm", async () => {
    await expect(parse("approve all the openai ones")).resolves.toEqual({
      intent: "BULK_REVIEW",
      vendor: "OpenAI",
    });
  });

  it("word amounts are understood", async () => {
    await expect(parse("take care of anything below two thousand")).resolves.toEqual({
      intent: "BULK_REVIEW",
      maxAmount: 2000,
    });
  });
});

describe("offline parser: verb precedence", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.stubEnv("GEMINI_MODE", "mock");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ctx = { knownVendors: ["Figma", "Datadog"], knownCategories: ["AI"] };

  it.each([
    ["clear the queue under 5k", { intent: "BULK_REVIEW", maxAmount: 5000 }],
    ["clear out anything under 2k", { intent: "BULK_REVIEW", maxAmount: 2000 }],
    ["sort out the queue", { intent: "BULK_REVIEW" }],
  ])("'%s' is a bulk review, not an approval", async (message, expected) => {
    await expect(parseIntent(message, ctx)).resolves.toEqual(expected);
  });

  it("an approval verb with a vendor is still an approval", async () => {
    await expect(parseIntent("sign off on figma", ctx)).resolves.toEqual({ intent: "APPROVE", vendor: "Figma" });
  });
});

describe("offline parser: a confirmation must carry no details of its own", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.stubEnv("GEMINI_MODE", "mock");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ctx = { knownVendors: ["Figma", "Datadog"], knownCategories: ["AI"] };

  it.each(["yes everything under 5k", "sure everything under 5k", "ok handle everything under 4k"])(
    "'%s' is never treated as a bare yes",
    async (message) => {
      const intent = await parseIntent(message, ctx);
      expect(intent.intent).not.toBe("CONFIRM");
    }
  );

  it("plain confirmations still work", async () => {
    for (const message of ["yes", "yeah", "do it", "send it", "approve it", "sounds good"]) {
      await expect(parseIntent(message, ctx)).resolves.toEqual({ intent: "CONFIRM" });
    }
  });

  it("cancel stays permissive (it only clears a plan, it never writes)", async () => {
    await expect(parseIntent("cancel everything", ctx)).resolves.toEqual({ intent: "CANCEL" });
    await expect(parseIntent("nah forget it", ctx)).resolves.toEqual({ intent: "CANCEL" });
  });
});
