// Page behaviour: fetches official alerts and air targets from NEPTUN, computes the
// forecast in the browser (forecast.js, targets.js) and renders it. There is no server of our own.
import { buildForecast, durationCurves } from "./forecast.js?v=5";
import { evaluateTargets } from "./targets.js?v=5";

const ALERTS_URL = "https://neptun.in.ua/api/v1/alerts";
const THREATS_URL = "https://neptun.in.ua/api/v1/threats";
const REFRESH_MS = 45000;        // the source asks for no more than one request per 5 s
const BETWEEN_REQUESTS_MS = 6000; // so the two requests of one refresh are spaced out too
const FETCH_TIMEOUT_MS = 15000;
const STALE_AFTER_MS = 180000;   // no fresh data for this long -> no forecast is shown
const MEMORY_KEY = "airalarm.target.v1";
const MEMORY_MAX_GAP_MS = 180000;
const MEMORY_KEEP_MS = 6 * 3600000;

const LEVELS = { none: "Не вище звичайного", elevated: "Підвищена", high: "Висока", very_high: "Дуже висока" };
const ALERT_LEVELS = { red: "червоний рівень (ракетна небезпека)", yellow: "жовтий рівень (загроза БпЛА)" };
const HORIZON = { 30: "30 хв", 60: "1 година", 120: "2 години", 180: "3 години" };
const timeFmt = new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
const $ = (id) => document.getElementById(id);

let model = null;
let durations = null;
let durationValidated = false;  // false: the duration curve is not validated by the project's rules
let durationPreliminary = false;  // true: checked on a few weeks of current data; shown with a mark
let lastOkMs = null;      // when alerts were last fetched successfully
let lastAlerts = null;    // the last good response
let targetsModel = null;  // null if the experimental targets layer failed to load
let lastThreats = null;   // the last good list of targets
let lastThreatsMs = null;
let threatsTried = false;  // the first request for targets has finished (well or not)
let refreshing = false;
const simCache = new Map();
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
    const parts = [];
    if (ALERT_LEVELS[a.level]) parts.push(ALERT_LEVELS[a.level]);
    if (a.since) parts.push(`з ${clock(a.since)}, триває ${span(minutesSince(a.since, now))}`);
    detail = parts.join(" · ");
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

function renderCards(d, showForecast, withTargets) {
  const cards = $("cards");
  cards.textContent = "";
  const alertMode = showForecast && d.mode === "alert";
  $("cards-title").textContent = alertMode ? "Чи триватиме тривога" : "Чи почнеться тривога";
  $("alert-note").hidden = !alertMode;
  const note = $("layer-note");
  note.hidden = !showForecast || alertMode;
  note.textContent = !d.percentagesValidated ? "Рівень оцінюється за тривогами в сусідніх районах і за цілями в повітрі. Це експериментальна оцінка без відсотків: правила тривог змінилися у вересні 2026 року, модель навчена на старіших даних, і її точність для нинішніх правил не перевірена. Нові дані накопичуються."
    : withTargets
      ? "Відсоток рахується з карти тривог у сусідніх районах. " +
        "Рівень на картці може бути піднятий за даними про цілі; ця частина експериментальна, її точність ще не перевірена."
      : "Прогноз спирається лише на карту тривог у сусідніх районах, тому він грубий.";
  const title = $("cards-title");
  const noDuration = alertMode && !durationValidated && !durationPreliminary;
  $("alert-note").textContent = noDuration ? "Тривога діє. Оцінки, скільки вона ще триватиме, поки немає: правила тривог змінилися у вересні 2026 року, а нових даних ще замало."
    : durationValidated ? "Тривога вже діє. Нижче оцінка, чи вона ще триватиме."
    : "Тривога вже діє. Нижче попередня оцінка, чи вона ще триватиме: за тривогами в області за останній місяць, окремо для жовтого й червоного рівня. Перевірена лише на кількох тижнях даних; дуже довгі тривоги передбачає погано.";
  cards.hidden = title.hidden = noDuration;
  if (noDuration) return;
  if (alertMode && !durationValidated) title.append(el("span", "badge", "попередня оцінка"));
  if (showForecast && !alertMode && d.horizons.length && !d.percentagesValidated) {
    title.append(el("span", "badge", "експериментально"));
  }
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
        // the ends of the scale are unreliable, so they are shown only as "less than" / "more than"
        const shownP = h.shown === "below" ? 0.10 : h.shown === "above" ? 0.90 : h.probability;
        fill.style.width = `${Math.round(shownP * 100)}%`;
        bar.append(fill);
        const text = h.shown === "below" ? "менше 10 %" : h.shown === "above" ? "понад 90 %" : pct(h.probability);
        c.append(el("div", "big", text), el("div", "usual", "імовірно ще триватиме"), bar);
      }
    } else {
      c = el("div", `card ${h.level}`);
      c.append(el("div", "when", HORIZON[h.minutes]), el("div", "level", LEVELS[h.level] || h.level));
      if (d.percentagesValidated) {
        const p = el("div", "pct", h.atCap ? `${pct(h.probability)} і більше` : `≈ ${pct(h.probability)}`);
        p.append(el("div", "usual", `зазвичай ${pct(h.baseRate)}`));
        c.append(p);
      }
      if (h.raisedByTargets) c.append(el("div", "raised", "рівень піднято за даними про цілі (експериментально)"));
    }
    cards.append(c);
  }
}

