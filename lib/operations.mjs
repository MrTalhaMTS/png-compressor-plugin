import { ToolError } from "./errors.mjs";
import { decodePng, encodePng, fitWithin, resizeRgba, transparencyStats } from "./image.mjs";
import {
  describeChunk,
  metadataChunks,
  parseChunks,
  readIhdr,
  stripChunks,
  COLOR_CHUNKS,
  COLOR_TYPE_NAMES,
} from "./png-chunks.mjs";

const round1 = (n) => Math.round(n * 10) / 10;
const percent = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : 0);

/**
 * Compresses one PNG held in memory. Returns { output, info }.
 * output is null when the result would not be smaller than the original (the original is never made larger).
 */
export function compressBuffer(buf, options) {
  const decoded = decodePng(buf);
  if (decoded.animated) {
    throw new ToolError(
      "This is an animated PNG (APNG). Recompressing would flatten it to one frame, so it was left untouched. " +
        "Use strip_png_metadata to shrink it without touching the frames.",
    );
  }
  const warnings = [];
  if (decoded.ihdr.bitDepth === 16) {
    if (options.mode === "lossless") {
      throw new ToolError(
        "This PNG uses 16 bits per channel; lossless recompression here would convert it to 8 bits and change the pixels. " +
          'Use mode "smart" to accept the 8-bit conversion, or strip_png_metadata to keep the pixels exactly.',
      );
    }
    warnings.push("16-bit channels were converted to 8-bit.");
  }
  if (decoded.chunks.some((c) => c.type === "iCCP")) {
    warnings.push(
      "The embedded ICC color profile was removed; colors may look slightly different in color-managed viewers.",
    );
  }

  let { data, width, height } = decoded;
  const target = fitWithin(width, height, options.maxWidth, options.maxHeight);
  const resized = target.width !== width || target.height !== height;
  if (resized) {
    data = resizeRgba(data, width, height, target.width, target.height);
    width = target.width;
    height = target.height;
    if (options.mode === "lossless")
      warnings.push(
        "Resizing changes pixels, so the result is not pixel-identical to the original.",
      );
  }

  const stats = transparencyStats(data);
  const encoded = encodePng(data, width, height, options);
  const smaller = encoded.buffer.length < buf.length;
  const outputBytes = smaller ? encoded.buffer.length : buf.length;
  const info = {
    original_width: decoded.width,
    original_height: decoded.height,
    width,
    height,
    resized,
    original_bytes: buf.length,
    output_bytes: outputBytes,
    saved_bytes: buf.length - outputBytes,
    reduction_percent: percent(buf.length - outputBytes, buf.length),
    has_transparency: stats.transparent + stats.semi > 0,
    palette_colors: encoded.colors,
    target_met: encoded.targetMet,
    smaller,
    warnings,
  };
  if (!smaller) {
    warnings.push(
      "The recompressed file was not smaller than the original, so nothing was written.",
    );
  }
  return { output: smaller ? encoded.buffer : null, info };
}

function countUniqueColors(rgba, limit) {
  const seen = new Set();
  const view = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
  for (let i = 0; i < view.length; i++) {
    seen.add(view[i]);
    if (seen.size > limit) return { count: limit, capped: true };
  }
  return { count: seen.size, capped: false };
}

/** Read-only report on a PNG: size, format, transparency, colors and metadata. */
export function analyzeBuffer(buf) {
  const chunks = parseChunks(buf);
  const ihdr = readIhdr(buf, chunks);
  const animated = chunks.some((c) => c.type === "acTL");
  const meta = metadataChunks(chunks);
  const metadataBytes = meta.reduce((sum, c) => sum + c.size, 0);
  const hasTrns = chunks.some((c) => c.type === "tRNS");
  const hasAlphaChannel = ihdr.colorType === 4 || ihdr.colorType === 6 || hasTrns;

  const report = {
    file_bytes: buf.length,
    width: ihdr.width,
    height: ihdr.height,
    bit_depth: ihdr.bitDepth,
    color_type: COLOR_TYPE_NAMES[ihdr.colorType] ?? `unknown (${ihdr.colorType})`,
    interlaced: ihdr.interlaced,
    animated,
    has_alpha_channel: hasAlphaChannel,
    metadata: {
      total_bytes: metadataBytes,
      chunks: meta.map((c) => ({
        type: c.type,
        bytes: c.size,
        description: describeChunk(c.type),
      })),
    },
    tips: [],
  };

  let pixelNote = null;
  try {
    const decoded = decodePng(buf);
    const stats = transparencyStats(decoded.data);
    const unique = countUniqueColors(decoded.data, 65536);
    report.transparency = {
      transparent_percent: percent(stats.transparent, stats.total),
      semi_transparent_percent: percent(stats.semi, stats.total),
      opaque_percent: percent(stats.opaque, stats.total),
    };
    report.unique_colors = unique.capped ? "more than 65536" : unique.count;
    report.uses_transparency = stats.transparent + stats.semi > 0;
    if (hasAlphaChannel && !report.uses_transparency) {
      report.tips.push(
        "The file has an alpha channel but every pixel is fully opaque. Compressing will shrink it further.",
      );
    }
    if (!unique.capped && unique.count <= 256 && ihdr.colorType !== 3) {
      report.tips.push(
        `Only ${unique.count} distinct colors: this image fits a palette (PNG-8) and should compress very well in smart mode.`,
      );
    }
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    pixelNote = err.message;
    report.pixel_analysis_skipped = pixelNote;
  }

  if (metadataBytes > 0) {
    report.tips.push(
      `${metadataBytes} bytes of metadata can be removed losslessly with strip_png_metadata.`,
    );
  }
  if (ihdr.bitDepth === 16)
    report.tips.push("16-bit channels: smart or target_kb mode will convert to 8-bit.");
  if (animated)
    report.tips.push(
      "Animated PNG: only strip_png_metadata is safe; compress_png refuses animated files.",
    );
  return report;
}

/** Removes metadata chunks without touching pixel data. */
export function stripBuffer(buf, { stripColorProfile }) {
  const chunks = parseChunks(buf);
  const { output, removed } = stripChunks(buf, chunks, { stripColorProfile });
  const removedBytes = removed.reduce((sum, c) => sum + c.size, 0);
  const keptColor =
    !stripColorProfile && chunks.filter((c) => COLOR_CHUNKS.has(c.type)).map((c) => c.type);
  return {
    output: removedBytes > 0 ? output : null,
    info: {
      original_bytes: buf.length,
      output_bytes: removedBytes > 0 ? output.length : buf.length,
      removed_bytes: removedBytes,
      removed_chunks: removed.map((c) => ({
        type: c.type,
        bytes: c.size,
        description: describeChunk(c.type),
      })),
      kept_color_chunks: keptColor || [],
    },
  };
}
