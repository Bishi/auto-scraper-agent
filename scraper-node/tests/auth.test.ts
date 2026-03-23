import { describe, it, expect } from "vitest";
import { SIDECAR_TOKEN, isAuthorized } from "../src/auth.js";

describe("SIDECAR_TOKEN", () => {
  it("is a 64-character lowercase hex string (32 random bytes)", () => {
    expect(SIDECAR_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isAuthorized", () => {
  it("allows requests with the correct token", () => {
    expect(isAuthorized({ "x-sidecar-token": SIDECAR_TOKEN })).toBe(true);
  });

  it("rejects requests with no token header", () => {
    expect(isAuthorized({})).toBe(false);
  });

  it("rejects requests with a wrong token", () => {
    expect(isAuthorized({ "x-sidecar-token": "wrong" })).toBe(false);
  });

  it("rejects requests with an empty token", () => {
    expect(isAuthorized({ "x-sidecar-token": "" })).toBe(false);
  });

  it("rejects requests where token is almost correct (one char off)", () => {
    const almostRight = SIDECAR_TOKEN.slice(0, -1) + (SIDECAR_TOKEN.endsWith("a") ? "b" : "a");
    expect(isAuthorized({ "x-sidecar-token": almostRight })).toBe(false);
  });
});
