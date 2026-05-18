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

  it("mints a token, connects, logs, and heartbeats on connect", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onCommandAvailable = vi.fn();
    const client = {
      getWsToken: vi.fn().mockResolvedValue({ token: "token", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
      wsUrl: vi.fn().mockReturnValue("ws://localhost:3000/api/agent/ws?token=token"),
    } as unknown as AgentApiClient;

    const wsClient = new AgentWebSocketClient(client, onCommandAvailable);
    wsClient.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.message(JSON.stringify({ type: "connected" }));

    expect(client.getWsToken).toHaveBeenCalledOnce();
    expect(client.wsUrl).toHaveBeenCalledWith("token");
    expect(loggerMock.info).toHaveBeenCalledWith("[ws] Connected to agent WebSocket");
    expect(loggerMock.info).toHaveBeenCalledWith("[ws] Server accepted connection");
    expect(onCommandAvailable).toHaveBeenCalledWith("connect");

    wsClient.stop();
  });

  it("dedupes command.available messages and fires immediate heartbeat", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onCommandAvailable = vi.fn();
    const client = {
      getWsToken: vi.fn().mockResolvedValue({ token: "token", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
      wsUrl: vi.fn().mockReturnValue("ws://localhost:3000/api/agent/ws?token=token"),
    } as unknown as AgentApiClient;

    const wsClient = new AgentWebSocketClient(client, onCommandAvailable);
    wsClient.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0]!.message(JSON.stringify({
      type: "command.available",
      commandId: "cmd-1",
      command: "pause",
    }));
    FakeWebSocket.instances[0]!.message(JSON.stringify({
      type: "command.available",
      commandId: "cmd-1",
      command: "pause",
    }));
    FakeWebSocket.instances[0]!.message(JSON.stringify({
      type: "command.available",
      commandId: "cmd-2",
      command: "resume",
    }));

    expect(onCommandAvailable).toHaveBeenCalledTimes(2);
    expect(onCommandAvailable).toHaveBeenNthCalledWith(1, "cmd-1");
    expect(onCommandAvailable).toHaveBeenNthCalledWith(2, "cmd-2");
    expect(loggerMock.info).toHaveBeenCalledWith("[ws] Command available - firing immediate heartbeat");

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

  it("logs planned token-refresh closes at info level", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = {
      getWsToken: vi.fn().mockResolvedValue({ token: "token", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
      wsUrl: vi.fn().mockReturnValue("ws://localhost:3000/api/agent/ws?token=token"),
    } as unknown as AgentApiClient;

    const wsClient = new AgentWebSocketClient(client);
    wsClient.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0]!.open();
    await vi.advanceTimersByTimeAsync(240_000);

    expect(loggerMock.info).toHaveBeenCalledWith("[ws] Refreshing WebSocket token");
    expect(loggerMock.info).toHaveBeenCalledWith("[ws] Closed code=4001 reason=token refresh");
    expect(loggerMock.warn).not.toHaveBeenCalledWith("[ws] Closed code=4001 reason=token refresh");
    wsClient.stop();
  });

  it("ignores stale close events from a previous socket", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = {
      getWsToken: vi.fn().mockResolvedValue({ token: "token", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
      wsUrl: vi.fn().mockReturnValue("ws://localhost:3000/api/agent/ws?token=token"),
    } as unknown as AgentApiClient;

    const wsClient = new AgentWebSocketClient(client);
    wsClient.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const oldSocket = FakeWebSocket.instances[0]!;
    oldSocket.open();
    oldSocket.close(1006, "network");
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2));

    FakeWebSocket.instances[1]!.open();
    oldSocket.close(1000, "late close");
    await vi.advanceTimersByTimeAsync(35_000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    wsClient.stop();
  });
});
