/* Минимальная шахматная логика: воспроизведение партии из SAN -> UCI-ходы и FEN.
 * Без зависимостей. Работает и в браузере (globalThis.ChessLogic), и в Node (module.exports). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChessLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FILES = "abcdefgh";
  // индекс клетки: rank*8 + file, rank 0 = первый ряд (белые), file 0 = a
  const sqName = (s) => FILES[s & 7] + ((s >> 3) + 1);
  const isWhite = (p) => p !== "." && p === p.toUpperCase();
  const colorOf = (p) => (isWhite(p) ? "w" : "b");

  function startState() {
    const b = new Array(64).fill(".");
    const back = "RNBQKBNR";
    for (let f = 0; f < 8; f++) {
      b[f] = back[f];
      b[8 + f] = "P";
      b[48 + f] = "p";
      b[56 + f] = back[f].toLowerCase();
    }
    return { board: b, turn: "w", castle: { K: true, Q: true, k: true, q: true }, ep: -1, half: 0, full: 1 };
  }

  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function attacked(board, sq, by) {
    const f = sq & 7, r = sq >> 3;
    const P = by === "w" ? "P" : "p", N = by === "w" ? "N" : "n", K = by === "w" ? "K" : "k";
    const B = by === "w" ? "B" : "b", R = by === "w" ? "R" : "r", Q = by === "w" ? "Q" : "q";
    // белая пешка на (r-1, f±1) атакует (r, f); чёрная на (r+1, f±1)
    const pr = by === "w" ? r - 1 : r + 1;
    if (pr >= 0 && pr < 8) {
      for (const df of [-1, 1]) {
        const pf = f + df;
        if (pf >= 0 && pf < 8 && board[pr * 8 + pf] === P) return true;
      }
    }
    for (const [df, dr] of KNIGHT) {
      const nf = f + df, nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === N) return true;
    }
    for (const [df, dr] of KING) {
      const nf = f + df, nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === K) return true;
    }
    for (const [dirs, a, b] of [[DIAG, B, Q], [ORTH, R, Q]]) {
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const p = board[nr * 8 + nf];
          if (p !== ".") { if (p === a || p === b) return true; break; }
          nf += df; nr += dr;
        }
      }
    }
    return false;
  }

  function inCheck(state, color) {
    const k = state.board.indexOf(color === "w" ? "K" : "k");
    return k >= 0 && attacked(state.board, k, color === "w" ? "b" : "w");
  }

  function pseudoMoves(state) {
    const { board, turn } = state, moves = [];
    const us = turn, them = turn === "w" ? "b" : "w";
    const push = (from, to, extra) => moves.push(Object.assign({ from, to }, extra || {}));
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (p === "." || colorOf(p) !== us) continue;
      const f = s & 7, r = s >> 3, t = p.toLowerCase();
      if (t === "p") {
        const dir = us === "w" ? 1 : -1, startR = us === "w" ? 1 : 6, lastR = us === "w" ? 7 : 0;
        const nr = r + dir;
        if (nr < 0 || nr > 7) continue;
        const addPawn = (to, extra) => {
          if ((to >> 3) === lastR) { for (const pr of "qrbn") push(s, to, Object.assign({ promo: pr }, extra)); }
          else push(s, to, extra);
        };
        if (board[nr * 8 + f] === ".") {
          addPawn(nr * 8 + f);
          if (r === startR && board[(r + 2 * dir) * 8 + f] === ".") push(s, (r + 2 * dir) * 8 + f, { double: true });
        }
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf, q = board[to];
          if (q !== "." && colorOf(q) === them) addPawn(to);
          else if (to === state.ep) push(s, to, { enpassant: true });
        }
      } else if (t === "n" || t === "k") {
        for (const [df, dr] of (t === "n" ? KNIGHT : KING)) {
          const nf = f + df, nr = r + dr;
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          const q = board[nr * 8 + nf];
          if (q === "." || colorOf(q) === them) push(s, nr * 8 + nf);
        }
        if (t === "k") {
          const home = us === "w" ? 4 : 60, K = us === "w" ? "K" : "k", Q = us === "w" ? "Q" : "q";
          const rook = us === "w" ? "R" : "r";
          if (s === home && !attacked(board, home, them)) {
            if (state.castle[K] && board[home + 1] === "." && board[home + 2] === "." && board[home + 3] === rook &&
                !attacked(board, home + 1, them)) push(s, home + 2, { castle: "K" });
            if (state.castle[Q] && board[home - 1] === "." && board[home - 2] === "." && board[home - 3] === "." &&
                board[home - 4] === rook && !attacked(board, home - 1, them)) push(s, home - 2, { castle: "Q" });
          }
        }
      } else {
        const dirs = t === "b" ? DIAG : t === "r" ? ORTH : DIAG.concat(ORTH);
        for (const [df, dr] of dirs) {
          let nf = f + df, nr = r + dr;
          while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
            const q = board[nr * 8 + nf];
            if (q === ".") push(s, nr * 8 + nf);
            else { if (colorOf(q) === them) push(s, nr * 8 + nf); break; }
            nf += df; nr += dr;
          }
        }
      }
    }
    return moves;
  }

  function apply(state, m) {
    const board = state.board.slice();
    const p = board[m.from], us = state.turn, them = us === "w" ? "b" : "w";
    const captured = board[m.to];
    board[m.from] = ".";
    board[m.to] = m.promo ? (us === "w" ? m.promo.toUpperCase() : m.promo) : p;
    if (m.enpassant) board[m.to + (us === "w" ? -8 : 8)] = ".";
    if (m.castle) {
      const home = us === "w" ? 0 : 56;
      if (m.castle === "K") { board[home + 7] = "."; board[home + 5] = us === "w" ? "R" : "r"; }
      else { board[home] = "."; board[home + 3] = us === "w" ? "R" : "r"; }
    }
    const castle = Object.assign({}, state.castle);
    if (p === "K") { castle.K = false; castle.Q = false; }
    if (p === "k") { castle.k = false; castle.q = false; }
    for (const s of [m.from, m.to]) {
      if (s === 0) castle.Q = false;
      if (s === 7) castle.K = false;
      if (s === 56) castle.q = false;
      if (s === 63) castle.k = false;
    }
    const isPawn = p.toLowerCase() === "p";
    return {
      board, turn: them, castle,
      ep: m.double ? (m.from + m.to) / 2 : -1,
      half: isPawn || captured !== "." || m.enpassant ? 0 : state.half + 1,
      full: state.full + (us === "b" ? 1 : 0),
    };
  }

  function legalMoves(state) {
    const out = [];
    for (const m of pseudoMoves(state)) {
      if (!inCheck(apply(state, m), state.turn)) out.push(m);
    }
    return out;
  }

  const uci = (m) => sqName(m.from) + sqName(m.to) + (m.promo || "");

  function toFen(state) {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = "", empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = state.board[r * 8 + f];
        if (p === ".") empty++;
        else { if (empty) { row += empty; empty = 0; } row += p; }
      }
      if (empty) row += empty;
      rows.push(row);
    }
    const c = (state.castle.K ? "K" : "") + (state.castle.Q ? "Q" : "") + (state.castle.k ? "k" : "") + (state.castle.q ? "q" : "");
    return rows.join("/") + " " + state.turn + " " + (c || "-") + " " + (state.ep >= 0 ? sqName(state.ep) : "-") + " " + state.half + " " + state.full;
  }

  const SAN_RE = /^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(?:=?([QRBNqrbn]))?$/;
  // Русская нотация превращения: c1=Ф, c1=Л, c1=С, c1=К.
  const CYR_PROMO = { "Ф": "Q", "Л": "R", "С": "B", "К": "N", "ф": "q", "л": "r", "с": "b", "к": "n" };

  function cleanSan(s) {
    return String(s)
      .replace(/\s+/g, "")
      .replace(/[+#!?]+$/g, "")
      .replace(/0/g, "O")
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/=([ФЛСКфлск])/g, (_, p) => "=" + CYR_PROMO[p]);
  }

  /** Находит единственный легальный ход по SAN или возвращает null. */
  function findMove(state, sanRaw) {
    const san = cleanSan(sanRaw);
    const legal = legalMoves(state);
    if (san === "O-O" || san === "O-O-O") {
      const want = san === "O-O" ? "K" : "Q";
      const c = legal.filter((m) => m.castle === want);
      return c.length === 1 ? c[0] : null;
    }
    const m = SAN_RE.exec(san);
    if (!m) return null;
    const piece = m[1] ? m[1].toLowerCase() : "p";
    const dest = FILES.indexOf(m[4][0]) + (parseInt(m[4][1], 10) - 1) * 8;
    const dFile = m[2] ? FILES.indexOf(m[2]) : -1;
    const dRank = m[3] ? parseInt(m[3], 10) - 1 : -1;
    const promo = m[5] ? m[5].toLowerCase() : null;
    const c = legal.filter((mv) => {
      if (state.board[mv.from].toLowerCase() !== piece || mv.to !== dest) return false;
      if ((mv.promo || null) !== promo) return false;
      if (dFile >= 0 && (mv.from & 7) !== dFile) return false;
      if (dRank >= 0 && (mv.from >> 3) !== dRank) return false;
      if (piece === "p" && dFile < 0 && (mv.from & 7) !== (dest & 7)) return false;
      return true;
    });
    if (c.length === 0 && m[1] && (dest >> 3) === (state.turn === "w" ? 7 : 0)) {
      // chess.com sometimes renders a promotion as a figurine before the square ("Qe8" / "Qgxf8").
      // If a normal piece move also fits, standard SAN wins; that ambiguity is rare.
      const promoted = legal.filter((mv) =>
        mv.promo === piece && mv.to === dest &&
        (dFile < 0 || (mv.from & 7) === dFile) &&
        (dRank < 0 || (mv.from >> 3) === dRank)
      );
      if (promoted.length === 1) return promoted[0];
    }
    return c.length === 1 ? c[0] : null;
  }

  /** Неполная запись превращения ("g8" или "gxf8"), пока chess.com ждёт выбора фигуры. */
  function pendingPromotion(state, sanRaw) {
    const m = SAN_RE.exec(cleanSan(sanRaw));
    if (!m || m[1] || m[5]) return null;
    if (m[4][1] !== (state.turn === "w" ? "8" : "1")) return null;
    const dest = FILES.indexOf(m[4][0]) + (parseInt(m[4][1], 10) - 1) * 8;
    const dFile = m[2] ? FILES.indexOf(m[2]) : -1;
    const candidates = legalMoves(state).filter((mv) =>
      mv.promo && mv.to === dest && (dFile < 0 || (mv.from & 7) === dFile)
    );
    return candidates.length ? { to: dest } : null;
  }

  /** Воспроизводит список SAN с начальной позиции. */
  function replay(sanList) {
    let state = startState();
    const moves = [];
    for (let i = 0; i < sanList.length; i++) {
      const mv = findMove(state, sanList[i]);
      if (!mv) {
        if (i === sanList.length - 1 && pendingPromotion(state, sanList[i])) {
          return { ok: true, state, fen: toFen(state), uci: moves, turn: state.turn,
            legalCount: legalMoves(state).length, inCheck: inCheck(state, state.turn), pendingPromotion: true };
        }
        return { ok: false, error: "не удалось разобрать ход #" + (i + 1) + ": " + JSON.stringify(sanList[i]) };
      }
      moves.push(uci(mv));
      state = apply(state, mv);
    }
    const legal = legalMoves(state);
    return { ok: true, state, fen: toFen(state), uci: moves, turn: state.turn, legalCount: legal.length, inCheck: inCheck(state, state.turn) };
  }

  function perft(state, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of legalMoves(state)) n += depth === 1 ? 1 : perft(apply(state, m), depth - 1);
    return n;
  }

  function fromFen(fen) {
    const [pl, turn, cas, ep, half, full] = fen.trim().split(/\s+/);
    const board = new Array(64).fill(".");
    const rows = pl.split("/");
    for (let i = 0; i < 8; i++) {
      let f = 0;
      for (const ch of rows[i]) {
        if (/\d/.test(ch)) f += +ch; else { board[(7 - i) * 8 + f] = ch; f++; }
      }
    }
    return {
      board, turn,
      castle: { K: cas.includes("K"), Q: cas.includes("Q"), k: cas.includes("k"), q: cas.includes("q") },
      ep: ep === "-" ? -1 : FILES.indexOf(ep[0]) + (parseInt(ep[1], 10) - 1) * 8,
      half: +(half || 0), full: +(full || 1),
    };
  }

  return { startState, fromFen, toFen, legalMoves, apply, uci, findMove, replay, perft, sqName };
});
