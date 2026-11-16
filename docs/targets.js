// Layer B: forecast from the positions of air targets (trajectory simulation).
// A port of airalarm_forecast/model_targets.py (and the flat-map helpers of geo.py) from
// the main project. tests/vectors_targets.json holds cases computed by the Python code;
// `node --test` checks that this file gives the same answers. Change both sides together.
//
// EXPERIMENTAL: the parameters in models/targets_B.json are common-sense guesses and the
// accuracy has not been checked. The result may raise the text level on the page but
// must not be shown as a percentage.

import { parseTime } from "./forecast.js?v=5";

const EARTH_KM = 6371.0088;
const KM_PER_DEG_LAT = 111.19;
const RAD = Math.PI / 180;
const SQRT3 = Math.sqrt(3);
const LEVEL_ORDER = ["none", "elevated", "high", "very_high"];
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const mod = (a, n) => ((a % n) + n) % n;
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

// --- geometry -----------------------------------------------------------------

export function haversineKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const dp = p2 - p1, dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return mod(Math.atan2(y, x) / RAD + 360, 360);
}

/** [east km, north km] of a point relative to (lat0, lon0). */
function toXY(lat, lon, lat0, lon0) {
  return [(lon - lon0) * KM_PER_DEG_LAT * Math.cos(lat0 * RAD), (lat - lat0) * KM_PER_DEG_LAT];
}

function pointInRing(x, y, ring) {
  let inside = false;
  let [x1, y1] = ring[ring.length - 1];
  for (const [x2, y2] of ring) {
    if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
    x1 = x2; y1 = y2;
  }
  return inside;
}

function distToRing(x, y, ring) {
  let best = Infinity;
  let [x1, y1] = ring[ring.length - 1];
  for (const [x2, y2] of ring) {
    const dx = x2 - x1, dy = y2 - y1;
    const length2 = dx * dx + dy * dy;
    const u = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length2));
    const ex = x - (x1 + u * dx), ey = y - (y1 + u * dy);
    const d2 = ex * ex + ey * ey;
    if (d2 < best) best = d2;
    x1 = x2; y1 = y2;
  }
  return Math.sqrt(best);
}

const compass = (bearing) => COMPASS[Math.floor((mod(bearing, 360) + 22.5) / 45) % 8];
const angleDiff = (a, b) => Math.abs(mod(a - b + 180, 360) - 180);

// --- deterministic random numbers (same generator as the Python side) -----------

function seedOf(text) {
  let h = 2166136261; // FNV-1a, 32 bit
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 16777619) >>> 0;
  return h;
}

