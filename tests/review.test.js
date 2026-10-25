// Unit tests for the move-review logic (evaluation bar + chess.com-style annotations).
// Run: node tests/review.test.js
"use strict";
const assert = require("assert");
const Review = require("../extension/review.js");

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { fail++; console.log("FAIL:", msg); }
  else console.log("ok:", msg);
};
const cp = (value) => ({ type: "cp", value });
const mate = (value) => ({ type: "mate", value });

try {
  assert.strictEqual(Review.scoreToCp(cp(35)), 35);
  assert.strictEqual(Review.scoreToCp(mate(3)), 97000);
  assert.strictEqual(Review.scoreToCp(mate(-2)), -98000);
  ok(true, "scoreToCp: cp и мат");

  assert.strictEqual(Review.whiteCp(cp(50), "w"), 50);
  assert.strictEqual(Review.whiteCp(cp(50), "b"), -50);
  assert.strictEqual(Review.whiteCp(mate(-2), "b"), 98000);
  ok(true, "whiteCp: оценка всегда с точки зрения белых");

  assert.strictEqual(Review.barPercent(0), 50);
  assert(Review.barPercent(400) > 80);
  assert(Review.barPercent(-400) < 20);
  assert.strictEqual(Review.barPercent(99999), 100);
  assert.strictEqual(Review.barPercent(-99999), 0);
  ok(true, "barPercent: полоса перевеса");

  assert.strictEqual(Review.formatEval(cp(35), "w"), "+0.4");
  assert.strictEqual(Review.formatEval(cp(-35), "w"), "-0.4");
  assert.strictEqual(Review.formatEval(mate(3), "w"), "#3");
  assert.strictEqual(Review.formatEval(mate(3), "b"), "#-3");
  ok(true, "formatEval: подпись оценки");

  const best = Review.classify({ played: "e2e4", bestmove: "e2e4", before: cp(20), after: cp(-20) });
  assert.strictEqual(best.key, "best");

  const book = Review.classify({ played: "e2e4", bestmove: "e2e4", before: cp(20), after: cp(-20), book: true });
  assert.strictEqual(book.key, "book");

  const brilliant = Review.classify({
    played: "e2e4", bestmove: "e2e4", before: cp(20), after: cp(-20), sacrifice: true,
  });
  assert.strictEqual(brilliant.key, "brilliant");

  const great = Review.classify({
    played: "e2e4", bestmove: "e2e4", before: cp(-250), after: cp(-120),
  });
  assert.strictEqual(great.key, "great");

  const excellent = Review.classify({ played: "g1f3", bestmove: "e2e4", before: cp(0), after: cp(10) });
  assert.strictEqual(excellent.key, "excellent");

  const good = Review.classify({ played: "g1f3", bestmove: "e2e4", before: cp(0), after: cp(30) });
  assert.strictEqual(good.key, "good");

  const inaccuracy = Review.classify({ played: "g1f3", bestmove: "e2e4", before: cp(0), after: cp(80) });
  assert.strictEqual(inaccuracy.key, "inaccuracy");

  const mistake = Review.classify({ played: "g1f3", bestmove: "e2e4", before: cp(0), after: cp(150) });
  assert.strictEqual(mistake.key, "mistake");

  const blunder = Review.classify({ played: "g1f3", bestmove: "e2e4", before: cp(0), after: cp(300) });
  assert.strictEqual(blunder.key, "blunder");

  const missed = Review.classify({
    played: "g1f3", bestmove: "e2e4", before: mate(2), after: cp(50),
  });
  assert.strictEqual(missed.key, "missed");

  const missedWin = Review.classify({
    played: "g1f3", bestmove: "e2e4", before: cp(800), after: cp(50),
  });
  assert.strictEqual(missedWin.key, "missed");

  const stillMate = Review.classify({
    played: "g1f3", bestmove: "e2e4", before: mate(2), after: mate(-1),
  });
  assert.notStrictEqual(stillMate.key, "missed");

  const sharp = Review.classify({
    played: "g1f3", bestmove: "e2e4", before: cp(0), after: cp(20), sacrifice: true,
  });
  assert.strictEqual(sharp.key, "sharp");

  assert.strictEqual(Review.classify({ played: "e2e4", bestmove: "e2e4" }), null);
  ok(true, "classify: основные категории");

  ok(Review.sameLine(["e4", "e6", "Nf3"], "e4+e6+Nf3"), "sameLine: книга совпадает");
  ok(!Review.sameLine(["e4", "e5"], "e4+e6+Nf3"), "sameLine: книга не совпадает");
  ok(Review.sameLine(["e4", "e6", "Nf3"], "1.e4+e6+2.Nf3"), "sameLine: номера ходов игнорируются");
  ok(Review.sameLine(["e4", "e6"], "e4+e6+Nf3+c6"), "sameLine: текущая линия — начало книги");

  ok(Review.ICONS.brilliant.file === "brilliant.svg", "иконка brilliant");
  ok(Review.ICONS.best.color === "#96bc4b", "цвет best");
  ok(Review.ICONS.missed.file === "missed_win.svg", "иконка missed");
} catch (e) {
  fail++;
  console.error("FAIL:", e.message);
}

console.log(fail ? `\nЕсть ошибки: ${fail}` : "\nВсе проверки пройдены");
process.exit(fail ? 1 : 0);
