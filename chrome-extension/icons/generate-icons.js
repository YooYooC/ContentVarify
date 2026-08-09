"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SCALE = 4;
const SIZE = 128;
const W = SIZE * SCALE;
const pixels = new Uint8Array(W * W * 4);

function color(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255
  ];
}

function setPixel(x, y, rgba) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4;
  pixels[i] = rgba[0];
  pixels[i + 1] = rgba[1];
  pixels[i + 2] = rgba[2];
  pixels[i + 3] = rgba[3];
}

function roundedRect(x, y, width, height, radius, rgba) {
  x *= SCALE; y *= SCALE; width *= SCALE; height *= SCALE; radius *= SCALE;
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      const cx = Math.max(x + radius, Math.min(px, x + width - radius - 1));
      const cy = Math.max(y + radius, Math.min(py, y + height - radius - 1));
      if ((px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2) setPixel(px, py, rgba);
    }
  }
}

function circle(cx, cy, radius, rgba) {
  cx *= SCALE; cy *= SCALE; radius *= SCALE;
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) setPixel(x, y, rgba);
    }
  }
}

function line(x1, y1, x2, y2, width, rgba) {
  x1 *= SCALE; y1 *= SCALE; x2 *= SCALE; y2 *= SCALE; width *= SCALE;
  const minX = Math.floor(Math.min(x1, x2) - width);
  const maxX = Math.ceil(Math.max(x1, x2) + width);
  const minY = Math.floor(Math.min(y1, y2) - width);
  const maxY = Math.ceil(Math.max(y1, y2) + width);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const radius2 = (width / 2) ** 2;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      const qx = x1 + t * dx;
      const qy = y1 + t * dy;
      if ((x - qx) ** 2 + (y - qy) ** 2 <= radius2) setPixel(x, y, rgba);
    }
  }
}

function downsample() {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const total = [0, 0, 0, 0];
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          const i = (((y * SCALE + sy) * W) + x * SCALE + sx) * 4;
          for (let c = 0; c < 4; c++) total[c] += pixels[i + c];
        }
      }
      const o = (y * SIZE + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(total[c] / (SCALE * SCALE));
    }
  }
  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
  return output;
}

function png(width, height, rgba) {
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function resizeNearest(source, fromSize, toSize) {
  const out = Buffer.alloc(toSize * toSize * 4);
  for (let y = 0; y < toSize; y++) {
    for (let x = 0; x < toSize; x++) {
      const sx = Math.min(fromSize - 1, Math.floor(x * fromSize / toSize));
      const sy = Math.min(fromSize - 1, Math.floor(y * fromSize / toSize));
      source.copy(out, (y * toSize + x) * 4, (sy * fromSize + sx) * 4, (sy * fromSize + sx) * 4 + 4);
    }
  }
  return out;
}

const forest = color("#163e2c");
const lime = color("#dff268");
const paper = color("#f4f5ef");
const green = color("#255c43");

roundedRect(2, 2, 124, 124, 29, forest);
line(30, 38, 59, 58, 11, lime);
line(30, 64, 54, 51, 11, lime);
line(30, 89, 60, 71, 11, lime);
circle(72, 65, 19, paper);
circle(72, 65, 9, green);
line(84, 78, 103, 97, 10, paper);

const large = downsample();
for (const size of [16, 32, 48, 128]) {
  const data = size === 128 ? large : resizeNearest(large, 128, size);
  fs.writeFileSync(path.join(__dirname, "icon" + size + ".png"), png(size, size, data));
}
