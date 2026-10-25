// Generates extension/openings.js from the Lichess chess-openings TSV files (CC0).
// Usage: node tools/build-openings.js a.tsv b.tsv c.tsv d.tsv e.tsv
// Source: https://github.com/lichess-org/chess-openings
"use strict";
const fs = require("fs");
const path = require("path");
const Chess = require("../extension/chess.js");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node tools/build-openings.js <a.tsv> ... <e.tsv>");
  process.exit(2);
}

// Позиция без счётчиков ходов: расстановка, очередь, рокировки, взятие на проходе.
const posKey = (fen) => fen.split(" ").slice(0, 4).join(" ");

const positions = new Set();
let lines = 0;
let skipped = 0;
for (const file of files) {
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(1);
  for (const row of rows) {
    const pgn = row.split("\t")[2];
    if (!pgn) continue;
    const sans = pgn
      .replace(/\d+\.(\.\.)?/g, " ")
      .replace(/\b(?:1-0|0-1|1\/2-1\/2|\*)\b/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let ok = true;
    for (let i = 0; i < sans.length; i++) {
      const r = Chess.replay(sans.slice(0, i + 1));
      if (!r.ok) { ok = false; break; }
      positions.add(posKey(r.fen));
    }
    if (ok) lines++; else skipped++;
  }
}

const sorted = [...positions].sort();
const out = `/* Дебютный справочник: ${sorted.length} позиций из ${lines} линий (FEN).
 * Источник: https://github.com/lichess-org/chess-openings (CC0 1.0).
 * Сгенерировано tools/build-openings.js — не редактировать вручную. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OpeningBook = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const POSITIONS = ${JSON.stringify(sorted.join("|"))}.split("|");
  let index = null;

  const key = (fen) => String(fen || "").split(" ").slice(0, 4).join(" ");

  /** Позиция есть в дебютной теории — независимо от порядка ходов (транспозиции). */
  function isBook(fen) {
    if (!fen) return false;
    if (!index) index = new Set(POSITIONS);
    return index.has(key(fen));
  }

  return { isBook, size: POSITIONS.length };
});
`;

fs.writeFileSync(path.join(__dirname, "..", "extension", "openings.js"), out);
console.log(`positions: ${sorted.length}, lines: ${lines}, skipped: ${skipped}, bytes: ${Buffer.byteLength(out)}`);
