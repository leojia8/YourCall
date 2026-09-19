import type { PurchaseRequest } from "../types";
import type { CurrencyTotal } from "./orchestration.types";

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Trimmed, case-insensitive key used for all vendor/category comparisons. */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/** "$1,200" for USD or unknown currency (sandbox default), "1,200 CAD" otherwise. */
export function formatMoney(amount: number, currency?: string): string {
  const digits = amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (!currency || currency.trim().toUpperCase() === "USD") return `$${digits}`;
  return `${digits} ${currency.trim().toUpperCase()}`;
}

export function formatRequestAmount(request: PurchaseRequest): string {
  return formatMoney(request.amount, request.currency);
}

/** "six" for small counts, digits otherwise. */
export function countWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/** Distinct known currency codes (upper-cased). Requests without a currency are ignored. */
export function knownCurrencies(requests: PurchaseRequest[]): string[] {
  const codes = new Set<string>();
  for (const request of requests) {
    if (request.currency && request.currency.trim() !== "") {
      codes.add(request.currency.trim().toUpperCase());
    }
  }
  return [...codes].sort();
}

/**
 * Sums amounts only when all known currencies agree. Never converts or mixes
 * currencies: conflicting currencies return { ok: false } instead of a total.
 */
export function totalAmount(requests: PurchaseRequest[]): CurrencyTotal {
  const currencies = knownCurrencies(requests);
  if (currencies.length > 1) return { ok: false, currencies };
  const total = requests.reduce((sum, request) => sum + request.amount, 0);
  return { ok: true, total, currency: currencies[0] };
}

/** "$18,420" when currencies agree, otherwise "12,000 USD + 3,400 CAD" computed per currency. */
export function describeTotal(requests: PurchaseRequest[]): string {
  const result = totalAmount(requests);
  if (result.ok) return formatMoney(result.total, result.currency);

  const parts = result.currencies.map((currency) => {
    const inCurrency = requests.filter((r) => r.currency?.trim().toUpperCase() === currency);
    const sum = inCurrency.reduce((acc, r) => acc + r.amount, 0);
    return `${sum.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
  });
  const unlabelled = requests.filter((r) => !r.currency || r.currency.trim() === "");
  if (unlabelled.length > 0) {
    parts.push(`${unlabelled.length} ${plural(unlabelled.length, "request")} with no currency`);
  }
  return parts.join(" + ");
}
