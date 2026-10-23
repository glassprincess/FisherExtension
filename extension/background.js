"use strict";
// Настройки движка: ограничение поиска и сила. Значения заданы только здесь.
const LIMITS = {
  time: { low: 200, medium: 1000, high: 3000, max: 10000 },
  depth: { low: 5, medium: 10, high: 15, max: 20 },
  nodes: { low: 10000, medium: 100000, high: 500000, max: 1000000 },
};
const MODES = ["time", "depth", "nodes"];
const SKILLS = { full: 20, strong: 15, medium: 10, weak: 5 };
const DEFAULT_MODE = "time";
const DEFAULT_LIMIT = "medium";
const DEFAULT_SKILL = "full";
const HOST = "chess_hint_bridge";
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const IDLE_MS = 15000;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

let port = null;
let engineReady = false;
let lastError = "";
let nextId = 1;
let pending = null; // { id, resolve, timer }
let idleTimer = null;

function finish(result) {
  if (!pending) return;
  clearTimeout(pending.timer);
  const p = pending;
  pending = null;
  p.resolve(result);
}

function stopBridge() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!port) { lastError = ""; return; }
  const old = port;
  port = null;
  engineReady = false;
  lastError = "";
  finish({ cancelled: true });
  try { old.disconnect(); } catch (_) {}
}

/** Продлить жизнь моста, пока на странице идёт игра. */
function noteGameActive() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopBridge, IDLE_MS);
}

function connect() {
  if (port) return port;
  engineReady = false;
  let p;
  try {
    p = browser.runtime.connectNative(HOST);
  } catch (e) {
    lastError = String(e && e.message ? e.message : e);
    return null;
  }
  port = p;
  p.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") { engineReady = true; lastError = ""; return; }
    if (typeof msg.error === "string") {
      lastError = msg.error;
      if (pending && (msg.id === pending.id || msg.id === 0)) finish({ error: msg.error });
      return;
    }
    if (typeof msg.bestmove === "string" && UCI_MOVE.test(msg.bestmove) && pending && msg.id === pending.id) {
      finish({ bestmove: msg.bestmove });
    }
  });
  p.onDisconnect.addListener(() => {
    if (port !== p) return; // штатное отключение через stopBridge()
    const err = (p.error && p.error.message) || (browser.runtime.lastError && browser.runtime.lastError.message) || "";
    lastError = err || "мост отключился";
    port = null;
    engineReady = false;
    finish({ error: lastError });
  });
  return port;
}

async function getSettings() {
  let mode = DEFAULT_MODE, limit = DEFAULT_LIMIT, skill = DEFAULT_SKILL;
  try {
    const st = await browser.storage.local.get(["mode", "limit", "skill", "level"]);
    if (MODES.includes(st.mode)) mode = st.mode;
    if (has(LIMITS[mode], st.limit)) limit = st.limit;
    else if (mode === "time" && has(LIMITS.time, st.level)) limit = st.level; // старый ключ level
    if (has(SKILLS, st.skill)) skill = st.skill;
  } catch (_) {}
  return { mode, value: LIMITS[mode][limit], skill: SKILLS[skill] };
}

async function analyze(moves) {
  if (!Array.isArray(moves) || moves.length > 1024 || !moves.every((m) => typeof m === "string" && UCI_MOVE.test(m))) {
    return { error: "некорректный список ходов" };
  }
  noteGameActive();
  const settings = await getSettings();
  const timeout = settings.mode === "time" ? settings.value + 8000 : 30000;
  const p = connect();
  if (!p) return { error: lastError || "не удалось подключиться к мосту" };
  finish({ cancelled: true }); // предыдущий запрос больше не нужен; мост остановит поиск сам
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending && pending.id === id) finish({ error: "таймаут ответа движка" });
    }, timeout);
    pending = { id, resolve, timer };
    try {
      p.postMessage({ id, moves, mode: settings.mode, value: settings.value, skill: settings.skill });
    } catch (e) {
      finish({ error: String(e && e.message ? e.message : e) });
    }
  });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  // принимаем сообщения только от собственных скриптов расширения
  if (!sender || sender.id !== browser.runtime.id || !msg || typeof msg !== "object") return undefined;
  if (msg.type === "analyze") return analyze(msg.moves);
  if (msg.type === "game-active") {
    noteGameActive();
    return Promise.resolve({ ok: true });
  }
  if (msg.type === "game-inactive") {
    stopBridge();
    return Promise.resolve({ ok: true });
  }
  if (msg.type === "bridge-status") {
    return Promise.resolve({ connected: !!port, engineReady, error: lastError });
  }
  if (msg.type === "settings") {
    return Promise.resolve({ MODES, LIMITS, SKILLS, DEFAULT_MODE, DEFAULT_LIMIT, DEFAULT_SKILL });
  }
  return undefined;
});
