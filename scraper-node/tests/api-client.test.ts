import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiClient, describeAgentApiError, isTransientAgentApiError } from "../src/api-client.js";

describe("describeAgentApiError", () => {
  it("normalizes fetch transport failures into a clearer server message", () => {
    expect(describeAgentApiError(new TypeError("fetch failed"))).toBe(
      "could not connect to the server (TypeError: fetch failed)",
    );
  });

  it("passes through API errors unchanged", () => {
    expect(describeAgentApiError(new Error("API POST /api/agent/results -> 500: boom"))).toBe(
      "Error: API POST /api/agent/results -> 500: boom",
    );
  });

  it("classifies 503 API responses as transient without exposing the body", () => {
    const err = new Error(
      'API POST /api/agent/heartbeat → 503: {"error":"Database temporarily unavailable"}',
    );

    expect(isTransientAgentApiError(err)).toBe(true);
    expect(describeAgentApiError(err)).toBe("server temporarily unavailable; will retry");
  });

  it("passes through unknown error values as strings", () => {
    expect(describeAgentApiError("timeout")).toBe("timeout");
  });
});

describe("AgentApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gzip-compresses pushed scrape results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, summary: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentApiClient("https://dashboard.example", "api-key");
    const payload = {
      moduleName: "avto-net",
      jobPublicId: "abcdefghijkl",
      listings: [],
      logs: [],
    };

    await client.pushResults(payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dashboard.example/api/agent/results");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "X-API-Key": "api-key",
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    });
    expect(gunzipSync(init.body as Buffer).toString("utf8")).toBe(JSON.stringify(payload));
  });
});
