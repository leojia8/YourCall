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
