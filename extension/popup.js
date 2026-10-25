"use strict";
(async function () {
  const version = browser.runtime.getManifest().version;
  document.getElementById("version").textContent = "v" + version;
  const { MODES, LIMITS, SKILLS, DEFAULT_MODE, DEFAULT_LIMIT, DEFAULT_SKILL } =
    await browser.runtime.sendMessage({ type: "settings" });
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const modeNames = { time: "Время", depth: "Глубина", nodes: "Узлы" };
  const skillNames = { full: "полная", strong: "сильная", medium: "средняя", weak: "слабая" };

  const st = await browser.storage.local.get(["mode", "limit", "skill", "level", "safeMode", "reviewEnabled"]);
  let mode = MODES.includes(st.mode) ? st.mode : DEFAULT_MODE;
  let limit = has(LIMITS[mode], st.limit) ? st.limit
    : (mode === "time" && has(LIMITS.time, st.level) ? st.level : DEFAULT_LIMIT);
  let skill = has(SKILLS, st.skill) ? st.skill : DEFAULT_SKILL;
  let safeMode = st.safeMode !== false;
  let reviewEnabled = st.reviewEnabled !== false;

  const modeEl = document.getElementById("mode");
  const limitEl = document.getElementById("limit");
  const skillEl = document.getElementById("skill");
  const safeEl = document.getElementById("safeMode");
  const reviewEl = document.getElementById("reviewEnabled");

  const option = (value, text) => {
    const o = document.createElement("option");
    o.value = value; o.textContent = text;
    return o;
  };
  function limitLabel(m, key, value) {
    if (m === "time") return `${key} — ${value < 1000 ? value + " мс" : value / 1000 + " с"}`;
    if (m === "depth") return `${key} — ${value}`;
    return `${key} — ${value >= 1000000 ? value / 1000000 + " млн" : value / 1000 + " тыс."}`;
  }
  function fillModes() {
    modeEl.replaceChildren(...MODES.map((m) => option(m, modeNames[m] || m)));
    modeEl.value = mode;
  }
  function fillLimits() {
    limitEl.replaceChildren(...Object.entries(LIMITS[mode]).map(([k, v]) => option(k, limitLabel(mode, k, v))));
    limitEl.value = has(LIMITS[mode], limit) ? limit : DEFAULT_LIMIT;
  }
  function fillSkills() {
    skillEl.replaceChildren(...Object.entries(SKILLS).map(([k, v]) => option(k, `${skillNames[k] || k} (${v})`)));
    skillEl.value = skill;
  }
  const save = () => browser.storage.local.set({ mode, limit, skill, safeMode, reviewEnabled });

  modeEl.addEventListener("change", () => {
    mode = modeEl.value;
    if (!has(LIMITS[mode], limit)) limit = DEFAULT_LIMIT;
    fillLimits();
    save();
  });
  limitEl.addEventListener("change", () => { limit = limitEl.value; save(); });
  skillEl.addEventListener("change", () => { skill = skillEl.value; save(); });
  safeEl.addEventListener("change", () => { safeMode = safeEl.checked; save(); });
  reviewEl.addEventListener("change", () => { reviewEnabled = reviewEl.checked; save(); });
  fillModes(); fillLimits(); fillSkills();
  safeEl.checked = safeMode;
  reviewEl.checked = reviewEnabled;

  async function findPageStatus() {
    const currentTab = await browser.tabs.getCurrent().catch(() => null);
    let tabs;
    if (currentTab) {
      // Страница настроек открыта отдельно: ищем вкладку chess.com.
      tabs = await browser.tabs.query({ url: "https://www.chess.com/*" }).catch(() => []);
    } else {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      tabs = tab ? [tab] : [];
    }
    let fallback = null;
    for (const tab of tabs) {
      if (!tab || tab.id == null) continue;
      try {
        const r = await browser.tabs.sendMessage(tab.id, { type: "page-status" });
        if (!r) continue;
        if (r.allowedPage) return r;
        if (!fallback) fallback = r;
      } catch (_) {}
    }
    return fallback;
  }

  const pageEl = document.getElementById("page");
  const pageStatus = await findPageStatus();
  if (!pageStatus) pageEl.textContent = "нет ответа от вкладки chess.com — откройте игру и обновите её";
  else if (pageStatus.contentVersion !== version) pageEl.textContent = "старый скрипт — обновите вкладку chess.com";
  else pageEl.textContent = pageStatus.allowedPage ? pageStatus.status : "не страница игры с ботом";

  const bridgeEl = document.getElementById("bridge");
  try {
    const s = await browser.runtime.sendMessage({ type: "bridge-status" });
    bridgeEl.textContent = s.connected
      ? (s.engineReady ? "готов" : "запускается…")
      : (s.error ? "не запущен: " + s.error : "не запущен (запустится в игре)");
  } catch (e) {
    bridgeEl.textContent = "ошибка: " + e;
  }
})();
