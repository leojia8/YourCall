import { describe, expect, it } from "vitest";
import { detectAggregateSpend } from "../src/orchestration/anomaly";
import { describeTotal, totalAmount } from "../src/orchestration/format";
import type { PurchaseRequest } from "../src/types";

function req(id: string, vendor: string, amount: number, currency?: string): PurchaseRequest {
  return { id, vendor: { name: vendor }, amount, currency, status: "pending", existingVendor: true };
}

const openAi = [920, 870, 940, 980, 890, 960].map((amount, i) => req(`openai_${i + 1}`, "OpenAI", amount, "USD"));

describe("detectAggregateSpend", () => {
  it("detects vendor spend crossing $5,000", () => {
    expect(detectAggregateSpend(openAi)).toEqual([
      {
        requestIds: ["openai_1", "openai_2", "openai_3", "openai_4", "openai_5", "openai_6"],
        type: "AGGREGATE_SPEND",
        reason: "Six OpenAI requests total $5,560.",
      },
    ]);
  });

  it("groups vendor names case-insensitively", () => {
    const pending = [req("a", "OpenAI", 3000, "USD"), req("b", " openai ", 3000, "USD")];
    expect(detectAggregateSpend(pending)).toHaveLength(1);
  });

  it("does not flag totals at or below the threshold", () => {
    expect(detectAggregateSpend([req("a", "Figma", 2500), req("b", "Figma", 2500)])).toEqual([]);
  });

  it("does not flag a single large request (that is OVER_LIMIT's job)", () => {
    expect(detectAggregateSpend([req("a", "Datadog", 7200, "USD")])).toEqual([]);
  });

  it("mixed currencies are not silently combined into a misleading total", () => {
    const items = detectAggregateSpend([req("a", "OpenAI", 4000, "USD"), req("b", "OpenAI", 4000, "CAD")]);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("OTHER");
    expect(items[0]!.reason).not.toMatch(/8,000/);
  });
});

describe("currency totals", () => {
  it("sums when all known currencies agree", () => {
    expect(totalAmount([req("a", "X", 100, "USD"), req("b", "Y", 50)])).toEqual({ ok: true, total: 150, currency: "USD" });
  });

  it("refuses to total mixed currencies and reports them separately", () => {
    const mixed = [req("a", "X", 100, "USD"), req("b", "Y", 50, "CAD")];
    expect(totalAmount(mixed)).toEqual({ ok: false, currencies: ["CAD", "USD"] });
    expect(describeTotal(mixed)).toBe("50 CAD + 100 USD");
  });
});
