// Запуск: node tests/chess.test.js [путь к stockfish]
// Если путь к Stockfish передан, результаты сверяются с ним (perft и FEN). Иначе — только с известными числами.
const C = require("../extension/chess.js");
const { execFileSync } = require("child_process");
const fs = require("fs");
const sf = process.argv[2];
let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log("FAIL:", msg); } else console.log("ok:", msg); };

function sfRun(lines) {
  return execFileSync(sf, [], { input: lines.join("\n") + "\nquit\n", encoding: "utf8", timeout: 120000 });
}
function sfPerft(fenOrStart, depth) {
  const pos = fenOrStart === "startpos" ? "position startpos" : "position fen " + fenOrStart;
  const out = sfRun([pos, "go perft " + depth]);
  return parseInt(/Nodes searched:\s*(\d+)/.exec(out)[1], 10);
}
function sfFen(uciMoves) {
  const out = sfRun(["position startpos" + (uciMoves.length ? " moves " + uciMoves.join(" ") : ""), "d"]);
  return /Fen:\s*(.+)/.exec(out)[1].trim();
}

// 1) perft на известных позициях (chessprogramming.org) + сверка с Stockfish
const positions = [
  ["startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", [20, 400, 8902, 197281]],
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862]],
  ["pos3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238]],
  ["pos4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467]],
  ["pos5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379]],
];
for (const [name, fen, expected] of positions) {
  const st = C.fromFen(fen);
  expected.forEach((n, i) => {
    const got = C.perft(st, i + 1);
    let msg = `perft ${name} d${i + 1}: ${got} (ожидается ${n})`;
    if (sf) { const ref = sfPerft(fen, i + 1); msg += `, Stockfish: ${ref}`; ok(got === n && got === ref, msg); }
    else ok(got === n, msg);
  });
}

// 2) реальные данные пользователя: партия из списка ходов chess.com и расстановка фигур из chessboard
{
  const san = "e4 e6 Nf3 c6 Bc4 Qe7 O-O f6 b3 d5".split(" ");
  const r = C.replay(san);
  ok(r.ok, "партия из присланного списка ходов разобрана");
  // фигуры из присланного wc-chessboard.txt (класс square-XY: X=файл 1..8, Y=ряд 1..8)
  const sample = "br88 bn78 bb68 bk58 bq57 bb38 bn28 br18 bp87 bp77 bp66 bp56 bp45 bp36 bp27 bp17 wp82 wp72 wp62 wp54 wp42 wp32 wp23 wp12 wr61 wn63 wb34 wk71 wq41 wb31 wn21 wr11".split(" ");
  const expected = new Array(64).fill(".");
  for (const t of sample) {
    const ch = t[0] === "w" ? t[1].toUpperCase() : t[1];
    expected[(+t[3] - 1) * 8 + (+t[2] - 1)] = ch;
  }
  ok(r.ok && r.state.board.join("") === expected.join(""), "расстановка после воспроизведения совпадает с присланной доской chess.com");
  ok(r.ok && r.turn === "w", "после 10 полуходов очередь белых");
}

// 3) партии с шахами, длинной рокировкой, уточнением хода, взятием на проходе и превращением; сверка FEN со Stockfish
const games = {
  "Opera game": "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#",
  "en passant": "e4 a6 e5 d5 exd6 Nf6 d7+ Bxd7 Nf3 e6",
  "promotion": "h4 g5 hxg5 h5 g6 h4 g7 h3 gxf8=Q+ Kxf8",
  "short castle black": "e4 e5 Nf3 Nf6 Bc4 Be7 O-O O-O",
};
for (const [name, line] of Object.entries(games)) {
  const r = C.replay(line.split(" "));
  ok(r.ok, `${name}: разобрана${r.ok ? "" : " — " + r.error}`);
  if (r.ok && sf) {
    const ref = sfFen(r.uci).split(" ");
    const mine = r.fen.split(" ");
    // ep у Stockfish выводится только если взятие возможно — сравниваем ep лишь когда он есть у Stockfish
    const same = [0, 1, 2, 4, 5].every((i) => ref[i] === mine[i]) && (ref[3] === "-" || ref[3] === mine[3]);
    ok(same, `${name}: FEN совпадает со Stockfish (${mine.join(" ")})`);
  }
}
{
  const r = C.replay("e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 Nbd2 Bb7 Bc2 Re8 Nf1 Bf8 Ng3 g6".split(" "));
  ok(r.ok && r.legalCount > 0, "Ruy Lopez (Nbd7, Nbd2 с уточнением) разобрана");
}
{
  const r = C.replay("h4 g5 hxg5 h5 g6 h4 g7 h3 Qxf8+ Kxf8".split(" "));
  ok(r.ok && r.uci[8] === "g7f8q", "превращение с фигуркой перед клеткой (Qxf8) разобрано");
}
{
  const r = C.replay("h4 g5 hxg5 h5 g6 h4 g7 h3 Qh8".split(" "));
  ok(r.ok && r.uci[8] === "g7h8q", "превращение с фигуркой перед клеткой (Qh8) разобрано");
}
for (const [letter, piece] of Object.entries({ "Ф": "q", "Л": "r", "С": "b", "К": "n" })) {
  const r = C.replay(("h4 g5 hxg5 h5 g6 h4 g7 h3 gxf8=" + letter).split(" "));
  ok(r.ok && r.uci[8] === "g7f8" + piece, `русское превращение gxf8=${letter} разобрано как ${piece}`);
}
{
  const r = C.replay("a3 c5 b3 c4 d3 cxd3 Bb2 dxc2 Bc3 c1=Ф".split(" "));
  ok(r.ok && r.uci[9] === "c2c1q", "русское превращение чёрных c1=Ф разобрано как c2c1q");
}
{
  const r = C.replay("h4 g5 hxg5 h5 g6 h4 g7 h3 gxf8".split(" "));
  ok(r.ok && r.pendingPromotion && r.state.board[54] === "P", "незавершённое превращение (gxf8) сохраняет позицию до хода");
}
{
  const bad = C.replay(["e4", "e5", "Qxx9"]);
  ok(!bad.ok, "мусорный ход даёт ошибку, а не позицию");
  const illegal = C.replay(["e5"]);
  ok(!illegal.ok, "нелегальный ход даёт ошибку");
}
{
  const r = C.replay("f3 e5 g4 Qh4#".split(" "));
  ok(r.ok && r.legalCount === 0 && r.inCheck, "детский мат: ходов нет, шах");
}
console.log(fail ? `\nПровалено: ${fail}` : "\nВсе проверки пройдены");
process.exit(fail ? 1 : 0);
