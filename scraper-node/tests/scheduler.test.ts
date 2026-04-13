import { beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/scheduler.js";
import type { AgentApiClient, HeartbeatOptions } from "../src/api-client.js";
import { runModule } from "../src/scraper.js";

vi.mock("../src/scraper.js", () => ({
  runModule: vi.fn(),
}));

function mockClient(): AgentApiClient {
  return {
    cancelJobs: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(),
    getSchedule: vi.fn(),
    pushResults: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue({ ok: true }),
    startJob: vi.fn().mockResolvedValue(undefined),
    // Simulate a server that doesn't support Realtime; watcher falls back to polling silently.
    getRealtimeToken: vi.fn().mockRejectedValue(new Error("not supported")),
  } as unknown as AgentApiClient;
}

const runModuleMock = vi.mocked(runModule);

describe("Scheduler - state machine", () => {
  it("initial state: not running, not paused, no next run", () => {
    const s = new Scheduler();
    expect(s.isRunning).toBe(false);
    expect(s.isPaused).toBe(false);
    expect(s.nextRunAt).toBeNull();
  });

  it("pause() sets isPaused and clears nextRunAt", () => {
    const s = new Scheduler();
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

  it("persists pause and resume through the injected callback", () => {
    const persistPausedState = vi.fn();
    const s = new Scheduler(persistPausedState);

    s.pause();
    s.resume(mockClient());

    expect(persistPausedState).toHaveBeenNthCalledWith(1, true);
    expect(persistPausedState).toHaveBeenNthCalledWith(2, false);
  });
});

describe("Scheduler - triggerNow()", () => {
  it("skips and does not call getSchedule when already running", async () => {
    const s = new Scheduler();
    const client = mockClient();
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
    await s.triggerNow(client);
    expect(client.getSchedule).toHaveBeenCalledOnce();
  });
});

describe("Scheduler - heartbeat pause/resume", () => {
  it("starts paused without running the initial scrape", async () => {
    const client = mockClient();
    (client.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ modules: {} });
    const getSchedule = client.getSchedule as ReturnType<typeof vi.fn>;

    const s = new Scheduler();
    s.start(client as AgentApiClient, "1.0.0", true);

    await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1));
    expect(getSchedule).not.toHaveBeenCalled();
    expect(s.isPaused).toBe(true);

    expect(client.heartbeat).toHaveBeenCalledWith(
      "1.0.0",
      expect.any(String),
      expect.objectContaining({
        schedulerPaused: true,
      }),
    );

    s.stop();
  });

  it("applies pause when server returns pause + commandId", async () => {
    const persistPausedState = vi.fn();
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

    const s = new Scheduler(persistPausedState);
    s.start(client as AgentApiClient, "1.0.0");
    await vi.waitFor(() => expect(s.isPaused).toBe(true));
    expect(persistPausedState).toHaveBeenCalledWith(true);
    expect(hb).toHaveBeenCalledWith(
      "1.0.0",
      expect.any(String),
      expect.objectContaining({
        schedulerPaused: false,
      }),
    );
    s.stop();
  });

  it("cancels the follow-up ack heartbeat when stopped", async () => {
    vi.useFakeTimers();
    try {
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

      await vi.waitFor(() => expect(hb).toHaveBeenCalledTimes(1));
      s.stop();
      await vi.advanceTimersByTimeAsync(600);

      expect(hb).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acks stop_scrape even when no scrape is in progress", async () => {
    vi.useFakeTimers();
    try {
      const client = mockClient();
      (client.getSchedule as ReturnType<typeof vi.fn>).mockResolvedValue({
        intervalMs: 30 * 60 * 1000,
        jobs: [],
      });
      (client.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ modules: {} });
      const hb = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          command: "stop_scrape",
          commandId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
          paused: false,
        })
        .mockResolvedValue({ ok: true, paused: false });
      (client as unknown as { heartbeat: typeof hb }).heartbeat = hb;

      const s = new Scheduler();
      s.start(client as AgentApiClient, "1.0.0");

      await vi.waitFor(() => expect(hb).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(600);
      await vi.waitFor(() => expect(hb).toHaveBeenCalledTimes(2));

      expect(hb).toHaveBeenNthCalledWith(
        2,
        "1.0.0",
        expect.any(String),
        expect.objectContaining({
          ackCommandId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
          activeJobPublicId: null,
        }),
      );

      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pause the scheduler from heartbeat paused echo alone", async () => {
    vi.useFakeTimers();
    try {
      const client = mockClient();
      (client.getSchedule as ReturnType<typeof vi.fn>).mockResolvedValue({
        intervalMs: 30 * 60 * 1000,
        jobs: [],
      });
      (client.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ modules: {} });
      const hb = vi.fn().mockResolvedValue({ ok: true, paused: true });
      (client as unknown as { heartbeat: typeof hb }).heartbeat = hb;

      const s = new Scheduler();
      s.start(client as AgentApiClient, "1.0.0");
      await vi.waitFor(() => expect(hb).toHaveBeenCalledTimes(1));

      expect(s.isPaused).toBe(false);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("acks check_update after applying the server command once", async () => {
    vi.useFakeTimers();
    try {
      const client = mockClient();
      (client.getSchedule as ReturnType<typeof vi.fn>).mockResolvedValue({
        intervalMs: 30 * 60 * 1000,
        jobs: [],
      });
      (client.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ modules: {} });
      const hb = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          command: "check_update",
          commandId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        })
        .mockResolvedValue({ ok: true });
      (client as unknown as { heartbeat: typeof hb }).heartbeat = hb;

      const s = new Scheduler();
      s.start(client as AgentApiClient, "1.0.0");

      await vi.waitFor(() => expect(s.consumeUpdateCheck()).toBe(true));
      await vi.advanceTimersByTimeAsync(600);
      await vi.waitFor(() => expect(hb).toHaveBeenCalledTimes(2));

      expect(hb).toHaveBeenNthCalledWith(
        2,
        "1.0.0",
        expect.any(String),
        expect.objectContaining({
          ackCommandId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
          activeJobPublicId: null,
        }),
      );

      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists resume when the server returns a resume command", async () => {
    vi.useFakeTimers();
    try {
      const persistPausedState = vi.fn();
      const client = mockClient();
      const hb = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          command: "resume",
          commandId: "resume-command-id",
        })
        .mockResolvedValue({ ok: true });
      (client as unknown as { heartbeat: typeof hb }).heartbeat = hb;

      const s = new Scheduler(persistPausedState);
      s.pause();
      s.start(client as AgentApiClient, "1.0.0", true);

      await vi.waitFor(() => expect(hb).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(600);

      expect(s.isPaused).toBe(false);
      expect(persistPausedState).toHaveBeenLastCalledWith(false);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Scheduler - job lifecycle reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports startup failure against the specific job public id", async () => {
    const s = new Scheduler();
    const client = mockClient();
    const heartbeat = client.heartbeat as ReturnType<typeof vi.fn>;
    const startJob = client.startJob as ReturnType<typeof vi.fn>;
    const jobPublicId = "bbbbbbbbbbbb";

    startJob.mockRejectedValue(new Error("start failed"));
    (client.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      modules: { bolha: { enabled: true } },
    });

    await (s as unknown as {
      scrapeAll: (
        c: AgentApiClient,
        config: { modules: Record<string, { enabled: boolean }> },
        jobMap: Map<string, string>,
        trigger: "manual",
      ) => Promise<void>;
    }).scrapeAll(
      client,
      { modules: { bolha: { enabled: true } } },
      new Map([["bolha", jobPublicId]]),
      "manual",
    );

    expect(startJob).toHaveBeenCalledWith(jobPublicId, expect.any(String));
    expect(runModuleMock).not.toHaveBeenCalled();
    expect(client.pushResults).not.toHaveBeenCalled();
    expect(heartbeat).toHaveBeenCalledWith(
      "",
      expect.any(String),
      expect.objectContaining<HeartbeatOptions>({
        schedulerPaused: false,
        activeJobPublicId: jobPublicId,
        failureJobPublicId: jobPublicId,
      }),
    );
  });

  it("reports scrape or result failure with the active job public id before clearing it", async () => {
    const s = new Scheduler();
    const client = mockClient();
    const heartbeat = client.heartbeat as ReturnType<typeof vi.fn>;
    const jobPublicId = "cccccccccccc";

    runModuleMock.mockResolvedValue({
      hadManagedChallenge: false,
      listings: [],
      logs: [],
      filteredListings: [],
      failedUrls: [],
      debugSnapshots: [],
    });
    (client.pushResults as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("upload failed"));

    await (s as unknown as {
      scrapeAll: (
        c: AgentApiClient,
        config: { modules: Record<string, { enabled: boolean }> },
        jobMap: Map<string, string>,
        trigger: "manual",
      ) => Promise<void>;
    }).scrapeAll(
      client,
      { modules: { bolha: { enabled: true } } },
      new Map([["bolha", jobPublicId]]),
      "manual",
    );

    expect(client.startJob).toHaveBeenCalledWith(jobPublicId, expect.any(String));
    expect(client.pushResults).toHaveBeenCalledWith(
      expect.objectContaining({
        jobPublicId,
        moduleName: "bolha",
      }),
    );
    expect(heartbeat).toHaveBeenCalledWith(
      "",
      expect.any(String),
      expect.objectContaining<HeartbeatOptions>({
        schedulerPaused: false,
        activeJobPublicId: jobPublicId,
        failureJobPublicId: jobPublicId,
      }),
    );
    expect((s as unknown as { _activeJobPublicId: string | null })._activeJobPublicId).toBeNull();
  });
});
