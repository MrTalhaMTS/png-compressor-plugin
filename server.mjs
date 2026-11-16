#!/usr/bin/env node
// PNG Compressor MCP server (stdio). Everything runs locally; the server makes no network requests.
import fs from "node:fs";
import { createServer } from "./lib/mcp.mjs";
import { tools } from "./lib/tools.mjs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./.claude-plugin/plugin.json", import.meta.url), "utf8"),
);

const server = createServer({
  name: manifest.name,
  title: manifest.displayName,
  version: manifest.version,
  instructions:
    "Compresses PNG files that exist on the user's computer. Tools take file or folder paths, write results as new files " +
    "and never overwrite originals. If the user attached an image in chat that has no path on disk, ask for its file location.",
  tools,
});

server.serve();
