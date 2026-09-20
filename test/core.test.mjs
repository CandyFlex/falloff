/**
 * Tests for the parts that carry claims: the sampler, the absent/unreached
 * distinction, and the auditor's ability to catch a snapshot that lies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { samplePlan, ringLadder, allocatePoints, PRESETS, MIN_RING_POINTS } from '../src/sample.mjs';
import { reading, snapshot, tally, FOUND, ABSENT, UNREACHED } from '../src/schema.mjs';
import { visibility, packShare, byRing, reachEdge, goneBy, archetype } from '../src/metrics.mjs';
import { audit } from '../src/audit.mjs';

// An arbitrary centre in the northern hemisphere. Nothing here depends on
// the place: the assertions below are geometry, not a business.
const CENTRE = { lat: 25.8104, lng: -80.2037 };

/* ---------------- sampler ---------------- */

test('ring ladder is geometric and spans rmin..rmax', () => {
  const rings = ringLadder(2.5, 60);
  assert.equal(rings[0], 2.5);
  assert.equal(rings[rings.length - 1], 60);
  for (let i = 1; i < rings.length; i++) assert.ok(rings[i] > rings[i - 1], 'ascending');
});

test('ring ladder rejects impossible bounds', () => {
  assert.throws(() => ringLadder(0, 10));
  assert.throws(() => ringLadder(10, 5));
});

test('point allocation hits the budget exactly and never starves a ring', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const rings = ringLadder(p.rmin, p.rmax);
    const counts = allocatePoints(rings, p.points);
    const sum = counts.reduce((a, b) => a + b, 0);
    assert.equal(sum, p.points - 1, `${name}: allocation must sum to budget - 1 (home point)`);
    for (const c of counts) assert.ok(c >= MIN_RING_POINTS, `${name}: no ring below ${MIN_RING_POINTS}`);
  }
});

test('allocation refuses a budget it cannot honour', () => {
  const rings = ringLadder(2.5, 60);
  assert.throws(() => allocatePoints(rings, 10), /cannot cover/);
});

test('sample plan is deterministic', () => {
  const a = samplePlan({ ...CENTRE, preset: 'mid' });
  const b = samplePlan({ ...CENTRE, preset: 'mid' });
  assert.deepEqual(a.points, b.points, 'same inputs must give byte-identical points');
});

test('sample plan records every pin needed to reproduce it', () => {
  const { method } = samplePlan({ ...CENTRE, preset: 'tight' });
  for (const pin of ['sampler', 'rmin', 'rmax', 'budget', 'growth', 'goldenAngle', 'ringRadiiKm']) {
    assert.ok(method[pin] !== undefined, `method must pin ${pin}`);
  }
});

test('golden-angle stagger keeps rings out of alignment', () => {
  const { points } = samplePlan({ ...CENTRE, preset: 'mid' });
  const r1 = points.filter((p) => p.ring === 1).map((p) => p.bearing);
  const r2 = points.filter((p) => p.ring === 2).map((p) => p.bearing);
  const shared = r1.filter((b) => r2.some((c) => Math.abs(b - c) < 0.5));
  assert.ok(shared.length <= 1, `rings should not share bearings, shared ${shared.length}`);
});

/* ---------------- the distinction ---------------- */

test('a reading cannot be ABSENT and carry a rank', () => {
  const p = samplePlan({ ...CENTRE }).points[1];
  assert.throws(() => reading({ point: p, status: ABSENT, rank: 4 }), /only FOUND/);
});

test('UNREACHED must say why', () => {
  const p = samplePlan({ ...CENTRE }).points[1];
  assert.throws(() => reading({ point: p, status: UNREACHED }), /must record why/);
});

test('FOUND requires a real rank', () => {
  const p = samplePlan({ ...CENTRE }).points[1];
  assert.throws(() => reading({ point: p, status: FOUND, rank: 0 }), /integer rank/);
});

test('unreached points stay out of the denominator', () => {
  const pts = samplePlan({ ...CENTRE, preset: 'tight' }).points.slice(0, 10);
  const rs = pts.map((p, i) =>
    i < 3
      ? reading({ point: p, status: FOUND, rank: 2 })
      : i < 6
        ? reading({ point: p, status: ABSENT })
        : reading({ point: p, status: UNREACHED, error: 'timeout' }),
  );
  const v = visibility(rs);
  assert.equal(v.found, 3);
  assert.equal(v.measured, 6, 'denominator excludes the 4 unreached');
  assert.equal(v.unreached, 4);
  assert.equal(v.share, 0.5, '3 of 6 measured, not 3 of 10');
  assert.match(v.note, /never measured/);
});

