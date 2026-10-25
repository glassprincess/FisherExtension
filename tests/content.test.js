// Интеграционный тест content.js в Chromium (Playwright) на реальной разметке chess.com из fixtures/.
// Запуск: node tests/content.test.js   (нужен глобально установленный playwright)
const path = require("path");
const fs = require("fs");
let chromium;
try { ({ chromium } = require("playwright")); }
catch (_) {
  const dir = process.env.PLAYWRIGHT_DIR;
  if (!dir) { console.error("Playwright не установлен: npm i -D playwright && npx playwright install chromium"); process.exit(2); }
  ({ chromium } = require(path.join(dir, "playwright")));
}

const ext = path.join(__dirname, "..", "extension");
const chessJs = fs.readFileSync(path.join(ext, "chess.js"), "utf8");
const reviewJs = fs.readFileSync(path.join(ext, "review.js"), "utf8");
const contentJs = fs.readFileSync(path.join(ext, "content.js"), "utf8");
const board = fs.readFileSync(path.join(__dirname, "fixtures/board-after-10-plies.html"), "utf8");
const sidebar = fs.readFileSync(path.join(__dirname, "fixtures/sidebar.html"), "utf8");

const promoBoard = `<wc-chess-board id="board-play-computer">
  <div class="piece wp square-68"></div><div class="piece bk square-58"></div><div class="piece wk square-51"></div>
  <div class="promotion-window top promotion-window--visible" style="transform: translateX(500%);">
    <div class="promotion-piece wb"></div><div class="promotion-piece wn"></div>
    <div class="promotion-piece wq"></div><div class="promotion-piece wr"></div>
  </div>
</wc-chess-board>`;
const promoSidebar = `<wc-simple-move-list board-id="board-play-computer">${
  "h4 g5 hxg5 h5 g6 h4 g7 h3".split(" ").map((s) => `<div class="node main-line-ply"><span class="node-highlight-content">${s} </span></div>`).join("")
}</wc-simple-move-list>`;

const promotedBoard = `<wc-chess-board id="board-play-computer">
  <div class="piece wq square-18"></div><div class="piece bk square-58"></div><div class="piece wk square-51"></div>
</wc-chess-board>`;
const promotedSidebar = `<wc-simple-move-list board-id="board-play-computer">${
  "a4 h5 a5 h4 a6 h3 axb7 hxg2 bxa8=Ф Nf6".split(" ").map((s) => `<div class="node main-line-ply"><span class="node-highlight-content">${s} </span></div>`).join("")
}</wc-simple-move-list>`;

