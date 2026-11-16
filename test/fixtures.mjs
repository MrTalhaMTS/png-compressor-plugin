// Builds PNG test images in code so no binary fixtures are committed.
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";

const UPNG = createRequire(import.meta.url)("../lib/vendor/upng.cjs");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Inserts an ancillary chunk right after IHDR. */
export function addChunk(png, type, data) {
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([
    png.subarray(0, ihdrEnd),
    makeChunk(type, Buffer.from(data)),
    png.subarray(ihdrEnd),
  ]);
}

/** Smooth gradient with deterministic noise and a transparent circle in the middle. */
export function makeRgba(width, height, { transparentCircle = true } = {}) {
  const data = new Uint8Array(width * height * 4);
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = Math.round((x / width) * 255);
      data[o + 1] = Math.round((y / height) * 255);
      data[o + 2] = Math.round(rand() * 40 + 100);
      const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 < (width / 4) ** 2;
      data[o + 3] = transparentCircle && inside ? 0 : 255;
    }
  }
  return data;
}

export function makePng(width = 200, height = 160, opts) {
  const rgba = makeRgba(width, height, opts);
  return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0));
}

export function makeApng(width = 32, height = 32) {
  const a = makeRgba(width, height).buffer;
  const b = makeRgba(width, height, { transparentCircle: false }).buffer;
  return Buffer.from(UPNG.encode([a, b], width, height, 0, [100, 100]));
}

export function decode(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const img = UPNG.decode(ab);
  return { width: img.width, height: img.height, rgba: new Uint8Array(UPNG.toRGBA8(img)[0]) };
}
