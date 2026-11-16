import { ToolError } from "./errors.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Ancillary chunks that change how colors are displayed. Kept by default when stripping metadata.
export const COLOR_CHUNKS = new Set(["iCCP", "sRGB", "gAMA", "cHRM", "cICP"]);
// Chunks that carry animation data. Kept so animated PNGs keep working.
const ANIMATION_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);
// Chunks that describe the pixels themselves.
const IMAGE_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);

export const COLOR_TYPE_NAMES = {
  0: "grayscale",
  2: "truecolor (RGB)",
  3: "indexed (palette)",
  4: "grayscale + alpha",
  6: "truecolor + alpha (RGBA)",
};

export function isPng(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

/** Lists every chunk with its offset (start of the length field) and total size on disk. */
export function parseChunks(buf) {
  if (!isPng(buf)) throw new ToolError("Not a PNG file (missing PNG signature).");
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const size = length + 12; // length + type + data + crc
    if (offset + size > buf.length) {
      throw new ToolError(`Corrupt PNG: chunk "${type}" runs past the end of the file.`);
    }
    chunks.push({ type, offset, length, size });
    offset += size;
    if (type === "IEND") break;
  }
  if (chunks.length === 0 || chunks[0].type !== "IHDR" || chunks[0].length !== 13) {
    throw new ToolError("Corrupt PNG: the first chunk is not a valid IHDR header.");
  }
  if (chunks[chunks.length - 1].type !== "IEND") {
    throw new ToolError("Corrupt PNG: the file is truncated (no IEND chunk).");
  }
  return chunks;
}

export function readIhdr(buf, chunks) {
  const o = chunks[0].offset + 8;
  return {
    width: buf.readUInt32BE(o),
    height: buf.readUInt32BE(o + 4),
    bitDepth: buf[o + 8],
    colorType: buf[o + 9],
    interlaced: buf[o + 12] === 1,
  };
}

/** Ancillary chunks (everything that is not pixel data), with a short human description. */
const DESCRIPTIONS = {
  tEXt: "text (comments, author, software)",
  zTXt: "compressed text",
  iTXt: "international text (UTF-8, XMP)",
  eXIf: "EXIF data (camera, date, GPS)",
  pHYs: "physical pixel size (DPI)",
  tIME: "last-modified time",
  iCCP: "embedded ICC color profile",
  sRGB: "sRGB color space marker",
  gAMA: "gamma",
  cHRM: "primary chromaticities",
  cICP: "coding-independent color info",
  bKGD: "default background color",
  sBIT: "significant bits",
  hIST: "palette histogram",
  sPLT: "suggested palette",
};

export function describeChunk(type) {
  return DESCRIPTIONS[type] ?? "other ancillary data";
}

export function metadataChunks(chunks) {
  return chunks.filter((c) => !IMAGE_CHUNKS.has(c.type) && !ANIMATION_CHUNKS.has(c.type));
}

/**
 * Rebuilds the file without metadata chunks. Pixel data (IDAT) is copied byte for byte, so the
 * image is identical. Color chunks are kept unless stripColorProfile is true.
 */
export function stripChunks(buf, chunks, { stripColorProfile }) {
  const kept = [SIGNATURE];
  const removed = [];
  for (const c of chunks) {
    const critical = c.type.charCodeAt(0) >= 65 && c.type.charCodeAt(0) <= 90; // uppercase first letter
    const keep =
      critical ||
      IMAGE_CHUNKS.has(c.type) ||
      ANIMATION_CHUNKS.has(c.type) ||
      (COLOR_CHUNKS.has(c.type) && !stripColorProfile);
    if (keep) kept.push(buf.subarray(c.offset, c.offset + c.size));
    else removed.push(c);
  }
  return { output: Buffer.concat(kept), removed };
}
