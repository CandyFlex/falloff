/**
 * Vacuum scenarios: the tool pointed at a world whose answer is known.
 *
 * A synthetic provider makes the business visible inside a disc of radius
 * R km around its own location and invisible outside it. There is no noise
 * and no network, so every figure has one correct value and the tests can
 * say what it is. Then failures are injected, and the claim the README
 * leads with is put to the proof: a scan with gaps and a scan that measured
 * and found nothing must never report the same thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scan } from '../src/scan.mjs';
import { audit } from '../src/audit.mjs';
import { visibility, reachEdge, goneBy, byRing } from '../src/metrics.mjs';
import { samplePlan } from '../src/sample.mjs';
import { haversineKm } from '../src/providers/osm.mjs';
import { tally, FOUND, UNREACHED } from '../src/schema.mjs';

const TARGET = { name: 'Disc Test Co', id: 'disc-target', lat: 25.8104, lng: -80.2037 };

/** mulberry32: a small seeded PRNG, so "random" failures are the same every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick k distinct indices out of n with the seeded PRNG. */
function pick(n, k, seed) {
  const rnd = prng(seed);
  const idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return new Set(idx.slice(0, k));
}

/** Visible at rank 1 inside radiusKm of the target, absent outside. Calls in `failAt` throw. */
function discProvider(radiusKm, failAt = new Set()) {
  let call = 0;
  return {
    id: 'synthetic-disc',
    version: '1',
    pacingMs: 0,
    pins: { radiusKm },
    async query({ lat, lng }) {
      const i = call++;
      if (failAt.has(i)) throw new Error('injected failure');
      const d = haversineKm(TARGET.lat, TARGET.lng, lat, lng);
      return { results: d <= radiusKm ? [{ id: TARGET.id, name: TARGET.name }] : [{ id: 'someone-else', name: 'Someone Else' }] };
    },
  };
}

const run = (provider, preset = 'mid') =>
  scan({ target: TARGET, query: 'anything', preset, provider, command: `falloff scan --synthetic disc --preset ${preset}` });

test('the reach edge lands on the last ring inside the disc, for every disc between rings', async () => {
  const rings = samplePlan({ ...TARGET, preset: 'mid' }).rings; // 2.5 3.9 6.2 9.8 15.4 24.2 38.1 60
  for (let i = 0; i < rings.length - 1; i++) {
    const R = (rings[i] + rings[i + 1]) / 2;
    const { snapshot, audit: a } = await run(discProvider(R));
    const edge = reachEdge(snapshot.readings);
    assert.equal(edge.dKm, rings[i], `disc ${R} km: edge should be the ${rings[i]} km ring`);
    assert.equal(edge.hits, edge.measured, 'every point on that ring is inside the disc');
    assert.equal(edge.fragile, false);
    assert.equal(goneBy(snapshot.readings).dKm, rings[i + 1], 'and it is gone by the next ring out');
    assert.equal(a.ok, true);
  }
});

test('the reach edge is within one ring of the truth even when the disc boundary sits on a ring', async () => {
  const rings = samplePlan({ ...TARGET, preset: 'mid' }).rings;
  for (const R of [9.8, 15.4, 24.2]) {
    const { snapshot } = await run(discProvider(R));
    const edge = reachEdge(snapshot.readings).dKm;
    const i = rings.indexOf(R);
    assert.ok(edge === rings[i] || edge === rings[i - 1], `disc ${R}: edge ${edge} is not within one ring`);
  }
});

test('a disc smaller than the first ring: found at home only, and no edge is claimed', async () => {
  const { snapshot } = await run(discProvider(1));
  const v = visibility(snapshot.readings);
  assert.equal(v.found, 1);
  assert.equal(v.measured, 80);
  assert.equal(reachEdge(snapshot.readings), null, 'one point is not a ring');
  assert.equal(goneBy(snapshot.readings).dKm, 2.5);
});

test('k injected failures: measured is exactly total - k, and the share is exactly found/measured of what was measured', async () => {
  const R = 20;
  const { snapshot: clean } = await run(discProvider(R));
  const total = clean.readings.length;
  const cleanV = visibility(clean.readings);
  assert.equal(cleanV.unreached, 0);

  for (const [k, seed] of [[1, 11], [4, 22], [8, 33]]) {
    const failAt = pick(total, k, seed);
    const { snapshot, audit: a } = await run(discProvider(R, failAt));
    const v = visibility(snapshot.readings);
    const t = tally(snapshot.readings);

    assert.equal(t.unreached, k);
    assert.equal(v.measured, total - k, 'the denominator shrinks by exactly the failures');
    assert.equal(v.unreached, k);

    // The failed points that would have been sightings are the only thing that can move `found`.
    const lostSightings = [...failAt].filter((i) => clean.readings[i].status === FOUND).length;
    assert.equal(v.found, cleanV.found - lostSightings);
    assert.equal(v.share, (cleanV.found - lostSightings) / (total - k));

    // Every surviving reading is identical to the clean scan: failures remove information, they never change it.
    snapshot.readings.forEach((r, i) => {
      if (r.status === UNREACHED) assert.ok(failAt.has(i));
      else assert.equal(r.status, clean.readings[i].status);
    });
    assert.equal(a.ok, true, `${k}/${total} unreached is within tolerance`);
    assert.ok(!a.findings.some((f) => f.id === 'B4'));
  }
});

