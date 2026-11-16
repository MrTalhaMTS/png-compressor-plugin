// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
// It implements only what a tools-only server needs: initialize, ping, tools/list and tools/call.
import { ToolError } from "./errors.mjs";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export function createServer({ name, title, version, instructions, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  const listTools = () =>
    tools.map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations,
    }));

  function callTool(params) {
    const tool = params && typeof params.name === "string" ? byName.get(params.name) : undefined;
    if (!tool) {
      const err = new Error(`Unknown tool: ${params?.name}`);
      err.rpcCode = INVALID_PARAMS;
      throw err;
    }
    try {
      const text = tool.handler(params.arguments);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      if (err instanceof ToolError) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
      process.stderr.write(`[${name}] internal error in ${tool.name}: ${err?.stack ?? err}\n`);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Unexpected internal error while processing the file. The file was not modified.",
          },
        ],
      };
    }
  }

  function handleRequest(method, params) {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, title, version },
          instructions,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: listTools() };
      case "tools/call":
        return callTool(params);
      default: {
        const err = new Error(`Method not found: ${method}`);
        err.rpcCode = METHOD_NOT_FOUND;
        throw err;
      }
    }
  }

  /** Handles one parsed JSON-RPC message; returns the response object, or null for notifications. */
  function handleMessage(msg) {
    if (
      !msg ||
      typeof msg !== "object" ||
      Array.isArray(msg) ||
      msg.jsonrpc !== "2.0" ||
      typeof msg.method !== "string"
    ) {
      // Responses to requests we never send, or garbage: ignore unless it has an id to answer.
      if (
        msg &&
        typeof msg === "object" &&
        "id" in msg &&
        !("result" in msg) &&
        !("error" in msg)
      ) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: INVALID_REQUEST, message: "Invalid request" },
        };
      }
      return null;
    }
    const isNotification = !("id" in msg);
    try {
      const result = handleRequest(msg.method, msg.params);
      return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result };
    } catch (err) {
      if (isNotification) return null; // e.g. notifications/initialized, notifications/cancelled
      if (err?.rpcCode)
        return { jsonrpc: "2.0", id: msg.id, error: { code: err.rpcCode, message: err.message } };
      process.stderr.write(`[${name}] internal error: ${err?.stack ?? err}\n`);
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: INTERNAL_ERROR, message: "Internal error" },
      };
    }
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
      return;
    }
    const response = handleMessage(msg);
    if (response) send(response);
  }

  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function serve(input = process.stdin) {
    let pending = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        handleLine(line);
      }
    });
    input.on("end", () => {
      if (pending.trim()) handleLine(pending);
      process.exit(0);
    });
  }

  return { serve, handleMessage };
}
