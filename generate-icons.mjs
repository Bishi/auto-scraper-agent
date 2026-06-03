/**
 * Generates all Tauri-required icon formats (ICO, PNGs) from a solid-color
 * source PNG — no external image dependencies needed.
 *
 * Run once before building:
 *   node generate-icons.mjs    (from agent/)
 *   npm run generate:icons     (via package.json)
 */

import { deflateSync } from "node:zlib";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal PNG encoder (no deps — uses Node's built-in zlib)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = (CRC_TABLE[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0);
}
function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcVal]);
}

/** Create a solid-colour square PNG of `size`×`size` pixels. */
function createSolidPNG(size, r, g, b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: RGB truecolour

  // Each row: 1-byte filter (0 = None) + width×3 bytes of RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const rawData = Buffer.concat(Array.from({ length: size }, () => row));
  const idat = deflateSync(rawData);

  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Write source PNG and run `tauri icon`
// ---------------------------------------------------------------------------

const iconsDir = join(__dirname, "src-tauri/icons");
mkdirSync(iconsDir, { recursive: true });

// 1024×1024 indigo-500 (#6366F1) — must be at least 1024px for Tauri
const sourcePng = join(iconsDir, "_source.png");
console.log("Generating 1024×1024 source PNG...");
writeFileSync(sourcePng, createSolidPNG(1024, 0x63, 0x66, 0xf1));
console.log(`  ✓ ${sourcePng}`);

console.log("Running `tauri icon` to generate all formats...");
execSync(`npx tauri icon "${sourcePng}"`, { cwd: __dirname, stdio: "inherit" });

console.log("\n✅ Icons generated in src-tauri/icons/");