function pageHtml(flipped, boardHtml = board, sidebarHtml = sidebar) {
  let css = "wc-chess-board{display:block;position:relative;width:480px;height:480px}.piece{position:absolute;width:12.5%;height:12.5%}";
  for (let x = 1; x <= 8; x++) for (let y = 1; y <= 8; y++) {
    const l = flipped ? (8 - x) * 12.5 : (x - 1) * 12.5, t = flipped ? (y - 1) * 12.5 : (8 - y) * 12.5;
    css += `.square-${x}${y}{left:${l}%;top:${t}%}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${boardHtml}${sidebarHtml}</body></html>`;
}

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log("FAIL:", m); } else console.log("ok:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(browser, { url, flipped, reply, name, body, safeMode = true, waitMs = 1500 }) {
  const page = await browser.newPage();
  await page.route("https://www.chess.com/**", (route) => route.fulfill({ contentType: "text/html", body: body || pageHtml(flipped) }));
  await page.addInitScript(({ replyMsg, safeMode }) => {
    window.__calls = [];
    window.__listeners = [];
    window.__reply = replyMsg;
    window.browser = {
      runtime: {
        id: "test-id",
        sendMessage: async (m) => { window.__calls.push(m); return window.__reply; },
        onMessage: { addListener: (f) => window.__listeners.push(f) },
      },
      storage: {
        local: { get: async () => ({ safeMode, reviewEnabled: false }) },
        onChanged: { addListener() {} },
      },
    };
  }, { replyMsg: reply, safeMode });
  await page.goto(url);
  await page.addScriptTag({ content: chessJs });
  await page.addScriptTag({ content: contentJs });
  await sleep(waitMs); // несколько циклов опроса (300 мс) + стабилизация
  const calls = await page.evaluate(() => window.__calls);
  const arrow = await page.evaluate(() => {
    const svg = document.getElementById("cbh-arrow");
    if (!svg) return null;
    const [tx, ty] = svg.querySelector("polygon").getAttribute("points").split(" ")[0].split(",").map(Number);
    return { x2: tx, y2: ty };
  });
  const badge = await page.evaluate(() => document.querySelector("#cbh-arrow text")?.textContent || null);
  const promo = await page.evaluate(() => !!document.querySelector(".promotion-piece.cbh-promo"));
  const st = await page.evaluate(() => window.__listeners[0]({ type: "page-status" }, { id: "test-id" }));
  await page.close();
  return { calls, arrow, badge, promo, st };
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const expectedMoves = "e2e4 e7e6 g1f3 c7c6 f1c4 d8e7 e1g1 f7f6 b2b3 d7d5".split(" ");

  {
    const r = await scenario(browser, { url: "https://www.chess.com/play/computer/harry", flipped: false, reply: { bestmove: "c4d5" } });
    ok(r.calls.length === 1 && r.calls[0].type === "analyze", "ход пользователя: ровно один запрос к движку");
    ok(r.calls[0] && JSON.stringify(r.calls[0].moves) === JSON.stringify(expectedMoves), "в движок ушли верные UCI-ходы из реального списка chess.com");
    ok(r.arrow && Math.abs(r.arrow.y2 - 43.75) < 0.01 && Math.abs(r.arrow.x2 - 43.75) < 0.01, "стрелка нарисована к клетке d5 (белые снизу)");
    ok(r.st.botPage === true && r.st.allowedPage === true, "страница распознана как игра с ботом");
    ok(typeof r.st.contentVersion === "string" && r.st.contentVersion.length > 0, "content script сообщает версию");
  }
  {
    const body = pageHtml(false, promoBoard, promoSidebar);
    const r = await scenario(browser, { url: "https://www.chess.com/play/computer/harry", flipped: false, reply: { bestmove: "g7f8q" }, body });
    ok(r.calls.length === 1 && r.calls[0].moves.length === 8, "превращение: движок получил позицию до хода пешки");
    ok(r.arrow && Math.abs(r.arrow.x2 - 68.75) < 0.01 && Math.abs(r.arrow.y2 - 6.25) < 0.01, "стрелка нарисована к f8");
    ok(r.badge === "Q", "на стрелке показана фигура превращения (Q)");
    ok(r.promo === true, "в окне превращения подсвечен ферзь");
    ok(r.st.status === "подсказка: g7-f8=Q", "статус показывает превращение");
  }
  {
    const page = await browser.newPage();
    await page.route("https://www.chess.com/**", (route) => route.fulfill({ contentType: "text/html", body: pageHtml(false, promoBoard, promoSidebar) }));
    await page.addInitScript((replyMsg) => {
      window.__calls = [];
      window.__listeners = [];
      window.__reply = replyMsg;
      window.browser = {
        runtime: {
          id: "test-id",
          sendMessage: async (m) => { window.__calls.push(m); return window.__reply; },
          onMessage: { addListener: (f) => window.__listeners.push(f) },
        },
        storage: {
          local: { get: async () => ({ safeMode: true, reviewEnabled: false }) },
          onChanged: { addListener() {} },
        },
      };
    }, { bestmove: "g7f8q" });
    await page.goto("https://www.chess.com/play/computer/harry");
    await page.addScriptTag({ content: chessJs });
    await page.addScriptTag({ content: contentJs });
    await sleep(1500);
    ok(await page.evaluate(() => window.__calls.length === 1), "переход: до превращения запрос к движку есть");

    await page.evaluate(() => {
      const board = document.querySelector("#board-play-computer");
      const pawn = board.querySelector(".piece.wp.square-68");
      pawn.classList.remove("wp"); pawn.classList.add("wq");
      board.querySelector(".promotion-window")?.remove();
      document.querySelector('wc-simple-move-list[board-id="board-play-computer"]')
        .insertAdjacentHTML("beforeend", '<div class="node main-line-ply"><span class="node-highlight-content">gxf8=Q+ </span></div>');
    });
    await sleep(1200);
    const mid = await page.evaluate(async () => ({
      calls: window.__calls.length,
      arrow: !!document.getElementById("cbh-arrow"),
      status: (await window.__listeners[0]({ type: "page-status" }, { id: "test-id" })).status,
    }));
    ok(mid.calls === 1 && !mid.arrow && mid.status === "ход бота", "переход: после выбора фигуры ждём бота без стрелки");

    await page.evaluate(() => {
      const board = document.querySelector("#board-play-computer");
      board.querySelector(".piece.wq.square-68")?.remove();
      const bk = board.querySelector(".piece.bk.square-58");
      if (bk) { bk.classList.remove("square-58"); bk.classList.add("square-68"); }
      window.__reply = { bestmove: "g1f3" };
      document.querySelector('wc-simple-move-list[board-id="board-play-computer"]')
        .insertAdjacentHTML("beforeend", '<div class="node main-line-ply"><span class="node-highlight-content">Kxf8 </span></div>');
    });
    await sleep(1500);
    const end = await page.evaluate(async () => {
      const svg = document.getElementById("cbh-arrow");
      const [tx, ty] = svg ? svg.querySelector("polygon").getAttribute("points").split(" ")[0].split(",").map(Number) : [null, null];
      return {
        calls: window.__calls,
        arrow: svg ? { x2: tx, y2: ty } : null,
        status: (await window.__listeners[0]({ type: "page-status" }, { id: "test-id" })).status,
      };
    });
    ok(end.calls.length === 2 && end.calls[1].moves.length === 10, "переход: после ответа бота снова запрос с полной партией");
    ok(end.arrow && Math.abs(end.arrow.x2 - 68.75) < 0.01 && Math.abs(end.arrow.y2 - 68.75) < 0.01, "переход: после ответа бота снова рисуется стрелка");
    ok(end.status === "подсказка: g1-f3", "переход: статус снова показывает подсказку");
    await page.close();
  }
  {
    const body = pageHtml(false, promotedBoard, promotedSidebar);
    const r = await scenario(browser, { url: "https://www.chess.com/play/computer/harry", flipped: false, reply: { bestmove: "a8a7" }, body });
    ok(r.calls.length === 1 && r.calls[0].moves.length === 10, "после превращения и ответа бота: движок получил всю партию");
    ok(r.calls[0] && r.calls[0].moves[8] === "b7a8q", "русское превращение bxa8=Ф разобрано как b7a8q");
    ok(r.arrow && Math.abs(r.arrow.x2 - 6.25) < 0.01 && Math.abs(r.arrow.y2 - 18.75) < 0.01, "после превращения стрелка снова рисуется");
    ok(r.st.status === "подсказка: a8-a7", "после превращения подсказка снова показывается");
  }
  {
    const r = await scenario(browser, { url: "https://www.chess.com/play/computer/harry", flipped: true, reply: { bestmove: "c4d5" } });
    ok(r.calls.length === 0 && !r.arrow, "доска перевёрнута (чёрные снизу), ход белых = ход бота: запросов и стрелки нет");
    ok(r.st.status === "ход бота", "статус: ход бота");
  }
  {
    const r = await scenario(browser, { url: "https://www.chess.com/play/computer/harry", flipped: false, reply: { bestmove: "e2e5" } });
    ok(r.calls.length === 1 && !r.arrow, "нелегальный ответ движка не рисуется");
  }
  {
    const r = await scenario(browser, { url: "https://www.chess.com/play/online", flipped: false, reply: { bestmove: "c4d5" } });
    ok(r.calls.length === 0 && !r.arrow && r.st.botPage === false && r.st.allowedPage === false, "сейфмод включён: вне страницы ботов никаких запросов и рисования");
  }
  {
    const onlineBoard = board.replace("board-play-computer", "board-single");
    const onlineSidebar = sidebar.replaceAll("board-play-computer", "board-single");
    const r = await scenario(browser, {
      url: "https://www.chess.com/play/online",
      flipped: false,
      reply: { bestmove: "c4d5" },
      body: pageHtml(false, onlineBoard, onlineSidebar),
      safeMode: false,
    });
    ok(r.calls.length === 1 && r.calls[0].type === "analyze", "сейфмод выключен: работаем на другой странице и с другим id доски");
    ok(r.arrow && Math.abs(r.arrow.x2 - 43.75) < 0.01, "сейфмод выключен: стрелка рисуется");
    ok(r.st.allowedPage === true, "сейфмод выключен: страница разрешена");
  }
  {
    const listBody = pageHtml(false, board, sidebar.replaceAll("wc-simple-move-list", "wc-move-list"));
    const r = await scenario(browser, { url: "https://www.chess.com/analysis", flipped: false, reply: { bestmove: "c4d5" }, body: listBody, safeMode: false });
    ok(r.calls.length === 1 && r.calls[0].type === "analyze", "сейфмод выключен: читаем и wc-move-list");
  }
  {
    const page = await browser.newPage();
    await page.route("https://www.chess.com/**", (route) => route.fulfill({ contentType: "text/html", body: pageHtml(false) }));
    await page.addInitScript(() => {
      window.__calls = [];
      window.__listeners = [];
      window.browser = {
        runtime: {
          id: "test-id",
          getURL: (p) => "moz-extension://test/" + p,
          sendMessage: async (m) => {
            window.__calls.push(m);
            return m.moves.length === 9
              ? { bestmove: "d7d5", depth: 12, eval: { type: "cp", value: 0 } }
              : { bestmove: "c4d5", depth: 14, eval: { type: "cp", value: 30 } };
          },
          onMessage: { addListener: (f) => window.__listeners.push(f) },
        },
        storage: {
          local: { get: async () => ({ safeMode: true, reviewEnabled: true }) },
          onChanged: { addListener() {} },
        },
      };
    });
    await page.goto("https://www.chess.com/play/computer/harry");
    await page.addScriptTag({ content: chessJs });
    await page.addScriptTag({ content: reviewJs });
    await page.addScriptTag({ content: contentJs });
    await sleep(2500);
    const review = await page.evaluate(() => {
      const icon = document.querySelector(".cbh-review-icon");
      const rects = [...document.querySelectorAll("#cbh-review rect")];
      const white = document.querySelector("#cbh-eval .cbh-eval-white");
      return {
        calls: window.__calls.map((c) => c.moves.length),
        icon: icon ? { file: icon.getAttribute("src"), title: icon.title } : null,
        colors: rects.map((r) => r.getAttribute("fill")),
        rects: rects.length,
        label: document.querySelector("#cbh-eval .cbh-eval-label")?.textContent || null,
        whiteHeight: white ? white.style.height : null,
      };
    });
    ok(review.calls.includes(10) && review.calls.includes(9), "оценка ходов: считаются текущая и предыдущая позиции");
    ok(review.label === "+0.3", "полоса перевеса показывает оценку с точки зрения белых");
    ok(review.whiteHeight === "55%", "белая часть полосы заполнена по оценке");
    ok(review.icon && review.icon.file.endsWith("analysis-icons/book.svg"), "книжный ход получил иконку из панели теории");
    ok(review.rects === 2 && review.colors.every((c) => c === "#a88865"), "поля хода окрашены цветом иконки");
    await page.close();
  }
  {
    const r = await scenario(browser, {
      url: "https://www.chess.com/play/computer/harry",
      flipped: false,
      reply: { bestmove: "c4d5" },
      waitMs: 6200,
    });
    ok(r.calls.some((c) => c.type === "game-active"), "во время игры content шлёт heartbeat");
    ok(r.calls.filter((c) => c.type === "analyze").length === 1, "heartbeat не дублирует запрос к движку");
  }
  await browser.close();
  console.log(fail ? `\nПровалено: ${fail}` : "\nВсе проверки пройдены");
  process.exit(fail ? 1 : 0);
})();
