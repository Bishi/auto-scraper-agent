import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWebSocketClient } from "../src/ws-client.js";
import type { AgentApiClient } from "../src/api-client.js";

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  agentLogger: loggerMock,
}));

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(code = 1000, reason = ""): void {
    const event = new Event("close") as Event & { code: number; reason: string };
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }

  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("AgentWebSocketClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
  });

  it("mints a token, connects, and logs the accepted connection", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = {
      getWsToken: vi.fn().mockResolvedValue({ token: "token", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
      wsUrl: vi.fn().mockReturnValue("ws://localhost:3000/api/agent/ws?token=token"),
    } as unknown as AgentApiClient;

    const wsClient = new AgentWebSocketClient(client);
    wsClient.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.message(JSON.stringify({ type: "connected" }));

    expect(client.getWsToken).toHaveBeenCalledOnce();
    expect(client.wsUrl).toHaveBeenCalledWith("token");
    expect(loggerMock.info).toHaveBeenCalledWith("[ws] Connected to agent WebSocket");
    expect(loggerMock.info).toHaveBeenCalledWith("[ws] Server accepted connection");

    wsClient.stop();
  });

  it("reconnects with backoff after a close", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = {
      getWsToken: vi.fn().mockResolvedValue({ token: "token", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
      wsUrl: vi.fn().mockReturnValue("ws://localhost:3000/api/agent/ws?token=token"),
    } as unknown as AgentApiClient;

    const wsClient = new AgentWebSocketClient(client);
    wsClient.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0]!.close(1006, "network");
    await vi.advanceTimersByTimeAsync(1_500);

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    wsClient.stop();
  });
});
