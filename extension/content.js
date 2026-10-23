"use strict";
// Сейфмод включён (по умолчанию): работает только на странице игры с ботом /play/computer/<бот>.
// Сейфмод выключен: работает на любой странице chess.com, где есть доска и список ходов.
// На остальных страницах цикл ничего не делает: движок не запрашивается, ничего не рисуется.
(function () {
  if (window.__cbhLoaded) return;
  window.__cbhLoaded = true;

  const POLL_MS = 300;
  const HEARTBEAT_MS = 5000;
  const CONTENT_VERSION = "0.2.4"; // должно совпадать с version в manifest.json
  const NS = "http://www.w3.org/2000/svg";
  const ARROW_ID = "cbh-arrow";
  const STYLE_ID = "cbh-style";
  const PROMO_CLASS = "cbh-promo";

  let active = false;
  let pendingSig = "";
  let handledSig = "";
  let seq = 0;
  let settingsVersion = 0;
  let status = "неактивно";
  let lastArrow = null; // { uci, bottom }
  let safeMode = true;
  let gameLive = false;
  let lastBeat = 0;

  const isChess = () => location.hostname === "www.chess.com";
  const isBotPage = () => isChess() && /^\/play\/computer(\/|$)/.test(location.pathname);
  const isAllowedPage = () => isChess() && (!safeMode || isBotPage());
  const getBoard = () => {
    const boards = [...document.querySelectorAll("wc-chess-board")];
    const bot = boards.find((b) => b.id === "board-play-computer");
    if (bot) return bot;
    return boards.find((b) => {
      const r = b.getBoundingClientRect();
      return r.width >= 200 && r.height >= 200;
    }) || boards[0] || null;
  };
  const setStatus = (s) => { status = s; };
  const moveLabel = (uci) => uci.slice(0, 2) + "-" + uci.slice(2, 4) + (uci[4] ? "=" + uci[4].toUpperCase() : "");
  function sendMessage(msg) {
    try {
      const p = browser.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }
  function setGameLive(live) {
    if (gameLive === live) return;
    gameLive = live;
    if (!live) sendMessage({ type: "game-inactive" });
    else lastBeat = Date.now();
  }
  function beat() {
    if (!gameLive || Date.now() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = Date.now();
    sendMessage({ type: "game-active" });
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `.promotion-piece.${PROMO_CLASS}{outline:3px solid #22c55e;outline-offset:-3px;box-shadow:0 0 0 3px rgba(34,197,94,.55);border-radius:6px}`;
    (document.head || document.documentElement).appendChild(style);
  }

  function clearPromotion() {
    for (const el of document.querySelectorAll(".promotion-piece." + PROMO_CLASS)) el.classList.remove(PROMO_CLASS);
  }

  /** Подсветить рекомендованную фигуру в окне превращения chess.com. */
  function showPromotion(board, uci) {
    clearPromotion();
    if (!uci || uci.length !== 5) return;
    const win = board.querySelector(".promotion-window--visible") || document.querySelector(".promotion-window--visible");
    if (!win) return;
    const targetF = uci.charCodeAt(2) - 96, targetR = +uci[3];
    const pawn = [...board.querySelectorAll(".piece.wp, .piece.bp")].find((el) => {
      const cls = typeof el.className === "string" ? el.className : "";
      const m = /\bsquare-([1-8])([1-8])\b/.exec(cls);
      return m && +m[1] === targetF && +m[2] === targetR;
    });
    if (!pawn) return;
    const color = pawn.classList.contains("wp") ? "w" : "b";
    const piece = uci[4].toLowerCase();
    const el = win.querySelector(".promotion-piece." + color + piece);
    if (el) { ensureStyle(); el.classList.add(PROMO_CLASS); }
  }

  function textOf(n) {
    let s = "";
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) s += c.nodeValue;
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const fig = c.getAttribute("data-figurine");
        s += fig ? fig : textOf(c);
      }
    }
    return s;
  }

  /** Список ходов (SAN) из панели chess.com или null, если панель ещё не отрисована. */
  function readSan(board) {
    const lists = [...document.querySelectorAll("wc-simple-move-list, wc-move-list")];
    const list = lists.find((el) => !board.id || el.getAttribute("board-id") === board.id) || lists[0];
    if (!list) return null;
    const out = [];
    for (const node of list.querySelectorAll(".node.main-line-ply")) {
      const content = node.querySelector(".node-highlight-content") || node;
      const san = textOf(content).replace(/\s+/g, "");
      if (san) out.push(san);
    }
    return out;
  }

  /** Кто стоит снизу ("w"/"b"), по реальному положению фигур на экране; null — если не удалось. */
  function bottomColor(board) {
    const rect = board.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return null;
    let normal = 0, flipped = 0;
    for (const el of board.querySelectorAll(".piece")) {
      const m = /\bsquare-([1-8])([1-8])\b/.exec(typeof el.className === "string" ? el.className : "");
      if (!m) continue;
      const r = el.getBoundingClientRect();
      const fx = Math.floor(((r.left + r.width / 2 - rect.left) / rect.width) * 8);
      const fy = Math.floor(((r.top + r.height / 2 - rect.top) / rect.height) * 8);
      const X = +m[1], Y = +m[2];
      if (fx === X - 1 && fy === 8 - Y) normal++;
      else if (fx === 8 - X && fy === Y - 1) flipped++;
    }
    if (normal > 0 && flipped === 0) return "w";
    if (flipped > 0 && normal === 0) return "b";
    return null;
  }

  function overlay(board) {
    let svg = board.querySelector("#" + ARROW_ID);
    if (!svg) {
      svg = document.createElementNS(NS, "svg");
      svg.id = ARROW_ID;
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:60;";
      board.appendChild(svg);
    }
    return svg;
  }

  function clearArrow() {
    lastArrow = null;
    clearPromotion();
    const svg = document.getElementById(ARROW_ID);
    if (svg) svg.remove();
  }

  function drawArrow(board, uci, bottom) {
    const center = (file, rank) => {
      const x = bottom === "w" ? file : 7 - file;
      const y = bottom === "w" ? 7 - rank : rank;
      return [(x + 0.5) * 12.5, (y + 0.5) * 12.5];
    };
    const [x1, y1] = center(uci.charCodeAt(0) - 97, +uci[1] - 1);
    const [x2, y2] = center(uci.charCodeAt(2) - 97, +uci[3] - 1);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    const head = 4.6, half = 3.3, sx = x1 + ux * 2, sy = y1 + uy * 2;
    const bx = x2 - ux * head, by = y2 - uy * head;
    const svg = overlay(board);
    svg.replaceChildren();
    const color = "rgba(0, 170, 60, 0.85)";
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", sx); line.setAttribute("y1", sy);
    line.setAttribute("x2", bx); line.setAttribute("y2", by);
    line.setAttribute("stroke", color); line.setAttribute("stroke-width", "2.4"); line.setAttribute("stroke-linecap", "round");
    const poly = document.createElementNS(NS, "polygon");
    poly.setAttribute("points", `${x2},${y2} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`);
    poly.setAttribute("fill", color);
    svg.appendChild(line);
    svg.appendChild(poly);
    if (uci.length === 5) {
      const badge = document.createElementNS(NS, "g");
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", x2); circle.setAttribute("cy", y2); circle.setAttribute("r", "4.6");
      circle.setAttribute("fill", color);
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", x2); text.setAttribute("y", y2);
      text.setAttribute("text-anchor", "middle"); text.setAttribute("dominant-baseline", "central");
      text.setAttribute("font-size", "6"); text.setAttribute("font-weight", "700");
      text.setAttribute("font-family", "system-ui, sans-serif"); text.setAttribute("fill", "#fff");
      text.textContent = uci[4].toUpperCase();
      badge.appendChild(circle); badge.appendChild(text); svg.appendChild(badge);
    }
    lastArrow = { uci, bottom };
    showPromotion(board, uci);
  }

  function deactivate() {
    setGameLive(false);
    active = false;
    seq++;
    pendingSig = "";
    handledSig = "";
    clearArrow();
    setStatus("неактивно");
  }

  async function tick() {
    if (!isAllowedPage()) { if (active) deactivate(); return; }
    const board = getBoard();
    if (!board) { setGameLive(false); setStatus("жду доску"); return; }
    active = true;

    const sans = readSan(board);
    if (!sans) { setGameLive(false); setStatus("жду список ходов"); return; }
    const bottom = bottomColor(board);
    const sig = sans.join(" ") + "|" + bottom + "|" + settingsVersion;
    beat();

    if (sig !== pendingSig) { pendingSig = sig; return; } // ждём, пока позиция перестанет меняться
    if (sig === handledSig) {
      if (lastArrow) {
        if (!board.querySelector("#" + ARROW_ID)) drawArrow(board, lastArrow.uci, lastArrow.bottom);
        else showPromotion(board, lastArrow.uci);
      }
      return;
    }
    handledSig = sig;
    const mySeq = ++seq;
    clearArrow();

    if (!bottom) { setGameLive(false); setStatus("не удалось определить ориентацию доски"); return; }
    const r = ChessLogic.replay(sans);
    if (!r.ok) { setGameLive(false); setStatus("ошибка разбора: " + r.error); return; }
    if (r.legalCount === 0) { setGameLive(false); setStatus("партия окончена"); return; }
    setGameLive(true);
    if (r.turn !== bottom) { setStatus("ход бота"); return; }

    setStatus(r.pendingPromotion ? "превращение: считаю…" : "считаю…");
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "analyze", moves: r.uci });
    } catch (e) {
      res = { error: String(e && e.message ? e.message : e) };
    }
    if (mySeq !== seq) return; // позиция уже изменилась
    if (res && res.bestmove) {
      const legal = ChessLogic.legalMoves(r.state).map(ChessLogic.uci);
      if (!legal.includes(res.bestmove)) { setStatus("движок вернул нелегальный ход — игнорирую"); return; }
      drawArrow(board, res.bestmove, bottom);
      setStatus("подсказка: " + moveLabel(res.bestmove));
    } else if (res && res.cancelled) {
      handledSig = ""; // мост выгрузился; на следующем тике попробуем снова
    } else {
      setStatus("ошибка: " + ((res && res.error) || "нет ответа"));
    }
  }

  setInterval(() => { tick().catch((e) => setStatus("ошибка: " + (e && e.message ? e.message : e))); }, POLL_MS);

  window.addEventListener("pagehide", () => {
    setGameLive(false);
    seq++;
    pendingSig = "";
    handledSig = "";
  });

  if (browser.storage && browser.storage.local && browser.storage.local.get) {
    browser.storage.local.get(["safeMode"]).then((st) => {
      if (typeof st.safeMode === "boolean") safeMode = st.safeMode;
    }).catch(() => {});
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.safeMode) safeMode = changes.safeMode.newValue !== false;
    if (changes.mode || changes.limit || changes.skill || changes.level || changes.safeMode) settingsVersion++;
  });

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!sender || sender.id !== browser.runtime.id || !msg || msg.type !== "page-status") return undefined;
    return Promise.resolve({ botPage: isBotPage(), allowedPage: isAllowedPage(), contentVersion: CONTENT_VERSION, status });
  });
})();
