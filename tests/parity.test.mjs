// Checks that docs/forecast.js gives the same answers as the Python reference code.
// Run: node --test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildForecast, kyivHour, parseTime } from "../docs/forecast.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const model = read("../docs/models/alerts_A.json");
const durations = read("../docs/models/duration.json").durations_min;
const vectors = read("./vectors.json");

const close = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-4);

test("vectors were made for the model that is shipped", () => {
  assert.equal(vectors.modelVersion, model.version);
  assert.ok(vectors.cases.length >= 50);
});

test("time helpers", () => {
  assert.equal(parseTime("2026-11-13T10:11:05.414845208Z"), Date.parse("2026-11-13T10:11:05.414Z"));
  assert.equal(parseTime("garbage"), null);
  assert.equal(parseTime(null), null);
  assert.equal(kyivHour(Date.parse("2026-01-15T12:00:00Z")), 14);
  assert.equal(kyivHour(Date.parse("2026-07-15T12:00:00Z")), 15);
  assert.equal(kyivHour(Date.parse("2026-03-29T00:59:00Z")), 2);
  assert.equal(kyivHour(Date.parse("2026-03-29T01:00:00Z")), 4);
  assert.equal(kyivHour(Date.parse("2026-10-25T00:59:00Z")), 3);
  assert.equal(kyivHour(Date.parse("2026-10-25T01:00:00Z")), 3);
});

test("unusable response gives an unknown state, not a forecast", () => {
  for (const bad of [null, {}, { raions: "x" }, "text"]) {
    const d = buildForecast(bad, Date.now(), model, durations);
    assert.equal(d.mode, "unknown");
    assert.equal(d.alert.status, "unknown");
    assert.deepEqual(d.horizons, []);
  }
});

for (const c of vectors.cases) {
  test(`same as Python: ${c.name}`, () => {
    const got = buildForecast(c.alerts, Date.parse(c.now), model, durations,
                              c.lastEndedAt ? Date.parse(c.lastEndedAt) : null);
    const want = c.expected;
    assert.equal(got.mode, want.mode);
    assert.equal(got.alert.status, want.status);
    assert.equal(got.alert.level, want.level);
    assert.equal(got.alert.oblastRaionsActive, want.oblastRaionsActive);
    assert.equal(got.alert.oblastRaionsTotal, want.oblastRaionsTotal);
    // Python reports whole seconds
    const since = got.alert.since === null ? null : Math.floor(got.alert.since / 1000);
    assert.equal(since, want.since === null ? null : Date.parse(want.since) / 1000);
    assert.equal(got.horizons.length, want.horizons.length);
    got.horizons.forEach((h, i) => {
      const w = want.horizons[i];
      assert.equal(h.minutes, w.minutes);
      assert.ok(close(h.probability, w.probability), `${h.minutes} min: ${h.probability} vs ${w.probability}`);
      if (want.mode === "quiet") {
        assert.equal(h.level, w.level, `${h.minutes} min level`);
        assert.equal(h.atCap, w.atCap, `${h.minutes} min cap`);
        assert.ok(close(h.baseRate, w.baseRate));
      }
    });
  });
}
