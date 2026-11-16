import fs from "node:fs";
import path from "node:path";
import { ToolError, formatBytes } from "./errors.mjs";
import {
  chooseOutputPath,
  readPngFile,
  requireDirectory,
  resolveUserPath,
  uniquePngPath,
  writeNewFile,
} from "./files.mjs";
import { analyzeBuffer, compressBuffer, stripBuffer } from "./operations.mjs";

const MAX_FOLDER_FILES = 200;
const DEFAULT_FOLDER_FILES = 100;

// ---------- argument parsing ----------

function expectObject(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args))
    throw new ToolError("Arguments must be an object.");
  return args;
}

function rejectUnknown(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key))
      throw new ToolError(`Unknown argument "${key}". Allowed: ${allowed.join(", ")}.`);
  }
}

function optionalString(args, key) {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string.`);
  return v;
}

function optionalNumber(args, key, { min, max, integer }) {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new ToolError(`"${key}" must be a number.`);
  if (integer && !Number.isInteger(v)) throw new ToolError(`"${key}" must be a whole number.`);
  if (v < min || v > max) throw new ToolError(`"${key}" must be between ${min} and ${max}.`);
  return v;
}

function optionalBoolean(args, key) {
  const v = args[key];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new ToolError(`"${key}" must be true or false.`);
  return v;
}

const COMPRESSION_KEYS = ["mode", "quality", "target_kb", "max_width", "max_height"];

function parseCompressionOptions(args) {
  const targetKb = optionalNumber(args, "target_kb", { min: 1, max: 100000 });
  let mode = optionalString(args, "mode");
  if (mode === undefined) mode = targetKb !== undefined ? "target_kb" : "smart";
  if (!["smart", "lossless", "target_kb"].includes(mode)) {
    throw new ToolError(`"mode" must be "smart", "lossless" or "target_kb".`);
  }
  if (mode === "target_kb" && targetKb === undefined) {
    throw new ToolError(`mode "target_kb" needs "target_kb" (the size to aim for, in kilobytes).`);
  }
  const quality = optionalNumber(args, "quality", { min: 10, max: 100, integer: true }) ?? 70;
  const maxWidth = optionalNumber(args, "max_width", { min: 1, max: 20000, integer: true });
  const maxHeight = optionalNumber(args, "max_height", { min: 1, max: 20000, integer: true });
  return { mode, quality, targetKb, maxWidth, maxHeight };
}

const compressionSchema = {
  mode: {
    type: "string",
    enum: ["smart", "lossless", "target_kb"],
    description:
      'Compression mode. "smart" (default) reduces the palette according to "quality" for the biggest savings; ' +
      '"lossless" keeps every pixel identical; "target_kb" finds the best quality that fits under "target_kb". ' +
      'Defaults to "target_kb" when target_kb is given.',
  },
  quality: {
    type: "integer",
    minimum: 10,
    maximum: 100,
    description:
      "Smart mode only. 10-100, default 70. Higher keeps more colors; 98 or more is lossless.",
  },
  target_kb: {
    type: "number",
    minimum: 1,
    description:
      'Target file size in kilobytes for mode "target_kb". The smallest result is returned if it cannot be reached.',
  },
  max_width: {
    type: "integer",
    minimum: 1,
    description: "Shrink the image to at most this width in pixels (never enlarges).",
  },
  max_height: {
    type: "integer",
    minimum: 1,
    description: "Shrink the image to at most this height in pixels (never enlarges).",
  },
};

// ---------- formatting ----------

function describeResult(name, info) {
  if (!info.smaller)
    return `${name}: ${formatBytes(info.original_bytes)}, no smaller version found (left unchanged).`;
  return `${name}: ${formatBytes(info.original_bytes)} -> ${formatBytes(info.output_bytes)} (${info.reduction_percent}% smaller)`;
}

// ---------- tools ----------

const compressPng = {
  name: "compress_png",
  title: "Compress PNG",
  description:
    "Compress one PNG file on the user's computer and save the smaller copy as a NEW file next to the original " +
    "(never overwrites; the original is untouched). Supports smart palette compression, lossless mode, a target size in KB, " +
    "and shrinking to a maximum width/height. Nothing is uploaded; all processing is local. " +
    "Animated PNGs are refused. If no smaller file can be produced, nothing is written.",
  inputSchema: {
    type: "object",
    properties: {
      input_path: { type: "string", description: "Path of the PNG file to compress." },
      output_path: {
        type: "string",
        description:
          'Optional path for the compressed copy; must end in .png and must not exist. Default: "<name>-compressed.png" next to the input.',
      },
      ...compressionSchema,
    },
    required: ["input_path"],
    additionalProperties: false,
  },
  annotations: {
    title: "Compress PNG",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler(rawArgs) {
    const args = expectObject(rawArgs);
    rejectUnknown(args, ["input_path", "output_path", ...COMPRESSION_KEYS]);
    const inputFile = resolveUserPath(args.input_path, "input_path");
    const options = parseCompressionOptions(args);
    const explicitOutput = optionalString(args, "output_path");

    const buf = readPngFile(inputFile);
    const { output, info } = compressBuffer(buf, options);
    const lines = [describeResult(path.basename(inputFile), info)];
    let outputPath = null;
    if (output) {
      outputPath = chooseOutputPath(inputFile, explicitOutput, "-compressed");
      writeNewFile(outputPath, output);
      lines.push(`Saved to: ${outputPath}`);
    }
    if (info.resized)
      lines.push(
        `Resized from ${info.original_width}x${info.original_height} to ${info.width}x${info.height}.`,
      );
    if (info.target_met === false)
      lines.push(
        `The ${options.targetKb} KB target could not be reached; this is the smallest result found.`,
      );
    if (info.palette_colors) lines.push(`Palette: ${info.palette_colors} colors.`);
    if (info.has_transparency) lines.push("Transparency was preserved.");
    for (const w of info.warnings) lines.push(`Note: ${w}`);
    return lines.join("\n");
  },
};

function collectPngFiles(root, recursive, excludeDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      throw new ToolError(`Cannot read folder: ${dir}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skip =
          entry.name.startsWith(".") || entry.name === "node_modules" || full === excludeDir;
        if (recursive && !skip) walk(full);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".png") {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

const compressPngFolder = {
  name: "compress_png_folder",
  title: "Compress PNG folder",
  description:
    "Compress every .png file in a folder on the user's computer (up to 200 files per call) and save the smaller copies " +
    'into a separate output folder (default: a new "compressed" subfolder). Originals are never modified or overwritten. ' +
    "Files that cannot be made smaller, animated PNGs and corrupt files are skipped and reported. All processing is local.",
  inputSchema: {
    type: "object",
    properties: {
      input_dir: { type: "string", description: "Folder containing the PNG files." },
      output_dir: {
        type: "string",
        description:
          'Folder for the compressed copies (created if missing). Default: "<input_dir>/compressed".',
      },
      recursive: {
        type: "boolean",
        description:
          "Also include PNG files in subfolders (their layout is kept in the output folder). Default false.",
      },
      max_files: {
        type: "integer",
        minimum: 1,
        maximum: MAX_FOLDER_FILES,
        description: `Maximum number of files to process. Default ${DEFAULT_FOLDER_FILES}, maximum ${MAX_FOLDER_FILES}.`,
      },
      ...compressionSchema,
    },
    required: ["input_dir"],
    additionalProperties: false,
  },
  annotations: {
    title: "Compress PNG folder",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler(rawArgs) {
    const args = expectObject(rawArgs);
    rejectUnknown(args, ["input_dir", "output_dir", "recursive", "max_files", ...COMPRESSION_KEYS]);
    const inputDir = resolveUserPath(args.input_dir, "input_dir");
    requireDirectory(inputDir, "input_dir");
    const options = parseCompressionOptions(args);
    const recursive = optionalBoolean(args, "recursive");
    const maxFiles =
      optionalNumber(args, "max_files", { min: 1, max: MAX_FOLDER_FILES, integer: true }) ??
      DEFAULT_FOLDER_FILES;
    const explicitOut = optionalString(args, "output_dir");
    const outputDir =
      explicitOut !== undefined
        ? resolveUserPath(explicitOut, "output_dir")
        : path.join(inputDir, "compressed");
    if (fs.existsSync(outputDir)) requireDirectory(outputDir, "output_dir");
    if (outputDir === inputDir)
      throw new ToolError(
        "output_dir must be different from input_dir; originals are never overwritten.",
      );

    const all = collectPngFiles(inputDir, recursive, outputDir);
    if (all.length === 0) {
      return `No .png files found in ${inputDir}${recursive ? " (including subfolders)" : ""}.`;
    }
    const files = all.slice(0, maxFiles);

    let originalTotal = 0;
    let outputTotal = 0;
    let compressedCount = 0;
    const lines = [];
    for (const file of files) {
      const rel = path.relative(inputDir, file);
      try {
        const buf = readPngFile(file);
        const { output, info } = compressBuffer(buf, options);
        originalTotal += info.original_bytes;
        outputTotal += info.output_bytes;
        if (output) {
          const targetDir = path.join(outputDir, path.dirname(rel));
          fs.mkdirSync(targetDir, { recursive: true });
          const outPath = uniquePngPath(targetDir, path.basename(file, path.extname(file)));
          writeNewFile(outPath, output);
          compressedCount++;
          lines.push(
            `OK    ${rel}: ${formatBytes(info.original_bytes)} -> ${formatBytes(info.output_bytes)} (${info.reduction_percent}% smaller)`,
          );
        } else {
          lines.push(`SKIP  ${rel}: ${formatBytes(info.original_bytes)}, no smaller version found`);
        }
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        lines.push(`FAIL  ${rel}: ${err.message}`);
      }
    }

    const saved = originalTotal - outputTotal;
    const header = [
      `Processed ${files.length} PNG file(s) from ${inputDir}: ${compressedCount} compressed.`,
      originalTotal > 0
        ? `Total: ${formatBytes(originalTotal)} -> ${formatBytes(outputTotal)} (${formatBytes(saved)} saved, ${Math.round((saved / originalTotal) * 100)}%).`
        : null,
      compressedCount > 0 ? `Compressed copies are in: ${outputDir}` : null,
      all.length > files.length
        ? `${all.length - files.length} more PNG file(s) were not processed (limit ${maxFiles}); run again with a higher max_files or on a subfolder.`
        : null,
    ].filter(Boolean);
    return [...header, "", ...lines].join("\n");
  },
};

const analyzePng = {
  name: "analyze_png",
  title: "Analyze PNG",
  description:
    "Inspect a PNG file on the user's computer without changing anything: file size, dimensions, bit depth, color type, " +
    "transparency usage (including an alpha channel that is fully opaque), number of distinct colors, and embedded metadata " +
    "(EXIF, text, color profile) with how many bytes it takes. Use it to decide how to compress a file.",
  inputSchema: {
    type: "object",
    properties: { input_path: { type: "string", description: "Path of the PNG file to inspect." } },
    required: ["input_path"],
    additionalProperties: false,
  },
  annotations: { title: "Analyze PNG", readOnlyHint: true, openWorldHint: false },
  handler(rawArgs) {
    const args = expectObject(rawArgs);
    rejectUnknown(args, ["input_path"]);
    const inputFile = resolveUserPath(args.input_path, "input_path");
    const report = analyzeBuffer(readPngFile(inputFile));
    const lines = [
      `File: ${path.basename(inputFile)} (${formatBytes(report.file_bytes)})`,
      `Dimensions: ${report.width}x${report.height}px`,
      `Format: ${report.color_type}, ${report.bit_depth}-bit${report.interlaced ? ", interlaced" : ""}${report.animated ? ", animated (APNG)" : ""}`,
      `Alpha channel: ${report.has_alpha_channel ? "yes" : "no"}`,
    ];
    if (report.transparency) {
      const t = report.transparency;
      lines.push(
        `Pixels: ${t.opaque_percent}% opaque, ${t.semi_transparent_percent}% semi-transparent, ${t.transparent_percent}% fully transparent`,
      );
      lines.push(`Distinct colors: ${report.unique_colors}`);
    } else if (report.pixel_analysis_skipped) {
      lines.push(`Pixel analysis skipped: ${report.pixel_analysis_skipped}`);
    }
    if (report.metadata.chunks.length > 0) {
      lines.push(
        `Metadata: ${formatBytes(report.metadata.total_bytes)} in ${report.metadata.chunks.length} chunk(s)`,
      );
      for (const c of report.metadata.chunks)
        lines.push(`  - ${c.type} (${formatBytes(c.bytes)}): ${c.description}`);
    } else {
      lines.push("Metadata: none");
    }
    for (const tip of report.tips) lines.push(`Tip: ${tip}`);
    return lines.join("\n");
  },
};

const stripPngMetadata = {
  name: "strip_png_metadata",
  title: "Strip PNG metadata",
  description:
    "Remove metadata (EXIF, GPS location, text comments, timestamps, DPI) from a PNG on the user's computer and save the result " +
    "as a NEW file; the pixels are copied byte for byte, so the image is identical. Color profile chunks are kept unless " +
    "strip_color_profile is true. Works on animated PNGs. Never overwrites; nothing is uploaded.",
  inputSchema: {
    type: "object",
    properties: {
      input_path: { type: "string", description: "Path of the PNG file." },
      output_path: {
        type: "string",
        description:
          'Optional path for the cleaned copy; must end in .png and must not exist. Default: "<name>-clean.png" next to the input.',
      },
      strip_color_profile: {
        type: "boolean",
        description:
          "Also remove color profile chunks (iCCP, sRGB, gAMA, cHRM, cICP). This can change how colors look. Default false.",
      },
    },
    required: ["input_path"],
    additionalProperties: false,
  },
  annotations: {
    title: "Strip PNG metadata",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler(rawArgs) {
    const args = expectObject(rawArgs);
    rejectUnknown(args, ["input_path", "output_path", "strip_color_profile"]);
    const inputFile = resolveUserPath(args.input_path, "input_path");
    const explicitOutput = optionalString(args, "output_path");
    const stripColorProfile = optionalBoolean(args, "strip_color_profile");

    const { output, info } = stripBuffer(readPngFile(inputFile), { stripColorProfile });
    if (!output)
      return `${path.basename(inputFile)}: no metadata to remove (left unchanged, nothing written).`;
    const outputPath = chooseOutputPath(inputFile, explicitOutput, "-clean");
    writeNewFile(outputPath, output);
    const lines = [
      `${path.basename(inputFile)}: ${formatBytes(info.original_bytes)} -> ${formatBytes(info.output_bytes)} (${formatBytes(info.removed_bytes)} of metadata removed, pixels unchanged)`,
      `Saved to: ${outputPath}`,
      `Removed: ${info.removed_chunks.map((c) => c.type).join(", ")}`,
    ];
    if (info.kept_color_chunks.length > 0)
      lines.push(`Kept color chunks: ${info.kept_color_chunks.join(", ")}`);
    return lines.join("\n");
  },
};

export const tools = [compressPng, compressPngFolder, analyzePng, stripPngMetadata];
