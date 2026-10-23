// Unit test for the extension background: settings mapping and the native-bridge request.
// Run: node tests/background.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { fail++; console.log("FAIL:", msg); }
  else console.log("ok:", msg);
};

function loadBackground(storage) {
  let onMessage = null;
  const state = { sent: [], portMessage: null, disconnected: false };
  const port = {
    onMessage: { addListener(fn) { state.portMessage = fn; } },
    onDisconnect: { addListener() {} },
    postMessage(msg) { state.sent.push(msg); },
    disconnect() { state.disconnected = true; },
  };
  const browser = {
    runtime: {
      id: "test",
      lastError: null,
      connectNative: () => port,
      onMessage: { addListener(fn) { onMessage = fn; } },
    },
    storage: { local: { get: async () => Object.assign({}, storage) } },
  };
  vm.runInNewContext(src, { browser, setTimeout, clearTimeout, console });
  return { onMessage, state };
}

async function analyzeWith(storage, moves = []) {
  const bg = loadBackground(storage);
  const p = bg.onMessage({ type: "analyze", moves }, { id: "test" });
  for (let i = 0; i < 100 && bg.state.sent.length === 0; i++) await delay(1);
  const req = bg.state.sent[0];
  bg.state.portMessage({ type: "ready" });
  bg.state.portMessage({ id: req.id, bestmove: "e2e4" });
  const res = await p;
  return { req, res };
}

(async () => {
  {
    const bg = loadBackground({});
    const s = await bg.onMessage({ type: "settings" }, { id: "test" });
    ok(s.MODES.join(",") === "time,depth,nodes", "список режимов");
    ok(s.LIMITS.depth.high === 15 && s.LIMITS.nodes.max === 1000000, "таблица лимитов");
    ok(s.SKILLS.weak === 5 && s.SKILLS.full === 20, "таблица силы");
  }
  {
    const { req, res } = await analyzeWith({});
    ok(req.mode === "time" && req.value === 1000 && req.skill === 20, "по умолчанию: время 1000 мс, Skill 20");
    ok(res.bestmove === "e2e4", "ответ моста доходит до content");
  }
  {
    const { req } = await analyzeWith({ level: "max" });
    ok(req.mode === "time" && req.value === 10000 && req.skill === 20, "старый ключ level=max переносится во время");
  }
  {
    const { req } = await analyzeWith({ mode: "depth", limit: "high", skill: "weak" });
    ok(req.mode === "depth" && req.value === 15 && req.skill === 5, "глубина high + слабая сила");
  }
  {
    const { req } = await analyzeWith({ mode: "nodes", limit: "max", skill: "strong" });
    ok(req.mode === "nodes" && req.value === 1000000 && req.skill === 15, "узлы max + сильная сила");
  }
  {
    // Time mode accepts the legacy level fallback only when limit is absent.
    const { req } = await analyzeWith({ mode: "time", limit: "low", level: "max" });
    ok(req.value === 200, "новый limit важнее старого level");
  }
  {
    const bg = loadBackground({});
    const res = await bg.onMessage({ type: "bridge-status" }, { id: "test" });
    ok(!res.connected && bg.state.sent.length === 0, "проверка статуса не запускает мост");
  }
  {
    const bg = loadBackground({});
    const res = await bg.onMessage({ type: "game-active" }, { id: "test" });
    ok(res.ok && bg.state.sent.length === 0, "heartbeat игры не запускает движок");
  }
  {
    const bg = loadBackground({});
    const p = bg.onMessage({ type: "analyze", moves: [] }, { id: "test" });
    for (let i = 0; i < 100 && bg.state.sent.length === 0; i++) await delay(1);
    await bg.onMessage({ type: "game-inactive" }, { id: "test" });
    const res = await p;
    const status = await bg.onMessage({ type: "bridge-status" }, { id: "test" });
    ok(res.cancelled && bg.state.disconnected && !status.connected, "уход из игры выгружает мост и отменяет поиск");
  }
  {
    const bg = loadBackground({});
    const res = await bg.onMessage({ type: "analyze", moves: ["e2e4 quit"] }, { id: "test" });
    ok(res.error && bg.state.sent.length === 0, "нелегальный токен хода не уходит в мост");
  }
  console.log(fail ? "Есть ошибки" : "Все проверки пройдены");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
