import { createRequire } from "node:module";
import { ToolError } from "./errors.mjs";
import { parseChunks, readIhdr } from "./png-chunks.mjs";

const UPNG = createRequire(import.meta.url)("./vendor/upng.cjs");

// Decoded RGBA takes 4 bytes per pixel; this keeps memory use around 120 MB for the pixel buffer.
export const MAX_PIXELS = 30_000_000;

/**
 * Decodes the PNG to exact 8-bit RGBA (straight alpha, no color management).
 * Throws a ToolError for animated, oversized or corrupt files.
 */
export function decodePng(buf) {
  const chunks = parseChunks(buf);
  const ihdr = readIhdr(buf, chunks);
  if (ihdr.width === 0 || ihdr.height === 0)
    throw new ToolError("Corrupt PNG: zero width or height.");
  if (ihdr.width * ihdr.height > MAX_PIXELS) {
    throw new ToolError(
      `Image is ${ihdr.width}x${ihdr.height} (${((ihdr.width * ihdr.height) / 1e6).toFixed(0)} megapixels); the limit is ${MAX_PIXELS / 1e6} megapixels.`,
    );
  }
  const animated = chunks.some((c) => c.type === "acTL");
  let img;
  try {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    img = UPNG.decode(ab);
  } catch {
    throw new ToolError(
      "Could not decode the PNG: the image data is corrupt or uses an unsupported variant.",
    );
  }
  const frame = UPNG.toRGBA8(img)[0];
  if (!frame || frame.byteLength !== img.width * img.height * 4) {
    throw new ToolError("Could not decode the PNG pixel data.");
  }
  return {
    data: new Uint8Array(frame),
    width: img.width,
    height: img.height,
    ihdr,
    chunks,
    animated,
  };
}

/** Counts transparent, semi-transparent and opaque pixels in RGBA data. */
export function transparencyStats(rgba) {
  let transparent = 0;
  let semi = 0;
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a === 255) opaque++;
    else if (a === 0) transparent++;
    else semi++;
  }
  return { transparent, semi, opaque, total: transparent + semi + opaque };
}

/** Largest size that fits max_width / max_height while keeping the aspect ratio. Never upscales. */
export function fitWithin(width, height, maxWidth, maxHeight) {
  let w = width;
  let h = height;
  if (maxWidth && w > maxWidth) {
    h = Math.round(h * (maxWidth / w));
    w = maxWidth;
  }
  if (maxHeight && h > maxHeight) {
    w = Math.round(w * (maxHeight / h));
    h = maxHeight;
  }
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

function axisWeights(srcSize, dstSize) {
  const scale = srcSize / dstSize;
  const out = [];
  for (let d = 0; d < dstSize; d++) {
    const start = d * scale;
    const end = (d + 1) * scale;
    const first = Math.floor(start);
    const last = Math.min(srcSize, Math.ceil(end));
    const weights = [];
    for (let i = first; i < last; i++) {
      weights.push(Math.min(end, i + 1) - Math.max(start, i));
    }
    out.push({ first, weights, total: end - start });
  }
  return out;
}

/**
 * Area-average downscale. Colors are weighted by alpha so transparent pixels do not bleed their
 * (invisible) color into the edges of the image.
 */
export function resizeRgba(src, srcW, srcH, dstW, dstH) {
  const cols = axisWeights(srcW, dstW);
  const rows = axisWeights(srcH, dstH);

  // Horizontal pass: dstW x srcH, storing premultiplied color and alpha as floats.
  const mid = new Float32Array(dstW * srcH * 4);
  for (let y = 0; y < srcH; y++) {
    const rowOffset = y * srcW * 4;
    for (let x = 0; x < dstW; x++) {
      const { first, weights, total } = cols[x];
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let k = 0; k < weights.length; k++) {
        const o = rowOffset + (first + k) * 4;
        const w = weights[k];
        const alpha = src[o + 3];
        r += src[o] * alpha * w;
        g += src[o + 1] * alpha * w;
        b += src[o + 2] * alpha * w;
        a += alpha * w;
      }
      const m = (y * dstW + x) * 4;
      mid[m] = r / total;
      mid[m + 1] = g / total;
      mid[m + 2] = b / total;
      mid[m + 3] = a / total;
    }
  }

  // Vertical pass: dstW x dstH, back to straight 8-bit RGBA.
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const { first, weights, total } = rows[y];
    for (let x = 0; x < dstW; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let k = 0; k < weights.length; k++) {
        const m = ((first + k) * dstW + x) * 4;
        const w = weights[k];
        r += mid[m] * w;
        g += mid[m + 1] * w;
        b += mid[m + 2] * w;
        a += mid[m + 3] * w;
      }
      r /= total;
      g /= total;
      b /= total;
      a /= total;
      const o = (y * dstW + x) * 4;
      if (a > 0) {
        out[o] = Math.min(255, Math.round(r / a));
        out[o + 1] = Math.min(255, Math.round(g / a));
        out[o + 2] = Math.min(255, Math.round(b / a));
        out[o + 3] = Math.min(255, Math.round(a));
      }
    }
  }
  return out;
}

function encode(rgba, width, height, colors) {
  const pixels = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
  return Buffer.from(UPNG.encode([pixels], width, height, colors));
}

/**
 * Encodes RGBA with the same strategy as the comprimirpng.com web tool.
 *  - lossless: exact pixels, only the PNG packing is optimised.
 *  - smart: palette quantization, number of colors = 256 * quality / 100 (quality >= 98 is lossless).
 *  - target_kb: the most colors that still fit under targetKb.
 */
export function encodePng(rgba, width, height, { mode, quality, targetKb }) {
  if (mode === "lossless")
    return { buffer: encode(rgba, width, height, 0), colors: null, targetMet: null };

  if (mode === "target_kb") {
    const targetBytes = Math.round(targetKb * 1024);
    const full = encode(rgba, width, height, 256);
    if (full.length <= targetBytes) return { buffer: full, colors: 256, targetMet: true };
    let smallest = { buffer: full, colors: 256 };
    let fitting = null;
    let low = 2;
    let high = 256;
    for (let i = 0; i < 8 && low <= high; i++) {
      const mid = Math.floor((low + high) / 2);
      const candidate = encode(rgba, width, height, mid);
      if (candidate.length < smallest.buffer.length) smallest = { buffer: candidate, colors: mid };
      if (candidate.length <= targetBytes) {
        fitting = { buffer: candidate, colors: mid };
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const chosen = fitting ?? smallest;
    return { ...chosen, targetMet: fitting !== null };
  }

  if (quality >= 98)
    return { buffer: encode(rgba, width, height, 0), colors: null, targetMet: null };
  const colors = Math.max(2, Math.min(256, Math.round(256 * (quality / 100))));
  return { buffer: encode(rgba, width, height, colors), colors, targetMet: null };
}
