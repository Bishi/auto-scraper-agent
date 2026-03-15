/**
 * Build script: TypeScript → esbuild bundle → Node SEA .exe
 *
 * Steps:
 *   1. esbuild: src/index.ts → dist/scraper.cjs  (all deps inlined, CJS for SEA compatibility)
 *   2. Node SEA config
 *   3. Generate SEA blob:  node --experimental-sea-config sea-config.json
 *   4. Clone node.exe, inject blob with postject
 *   5. Copy to ../src-tauri/binaries/scraper-node-<triple>.exe
 *
 * Usage:
 *   node build.mjs          (from agent/scraper-node/)
 *   npm run build:sea       (same, via package.json)
 */

import { build } from "esbuild";
import { execSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
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

const triple = getTargetTriple();
const exeName = isWin ? "scraper-node.exe" : "scraper-node";
const distDir = join(__dirname, "dist");
const outCjs = join(distDir, "scraper.cjs");
const outBlob = join(distDir, "sea-prep.blob");
const outExe = join(distDir, exeName);

mkdirSync(distDir, { recursive: true });

// ---------------------------------------------------------------------------
// Step 1: Bundle with esbuild
// ---------------------------------------------------------------------------
console.log("Step 1: Bundling with esbuild...");

await build({
  entryPoints: [join(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: outCjs,
  // Playwright launches a browser subprocess and connects via WebSocket.
  // Its JS code bundles fine as long as executablePath is set at runtime
  // (so it never tries to locate its own browser binaries on disk).
  // No explicit externals needed for our usage pattern.
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  minify: false,
  sourcemap: false,
});

console.log("  ✓ dist/scraper.cjs");

// ---------------------------------------------------------------------------
// Step 2: SEA config
// ---------------------------------------------------------------------------
console.log("Step 2: Writing SEA config...");

const seaConfigPath = join(__dirname, "sea-config.json");
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: outCjs.replace(/\\/g, "/"),
      output: outBlob.replace(/\\/g, "/"),
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);

console.log("  ✓ sea-config.json");

// ---------------------------------------------------------------------------
// Step 3: Generate SEA blob
// ---------------------------------------------------------------------------
console.log("Step 3: Generating SEA blob...");
execSync(`node --experimental-sea-config "${seaConfigPath}"`, {
  cwd: __dirname,
  stdio: "inherit",
});
console.log("  ✓ dist/sea-prep.blob");

// ---------------------------------------------------------------------------
// Step 4: Clone node binary + inject blob
// ---------------------------------------------------------------------------
console.log("Step 4: Injecting blob into Node binary...");

copyFileSync(process.execPath, outExe);

// macOS requires removing the code signature before injection
if (isMac) {
  execSync(`codesign --remove-signature "${outExe}"`, { stdio: "inherit" });
}

execSync(
  [
    `npx postject`,
    `"${outExe}"`,
    `NODE_SEA_BLOB`,
    `"${outBlob}"`,
    `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    isMac ? "--macho-segment-name NODE_SEA" : "",
  ]
    .filter(Boolean)
    .join(" "),
  { cwd: __dirname, stdio: "inherit" },
);

console.log(`  ✓ dist/${exeName}`);

// ---------------------------------------------------------------------------
// Step 5: Copy to Tauri binaries dir
// ---------------------------------------------------------------------------
console.log("Step 5: Copying to Tauri binaries...");

const binariesDir = join(__dirname, "../src-tauri/binaries");
mkdirSync(binariesDir, { recursive: true });

const tauriName = `scraper-node-${triple}${isWin ? ".exe" : ""}`;
copyFileSync(outExe, join(binariesDir, tauriName));

console.log(`  ✓ src-tauri/binaries/${tauriName}`);
console.log("\n✅ Node SEA build complete.");
console.log("\nNext: copy Playwright headless-shell to src-tauri/binaries/");
console.log("  npx playwright install --only-shell chromium");
console.log(`  Then copy headless_shell.exe → src-tauri/binaries/chromium-headless-shell-${triple}.exe`);
