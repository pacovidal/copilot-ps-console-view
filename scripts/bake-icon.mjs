#!/usr/bin/env node
// One-shot tool: convert a PNG into the self-describing .rgba blob format
// that lib/webview-child.mjs feeds straight to setWindowIcon. Run with:
//   npm install --no-save pngjs
//   node scripts/bake-icon.mjs <input.png> <output.rgba>
// The .rgba layout is:
//   bytes 0..3  : width  (uint32 little-endian)
//   bytes 4..7  : height (uint32 little-endian)
//   bytes 8..   : raw RGBA8 pixel data (width * height * 4 bytes)
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
    console.error("usage: bake-icon.mjs <input.png> <output.rgba>");
    process.exit(2);
}

const png = PNG.sync.read(readFileSync(inPath));
const header = Buffer.alloc(8);
header.writeUInt32LE(png.width, 0);
header.writeUInt32LE(png.height, 4);
writeFileSync(outPath, Buffer.concat([header, png.data]));
console.log(`Wrote ${outPath} (${png.width}x${png.height}, ${png.data.length} pixel bytes).`);
