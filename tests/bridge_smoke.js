// Smoke test for the native bridge + real Stockfish: framing, all search modes, legacy format.
// Usage: node tests/bridge_smoke.js [bridge.exe] [stockfish.exe]
// Defaults: bin/chess_hint_bridge.exe and engine/stockfish.exe.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.platform !== "win32") {
  console.error("bridge_smoke: this bridge is a Windows executable");
  process.exit(2);
}
const root = path.join(__dirname, "..");
const bridge = path.resolve(process.argv[2] || path.join(root, "bin", "chess_hint_bridge.exe"));
const engine = path.resolve(process.argv[3] || path.join(root, "engine", "stockfish.exe"));
for (const f of [bridge, engine]) {
  if (!fs.existsSync(f)) { console.error("not found: " + f); process.exit(2); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbh-bridge-"));
const exe = path.join(dir, "chess_hint_bridge.exe");
fs.copyFileSync(bridge, exe);
fs.writeFileSync(path.join(dir, "engine_path.txt"), engine);

const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = Buffer.alloc(0);
let stderr = "";
let readyMsg = null;
const waiters = new Map();

child.stderr.on("data", (d) => { stderr += d.toString(); });
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const msg = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
    buf = buf.subarray(4 + n);
    if (msg.type === "ready") { readyMsg = msg; waiters.get("ready")?.(msg); continue; }
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([head, body]));
}
function waitFor(key, ms = 30000) {
  if (key === "ready" && readyMsg) return Promise.resolve(readyMsg);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for " + key + (stderr ? "; stderr=" + stderr : ""))), ms);
    waiters.set(key, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
  });
}
async function request(id, obj) {
  send(Object.assign({ id }, obj));
  const r = await waitFor(id);
  if (!r.bestmove || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(r.bestmove)) throw new Error("bad reply: " + JSON.stringify(r));
  return r.bestmove;
}

(async () => {
  await waitFor("ready", 40000);
  console.log("ok: ready");
  for (const [id, mode, value, skill] of [
    [1, "time", 200, 20],
    [2, "depth", 5, 10],
    [3, "nodes", 10000, 5],
  ]) {
    const best = await request(id, { moves: [], mode, value, skill });
    console.log(`ok: ${mode} ${value}, skill ${skill} -> ${best}`);
  }
  const legacy = await request(4, { moves: [], movetime: 200 });
  console.log("ok: legacy movetime -> " + legacy);
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
    child.stdin.end();
  });
  if (!exited) throw new Error("bridge did not exit after stdin close");
  console.log("ok: bridge exits after stdin close");
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
})().catch((e) => {
  console.error("FAIL:", e.message);
  child.kill();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
