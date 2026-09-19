import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateJson, RETRY_DELAY_MS } from "../src/gemini/gemini.service";

const schema = { type: "OBJECT" as const };
const ok = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"intent":"CONFIRM"}' }] } }] }), {
    status: 200,
  });
const status = (code: number) => new Response("{}", { status: code });

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.stubGlobal("fetch", mockFetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(): Promise<string> {
  const pending = generateJson("prompt", schema);
  await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
  return pending;
}

describe("generateJson retry", () => {
  it.each([503, 429])("retries once after a %i and returns the second response", async (code) => {
    mockFetch.mockResolvedValueOnce(status(code)).mockResolvedValueOnce(ok());
    await expect(run()).resolves.toBe('{"intent":"CONFIRM"}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after exactly one retry", async () => {
    mockFetch.mockResolvedValue(status(503));
    const result = generateJson("prompt", schema);
    const assertion = expect(result).rejects.toThrow("status 503");
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    mockFetch.mockResolvedValue(status(400));
    await expect(generateJson("prompt", schema)).rejects.toThrow("status 400");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a success", async () => {
    mockFetch.mockResolvedValue(ok());
    await expect(generateJson("prompt", schema)).resolves.toBe('{"intent":"CONFIRM"}');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends the key in a header, never in the URL", async () => {
    mockFetch.mockResolvedValue(ok());
    await generateJson("prompt", schema);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).not.toContain("test-key");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });
});

describe("daily quota", () => {
  const dailyQuota = () =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] }],
        },
      }),
      { status: 429 }
    );

  it("does not retry a daily-quota 429 (a retry would waste another call)", async () => {
    mockFetch.mockResolvedValue(dailyQuota());
    await expect(generateJson("prompt", schema)).rejects.toThrow(/PerDay/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("still retries a plain 429", async () => {
    mockFetch.mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok());
    await expect(run()).resolves.toBe('{"intent":"CONFIRM"}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
