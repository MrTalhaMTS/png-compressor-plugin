# PNG Compressor

Lets Claude shrink PNG images that are on your computer. Ask in plain language, for example "compress every PNG in my Downloads/screenshots folder", and Claude calls this plugin's tools. It uses the same compression approach as the free web tool at [comprimirpng.com](https://comprimirpng.com): palette quantization for big savings, a lossless mode that keeps every pixel, and a "fit under N KB" mode.

Everything runs locally on your machine. The plugin never makes network requests and never uploads your images.

## Requirements

- Claude Code or Cowork (local plugins run on your computer; regular chat does not run them).
- [Node.js](https://nodejs.org) 18 or newer on your PATH. There is nothing else to install and no build step.

## Install

```bash
/plugin marketplace add MrTalhaMTS/png-compressor-plugin
/plugin install png-compressor@png-compressor-plugin
```

## Tools

| Tool                  | What it does                                                                                                                                   | Writes files?                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `compress_png`        | Compresses one PNG. Modes: `smart` (default, set `quality` 10-100), `lossless`, or `target_kb`. Can also shrink to `max_width` / `max_height`. | New file only                  |
| `compress_png_folder` | Compresses every PNG in a folder (up to 200 per call, optionally including subfolders).                                                        | New files in a separate folder |
| `analyze_png`         | Reports size, dimensions, color type, transparency use, distinct colors and embedded metadata.                                                 | No (read-only)                 |
| `strip_png_metadata`  | Removes EXIF, GPS, text comments and timestamps. Pixels are copied byte for byte.                                                              | New file only                  |

## Examples

1. **Compress one screenshot.** "Compress ~/Desktop/hero.png." Claude calls `compress_png` and saves `hero-compressed.png` next to the original, then tells you the before and after size (for typical graphics and screenshots, 40-70% smaller).
2. **Hit a size limit.** "I need logo.png under 100 KB for an upload form." Claude calls `compress_png` with `target_kb: 100`. If 100 KB cannot be reached it returns the smallest result it found and says so.
3. **Clean a whole folder.** "Optimise all PNGs in ~/site/images, keep them lossless." Claude calls `compress_png_folder` with `mode: "lossless"` and writes the copies to `~/site/images/compressed/`, with a per-file report and total savings.
4. **Check before you compress.** "What is inside this PNG? Is the transparency real?" Claude calls `analyze_png` and explains the result, for example that an alpha channel is fully opaque or that 40 KB of EXIF can be removed.
5. **Remove private data.** "Strip the location data from photo.png." Claude calls `strip_png_metadata`; the image looks identical but the EXIF/GPS chunks are gone.

## Safety behaviour

- Original files are never modified, moved or deleted. Results are written as new files; if the target name exists, a number is added (`-2`, `-3`, ...). An explicit `output_path` that already exists is refused.
- If the compressed version would not be smaller, nothing is written.
- Only files that really are PNGs (checked by file signature) are read. Files over 100 MB or 30 megapixels are rejected.
- Animated PNGs (APNG) are refused by `compress_png` because recompressing would flatten them to one frame. `strip_png_metadata` works on them.
- 16-bit PNGs are rejected in `lossless` mode (they would have to be converted to 8-bit) and converted to 8-bit in other modes, with a note in the result.
- Recompressing removes the embedded ICC color profile, and says so in the result. `strip_png_metadata` keeps color profile chunks unless you ask it to remove them.

## Privacy Policy

- **Data collected:** none. The plugin does not collect, log or transmit any data.
- **Data processing:** the file paths and image contents you point Claude at are read from your disk and processed in memory on your computer. Results are written to your disk. The plugin has no network access code and no analytics or telemetry.
- **Third parties:** none. The only outputs go to Claude as the tool result text (file names, sizes and the paths written), the same way any tool result does.
- **Storage and retention:** the plugin stores nothing. The only files it creates are the compressed or cleaned PNGs you asked for.
- **Dependencies:** the PNG encoder is [UPNG.js](https://github.com/photopea/UPNG.js) (MIT), included as readable source in `lib/vendor/`. It runs on Node's built-in `zlib`. No packages are downloaded at install or run time.
- **Contact:** contato@comprimirpng.com

## Development

The server is a dependency-free Node script speaking MCP over stdio (`server.mjs`, `lib/`). Run the end-to-end tests, which generate their own PNG fixtures, with:

```bash
node --test test/server.test.mjs
```

## License

MIT. See `LICENSE`. UPNG.js is MIT licensed, see `lib/vendor/UPNG-LICENSE.txt`.
