/* Оценка позиции и классификация ходов в стиле chess.com.
 * Чистые функции без DOM: работают и в браузере (globalThis.MoveReview), и в Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MoveReview = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Оценка Stockfish приходит от лица того, чей сейчас ход.
  // Мат переводим в большое число: 97000/98000/99000..., чтобы его перекрывал любой cp.
  function scoreToCp(score) {
    if (!score) return 0;
    if (score.type === "mate") {
      const n = Math.min(Math.abs(score.value), 99);
      return Math.sign(score.value) * (100000 - n * 1000);
    }
    return score.value;
  }

  // Оценка всегда с точки зрения белых: после хода чёрных знак переворачивается.
  function whiteCp(score, turn) {
    const cp = scoreToCp(score);
    return turn === "b" ? -cp : cp;
  }

  // Доля полосы перевеса белых в процентах. tanh сжимает большие оценки, край — 100/0.
  function barPercent(cp) {
    if (cp >= 2000) return 100;
    if (cp <= -2000) return 0;
    return Math.round(50 + 50 * Math.tanh(cp / 300));
  }

  function formatEval(score, turn) {
    if (!score) return "";
    if (score.type === "mate") return "#" + (turn === "b" ? -score.value : score.value);
    const cp = turn === "b" ? -score.value : score.value;
    const v = (Math.sign(cp) * Math.round(Math.abs(cp) / 10)) / 10;
    return (cp > 0 ? "+" : "") + v.toFixed(1);
  }

  // Пороги потери в сантипешках (после — уже с точки зрения сделавшего ход).
  const EXCELLENT_MAX = 20;
  const GOOD_MAX = 50;
  const INACCURACY_MAX = 100;
  const MISTAKE_MAX = 250;

  const ICONS = {
    brilliant: { file: "brilliant.svg", color: "#1bada6", label: "Блестящий ход" },
    great: { file: "great_find.svg", color: "#1bada6", label: "Великолепный ход" },
    best: { file: "best.svg", color: "#96bc4b", label: "Лучший ход" },
    excellent: { file: "excellent.svg", color: "#96bc4b", label: "Прекрасный ход" },
    good: { file: "good.svg", color: "#96af8b", label: "Хороший ход" },
    book: { file: "book.svg", color: "#a88865", label: "Книжный ход" },
    sharp: { file: "sharp.svg", color: "#ad5b8c", label: "Интересный ход" },
    inaccuracy: { file: "inaccuracy.svg", color: "#f7c045", label: "Неточность" },
    mistake: { file: "mistake.svg", color: "#e58f2a", label: "Ошибка" },
    missed: { file: "missed_win.svg", color: "#dbac16", label: "Упущенный шанс" },
    blunder: { file: "blunder.svg", color: "#ca3431", label: "Зевок" },
  };

  /* played/bestmove — UCI, before — оценка до хода (от лица ходящего),
   * after — оценка после хода (от лица соперника). book и sacrifice — флаги из content.js. */
  function classify({ played, bestmove, before, after, book, sacrifice }) {
    if (!before || !after) return null;
    const beforeCp = scoreToCp(before);
    const afterCp = -scoreToCp(after); // обратно к лицу, сделавшему ход
    const loss = beforeCp - afterCp;
    const isBest = played === bestmove;

    if (book) return { key: "book" };
    if (sacrifice && isBest) return { key: "brilliant" };
    if (isBest && beforeCp <= -150 && afterCp >= -50) return { key: "great" };
    if (isBest) return { key: "best" };
    const afterMateForMover = after.type === "mate" && after.value < 0; // соперник под матом
    if (afterMateForMover) return { key: "excellent" }; // мат остался, даже если дальше
    if (before.type === "mate" && before.value > 0) return { key: "missed" };
    if (beforeCp >= 500 && afterCp < 150) return { key: "missed" };
    if (sacrifice && loss <= INACCURACY_MAX) return { key: "sharp" };
    if (loss <= EXCELLENT_MAX) return { key: "excellent" };
    if (loss <= GOOD_MAX) return { key: "good" };
    if (loss <= INACCURACY_MAX) return { key: "inaccuracy" };
    if (loss <= MISTAKE_MAX) return { key: "mistake" };
    return { key: "blunder" };
  }

  return { scoreToCp, whiteCp, barPercent, formatEval, classify, ICONS };
});