function uniformSource(seed) {
  let state = seed >>> 0;
  return () => { // mulberry32
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (uniform) => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());

// --- reading one target ---------------------------------------------------------

/** "sim" (simulate), "area" (only counted), "flag" (separate warning), "skip". */
export function classify(threat, model) {
  const kind = threat.type;
  if (threat.status === "resolved" || model.skip_types.includes(kind)) return "skip";
  if (model.flag_types.includes(kind)) return "flag";
  if (threat.areaOnly) return "area";
  if (!isNumber(threat.lat) || !isNumber(threat.lon)) return "skip";
  return "sim";
}

function trailBearing(threat, minKm = 3) {
  const points = [];
  for (const p of Array.isArray(threat.trail) ? threat.trail : []) {
    if (p && typeof p === "object" && isNumber(p.lat) && isNumber(p.lon)) points.push([p.lat, p.lon]);
  }
  if (isNumber(threat.lat) && isNumber(threat.lon)) points.push([threat.lat, threat.lon]);
  if (points.length < 2) return null;
  const end = points[points.length - 1];
  for (let i = points.length - 2; i >= 0; i--) {
    if (haversineKm(points[i][0], points[i][1], end[0], end[1]) >= minKm) {
      return bearingDeg(points[i][0], points[i][1], end[0], end[1]);
    }
  }
  return null;
}

/** {bearing (or null), sigma (degrees), source}. */
export function course(threat, model) {
  let bearing = null, source = "unknown";
  const velocity = threat.velocity;
  if (velocity && typeof velocity === "object" && isNumber(velocity.bearingDeg)) {
    bearing = velocity.bearingDeg; source = "trail";
  }
  if (bearing === null) {
    bearing = trailBearing(threat);
    if (bearing !== null) source = "trail";
  }
  if (bearing === null && isNumber(threat.heading)) { bearing = threat.heading; source = "heading"; }
  if (bearing === null) return { bearing: null, sigma: 0, source };
  let sigma = model.course_sigma_deg[source];
  if (threat.presumptiveCourse) sigma += model.presumptive_extra_deg;
  if (threat.positionQuality === "approx") sigma += model.approx_extra_deg;
  return { bearing: mod(bearing, 360), sigma, source };
}

/** Plausible speed [lo, hi], km/h: reported if present (within reason), otherwise by type. */
export function speedRange(threat, model) {
  const [lo, hi] = model.speed_kmh[threat.type] ?? model.speed_kmh.unknown;
  const velocity = threat.velocity;
  const reported = velocity && typeof velocity === "object" && isNumber(velocity.speedKmh) ? velocity.speedKmh : null;
  if (reported !== null && reported > 0) {
    const v = Math.min(Math.max(reported, 0.6 * lo), 1.3 * hi);
    return [v * (1 - model.velocity_spread), v * (1 + model.velocity_spread)];
  }
  return [lo, hi];
}

// --- simulation -----------------------------------------------------------------

/** Minutes after the target's last update at which each simulated trajectory enters the
 *  zone, sorted. Trajectories that never enter are left out. */
export function entryTimes(threat, model) {
  const [lat0, lon0] = model.center;
  const ring = model.ring_km, bufferKm = model.buffer_km;
  const inner = model.inner_km + bufferKm;   // closer than this: certainly inside
  const outer = model.outer_km + bufferKm;   // farther than this: certainly outside
  const inner2 = inner * inner, outer2 = outer * outer;
  const window = model.max_age_min + Math.max(...model.horizons);
  const step = model.step_km;

  const [x0, y0] = toXY(threat.lat, threat.lon, lat0, lon0);
  const sigmaPos = Math.min((isNumber(threat.uncertaintyKm) ? threat.uncertaintyKm : 0) * model.position_sigma_share,
                            model.position_sigma_max_km);
  const [vLo, vHi] = speedRange(threat, model);
  if (Math.hypot(x0, y0) - outer - 3 * sigmaPos > vHi / 60 * window) return [];
  const { bearing, sigma } = course(threat, model);
  const uniform = uniformSource(seedOf(`${threat.id ?? ""}|${threat.updatedAt ?? ""}`));

  const out = [];
  for (let i = 0; i < model.trajectories; i++) {
    let x = x0 + gauss(uniform) * sigmaPos;
    let y = y0 + gauss(uniform) * sigmaPos;
    const v = (vLo + uniform() * (vHi - vLo)) / 60; // km per minute
    let theta = (bearing === null ? uniform() * 360 : bearing + gauss(uniform) * sigma) * RAD;
    const dt = step / v;
    const kick = model.drift_deg_per_sqrt_min * RAD * Math.sqrt(dt) * SQRT3;
    let t = 0;
    for (;;) {
      const d2 = x * x + y * y;
      if (d2 <= inner2 || (d2 <= outer2 && (pointInRing(x, y, ring) || distToRing(x, y, ring) <= bufferKm))) {
        out.push(t);
        break;
      }
      if (d2 > outer2 && Math.sqrt(d2) - outer > v * (window - t)) break;
      t += dt;
      if (t > window) break;
      theta += (2 * uniform() - 1) * kick;
      x += step * Math.sin(theta);
      y += step * Math.cos(theta);
    }
  }
  return out.sort((a, b) => a - b);
}

/** Share of the n trajectories that entered no later than `minutes`; with attrition a
 *  trajectory that needs t minutes counts as exp(-t / attrition). */
export function shareWithin(entries, n, minutes, attritionMin = null) {
  let total = 0;
  for (const t of entries) {
    if (t > minutes) break;
    total += attritionMin ? Math.exp(-t / attritionMin) : 1;
  }
  return total / n;
}

// --- all targets together ---------------------------------------------------------

export function targetsLevel(probability, model) {
  if (probability >= model.levels.high) return "high";
  if (probability >= model.levels.elevated) return "elevated";
  return "none";
}

export const higherLevel = (a, b) => (LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b);

const simKey = (t) => JSON.stringify([t.id, t.updatedAt, t.lat, t.lon, t.heading, t.velocity, t.trail?.length,
                                      t.presumptiveCourse, t.positionQuality, t.uncertaintyKm, t.type]);
const roundTo = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * Layer B for the current set of targets (the `threats` array of GET /api/v1/threats).
 * cache (optional Map, owned by the caller) lets the page simulate each target once per
 * update, not once per refresh.
 */
export function evaluateTargets(threats, nowMs, model, cache = null) {
  const horizons = model.horizons, n = model.trajectories;
  const [cityLat, cityLon] = model.city;
  const miss = new Map(horizons.map((h) => [h, 1]));
  const listed = [], areaOnly = new Map(), flags = new Set(), seen = new Set();
  let simulated = 0, stale = 0;

  for (const threat of Array.isArray(threats) ? threats : []) {
    if (!threat || typeof threat !== "object") continue;
    const what = classify(threat, model);
    if (what === "skip") continue;
    if (what === "flag") { flags.add(threat.type); continue; }
    if (what === "area") {
      const region = threat.region || "?";
      areaOnly.set(region, (areaOnly.get(region) ?? 0) + 1);
      continue;
    }
    const updated = parseTime(threat.updatedAt);
    const age = updated === null ? 0 : Math.max(0, (nowMs - updated) / 60000);
    if (age > model.max_age_min) { stale += 1; continue; }
    simulated += 1;
    seen.add(threat.id);
    const key = simKey(threat);
    let entries;
    const hit = cache?.get(threat.id);
    if (hit && hit.key === key) {
      entries = hit.entries;
    } else {
      entries = entryTimes(threat, model);
      cache?.set(threat.id, { key, entries });
    }
    const p = new Map(horizons.map((h) => [h, shareWithin(entries, n, age + h, model.attrition_min)]));
    for (const h of horizons) miss.set(h, miss.get(h) * (1 - p.get(h)));
    if (p.get(horizons[horizons.length - 1]) < model.list_min_probability) continue;
    const c = course(threat, model);
    const toward = c.bearing === null ? null
      : angleDiff(c.bearing, bearingDeg(threat.lat, threat.lon, cityLat, cityLon));
    const eta = entries.length >= 0.1 * n ? Math.max(0, entries[Math.floor(entries.length / 2)] - age) : null;
    listed.push({
      id: threat.id ?? null,
      type: threat.type ?? null,
      title: threat.title ?? null,
      locality: threat.locality ?? null,
      region: threat.region ?? null,
      count: threat.count ?? null,
      distanceKm: Math.round(haversineKm(cityLat, cityLon, threat.lat, threat.lon)),
      direction: compass(bearingDeg(cityLat, cityLon, threat.lat, threat.lon)), // where it is, seen from the city
      course: toward === null ? "unknown" : toward <= 35 ? "toward" : toward >= 110 ? "away" : "aside",
      courseSource: c.source,
      presumptive: Boolean(threat.presumptiveCourse),
      etaMin: eta === null ? null : Math.round(eta / 5) * 5,
      ageMin: Math.round(age),
      p: Object.fromEntries(horizons.map((h) => [String(h), roundTo(p.get(h), 3)])),
    });
  }

  if (cache) for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
  const first = String(horizons.length > 1 ? horizons[1] : horizons[0]);
  const last = String(horizons[horizons.length - 1]);
  listed.sort((a, b) => (b.p[first] - a.p[first]) || (b.p[last] - a.p[last]) || (a.distanceKm - b.distanceKm));
  const probability = {}, level = {};
  for (const h of horizons) {
    probability[String(h)] = roundTo(1 - miss.get(h), 4);
    level[String(h)] = targetsLevel(1 - miss.get(h), model);
  }
  return {
    version: model.version,
    probability,
    level,
    targets: listed.slice(0, model.list_max),
    listedTotal: listed.length,
    simulated,
    staleIgnored: stale,
    areaOnly: [...areaOnly.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([region, count]) => ({ region, count })),
    ballistic: flags.has("ballistic"),
    mig31k: flags.has("mig31k"),
  };
}
