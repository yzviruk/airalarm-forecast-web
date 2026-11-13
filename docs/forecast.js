// Forecast logic. A line-by-line port of the Python reference implementation
// (airalarm_forecast/model_alerts.py, duration.py, forecast.py in the main project).
// tests/vectors.json holds cases computed by the Python code; `node --test` checks
// that this file gives the same answers. Change both sides together.

export const HORIZONS = [30, 60, 120, 180]; // minutes
const NEW_ALERT_MIN = 15;
const RECENT_END_SCALE_MIN = 60;
const OBLASTS_NORMALISER = 24;
const MIN_COMPARABLE = 8;
// Every entry of the alerts feed is a real alert, whatever its level. The source sends "red"
// and "yellow"; both are official air raid alerts (the official announcements say "yellow level
// of alert, go to the shelter"). The level is only shown. An entry without a level is shown as this one.
export const DEFAULT_LEVEL = "red";

/** ISO time -> milliseconds since epoch, or null. Tolerates nanoseconds. */
export function parseTime(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value.trim().replace(/\.(\d{3})\d+/, ".$1"));
  return Number.isNaN(ms) ? null : ms;
}

function lastSundayUtc(year, monthIndex) {
  const d = new Date(Date.UTC(year, monthIndex + 1, 0, 1)); // last day of the month, 01:00 UTC
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}

/** Local hour in Kyiv: UTC+2, or UTC+3 during EU summer time. */
export function kyivHour(ms) {
  const t = new Date(ms);
  const y = t.getUTCFullYear();
  const summer = ms >= lastSundayUtc(y, 2) && ms < lastSundayUtc(y, 9);
  return (t.getUTCHours() + (summer ? 3 : 2)) % 24;
}

function group(items) {
  const out = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item === "object" && typeof item.key === "string") {
      out.set(item.key, { since: parseTime(item.since), level: item.level ?? null });
    }
  }
  return out;
}

/** Body of GET /api/v1/alerts -> {raions: Map, oblasts: Map}, or null if unusable. */
export function snapshotFromAlerts(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.raions)) return null;
  return { raions: group(data.raions), oblasts: group(data.oblasts) };
}

export function prepareGeometry(model) {
  const g = model.geometry;
  return {
    target: g.target,
    targetOblast: model.target_oblast,
    weight: new Map(Object.entries(g.weight)),
    ring1: new Set(g.ring1),
    ring2: new Set(g.ring2),
    sameOblast: new Set(g.same_oblast),
    oblastOf: new Map(Object.entries(g.oblast_of)),
  };
}

/** {level, since} of the alert covering the target raion; level is null when there is none. */
export function targetAlert(snap, g) {
  const own = snap.raions.get(g.target) ?? snap.oblasts.get(g.targetOblast);
  return own ? { level: own.level || DEFAULT_LEVEL, since: own.since } : { level: null, since: null };
}

/** Raions under alert (any level): Map raion -> ms when its alert started. */
export function activeRaions(snap, g, receivedMs) {
  const active = new Map();
  for (const [key, a] of snap.raions) {
    if (g.weight.has(key)) {
      active.set(key, a.since ?? receivedMs);
    }
  }
  for (const [okey, a] of snap.oblasts) {
    for (const [raion, oblast] of g.oblastOf) {
      if (oblast === okey && g.weight.has(raion) && !active.has(raion)) {
        active.set(raion, a.since ?? receivedMs);
      }
    }
  }
  return active;
}

/** Feature vector in the order of model.features. */
export function features(nowMs, active, lastEndMs, g) {
  let ring1 = 0, ring2 = 0, same = 0, pressure = 0, newPressure = 0;
  const oblasts = new Set();
  for (const [raion, started] of active) {
    const w = g.weight.get(raion);
    if (w === undefined) continue;
    pressure += w;
    if (nowMs - started <= NEW_ALERT_MIN * 60000) newPressure += w;
    if (g.ring1.has(raion)) ring1 += 1;
    else if (g.ring2.has(raion)) ring2 += 1;
    if (g.sameOblast.has(raion)) same += 1;
    oblasts.add(g.oblastOf.get(raion));
  }
  let recent = 0;
  if (lastEndMs != null && nowMs >= lastEndMs) {
    recent = Math.exp(-(nowMs - lastEndMs) / 60000 / RECENT_END_SCALE_MIN);
  }
  const hour = kyivHour(nowMs);
  return [
    ring1 / Math.max(1, g.ring1.size),
    ring2 / Math.max(1, g.ring2.size),
    pressure,
    newPressure,
    same / Math.max(1, g.sameOblast.size),
    oblasts.size / OBLASTS_NORMALISER,
    recent,
    hour >= 22 || hour < 6 ? 1 : 0,
  ];
}

