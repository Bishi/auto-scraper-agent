import { describe, it, expect, vi } from "vitest";
import { Scheduler } from "../src/scheduler.js";
import type { AgentApiClient } from "../src/api-client.js";

function mockClient(): AgentApiClient {
  return {
    getConfig: vi.fn(),
    getSchedule: vi.fn(),
    pushResults: vi.fn(),
    heartbeat: vi.fn(),
  } as unknown as AgentApiClient;
}

describe("Scheduler — state machine", () => {
  it("initial state: not running, not paused, no next run", () => {
    const s = new Scheduler();
    expect(s.isRunning).toBe(false);
    expect(s.isPaused).toBe(false);
    expect(s.nextRunAt).toBeNull();
  });

  it("pause() sets isPaused and clears nextRunAt", () => {
    const s = new Scheduler();
    // Simulate a scheduled scrape being set
    (s as unknown as { nextRunAt: number }).nextRunAt = Date.now() + 60_000;
    s.pause();
    expect(s.isPaused).toBe(true);
    expect(s.nextRunAt).toBeNull();
  });

  it("stop() resets all state including paused", () => {
    const s = new Scheduler();
    s.pause();
    expect(s.isPaused).toBe(true);
    s.stop();
    expect(s.isPaused).toBe(false);
    expect(s.isRunning).toBe(false);
    expect(s.nextRunAt).toBeNull();
  });

  it("pause() can be called multiple times without error", () => {
    const s = new Scheduler();
    s.pause();
    s.pause();
    expect(s.isPaused).toBe(true);
  });
});

describe("Scheduler — triggerNow()", () => {
  it("skips and does not call getSchedule when already running", async () => {
    const s = new Scheduler();
    const client = mockClient();
    // Force the running flag to simulate an active scrape
    (s as unknown as { _running: boolean })._running = true;
    await s.triggerNow(client);
    expect(client.getSchedule).not.toHaveBeenCalled();
  });

  it("calls getSchedule when not running", async () => {
    const s = new Scheduler();
    const client = mockClient();
    (client.getSchedule as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    );
    // runCycle will fail gracefully — we just confirm it attempted the call
    await s.triggerNow(client);
    expect(client.getSchedule).toHaveBeenCalledOnce();
  });
});

describe("Scheduler — heartbeat pause/resume", () => {
  it("applies pause when server returns pause + commandId", async () => {
    const client = mockClient();
    (client.getSchedule as ReturnType<typeof vi.fn>).mockResolvedValue({
      intervalMs: 30 * 60 * 1000,
      jobs: [],
    });
    (client.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ modules: {} });
    const hb = vi.fn().mockResolvedValue({
      ok: true,
      command: "pause",
      commandId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      paused: false,
    });
    (client as unknown as { heartbeat: typeof hb }).heartbeat = hb;

    const s = new Scheduler();
    s.start(client as AgentApiClient, "1.0.0");
    await vi.waitFor(() => expect(s.isPaused).toBe(true));
    expect(hb).toHaveBeenCalledWith(
      "1.0.0",
      expect.any(String),
      expect.objectContaining({
        schedulerPaused: false,
      }),
    );
    s.stop();
  });

});
