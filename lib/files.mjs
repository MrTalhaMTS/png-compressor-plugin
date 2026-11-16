import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError } from "./errors.mjs";
import { isPng } from "./png-chunks.mjs";

export const MAX_INPUT_BYTES = 100 * 1024 * 1024;

export function resolveUserPath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError(`"${label}" must be a non-empty file path.`);
  }
  let p = value.trim();
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

/** Reads a PNG from disk after checking it is a regular file, not too large, and really a PNG. */
export function readPngFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ToolError(`File not found or not readable: ${file}`);
  }
  if (!stat.isFile()) throw new ToolError(`Not a file: ${file}`);
  if (stat.size > MAX_INPUT_BYTES) {
    throw new ToolError(
      `File is ${(stat.size / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_INPUT_BYTES / 1024 / 1024} MB.`,
    );
  }
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    throw new ToolError(`File not readable (permission denied?): ${file}`);
  }
  if (!isPng(buf)) {
    throw new ToolError(`Not a PNG file (the PNG signature is missing): ${file}`);
  }
  return buf;
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** First free path of the form dir/name.png, dir/name-2.png, dir/name-3.png, ... */
export function uniquePngPath(dir, baseName) {
  let candidate = path.join(dir, `${baseName}.png`);
  for (let i = 2; exists(candidate); i++) {
    if (i > 1000)
      throw new ToolError(`Could not find a free file name for "${baseName}" in ${dir}.`);
    candidate = path.join(dir, `${baseName}-${i}.png`);
  }
  return candidate;
}

/**
 * Picks where to write a result. An explicit output path is used as given (and must not exist yet).
 * Otherwise the file goes next to the input as "<name><suffix>.png", numbered if that already exists.
 */
export function chooseOutputPath(inputFile, explicitOutput, suffix) {
  if (explicitOutput !== undefined) {
    const out = resolveUserPath(explicitOutput, "output_path");
    if (path.extname(out).toLowerCase() !== ".png") {
      throw new ToolError(`output_path must end in .png (got "${path.basename(out)}").`);
    }
    if (out === inputFile) {
      throw new ToolError(
        "output_path is the same as input_path. This tool never overwrites the original.",
      );
    }
    if (exists(out)) {
      throw new ToolError(
        `output_path already exists: ${out}. This tool never overwrites files; choose another name.`,
      );
    }
    requireDirectory(path.dirname(out), "The folder for output_path");
    return out;
  }
  const dir = path.dirname(inputFile);
  const base = path.basename(inputFile, path.extname(inputFile));
  return uniquePngPath(dir, `${base}${suffix}`);
}

export function requireDirectory(dir, label) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new ToolError(`${label} does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new ToolError(`${label} is not a folder: ${dir}`);
}

/** Creates the file only if it does not exist yet ("wx"), so existing files are never overwritten. */
export function writeNewFile(file, data) {
  try {
    fs.writeFileSync(file, data, { flag: "wx" });
  } catch (err) {
    if (err && err.code === "EEXIST")
      throw new ToolError(`Refusing to overwrite existing file: ${file}`);
    if (err && (err.code === "EACCES" || err.code === "EPERM")) {
      throw new ToolError(`Permission denied writing ${file}`);
    }
    throw new ToolError(`Could not write ${file}: ${err?.code ?? "unknown error"}`);
  }
}
