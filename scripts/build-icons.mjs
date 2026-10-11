// Rasterizes assets/icon.svg into the PNG icon the extension ships.
// Usage: npm install --no-save sharp && node scripts/build-icons.mjs
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync(new URL('../assets/icon.svg', import.meta.url));

// The icon is 512x512 and the manifest points every slot at this one file
// (browsers downscale per the manifest map).
const targets = [
  'wxt/public/imgs/logo.png',
];

const png = await sharp(svg, { density: 288 }) // supersample, then downscale for crisp edges
  .resize(512, 512)
  .png()
  .toBuffer();

for (const t of targets) writeFileSync(t, png);
console.log(`wrote ${targets.length} icons`);
