import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addChunk, decode, makeApng, makePng } from "./fixtures.mjs";

const serverPath = new URL("../server.mjs", import.meta.url).pathname;
let child;
let nextId = 1;
const waiting = new Map();
let tmp;

function startServer() {
  child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
}

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function call(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  assert.ok(res.result, `expected a result, got ${JSON.stringify(res)}`);
  return res.result;
}

const textOf = (result) => result.content[0].text;
const file = (name) => path.join(tmp, name);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "png-compressor-test-"));
  startServer();
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
});

after(() => {
  child.stdin.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("lists four tools with annotations", async () => {
  const { result } = await rpc("tools/list", {});
  assert.deepEqual(result.tools.map((t) => t.name).sort(), [
    "analyze_png",
    "compress_png",
    "compress_png_folder",
    "strip_png_metadata",
  ]);
  for (const t of result.tools) {
    assert.ok(t.title && t.description && t.inputSchema && t.annotations, t.name);
    assert.ok(t.name.length <= 64);
  }
  assert.equal(result.tools.find((t) => t.name === "analyze_png").annotations.readOnlyHint, true);
  for (const t of result.tools.filter((t) => t.name !== "analyze_png")) {
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
});

test("unknown method and unknown tool return JSON-RPC errors", async () => {
  assert.equal((await rpc("nope", {})).error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
});

test("analyze_png reports format, transparency and metadata", async () => {
  const png = addChunk(makePng(), "tEXt", Buffer.from("Comment\0hello world, this is metadata"));
  fs.writeFileSync(file("meta.png"), png);
  const text = textOf(await call("analyze_png", { input_path: file("meta.png") }));
  assert.match(text, /Dimensions: 200x160px/);
  assert.match(text, /tEXt/);
  assert.match(text, /fully transparent/);
  assert.match(text, /strip_png_metadata/);
});

test("compress_png smart mode writes a smaller copy and keeps the original", async () => {
  const png = makePng(300, 240);
  fs.writeFileSync(file("a.png"), png);
  const result = await call("compress_png", { input_path: file("a.png") });
  assert.ok(!result.isError, textOf(result));
  const out = file("a-compressed.png");
  assert.ok(fs.existsSync(out));
  assert.ok(fs.statSync(out).size < png.length);
  assert.ok(fs.readFileSync(file("a.png")).equals(png), "original must be untouched");
  const decoded = decode(fs.readFileSync(out));
  assert.equal(decoded.width, 300);
  assert.equal(decoded.height, 240);
  assert.match(textOf(result), /Transparency was preserved/);

  // A second run must not overwrite the first result.
  await call("compress_png", { input_path: file("a.png") });
  assert.ok(fs.existsSync(file("a-compressed-2.png")));
});

test("lossless mode keeps every pixel identical", async () => {
  // Metadata padding guarantees the lossless re-encode is smaller, so a file gets written.
  const png = addChunk(
    makePng(120, 100),
    "tEXt",
    Buffer.from(`Comment\0${"padding ".repeat(500)}`),
  );
  fs.writeFileSync(file("l.png"), png);
  const result = await call("compress_png", {
    input_path: file("l.png"),
    mode: "lossless",
    output_path: file("l-out.png"),
  });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(decode(fs.readFileSync(file("l-out.png"))).rgba, decode(png).rgba);
});

test("a file that cannot get smaller is left alone and nothing is written", async () => {
  fs.writeFileSync(file("tight.png"), makePng(120, 100));
  const result = await call("compress_png", { input_path: file("tight.png"), mode: "lossless" });
  assert.ok(!result.isError, textOf(result));
  assert.match(textOf(result), /no smaller version found/);
  assert.ok(!fs.existsSync(file("tight-compressed.png")));
});

test("target_kb gets under the target or says it could not", async () => {
  const png = makePng(400, 400);
  fs.writeFileSync(file("t.png"), png);
  const target = Math.round(png.length / 1024 / 2);
  const result = await call("compress_png", { input_path: file("t.png"), target_kb: target });
  assert.ok(!result.isError, textOf(result));
  const out = file("t-compressed.png");
  const size = fs.statSync(out).size;
  assert.ok(
    size <= target * 1024 || /could not be reached/.test(textOf(result)),
    `${size} bytes vs ${target} KB`,
  );
});

test("max_width resizes and keeps the aspect ratio", async () => {
  fs.writeFileSync(file("r.png"), makePng(400, 200));
  const result = await call("compress_png", { input_path: file("r.png"), max_width: 100 });
  assert.ok(!result.isError, textOf(result));
  const d = decode(fs.readFileSync(file("r-compressed.png")));
  assert.equal(d.width, 100);
  assert.equal(d.height, 50);
  // transparent circle survives the resize
  const centre = (25 * 100 + 50) * 4;
  assert.equal(d.rgba[centre + 3], 0);
});

test("strip_png_metadata removes text chunks but keeps pixels byte for byte", async () => {
  const png = addChunk(makePng(), "tEXt", Buffer.from("Software\0secret editor"));
  fs.writeFileSync(file("s.png"), png);
  const result = await call("strip_png_metadata", { input_path: file("s.png") });
  assert.ok(!result.isError, textOf(result));
  const out = fs.readFileSync(file("s-clean.png"));
  assert.ok(out.length < png.length);
  assert.ok(!out.includes(Buffer.from("secret editor")));
  assert.deepEqual(decode(out).rgba, decode(png).rgba);
});

test("strip_png_metadata on a clean file writes nothing", async () => {
  fs.writeFileSync(file("c.png"), makePng());
  const result = await call("strip_png_metadata", { input_path: file("c.png") });
  assert.match(textOf(result), /no metadata to remove/);
  assert.ok(!fs.existsSync(file("c-clean.png")));
});

test("never overwrites an existing output_path", async () => {
  fs.writeFileSync(file("o.png"), makePng(300, 240));
  fs.writeFileSync(file("exists.png"), "keep me");
  const result = await call("compress_png", {
    input_path: file("o.png"),
    output_path: file("exists.png"),
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /already exists/);
  assert.equal(fs.readFileSync(file("exists.png"), "utf8"), "keep me");
});

test("rejects bad input with actionable errors", async () => {
  fs.writeFileSync(file("fake.png"), "not really a png");
  assert.match(
    textOf(await call("compress_png", { input_path: file("fake.png") })),
    /PNG signature is missing/,
  );
  assert.match(
    textOf(await call("compress_png", { input_path: file("missing.png") })),
    /not found/,
  );
  assert.match(
    textOf(await call("compress_png", { input_path: file("a.png"), quality: 5 })),
    /between 10 and 100/,
  );
  assert.match(
    textOf(await call("compress_png", { input_path: file("a.png"), mode: "target_kb" })),
    /needs "target_kb"/,
  );
  assert.match(
    textOf(await call("compress_png", { input_path: file("a.png"), bogus: 1 })),
    /Unknown argument/,
  );
  assert.match(textOf(await call("compress_png", {})), /input_path/);
  assert.match(
    textOf(await call("compress_png", { input_path: file("a.png"), output_path: file("x.jpg") })),
    /must end in \.png/,
  );
  const truncated = makePng().subarray(0, 60);
  fs.writeFileSync(file("trunc.png"), truncated);
  assert.equal((await call("compress_png", { input_path: file("trunc.png") })).isError, true);
});

test("animated PNG is refused for compression but can be stripped", async () => {
  const apng = addChunk(makeApng(), "tEXt", Buffer.from("Comment\0animated and annotated"));
  fs.writeFileSync(file("anim.png"), apng);
  const refused = await call("compress_png", { input_path: file("anim.png") });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /animated PNG/);
  const stripped = await call("strip_png_metadata", { input_path: file("anim.png") });
  assert.ok(!stripped.isError, textOf(stripped));
  assert.ok(fs.existsSync(file("anim-clean.png")));
});

test("compress_png_folder processes a folder into a new subfolder", async () => {
  const dir = file("folder");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "one.png"), makePng(300, 240));
  fs.writeFileSync(path.join(dir, "two.PNG"), makePng(260, 200));
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");
  fs.writeFileSync(path.join(dir, "broken.png"), "garbage");
  const result = await call("compress_png_folder", { input_dir: dir });
  assert.ok(!result.isError, textOf(result));
  const text = textOf(result);
  assert.match(text, /Processed 3 PNG file/);
  assert.match(text, /FAIL  broken\.png/);
  assert.deepEqual(fs.readdirSync(path.join(dir, "compressed")).sort(), ["one.png", "two.png"]);
  assert.equal(
    fs.readFileSync(path.join(dir, "one.png")).length,
    makePng(300, 240).length,
    "originals untouched",
  );

  // A second run skips the output folder and numbers new files instead of overwriting.
  await call("compress_png_folder", { input_dir: dir });
  assert.ok(fs.existsSync(path.join(dir, "compressed", "one-2.png")));
});

test("malformed JSON gets a parse error and the server keeps running", async () => {
  const reply = new Promise((resolve) =>
    child.stdout.once("data", (d) => resolve(JSON.parse(String(d).trim()))),
  );
  child.stdin.write("{not json\n");
  assert.equal((await reply).error.code, -32700);
  assert.deepEqual((await rpc("ping", {})).result, {});
});