test('tally accounts for every reading', () => {
  const pts = samplePlan({ ...CENTRE, preset: 'tight' }).points.slice(0, 8);
  const rs = pts.map((p, i) =>
    i % 2 ? reading({ point: p, status: ABSENT }) : reading({ point: p, status: FOUND, rank: 1 }),
  );
  const t = tally(rs);
  assert.equal(t.found + t.absent + t.unreached, t.total);
});

/* ---------------- metrics honesty ---------------- */

test('a thin ring is marked unreliable rather than reported', () => {
  const pts = samplePlan({ ...CENTRE, preset: 'tight' }).points;
  const rs = [
    reading({ point: pts[0], status: FOUND, rank: 1 }),
    reading({ point: pts[1], status: FOUND, rank: 1 }),
  ];
  const ring = byRing(rs).find((r) => r.ring === 1);
  assert.equal(ring.reliable, false);
  assert.match(ring.note, /needs 4/);
});

test('goneBy finds the first fully-absent ring', () => {
  const plan = samplePlan({ ...CENTRE, preset: 'tight' });
  const rs = plan.points.map((p) =>
    p.dKm <= 5 ? reading({ point: p, status: FOUND, rank: 2 }) : reading({ point: p, status: ABSENT }),
  );
  const g = goneBy(rs);
  assert.ok(g && g.dKm > 5, 'should report the first ring with no sightings');
});

/* ---------------- the auditor catches lies ---------------- */

function buildSnapshot(readings, plan, overrides = {}) {
  return snapshot({
    target: { name: 'Test Co', lat: CENTRE.lat, lng: CENTRE.lng },
    query: 'dentist',
    plan,
    readings,
    provider: { id: 'test', version: '1' },
    command: 'falloff scan --test',
    startedAt: '2026-09-19T00:00:00Z',
    finishedAt: '2026-09-19T00:05:00Z',
    ...overrides,
  });
}

function cleanSnapshot() {
  const plan = samplePlan({ ...CENTRE, preset: 'tight' });
  const rs = plan.points.map((p) =>
    p.dKm <= 6 ? reading({ point: p, status: FOUND, rank: 2 }) : reading({ point: p, status: ABSENT }),
  );
  return buildSnapshot(rs, plan);
}

test('a clean snapshot passes', () => {
  const r = audit(cleanSnapshot());
  assert.equal(r.ok, true, JSON.stringify(r.findings, null, 2));
});

test('audit fails a snapshot with no reproduce command', () => {
  assert.throws(() => {
    const plan = samplePlan({ ...CENTRE, preset: 'tight' });
    buildSnapshot([], plan, { command: undefined });
  }, /reproduce/);
});

test('audit fails when too many points are unreached', () => {
  const plan = samplePlan({ ...CENTRE, preset: 'tight' });
  const rs = plan.points.map((p, i) =>
    i % 3 === 0
      ? reading({ point: p, status: FOUND, rank: 1 })
      : reading({ point: p, status: UNREACHED, error: 'blocked' }),
  );
  const r = audit(buildSnapshot(rs, plan));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.id === 'B4'), 'should flag the gap rate');
});

test('[tamper] audit catches a forged rank on an absent point', () => {
  const snap = cleanSnapshot();
  snap.readings[5].rank = 1; // tamper: ABSENT now claims a rank
  snap.readings[5].status = ABSENT;
  const r = audit(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.id === 'C2'));
});

test('[tamper] audit catches points that do not match their own method pins', () => {
  const snap = cleanSnapshot();
  snap.readings[3].lat += 0.5; // tamper: move a point
  const r = audit(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.id === 'D4'), 'geometry replay should catch drift');
});

test('[tamper] audit catches a doctored method pin', () => {
  const snap = cleanSnapshot();
  snap.method.rmax = 999; // tamper: claim a different reach
  const r = audit(snap);
  assert.equal(r.ok, false);
  assert.ok(
    r.findings.some((f) => ['D2', 'D3', 'D4'].includes(f.id)),
    'any of D2/D3/D4 proves the pins do not match the data',
  );
});

