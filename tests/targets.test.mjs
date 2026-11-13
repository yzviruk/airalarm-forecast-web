// Checks that docs/targets.js (experimental targets layer) gives the same answers as the
// Python reference code. Run: node --test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildForecast } from "../docs/forecast.js";
import { evaluateTargets } from "../docs/targets.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const model = read("../docs/models/targets_B.json");
const vectors = read("./vectors_targets.json");
const TOLERANCE = 1e-6;

test("target vectors were made for the model that is shipped", () => {
  assert.equal(vectors.modelVersion, model.version);
  assert.ok(vectors.cases.length >= 40);
  assert.equal(model.fitted, false, "once the model is fitted, review how the page labels this layer");
});

for (const c of vectors.cases) {
  test(`targets, same as Python: ${c.name}`, () => {
    const got = evaluateTargets(c.threats, Date.parse(c.now), model);
    const want = c.expected;
    for (const h of Object.keys(want.probability)) {
      assert.ok(Math.abs(got.probability[h] - want.probability[h]) <= TOLERANCE,
                `${h} min: ${got.probability[h]} vs ${want.probability[h]}`);
    }
    assert.deepEqual(got.level, want.level);
    for (const key of ["version", "listedTotal", "simulated", "staleIgnored", "ballistic", "mig31k"]) {
      assert.equal(got[key], want[key], key);
    }
    assert.deepEqual(got.areaOnly, want.areaOnly);
    assert.deepEqual(got.targets.map((t) => t.id), want.targets.map((t) => t.id));
    got.targets.forEach((t, i) => {
      const { p, ...rest } = t;
      const { p: wantP, ...wantRest } = want.targets[i];
      assert.deepEqual(rest, wantRest);
      for (const h of Object.keys(wantP)) assert.ok(Math.abs(p[h] - wantP[h]) <= TOLERANCE, `${t.id} ${h} min`);
    });
  });
}

test("the cache does not change the answer and forgets removed targets", () => {
  const c = vectors.cases.find((x) => x.name.startsWith("many targets"));
  const cache = new Map();
  const now = Date.parse(c.now);
  const plain = evaluateTargets(c.threats, now, model);
  assert.deepEqual(evaluateTargets(c.threats, now, model, cache), plain);
  assert.deepEqual(evaluateTargets(c.threats, now, model, cache), plain);
  assert.equal(cache.size, c.threats.length);
  evaluateTargets([], now, model, cache);
  assert.equal(cache.size, 0);
});

test("unusable input gives an empty result, not an error", () => {
  for (const bad of [null, undefined, "text", [null, 5, "x", {}]]) {
    const r = evaluateTargets(bad, Date.now(), model);
    assert.equal(r.simulated, 0);
    assert.equal(r.probability["180"], 0);
  }
});

test("targets raise the level of a card but never its percentage", () => {
  const alertsModel = read("../docs/models/alerts_A.json");
  const durations = read("../docs/models/duration.json").durations_min;
  const c = vectors.cases.find((x) => x.name === "already inside the zone");
  const now = Date.parse(c.now);
  const targets = evaluateTargets(c.threats, now, model);
  const calm = { raions: [], oblasts: [] };
  const plain = buildForecast(calm, now, alertsModel, durations);
  const raised = buildForecast(calm, now, alertsModel, durations, null, targets);
  plain.horizons.forEach((h, i) => {
    const r = raised.horizons[i];
    assert.equal(h.raisedByTargets, false);
    assert.equal(h.level, h.alertsLevel);
    assert.equal(r.probability, h.probability);
    assert.equal(r.level, "high");
    assert.equal(r.alertsLevel, h.level);
    assert.equal(r.raisedByTargets, true);
  });
});
