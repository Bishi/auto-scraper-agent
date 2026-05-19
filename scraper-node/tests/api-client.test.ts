import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiClient, AgentLogUploadError, describeAgentApiError, isTransientAgentApiError, registerAgent } from "../src/api-client.js";

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

    const client = new AgentApiClient("https://dashboard.example", "agent-id", "agent-secret");
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
      "X-Agent-Id": "agent-id",
      "X-Agent-Secret": "agent-secret",
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    });
    expect(gunzipSync(init.body as Buffer).toString("utf8")).toBe(JSON.stringify(payload));
  });

  it("gzip-compresses pushed central logs and preserves Retry-After failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, accepted: 1, duplicates: 0, invalid: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Rate limit exceeded." }), {
          status: 429,
          headers: { "Retry-After": "17" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentApiClient("https://dashboard.example", "agent-id", "agent-secret");
    const entries = [{
      clientLogId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      occurredAt: "2026-05-01T09:03:52.000Z",
      level: 30 as const,
      component: "agent" as const,
      message: "Started",
    }];

    await expect(client.pushLogs(entries)).resolves.toEqual({ ok: true, accepted: 1, duplicates: 0, invalid: 0 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dashboard.example/api/agent/logs");
    expect(init.headers).toMatchObject({
      "X-Agent-Id": "agent-id",
      "X-Agent-Secret": "agent-secret",
      "Content-Encoding": "gzip",
    });
    expect(gunzipSync(init.body as Buffer).toString("utf8")).toBe(JSON.stringify({ entries }));

    await expect(client.pushLogs(entries)).rejects.toMatchObject({
      name: "AgentLogUploadError",
      status: 429,
      retryAfterMs: 17_000,
    } satisfies Partial<AgentLogUploadError>);
  });

  it("registers with the profile API key bootstrap credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agentId: "agent-id", agentSecret: "agent-secret" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      registerAgent("https://dashboard.example", "profile-key", {
        hostname: "desk",
        version: "1.0.0",
        platform: "win32",
      }),
    ).resolves.toEqual({ agentId: "agent-id", agentSecret: "agent-secret" });

    expect(fetchMock).toHaveBeenCalledWith("https://dashboard.example/api/agent/register", {
      method: "POST",
      headers: {
        "X-API-Key": "profile-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hostname: "desk", version: "1.0.0", platform: "win32" }),
    });
  });

  it("fetches a first-party WebSocket token with agent credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "ws-token", expiresAt: 123 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentApiClient("https://dashboard.example", "agent-id", "agent-secret");

    await expect(client.getWsToken()).resolves.toEqual({ token: "ws-token", expiresAt: 123 });
    expect(fetchMock).toHaveBeenCalledWith("https://dashboard.example/api/agent/ws-token", {
      headers: {
        "X-Agent-Id": "agent-id",
        "X-Agent-Secret": "agent-secret",
        "Content-Type": "application/json",
      },
    });
  });

  it("builds ws and wss URLs for the first-party command channel", () => {
    expect(new AgentApiClient("https://dashboard.example", "agent-id", "agent-secret").wsUrl("token"))
      .toBe("wss://dashboard.example/api/agent/ws?token=token");
    expect(new AgentApiClient("http://localhost:3000", "agent-id", "agent-secret").wsUrl("token"))
      .toBe("ws://localhost:3000/api/agent/ws?token=token");
  });
});
