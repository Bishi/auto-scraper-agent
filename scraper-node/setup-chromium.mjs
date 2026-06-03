/**
 * Downloads Playwright's chromium-headless-shell and copies it to
 * src-tauri/binaries/ with the correct Tauri platform triple suffix.
 *
 * It also copies the browser's runtime support files to src-tauri/resources/.
 * macOS headless-shell needs files such as icudtl.dat next to the executable.
 *
 * Run once before `npm run build:tauri`:
 *   node setup-chromium.mjs        (from agent/scraper-node/)
 *   npm run setup:chromium         (via package.json)
 */

import { execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = platform() === "win32";
const isMac = platform() === "darwin";

function getTargetTriple() {
  if (isWin) return "x86_64-pc-windows-msvc";
  if (isMac) return arch() === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return "x86_64-unknown-linux-gnu";
}

// ---------------------------------------------------------------------------
// Step 1: Install chromium-headless-shell via Playwright
// ---------------------------------------------------------------------------
console.log("Step 1: Installing chromium-headless-shell via Playwright...");

// Run from the repo root so it uses the root node_modules/playwright.
const repoRoot = join(__dirname, "../..");
execSync("npx playwright install chromium-headless-shell", {
  cwd: repoRoot,
  stdio: "inherit",
});

// ---------------------------------------------------------------------------
// Step 2: Locate the installed binary
// ---------------------------------------------------------------------------
console.log("Step 2: Locating installed binary...");

function findShellBinary() {
  const customPath = process.env["PLAYWRIGHT_BROWSERS_PATH"];

  const searchRoots = [];
  if (customPath) searchRoots.push(customPath);

  if (isWin) {
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    searchRoots.push(join(localAppData, "ms-playwright"));
  } else if (isMac) {
    searchRoots.push(join(process.env["HOME"] ?? "", "Library/Caches/ms-playwright"));
  } else {
    searchRoots.push(join(process.env["HOME"] ?? "", ".cache/ms-playwright"));
  }

  for (const root of searchRoots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) =>
      d.startsWith("chromium-headless-shell") || d.startsWith("chromium_headless_shell"),
    );
    for (const dir of dirs) {
      const dirPath = join(root, dir);
      const candidates = [
        join(dirPath, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
        join(dirPath, "chrome-win", "headless_shell.exe"),
        join(dirPath, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
        join(dirPath, "chrome-headless-shell-mac_arm64", "chrome-headless-shell"),
        join(dirPath, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
        join(dirPath, "chrome-mac", "headless_shell"),
        join(dirPath, "chrome-headless-shell-linux", "chrome-headless-shell"),
        join(dirPath, "chrome-linux", "headless_shell"),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const shellSrc = findShellBinary();

if (!shellSrc) {
  const triple = getTargetTriple();
  console.error("ERROR: Could not locate chromium-headless-shell after installation.");
  console.error("Copy it manually from your Playwright browser cache:");
  console.error("  %LOCALAPPDATA%\\ms-playwright\\chromium_headless_shell-*\\chrome-headless-shell-win64\\chrome-headless-shell.exe");
  console.error(`  -> agent/src-tauri/binaries/chromium-headless-shell-${triple}.exe`);
  process.exit(1);
}

console.log(`  Found: ${shellSrc}`);

// ---------------------------------------------------------------------------
// Step 3: Copy executable for Tauri externalBin compatibility
// ---------------------------------------------------------------------------
console.log("Step 3: Copying executable to Tauri binaries...");

const triple = getTargetTriple();
const ext = isWin ? ".exe" : "";
const binariesDir = join(__dirname, "../src-tauri/binaries");
mkdirSync(binariesDir, { recursive: true });

const dest = join(binariesDir, `chromium-headless-shell-${triple}${ext}`);
copyFileSync(shellSrc, dest);
if (!isWin) {
  chmodSync(dest, 0o755);
}

console.log(`  src-tauri/binaries/chromium-headless-shell-${triple}${ext}`);

// ---------------------------------------------------------------------------
// Step 4: Copy runtime support files for bundled execution
// ---------------------------------------------------------------------------
console.log("Step 4: Copying Chromium runtime support files...");

const chromiumResourcesDir = join(
  __dirname,
  "../src-tauri/resources",
  `chromium-headless-shell-${triple}`,
);
rmSync(chromiumResourcesDir, { recursive: true, force: true });
mkdirSync(chromiumResourcesDir, { recursive: true });
cpSync(dirname(shellSrc), chromiumResourcesDir, { recursive: true });

const normalizedResourceBinary = join(
  chromiumResourcesDir,
  `chromium-headless-shell${ext}`,
);
copyFileSync(shellSrc, normalizedResourceBinary);
if (!isWin) {
  chmodSync(normalizedResourceBinary, 0o755);
}

console.log(`  src-tauri/resources/chromium-headless-shell-${triple}/`);
console.log("\nChromium headless-shell ready. You can now run: npm run build:tauri");
