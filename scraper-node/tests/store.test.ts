import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));

const homedirMock = vi.fn(() => "C:\\Users\\tester");

vi.mock("node:os", () => ({
  homedir: homedirMock,
}));

describe("store", () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    homedirMock.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("reads legacy config files without schedulerPaused", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      apiKey: "as_live_123",
      serverUrl: "http://localhost:3000",
    }));

    const { readConfig } = await import("../src/store.js");

    expect(readConfig()).toEqual({
      apiKey: "as_live_123",
      serverUrl: "http://localhost:3000",
      schedulerPaused: undefined,
    });
  });

  it("reads schedulerPaused from saved config", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      apiKey: "as_live_123",
      serverUrl: "http://localhost:3000",
      schedulerPaused: true,
    }));

    const { readConfig } = await import("../src/store.js");

    expect(readConfig()?.schedulerPaused).toBe(true);
  });

  it("merges schedulerPaused writes without clobbering saved credentials", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      apiKey: "as_live_123",
      serverUrl: "http://localhost:3000",
    }));

    const { updateConfig } = await import("../src/store.js");

    updateConfig({ schedulerPaused: true });

    expect(mkdirSyncMock).toHaveBeenCalledOnce();
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("agent.json"),
      JSON.stringify({
        apiKey: "as_live_123",
        serverUrl: "http://localhost:3000",
        schedulerPaused: true,
      }, null, 2),
      "utf8",
    );
  });

  it("preserves schedulerPaused when saving config changes", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      apiKey: "as_live_old",
      serverUrl: "http://localhost:3000",
      schedulerPaused: true,
    }));

    const { writeConfig } = await import("../src/store.js");

    writeConfig({
      apiKey: "as_live_new",
      serverUrl: "https://example.com",
    });

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("agent.json"),
      JSON.stringify({
        apiKey: "as_live_new",
        serverUrl: "https://example.com",
        schedulerPaused: true,
      }, null, 2),
      "utf8",
    );
  });
});
