import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  LINQ_API_KEY: "test-api-key-123",
  LINQ_BASE_URL: "https://api.linqapp.com/api/partner/v3/",
  LINQ_WEBHOOK_SECRET: "",
}));
vi.mock("../src/config/env", () => ({ env: mockEnv }));

import { LinqApiError, LinqConfigError, startTyping, stopTyping } from "../src/linq/linq.service";

const CHAT = "8f392755-6865-4b18-880a-227f9d8b458f";

describe.each([
  ["startTyping", startTyping, "POST"],
  ["stopTyping", stopTyping, "DELETE"],
] as const)("%s", (_name, fn, method) => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockEnv.LINQ_API_KEY = "test-api-key-123";
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(`${method}s /chats/{id}/typing with a Bearer token and no body`, async () => {
    await expect(fn(CHAT)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.linqapp.com/api/partner/v3/chats/${CHAT}/typing`);
    expect(init.method).toBe(method);
    expect(init.headers).toEqual({ Authorization: "Bearer test-api-key-123" });
    expect(init.body).toBeUndefined();
  });

  it("URL-encodes the chat id", async () => {
    await fn("a/b c");
    expect(fetchMock.mock.calls[0]![0]).toContain("/chats/a%2Fb%20c/typing");
  });

  it("throws LinqApiError with code and trace id, and never leaks the API key", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { status: 404, code: 2001, message: "Chat not found" },
            trace_id: "trace_abc",
          }),
          { status: 404 },
        ),
    );

    const err = await fn("missing").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LinqApiError);
    expect(err).toMatchObject({ status: 404, code: 2001, traceId: "trace_abc" });
    expect(String((err as Error).message)).not.toContain("test-api-key-123");
  });

  it("does not call Linq without an API key", async () => {
    mockEnv.LINQ_API_KEY = "";
    await expect(fn(CHAT)).rejects.toBeInstanceOf(LinqConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty conversation id without calling Linq", async () => {
    await expect(fn("  ")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
