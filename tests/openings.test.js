// Unit tests for the bundled opening book (Lichess chess-openings, CC0).
// Run: node tests/openings.test.js
"use strict";
const assert = require("assert");
const Chess = require("../extension/chess.js");
const Book = require("../extension/openings.js");

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { fail++; console.log("FAIL:", msg); }
  else console.log("ok:", msg);
};
const fen = (list) => {
  const r = Chess.replay(list);
  assert(r.ok, "не разобрана линия: " + list.join(" "));
  return r.fen;
};

try {
  assert(Book.size > 5000, "слишком маленькая книга: " + Book.size);
  ok(true, "книга загружена: " + Book.size + " позиций");

  ok(Book.isBook(fen(["e4"])), "1.e4 — теория");
  ok(Book.isBook(fen(["e4", "e5", "Nf3", "Nc6", "Bb5"])), "Ruy Lopez — теория");
  ok(Book.isBook(fen(["d4", "d5", "c4"])), "ферзевый гамбит — теория");
  ok(!Book.isBook(""), "пустая позиция — не теория");
  ok(!Book.isBook(fen(["e4", "e5", "Qh5", "Nc6", "Qxf7"])), "Qh5/Qxf7 — не теория");
  ok(!Book.isBook(fen("e4 e6 Nf3 c6 Bc4 Qe7 O-O f6 b3 d5".split(" "))),
    "партия с chess.com-бота — уже не теория");
  ok(Book.isBook(fen(["e4"]).replace(/ \d+ \d+$/, " 7 23")), "счётчики ходов не влияют на теорию");
} catch (e) {
  fail++;
  console.error("FAIL:", e.message);
}

console.log(fail ? `\nЕсть ошибки: ${fail}` : "\nВсе проверки пройдены");
process.exit(fail ? 1 : 0);
