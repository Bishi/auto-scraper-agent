import { describe, expect, it } from "vitest";
import { shouldTriggerCommandHint } from "../src/realtime-watcher.js";

describe("RealtimeWatcher - command envelope filtering", () => {
  it("fires when a new pending command envelope appears", () => {
    expect(
      shouldTriggerCommandHint(
        { pending_command: "scrape_now", pending_command_id: "cmd-1" },
        { pending_command: null, pending_command_id: null },
        null,
      ),
    ).toBe(true);
  });

  it("ignores lease-only row churn when the command envelope is unchanged", () => {
    expect(
      shouldTriggerCommandHint(
        { pending_command: "scrape_now", pending_command_id: "cmd-1" },
        { pending_command: "scrape_now", pending_command_id: "cmd-1" },
        null,
      ),
    ).toBe(false);
  });

  it("ignores rows without a concrete command id", () => {
    expect(
      shouldTriggerCommandHint(
        { pending_command: "scrape_now", pending_command_id: null },
        { pending_command: null, pending_command_id: null },
        null,
      ),
    ).toBe(false);
  });

  it("ignores a command id that was already seen via heartbeat", () => {
    expect(
      shouldTriggerCommandHint(
        { pending_command: "pause", pending_command_id: "cmd-2" },
        { pending_command: null, pending_command_id: null },
        "cmd-2",
      ),
    ).toBe(false);
  });
});
