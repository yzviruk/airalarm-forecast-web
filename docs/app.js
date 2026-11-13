// Page behaviour: fetches official alerts from NEPTUN, computes the forecast in the
// browser (forecast.js) and renders it. There is no server of our own.
import { buildForecast } from "./forecast.js?v=1";

const ALERTS_URL = "https://neptun.in.ua/api/v1/alerts";
const REFRESH_MS = 45000;        // the source asks for no more than one request per 5 s
const FETCH_TIMEOUT_MS = 15000;
const STALE_AFTER_MS = 180000;   // no fresh data for this long -> no forecast is shown
const MEMORY_KEY = "airalarm.target.v1";
const MEMORY_MAX_GAP_MS = 180000;
const MEMORY_KEEP_MS = 6 * 3600000;

const LEVELS = { none: "Ознак загрози не видно", elevated: "Підвищена", high: "Висока", very_high: "Дуже висока" };
const HORIZON = { 30: "30 хв", 60: "1 година", 120: "2 години", 180: "3 години" };
const timeFmt = new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
const $ = (id) => document.getElementById(id);

let model = null;
let durations = null;
let lastOkMs = null;      // when alerts were last fetched successfully
let lastAlerts = null;    // the last good response
let timer = null;

const clock = (ms) => timeFmt.format(new Date(ms));
const minutesSince = (ms, now) => Math.max(0, Math.round((now - ms) / 60000));
function span(mins) {
  if (mins < 60) return `${mins} хв`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h} год${m ? ` ${m} хв` : ""}`;
}
function pct(p) {
  const v = p * 100;
  return `${v < 10 ? v.toFixed(1).replace(".", ",") : Math.round(v)} %`;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// --- memory of the previous alert (this browser only) ----------------------
// Without a server the page knows when an alert ended only if it saw it end.

function readMemory() {
  try { return JSON.parse(localStorage.getItem(MEMORY_KEY)) || {}; } catch { return {}; }
}
function writeMemory(m) {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(m)); } catch { /* private mode: no memory */ }
}
/** Updates the memory with what is seen now; returns when the previous alert ended (ms) or null. */
function rememberAlert(inAlert, now) {
  const m = readMemory();
  let endedAt = typeof m.endedAt === "number" ? m.endedAt : null;
  if (inAlert) {
    endedAt = null;
  } else if (m.active === true) {
    // It was active when we last looked. We know the end time only if we looked recently.
    endedAt = now - (m.seenAt || 0) <= MEMORY_MAX_GAP_MS ? now : null;
  }
  if (endedAt !== null && now - endedAt > MEMORY_KEEP_MS) endedAt = null;
  writeMemory({ active: inAlert, seenAt: now, endedAt });
  return endedAt;
}

// --- rendering --------------------------------------------------------------

function renderStatus(d, now, endedAt) {
  const a = d.alert;
  let cls, title, detail = "";
  if (a.status === "alert") {
    cls = "alert"; title = "Повітряна тривога";
    if (a.since) detail = `з ${clock(a.since)}, триває ${span(minutesSince(a.since, now))}`;
  } else if (a.status === "elevated") {
    cls = "elevated"; title = "Підвищена небезпека";
    detail = `Рівень «${a.level || "?"}»${a.since ? ` з ${clock(a.since)}` : ""}. Сирена не оголошена.`;
  } else if (a.status === "none") {
    cls = "calm"; title = "Тривоги немає";
    if (endedAt && minutesSince(endedAt, now) <= 60) detail = `Відбій о ${clock(endedAt)}`;
  } else {
    cls = "unknown"; title = "Стан тривоги невідомий";
    detail = "Перевірте офіційний застосунок «Повітряна тривога».";
  }
  $("status").className = `status ${cls}`;
  $("status-title").textContent = title;
  $("status-detail").textContent = detail;
  $("status-sub").textContent = a.oblastRaionsActive == null ? ""
    : a.oblastRaionsActive === 0 ? "У жодному районі області тривоги немає."
    : `Тривога в ${a.oblastRaionsActive} з ${a.oblastRaionsTotal} районів області.`;
}

function renderCards(d, showForecast) {
  const cards = $("cards");
  cards.textContent = "";
  const alertMode = showForecast && d.mode === "alert";
  $("cards-title").textContent = alertMode ? "Чи триватиме тривога" : "Чи почнеться тривога";
  $("alert-note").hidden = !alertMode;
  $("layer-note").hidden = !showForecast || alertMode;
  if (!showForecast || !d.horizons.length) {
    for (const m of [30, 60, 120, 180]) {
      const c = el("div", "card nodata");
      c.append(el("div", "when", HORIZON[m]), el("div", "level", "Немає даних"));
      cards.append(c);
    }
    return;
  }
  for (const h of d.horizons) {
    let c;
    if (alertMode) {
      c = el("div", `card${h.probability == null ? " nodata" : ""}`);
      c.append(el("div", "when", `через ${HORIZON[h.minutes]}`));
      if (h.probability == null) {
        c.append(el("div", "level", "Замало схожих випадків"));
      } else {
        const bar = el("div", "bar"), fill = document.createElement("i");
        fill.style.width = `${Math.round(h.probability * 100)}%`;
        bar.append(fill);
        c.append(el("div", "big", pct(h.probability)), el("div", "usual", "імовірно ще триватиме"), bar);
      }
    } else {
      c = el("div", `card ${h.level}`);
      const p = el("div", "pct", h.atCap ? `${pct(h.probability)} і більше` : `≈ ${pct(h.probability)}`);
      p.append(el("div", "usual", `зазвичай ${pct(h.baseRate)}`));
      c.append(el("div", "when", HORIZON[h.minutes]), el("div", "level", LEVELS[h.level] || h.level), p);
    }
    cards.append(c);
  }
}

function render() {
  const now = Date.now();
  const stale = lastOkMs === null || now - lastOkMs > STALE_AFTER_MS;
  const d = buildForecast(lastAlerts, now, model, durations, readMemory().endedAt ?? null);
  renderStatus(d, now, readMemory().endedAt ?? null);
  renderCards(d, !stale);
  const banner = $("stale");
  banner.hidden = !stale;
  if (stale) {
    banner.textContent = lastOkMs === null
      ? "Не вдається отримати дані про тривоги. Перевірте інтернет і офіційний застосунок «Повітряна тривога»."
      : `Дані застаріли: останнє оновлення о ${clock(lastOkMs)}. Стан вище може бути неактуальним, прогнозу немає.`;
  }
  $("service").textContent = lastOkMs === null ? `Модель ${model.version}`
    : `Оновлено о ${clock(lastOkMs)} · модель ${model.version}`;
}

// --- data -------------------------------------------------------------------

async function getJson(url, options = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...options, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function refresh() {
  try {
    const data = await getJson(ALERTS_URL, { cache: "no-store" });
    if (!data || !Array.isArray(data.raions)) throw new Error("unexpected response");
    const now = Date.now();
    lastAlerts = data;
    lastOkMs = now;
    rememberAlert(buildForecast(data, now, model, durations).alert.status === "alert", now);
  } catch (err) {
    console.warn("alerts refresh failed:", err);
  }
  render();
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
}

async function start() {
  try {
    [model, durations] = await Promise.all([
      getJson("models/alerts_A.json", { cache: "no-cache" }),
      getJson("models/duration.json", { cache: "no-cache" }).then((d) => d.durations_min),
    ]);
  } catch (err) {
    $("status-title").textContent = "Сторінка не завантажилась";
    $("status-detail").textContent = "Оновіть сторінку. Якщо не допоможе, перевірте офіційний застосунок «Повітряна тривога».";
    console.error(err);
    return;
  }
  await refresh();
  schedule();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}

start();