test('over many seeds the share with gaps centres on the true share (unbiased), which a collapse-to-absent tool cannot do', async () => {
  const R = 20;
  const { snapshot: clean } = await run(discProvider(R));
  const total = clean.readings.length;
  const truth = visibility(clean.readings).share;
  const k = 8;
  let honest = 0;
  let collapsed = 0;
  const N = 200;
  for (let seed = 1; seed <= N; seed++) {
    const failAt = pick(total, k, seed);
    // Same arithmetic scan() would produce, without 200 scans: drop the failed readings.
    const kept = clean.readings.filter((_, i) => !failAt.has(i));
    const found = kept.filter((r) => r.status === FOUND).length;
    honest += found / kept.length; // Falloff: unreached leave the denominator
    collapsed += found / total; // the common mistake: unreached counted as not visible
  }
  honest /= N;
  collapsed /= N;
  assert.ok(Math.abs(honest - truth) < 0.01, `honest mean ${honest} vs truth ${truth}`);
  assert.ok(truth - collapsed > 0.03, `collapsing gaps into absences biases the share down (${collapsed} vs ${truth})`);
});

test('more than 10% unreached is a CRITICAL B4 and the scan does not publish; exactly 10% still passes', async () => {
  const total = 80;
  const atLimit = await run(discProvider(20, pick(total, 8, 5)));
  assert.equal(atLimit.audit.ok, true, '8/80 is 10%, not more than 10%');

  const over = await run(discProvider(20, pick(total, 9, 5)));
  assert.equal(over.audit.ok, false);
  const b4 = over.audit.findings.find((f) => f.id === 'B4');
  assert.ok(b4, 'B4 must fire');
  assert.equal(b4.level, 'CRITICAL');
  assert.match(b4.message, /^9\/80 points unreached \(11%\)/);
});

test('THE CENTRAL CLAIM: "37% visible" from a complete scan and from a scan with 30 gaps are different facts, and only one publishes', async () => {
  const total = 80;
  // Scan A: all 80 measured, 30 sightings.
  let a = 0;
  const complete = await run({
    id: 'synthetic-complete', pacingMs: 0,
    async query() { return { results: a++ < 30 ? [{ id: TARGET.id }] : [{ id: 'someone-else' }] }; },
  });
  // Scan B: the same 30 sightings, 20 measured absences, and 30 points that never answered.
  let b = 0;
  const gappy = await run({
    id: 'synthetic-gappy', pacingMs: 0,
    async query() {
      const i = b++;
      if (i < 30) return { results: [{ id: TARGET.id }] };
      if (i < 50) return { results: [{ id: 'someone-else' }] };
      throw new Error('blocked');
    },
  });

  // What a tool that collapses absent and unreached would print for both: 30/80.
  const naive = (snap) => snap.readings.filter((r) => r.status === FOUND).length / snap.readings.length;
  assert.equal(naive(complete.snapshot), 0.375);
  assert.equal(naive(gappy.snapshot), 0.375, 'collapsed, the two scans are indistinguishable: both "37% visible"');

  // What Falloff prints.
  const va = visibility(complete.snapshot.readings);
  const vb = visibility(gappy.snapshot.readings);
  assert.deepEqual({ found: va.found, measured: va.measured, unreached: va.unreached }, { found: 30, measured: total, unreached: 0 });
  assert.deepEqual({ found: vb.found, measured: vb.measured, unreached: vb.unreached }, { found: 30, measured: 50, unreached: 30 });
  assert.notEqual(va.measured, vb.measured);
  assert.equal(va.share, 0.375);
  assert.equal(vb.share, 0.6, 'of what was measured, 30/50');
  assert.equal(va.note, null);
  assert.match(vb.note, /30 point\(s\) never measured/);

  // And only the complete one may publish.
  assert.equal(complete.audit.ok, true, JSON.stringify(complete.audit.findings));
  assert.equal(gappy.audit.ok, false);
  assert.ok(gappy.audit.findings.some((f) => f.id === 'B4' && f.level === 'CRITICAL'));
});

test('a ring that lost most of its points to failures stops being reportable instead of reporting a confident share', async () => {
  const plan = samplePlan({ ...TARGET, preset: 'mid' });
  // Fail four of the six points on the 3.9 km ring (call indices 7..12 are ring 2).
  const ring2 = plan.points.map((p, i) => (p.ring === 2 ? i : -1)).filter((i) => i >= 0);
  const { snapshot, audit: a } = await run(discProvider(20, new Set(ring2.slice(0, 4))));
  const ring = byRing(snapshot.readings).find((r) => r.ring === 2);
  assert.equal(ring.measured, 2);
  assert.equal(ring.unreached, 4);
  assert.equal(ring.reliable, false);
  assert.match(ring.note, /only 2 measured point\(s\); needs 4/);
  assert.ok(a.findings.some((f) => f.id === 'F2' && /3\.9 km/.test(f.message)));
  // The edge walk skips the unreportable ring rather than stopping at it.
  assert.equal(reachEdge(snapshot.readings).dKm, 15.4);
});