const DIRECTION = { N: "північ", NE: "північний схід", E: "схід", SE: "південний схід",
                    S: "південь", SW: "південний захід", W: "захід", NW: "північний захід" };
const COURSE = { toward: "курс у наш бік", aside: "курс убік", away: "курс від нас", unknown: "курс невідомий" };

/** t: result of evaluateTargets() or null (no fresh data about targets). */
function renderTargets(t, stale) {
  $("ballistic").hidden = stale || !(t && t.ballistic);
  $("mig").hidden = stale || !(t && t.mig31k);
  const box = $("targets-box");
  box.hidden = stale || !targetsModel;
  if (box.hidden) return;
  $("targets-incomplete").hidden = t !== null || !threatsTried;
  const list = $("targets");
  list.textContent = "";
  const items = t ? t.targets : [];
  list.hidden = !items.length;
  for (const x of items) {
    const li = el("li");
    let course = COURSE[x.course] || COURSE.unknown;
    if (x.presumptive && x.course !== "unknown") course += " (припущений)";
    let where = `${x.distanceKm} км на ${DIRECTION[x.direction] || "?"} від міста · ${course}`;
    if (x.etaMin != null) where += ` · якщо летітиме сюди: ${x.etaMin < 5 ? "уже поруч" : `≈ ${span(x.etaMin)}`}`;
    li.append(el("div", "what", (x.title || "Ціль") + (x.locality ? ` · ${x.locality}` : "")), el("div", "where", where));
    list.append(li);
  }
  const parts = [];
  if (!t) {
    parts.push(threatsTried ? "Свіжих даних про цілі немає." : "Дані про цілі завантажуються…");
  } else {
    if (!items.length) parts.push("Цілей, які найближчими годинами можуть дістатися району, не видно. Це не означає безпеки.");
    else if (t.listedTotal > items.length) parts.push(`Показано ${items.length} із ${t.listedTotal} найвпливовіших.`);
    parts.push(`Враховано цілей: ${t.simulated}.`);
    if (t.areaOnly.length) {
      parts.push(`Без точних координат: ${t.areaOnly.map((a) => a.region + (a.count > 1 ? ` (${a.count})` : "")).join(", ")}.`);
    }
    parts.push("Положення й курс цілей неточні (похибка 10–25 км, курс часто припущений); час підльоту дуже приблизний.");
  }
  $("targets-note").textContent = parts.join(" ");
}

function currentTargets(now) {
  if (!targetsModel || lastThreats === null || now - lastThreatsMs > STALE_AFTER_MS) return null;
  try {
    return evaluateTargets(lastThreats, now, targetsModel, simCache);
  } catch (err) {   // the experimental layer must never break the page
    console.error("targets layer failed:", err);
    return null;
  }
}

function render() {
  const now = Date.now();
  const stale = lastOkMs === null || now - lastOkMs > STALE_AFTER_MS;
  const targets = stale ? null : currentTargets(now);
  const d = buildForecast(lastAlerts, now, model, durations, readMemory().endedAt ?? null, targets);
  renderStatus(d, now, readMemory().endedAt ?? null);
  renderCards(d, !stale, targets !== null);
  renderTargets(targets, stale);
  const banner = $("stale");
  banner.hidden = !stale;
  if (stale) {
    banner.textContent = lastOkMs === null
      ? "Не вдається отримати дані про тривоги. Перевірте інтернет і офіційний застосунок «Повітряна тривога»."
      : `Дані застаріли: останнє оновлення о ${clock(lastOkMs)}. Стан вище може бути неактуальним, прогнозу немає.`;
  }
  const versions = model.version + (targetsModel ? ` + ${targetsModel.version} (цілі, експериментально)` : "");
  $("service").textContent = lastOkMs === null ? `Модель ${versions}` : `Оновлено о ${clock(lastOkMs)} · модель ${versions}`;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshThreats() {
  try {
    const data = await getJson(THREATS_URL, { cache: "no-store" });
    if (!data || !Array.isArray(data.threats)) throw new Error("unexpected response");
    lastThreats = data.threats;
    lastThreatsMs = Date.now();
  } catch (err) {
    console.warn("threats refresh failed:", err);
  }
  threatsTried = true;
}

async function refresh() {
  if (refreshing) return;   // one refresh at a time keeps the requests spaced out
  refreshing = true;
  try {
    await refreshAlerts();
    render();
    if (targetsModel) {
      await sleep(BETWEEN_REQUESTS_MS);
      await refreshThreats();
      render();
    }
  } finally {
    refreshing = false;
  }
}

async function refreshAlerts() {
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
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
}

async function start() {
  try {
    [model, durations] = await Promise.all([
      getJson("models/alerts_A.json", { cache: "no-cache" }),
      getJson("models/duration.json", { cache: "no-cache" })
        .then((d) => {
          durationValidated = d.validated === true;
          durationPreliminary = d.preliminary === true;
          return durationCurves(d);
        }),
    ]);
  } catch (err) {
    $("status-title").textContent = "Сторінка не завантажилась";
    $("status-detail").textContent = "Оновіть сторінку. Якщо не допоможе, перевірте офіційний застосунок «Повітряна тривога».";
    console.error(err);
    return;
  }
  try {
    targetsModel = await getJson("models/targets_B.json", { cache: "no-cache" });
  } catch (err) {
    console.warn("targets layer is not available:", err);
  }
  schedule();
  await refresh();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}

start();
