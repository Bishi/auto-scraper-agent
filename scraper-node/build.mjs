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

// ---------------------------------------------------------------------------
// esbuild plugins — stub optional playwright-core deps unavailable in SEA
// ---------------------------------------------------------------------------

/**
 * playwright-core ≥ 1.46 eagerly imports chromium-bidi (BiDi protocol) at the
 * top of server/playwright.js. We never use BiDi — only CDP via a persistent
 * context — so replace with no-op stubs bundled into the SEA.
 */
const chromiumBidiStub = {
  name: "chromium-bidi-stub",
  setup(build) {
    build.onResolve({ filter: /^chromium-bidi\// }, (args) => ({
      path: args.path,
      namespace: "chromium-bidi-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "chromium-bidi-stub" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};

/**
 * puppeteer-extra (and its stealth plugin's dependency chain) uses a lazy
 * Object.defineProperty getter that calls require('kind-of') at runtime.
 * esbuild cannot statically inline it, so the bare require survives into the
 * bundle. In Node.js SEA mode require() is redirected to embedderRequire,
 * which only handles built-in modules → ERR_UNKNOWN_BUILTIN_MODULE crash.
 * Stub it out the same way as chromium-bidi.
 */
const kindOfStub = {
  name: "kind-of-stub",
  setup(build) {
    build.onResolve({ filter: /^kind-of$/ }, (args) => ({
      path: args.path,
      namespace: "kind-of-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "kind-of-stub" }, () => ({
      // Minimal implementation: return the native typeof so callers get
      // a valid string rather than crashing entirely.
      contents: "module.exports = function kindOf(v) { return typeof v; };",
      loader: "js",
    }));
  },
};

/**
 * clone-deep and shallow-clone (dependencies of puppeteer-extra) use the
 * legacy `lazy-cache` pattern: they temporarily replace the local `require`
 * with a lazy-cache wrapper and register their own deps (kind-of, etc.) into
 * it.  The wrapper captures the *outer* require reference — which in Node SEA
 * mode is `embedderRequire` — and calls it lazily when a property is accessed.
 * esbuild's onResolve stub for `kind-of` is therefore bypassed, and the lazy
 * getter crashes with ERR_UNKNOWN_BUILTIN_MODULE at runtime.
 *
 * Fix: replace both packages with self-contained stubs so `lazy-cache` is
 * never involved at all.  These stubs cover every call-site in puppeteer-extra
 * (deep-cloning plain plugin config objects + primitive values).
 */
const cloneDeepStub = {
  name: "clone-deep-stub",
  setup(build) {
    build.onResolve({ filter: /^clone-deep$/ }, (args) => ({
      path: args.path,
      namespace: "clone-deep-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "clone-deep-stub" }, () => ({
      contents: `
module.exports = function cloneDeep(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(module.exports);
  // Set and Map must be cloned as Set/Map — iterating them as plain objects
  // produces empty results and breaks plugins that store options in a Set
  // (e.g. puppeteer-extra-plugin-stealth's enabledEvasions Set).
  if (val instanceof Set) return new Set(Array.from(val).map(module.exports));
  if (val instanceof Map) return new Map(Array.from(val).map(([k, v]) => [module.exports(k), module.exports(v)]));
  const out = {};
  for (const k of Object.keys(val)) {
    out[k] = typeof val[k] === "function" ? val[k] : module.exports(val[k]);
  }
  return out;
};`,
      loader: "js",
    }));
  },
};

const shallowCloneStub = {
  name: "shallow-clone-stub",
  setup(build) {
    build.onResolve({ filter: /^shallow-clone$/ }, (args) => ({
      path: args.path,
      namespace: "shallow-clone-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "shallow-clone-stub" }, () => ({
      contents: `
module.exports = function shallowClone(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.slice();
  return Object.assign({}, val);
};`,
      loader: "js",
    }));
  },
};

/**
 * playwright-core uses require.resolve() to locate its own package directory.
 * In Node.js ≥ 24 SEA mode require.resolve is not a function. Polyfill it so
 * the registry init doesn't crash before we even call launchPersistentContext.
 * We override executablePath at runtime so the wrong coreDir doesn't matter.
 */
const requireResolvePolyfill = `\
if (typeof require !== "undefined" && typeof require.resolve !== "function") {
  require.resolve = function seaRequireResolveStub(id) { return id; };
}
`;

await build({
  entryPoints: [join(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: outCjs,
  plugins: [chromiumBidiStub, kindOfStub, cloneDeepStub, shallowCloneStub],
  banner: { js: requireResolvePolyfill },
  // Playwright launches a browser subprocess and connects via WebSocket.
  // Its JS code bundles fine as long as executablePath is set at runtime
  // (so it never tries to locate its own browser binaries on disk).
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
