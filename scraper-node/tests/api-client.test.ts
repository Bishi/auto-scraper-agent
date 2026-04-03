import { describe, expect, it } from "vitest";
import { describeAgentApiError } from "../src/api-client.js";

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

  it("passes through unknown error values as strings", () => {
    expect(describeAgentApiError("timeout")).toBe("timeout");
  });
});
