import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultServerUrl = "https://auto-scraper-develop.up.railway.app";

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("packaged setup and macOS runtime wiring", () => {
  it("defaults first-run setup to the develop server without requiring an API key", async () => {
    const renderer = await readRepoFile("renderer/renderer.js");
    const html = await readRepoFile("renderer/index.html");

    expect(renderer).toContain(`const DEFAULT_SERVER_URL = "${defaultServerUrl}"`);
    expect(html).toContain(defaultServerUrl);
    expect(html).toContain("No API key is needed.");
    expect(html).toContain("Legacy API Key");
  });

  it("bundles Chromium runtime resources and macOS sidecar entitlements", async () => {
    const config = JSON.parse(await readRepoFile("src-tauri/tauri.conf.json")) as {
      bundle?: {
        resources?: string[];
        macOS?: {
          hardenedRuntime?: boolean;
          entitlements?: string;
        };
      };
    };
    const entitlements = await readRepoFile("src-tauri/entitlements/macos.plist");
    const setupChromium = await readRepoFile("scraper-node/setup-chromium.mjs");

    expect(config.bundle?.resources).toContain("resources/chromium-headless-shell-*/**/*");
    expect(config.bundle?.macOS?.hardenedRuntime).toBe(true);
    expect(config.bundle?.macOS?.entitlements).toBe("entitlements/macos.plist");
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(setupChromium).toContain("../src-tauri/resources");
    expect(setupChromium).toContain("chromium-headless-shell-${triple}");
  });

  it("keeps ownership of the Tauri sidecar child process", async () => {
    const tauriLib = await readRepoFile("src-tauri/src/lib.rs");

    expect(tauriLib).toContain("static SIDECAR_CHILD");
    expect(tauriLib).toContain("store_sidecar_child(child)");
    expect(tauriLib).toContain("shutdown_sidecar_for_app_exit()");
    expect(tauriLib).not.toContain("std::mem::forget(child)");
    expect(tauriLib).not.toContain("std::mem::forget(new_child)");
  });

  it("does not reuse the bundled headless shell for headed browser mode", async () => {
    const scraper = await readRepoFile("scraper-node/src/scraper.ts");

    expect(scraper).toContain("resolveBrowserExecutablePath(headless)");
    expect(scraper).toContain("isHeadlessShellPath(chromiumPath)");
    expect(scraper).toContain("headless=false; ignoring bundled chromium-headless-shell");
    expect(scraper).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });
});