test('[tamper] audit catches an unexplained gap', () => {
  const snap = cleanSnapshot();
  snap.readings[4].status = UNREACHED;
  snap.readings[4].rank = null;
  snap.readings[4].error = null;
  const r = audit(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.id === 'C3'));
});

/* ---------------- geometry pins ---------------- */

test('the default mid plan is unchanged by the kmPerDegLat pin (first and last point pinned to 1e-9)', () => {
  // Recorded from the plan produced before kmPerDegLat became a parameter.
  // If these move, every existing snapshot stops replaying, so the centre
  // below is the one the values were recorded at and must not be changed.
  // It is a coordinate pair and nothing else: no place and no business.
  const PINNED_CENTRE = { lat: 25.8104, lng: -80.2037 };
  const { points, method } = samplePlan({ ...PINNED_CENTRE, preset: 'mid' });
  assert.equal(points.length, 80);
  const first = points[0];
  const second = points[1];
  const last = points[points.length - 1];
  assert.equal(first.ring, 0);
  assert.ok(Math.abs(first.lat - 25.8104) < 1e-9 && Math.abs(first.lng - -80.2037) < 1e-9);
  assert.ok(Math.abs(second.lat - 25.83300929332393) < 1e-9, `second.lat ${second.lat}`);
  assert.ok(Math.abs(second.lng - -80.2037) < 1e-9, `second.lng ${second.lng}`);
  assert.equal(last.ring, 8);
  assert.equal(last.index, 17);
  assert.ok(Math.abs(last.lat - 25.41067594639788) < 1e-9, `last.lat ${last.lat}`);
  assert.ok(Math.abs(last.lng - -80.60859429365159) < 1e-9, `last.lng ${last.lng}`);
  assert.equal(method.kmPerDegLat, 110.574);
  assert.equal(method.kmPerDegLngEquator, 111.32);
  assert.equal(method.lngScale, 'cos-lat');
  assert.equal(method.sampler, 'radial-v2');
});

test('a plan made with another latitude constant records it and replays under audit', () => {
  const plan = samplePlan({ ...CENTRE, preset: 'tight', kmPerDegLat: 110.57 });
  assert.equal(plan.method.kmPerDegLat, 110.57);
  const rs = plan.points.map((p) => reading({ point: p, status: ABSENT }));
  const r = audit(buildSnapshot(rs, plan));
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.ok(!r.findings.some((f) => f.id === 'D4'), 'replay must use the recorded pin');
});

test('[tamper] audit catches a doctored latitude pin (tamper: 110.574 -> 110.584)', () => {
  const snap = cleanSnapshot();
  snap.method.kmPerDegLat += 0.01;
  const r = audit(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.id === 'D4'), 'the pin is part of the geometry; changing it must fail D4');
});

test('[tamper] audit catches a rank that does not match the recorded result list (tamper: rank 2 -> 1)', () => {
  const plan = samplePlan({ ...CENTRE, preset: 'tight' });
  const results = [{ id: 'other', name: 'Other' }, { id: 't', name: 'Test Co' }];
  const rs = plan.points.map((p) => reading({ point: p, status: FOUND, rank: 2, results, listDepth: 2 }));
  const snap = buildSnapshot(rs, plan, { target: { name: 'Test Co', id: 't', lat: CENTRE.lat, lng: CENTRE.lng } });
  assert.equal(audit(snap).ok, true);
  snap.readings[7].rank = 1;
  const r = audit(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.id === 'C6'));
});

test('a scan with no sightings on any reportable ring is shaped "absent", not "weak-core"', () => {
  const plan = samplePlan({ ...CENTRE, preset: 'mid' });
  const none = plan.points.map((p) => reading({ point: p, status: ABSENT }));
  assert.equal(archetype(none).archetype, 'absent');
  const homeOnly = plan.points.map((p) => (p.ring === 0 ? reading({ point: p, status: FOUND, rank: 1 }) : reading({ point: p, status: ABSENT })));
  assert.equal(archetype(homeOnly).archetype, 'absent', 'the home point alone is not a reportable ring');
  const one = plan.points.map((p) => (p.ring === 1 && p.index === 0 ? reading({ point: p, status: FOUND, rank: 9 }) : reading({ point: p, status: ABSENT })));
  assert.equal(archetype(one).archetype, 'weak-core');
});