/** Probability that an alert starts within each horizon; never decreases with the horizon. */
export function predict(x, model) {
  const cap = model.cap ?? 1;
  const z = x.map((v, i) => (v - model.mean[i]) / model.std[i]);
  const out = {};
  let floor = 0;
  for (const h of Object.keys(model.horizons).map(Number).sort((a, b) => a - b)) {
    const c = model.horizons[String(h)];
    let score = c.intercept;
    for (let i = 0; i < z.length; i++) score += c.weights[i] * z[i];
    score = Math.max(-30, Math.min(30, score));
    floor = Math.max(floor, Math.min(cap, 1 / (1 + Math.exp(-score))));
    out[h] = floor;
  }
  return out;
}

function countAtMost(sorted, x) { // number of values <= x
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** P(alert still active H minutes from now | it has lasted elapsedMin). null = too few similar past alerts. */
export function stillActive(durationsMin, elapsedMin) {
  const n = durationsMin.length;
  const atRisk = n - countAtMost(durationsMin, elapsedMin);
  const out = {};
  for (const h of HORIZONS) {
    out[h] = atRisk < MIN_COMPARABLE ? null : (n - countAtMost(durationsMin, elapsedMin + h)) / atRisk;
  }
  return out;
}

export function levelFor(probability, baseRate) {
  if (probability >= 0.6) return "very_high";
  if (probability >= 0.3 || probability >= 4 * baseRate) return "high";
  if (probability >= 1.5 * baseRate) return "elevated";
  return "none";
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;
const LEVEL_ORDER = ["none", "elevated", "high", "very_high"];
const higherLevel = (a, b) => (LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b);

/**
 * Everything the page shows, from one alerts response.
 * alertsData  -- body of GET /api/v1/alerts
 * lastEndedMs -- when the target's previous alert ended, if the page knows it (else null)
 * targets     -- result of evaluateTargets() (targets.js, experimental) or null. It can only
 *                raise the text level of a card; the percentage always comes from the alerts model.
 */
export function buildForecast(alertsData, nowMs, model, durationsMin, lastEndedMs = null, targets = null) {
  const g = prepareGeometry(model);
  const snap = snapshotFromAlerts(alertsData);
  const result = {
    mode: "unknown",
    alert: { status: "unknown", level: null, since: null,
             oblastRaionsActive: null, oblastRaionsTotal: g.sameOblast.size + 1 },
    horizons: [],
  };
  if (!snap) return result;

  const own = targetAlert(snap, g);
  const active = activeRaions(snap, g, nowMs);
  const inAlert = own.level !== null;
  let sameActive = inAlert ? 1 : 0;
  for (const r of g.sameOblast) if (active.has(r)) sameActive += 1;
  result.alert = { ...result.alert, status: inAlert ? "alert" : "none",
                   level: own.level, since: own.since, oblastRaionsActive: sameActive };

  if (inAlert) {
    result.mode = "alert";
    const elapsed = own.since != null ? Math.max(0, (nowMs - own.since) / 60000) : 0;
    const remaining = stillActive(durationsMin, elapsed);
    result.horizons = HORIZONS.map((h) => ({ minutes: h, probability: remaining[h] }));
  } else {
    result.mode = "quiet";
    const probs = predict(features(nowMs, active, lastEndedMs, g), model);
    const cap = model.cap ?? 1;
    result.horizons = HORIZONS.map((h) => {
      const own = levelFor(probs[h], model.base_rates[String(h)]);
      const byTargets = targets ? (targets.level[String(h)] ?? "none") : "none";
      const level = higherLevel(own, byTargets);
      return {
        minutes: h,
        probability: round4(probs[h]),
        baseRate: round4(model.base_rates[String(h)]),
        level,
        alertsLevel: own,
        targetsLevel: targets ? byTargets : null,
        raisedByTargets: level !== own, // the experimental layer lifted the level
        atCap: probs[h] >= cap - 1e-9,
      };
    });
  }
  return result;
}
