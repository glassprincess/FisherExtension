"use strict";
// Сейфмод включён (по умолчанию): работает только на странице игры с ботом /play/computer/<бот>.
// Сейфмод выключен: работает на любой странице chess.com, где есть доска и список ходов.
// На остальных страницах цикл ничего не делает: движок не запрашивается, ничего не рисуется.
(function () {
  if (window.__cbhLoaded) return;
  window.__cbhLoaded = true;

  const POLL_MS = 300;
  const HEARTBEAT_MS = 5000;
  const CONTENT_VERSION = "0.3.1"; // должно совпадать с version в manifest.json
  const NS = "http://www.w3.org/2000/svg";
  const ARROW_ID = "cbh-arrow";
  const REVIEW_ID = "cbh-review";
  const BADGE_ID = "cbh-review-badge";
  const EVAL_ID = "cbh-eval";
  const REVIEW_ICON = "cbh-review-icon";
  const ICON_DIR = "analysis-icons/";
  const CACHE_MAX = 300;
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
  let reviewEnabled = true;
  let gameLive = false;
  let lastBeat = 0;
  let reviewMoves = []; // по полуходам: { san, uci, key } | undefined
  let lastReview = null; // { uci, key, bottom }
  let lastEval = null; // { score, turn, bottom }
  const evalCache = new Map(); // "uci uci ..." -> { bestmove, eval }

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
    style.textContent = `.promotion-piece.${PROMO_CLASS}{outline:3px solid #22c55e;outline-offset:-3px;box-shadow:0 0 0 3px rgba(34,197,94,.55);border-radius:6px}`
      + `.${REVIEW_ICON}{width:13px;height:13px;margin-left:2px;vertical-align:-2px;display:inline-block;pointer-events:none}`
      + `#${EVAL_ID}{position:fixed;z-index:2147483000;pointer-events:none;font:700 10px/1 system-ui,sans-serif;color:#fff}`
      + `#${EVAL_ID} .cbh-eval-bar{position:relative;width:12px;height:100%;box-sizing:border-box;background:#2b2b2b;border:1px solid rgba(255,255,255,.35);border-radius:4px;overflow:hidden}`
      + `#${EVAL_ID} .cbh-eval-white{position:absolute;left:0;right:0;background:#f2f2f2}`
      + `#${EVAL_ID} .cbh-eval-label{position:absolute;left:50%;transform:translateX(-50%);white-space:nowrap;text-shadow:0 1px 3px #000,0 0 2px #000}`;
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

  function moveList(board) {
    const lists = [...document.querySelectorAll("wc-simple-move-list, wc-move-list")];
    return lists.find((el) => !board.id || el.getAttribute("board-id") === board.id) || lists[0] || null;
  }

  /** Список ходов (SAN) из панели chess.com или null, если панель ещё не отрисована. */
  function readSan(board) {
    const list = moveList(board);
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

  // ─────────────────────── оценка ходов ───────────────────────

  const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const cacheKey = (moves) => moves.join(" ");

  function cachePut(moves, rec) {
    evalCache.set(cacheKey(moves), rec);
    if (evalCache.size > CACHE_MAX) evalCache.delete(evalCache.keys().next().value);
  }

  async function ensurePosition(moves) {
    const key = cacheKey(moves);
    const hit = evalCache.get(key);
    if (hit) return hit;
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "analyze", moves });
    } catch (_) {
      return null;
    }
    if (!res || !res.bestmove || !res.eval) return null;
    const rec = { bestmove: res.bestmove, eval: res.eval };
    cachePut(moves, rec);
    return rec;
  }

  /** Теория из дебютного справочника по позиции (учитывает транспозиции). */
  function isBookPosition(sans, i, finalState) {
    const state = i === sans.length - 1 ? finalState : ChessLogic.replay(sans.slice(0, i + 1)).state;
    return !!state && OpeningBook.isBook(ChessLogic.toFen(state));
  }

  /** Жертва: лучший ход ставит фигуру под бой, а взятие не окупает её. */
  function isSacrifice(sans, uci, i, finalState) {
    const before = ChessLogic.replay(sans.slice(0, i));
    const after = i === sans.length - 1 ? finalState : ChessLogic.replay(sans.slice(0, i + 1)).state;
    if (!before.ok || !after) return false;
    const to = uci[i].charCodeAt(2) - 97 + (Number(uci[i][3]) - 1) * 8;
    const piece = after.board[to];
    if (!piece || piece.toLowerCase() === "k") return false;
    const us = piece === piece.toUpperCase() ? "w" : "b";
    if (!ChessLogic.attacked(after.board, to, us === "w" ? "b" : "w")) return false;
    const victim = before.state.board[to];
    const gain = victim === "." ? 0 : PIECE_VALUE[victim.toLowerCase()] || 0;
    const value = PIECE_VALUE[piece.toLowerCase()] || 0;
    return value >= 3 && gain < value;
  }

  function classifyAt(sans, uci, i, finalState) {
    const before = evalCache.get(cacheKey(uci.slice(0, i)));
    const after = evalCache.get(cacheKey(uci.slice(0, i + 1)));
    if (!before || !after || !uci[i]) return false;
    const cls = MoveReview.classify({
      played: uci[i],
      bestmove: before.bestmove,
      before: before.eval,
      after: after.eval,
      book: isBookPosition(sans, i, finalState),
      sacrifice: isSacrifice(sans, uci, i, finalState),
    });
    if (!cls) return false;
    reviewMoves[i] = { san: sans[i], uci: uci[i], key: cls.key };
    return true;
  }

  function alignReviews(sans) {
    const stale = sans.length < reviewMoves.length
      || reviewMoves.some((m, i) => m && m.san !== sans[i]);
    if (!stale) return;
    reviewMoves = [];
    lastReview = null;
    lastEval = null;
    evalCache.clear();
    const svg = document.getElementById(REVIEW_ID);
    if (svg) svg.remove();
    const badge = document.getElementById(BADGE_ID);
    if (badge) badge.remove();
  }

  function decorateMoves(board) {
    const list = moveList(board);
    if (!list) return;
    const nodes = [...list.querySelectorAll(".node.main-line-ply")];
    nodes.forEach((node, i) => {
      const old = node.querySelector("." + REVIEW_ICON);
      const rec = reviewMoves[i];
      const icon = rec && MoveReview.ICONS[rec.key];
      if (!icon) { if (old) old.remove(); return; }
      if (old && old.dataset.key === rec.key) return;
      if (old) old.remove();
      const img = document.createElement("img");
      img.className = REVIEW_ICON;
      img.dataset.key = rec.key;
      img.src = browser.runtime.getURL(ICON_DIR + icon.file);
      img.alt = "";
      img.title = icon.label;
      img.draggable = false;
      ensureStyle();
      (node.querySelector(".node-highlight-content") || node).after(img);
    });
  }

  function reviewOverlay(board) {
    let svg = board.querySelector("#" + REVIEW_ID);
    if (!svg) {
      svg = document.createElementNS(NS, "svg");
      svg.id = REVIEW_ID;
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1;";
      board.insertBefore(svg, board.firstChild);
    }
    return svg;
  }

  /** Иконка оценки — в правом верхнем углу поля, куда пришла фигура. */
  function drawBadge(board) {
    let layer = board.querySelector("#" + BADGE_ID);
    if (!lastReview || !lastReview.bottom) { if (layer) layer.remove(); return; }
    if (!layer) {
      layer = document.createElementNS(NS, "svg");
      layer.id = BADGE_ID;
      layer.setAttribute("viewBox", "0 0 100 100");
      layer.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:61;";
      board.appendChild(layer);
    }
    layer.replaceChildren();
    const uci = lastReview.uci;
    const f = uci.charCodeAt(2) - 97;
    const r = +uci[3] - 1;
    const x = lastReview.bottom === "w" ? f : 7 - f;
    const y = lastReview.bottom === "w" ? 7 - r : r;
    const size = 4.8;
    const img = document.createElementNS(NS, "image");
    img.setAttribute("href", browser.runtime.getURL(ICON_DIR + MoveReview.ICONS[lastReview.key].file));
    img.setAttribute("x", x * 12.5 + 12.5 - size - 0.2);
    img.setAttribute("y", y * 12.5 + 0.2);
    img.setAttribute("width", size);
    img.setAttribute("height", size);
    layer.appendChild(img);
  }

  /** Поля последнего оценённого хода красим цветом его иконки. */
  function redrawReview(board) {
    const svg = board.querySelector("#" + REVIEW_ID);
    if (!lastReview) { if (svg) svg.remove(); drawBadge(board); return; }
    const color = MoveReview.ICONS[lastReview.key].color;
    const layer = svg || reviewOverlay(board);
    layer.replaceChildren();
    if (lastReview.bottom) {
      const uci = lastReview.uci;
      for (const [f, r] of [[uci.charCodeAt(0) - 97, +uci[1] - 1], [uci.charCodeAt(2) - 97, +uci[3] - 1]]) {
        const x = lastReview.bottom === "w" ? f : 7 - f;
        const y = lastReview.bottom === "w" ? 7 - r : r;
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", x * 12.5); rect.setAttribute("y", y * 12.5);
        rect.setAttribute("width", 12.5); rect.setAttribute("height", 12.5);
        rect.setAttribute("fill", color); rect.setAttribute("fill-opacity", "0.5");
        layer.appendChild(rect);
      }
    }
    drawBadge(board);
  }

  /** Полоса перевеса слева от доски: белое снизу, чёрное сверху (при перевёрнутой доске — наоборот). */
  function drawEvalBar(board, score, turn, bottom) {
    const rect = board.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) return;
    let el = document.getElementById(EVAL_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = EVAL_ID;
      el.innerHTML = '<div class="cbh-eval-bar"><div class="cbh-eval-white"></div></div><div class="cbh-eval-label"></div>';
      document.body.appendChild(el);
    }
    const cp = MoveReview.whiteCp(score, turn);
    const white = el.querySelector(".cbh-eval-white");
    white.style.height = MoveReview.barPercent(cp) + "%";
    white.style.top = bottom === "b" ? "0" : "auto";
    white.style.bottom = bottom === "b" ? "auto" : "0";
    const label = el.querySelector(".cbh-eval-label");
    label.textContent = MoveReview.formatEval(score, turn);
    label.style.top = bottom === "b" ? "auto" : "-16px";
    label.style.bottom = bottom === "b" ? "-16px" : "auto";
    el.style.top = rect.top + "px";
    el.style.height = rect.height + "px";
    el.style.left = (rect.left >= 24 ? rect.left - 18 : rect.left + 2) + "px";
  }

  function clearReview() {
    reviewMoves = [];
    lastReview = null;
    lastEval = null;
    evalCache.clear();
    const bar = document.getElementById(EVAL_ID);
    if (bar) bar.remove();
    const svg = document.getElementById(REVIEW_ID);
    if (svg) svg.remove();
    const badge = document.getElementById(BADGE_ID);
    if (badge) badge.remove();
    for (const el of document.querySelectorAll("." + REVIEW_ICON)) el.remove();
  }

  async function reviewPosition(board, sans, r, bottom, mySeq) {
    for (let i = 0; i < sans.length; i++) {
      if (!reviewMoves[i]) classifyAt(sans, r.uci, i, r.state);
    }
    const last = sans.length - 1;
    if (last >= 0 && !reviewMoves[last]) {
      const prev = await ensurePosition(r.uci.slice(0, last));
      if (mySeq !== seq) return;
      if (prev) classifyAt(sans, r.uci, last, r.state);
    }
    if (reviewMoves[last]) lastReview = { uci: r.uci[last], key: reviewMoves[last].key, bottom };
    decorateMoves(board);
    redrawReview(board);
  }

  // ───────────────────────────────────────────────────────────

  function deactivate() {
    setGameLive(false);
    active = false;
    seq++;
    pendingSig = "";
    handledSig = "";
    clearArrow();
    clearReview();
    setStatus("неактивно");
  }

  async function tick() {
    if (!isAllowedPage()) { if (active) deactivate(); return; }
    const board = getBoard();
    if (!board) { setGameLive(false); setStatus("жду доску"); return; }
    active = true;

    const sans = readSan(board);
    if (!sans) { setGameLive(false); setStatus("жду список ходов"); return; }
    if (reviewEnabled) alignReviews(sans);
    const bottom = bottomColor(board);
    const sig = sans.join(" ") + "|" + bottom + "|" + settingsVersion;
    beat();

    if (sig !== pendingSig) { pendingSig = sig; return; } // ждём, пока позиция перестанет меняться
    if (sig === handledSig) {
      if (reviewEnabled) {
        decorateMoves(board);
        redrawReview(board);
        if (lastEval) drawEvalBar(board, lastEval.score, lastEval.turn, lastEval.bottom);
      }
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
    const needHint = r.turn === bottom;
    if (!needHint && !reviewEnabled) { setStatus("ход бота"); return; }

    setStatus(needHint ? (r.pendingPromotion ? "превращение: считаю…" : "считаю…") : "оценка позиции…");
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "analyze", moves: r.uci });
    } catch (e) {
      res = { error: String(e && e.message ? e.message : e) };
    }
    if (mySeq !== seq) return; // позиция уже изменилась
    if (res && res.bestmove) {
      if (reviewEnabled && res.eval) {
        cachePut(r.uci, { bestmove: res.bestmove, eval: res.eval });
        lastEval = { score: res.eval, turn: r.turn, bottom };
        drawEvalBar(board, res.eval, r.turn, bottom);
      }
      if (needHint) {
        const legal = ChessLogic.legalMoves(r.state).map(ChessLogic.uci);
        if (!legal.includes(res.bestmove)) {
          setStatus("движок вернул нелегальный ход — игнорирую");
        } else {
          drawArrow(board, res.bestmove, bottom);
          setStatus("подсказка: " + moveLabel(res.bestmove));
        }
      } else {
        setStatus("ход бота");
      }
      if (reviewEnabled) await reviewPosition(board, sans, r, bottom, mySeq);
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
    browser.storage.local.get(["safeMode", "reviewEnabled"]).then((st) => {
      if (typeof st.safeMode === "boolean") safeMode = st.safeMode;
      if (typeof st.reviewEnabled === "boolean") reviewEnabled = st.reviewEnabled;
    }).catch(() => {});
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.safeMode) safeMode = changes.safeMode.newValue !== false;
    if (changes.reviewEnabled) {
      reviewEnabled = changes.reviewEnabled.newValue !== false;
      if (!reviewEnabled) clearReview();
    }
    if (changes.mode || changes.limit || changes.skill || changes.level || changes.safeMode || changes.reviewEnabled) settingsVersion++;
  });

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!sender || sender.id !== browser.runtime.id || !msg || msg.type !== "page-status") return undefined;
    return Promise.resolve({ botPage: isBotPage(), allowedPage: isAllowedPage(), contentVersion: CONTENT_VERSION, status });
  });
})();
