/**
 * Tests for the legacy converter.
 *
 * The fixture is a real 80-point scan (names withheld, ids and coordinates
 * kept) produced by the older browser-driven scanner with 110.57 km per
 * degree of latitude. The converter must replay it exactly, keep failures
 * as failures, and refuse anything that does not land on the geometry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { convertGridScan, LEGACY_KM_PER_DEG_LAT } from '../src/node/convert-grid-scan.mjs';
import { audit } from '../src/audit.mjs';
import { FOUND, ABSENT, UNREACHED, tally } from '../src/schema.mjs';
import { KM_PER_DEG_LAT } from '../src/sample.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/legacy-grid-scan.json', import.meta.url));
const load = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const OPTS = { basename: 'legacy-grid-scan.json', convertedAt: '2026-09-19T00:00:00.000Z' };

test('the real legacy scan converts: 80 readings, 24 found, 0 unreached, ring counts 1/6/6/6/6/8/12/17/18', () => {
  const snap = convertGridScan(load(), OPTS);
  assert.equal(snap.schema, 'falloff/snapshot@1');
  assert.equal(snap.readings.length, 80);
  const t = tally(snap.readings);
  assert.equal(t.found, 24);
  assert.equal(t.unreached, 0);
  assert.equal(t.absent, 56);
  const perRing = [];
  for (const r of snap.readings) perRing[r.ring] = (perRing[r.ring] ?? 0) + 1;
  assert.deepEqual(perRing, [1, 6, 6, 6, 6, 8, 12, 17, 18]);
});

test('the converted snapshot passes audit on the legacy earth constant', () => {
  const snap = convertGridScan(load(), OPTS);
  assert.equal(snap.method.kmPerDegLat, LEGACY_KM_PER_DEG_LAT);
  assert.notEqual(snap.method.kmPerDegLat, KM_PER_DEG_LAT, 'the pin must be the legacy one, not the default');
  const r = audit(snap);
  assert.equal(r.ok, true, JSON.stringify(r.findings, null, 2));
  assert.ok(!r.findings.some((f) => f.id === 'D4'));
});

test('[tamper] replaying the same snapshot with the default constant would fail D4 (this is why the pin exists)', () => {
  const snap = convertGridScan(load(), OPTS);
  delete snap.method.kmPerDegLat; // pretend the pin was never recorded
  const r = audit(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.id === 'D4'));
});

test('bearing and label are recomputed and match the legacy label at every point', () => {
  const legacy = load();
  const snap = convertGridScan(legacy, OPTS);
  const byKey = new Map(legacy.results.map((row) => [`${row.row}:${row.col}`, row]));
  for (const r of snap.readings) {
    const row = byKey.get(`${r.ring}:${r.index}`);
    assert.ok(row, `legacy row for ${r.ring}:${r.index}`);
    assert.equal(r.label, row.label);
    if (r.ring === 0) assert.equal(r.bearing, null);
    else assert.ok(Number.isFinite(r.bearing) && r.bearing >= 0 && r.bearing < 360);
  }
});

test('provider, method, provenance, command and timestamps are recorded as the converter promises', () => {
  const legacy = load();
  const snap = convertGridScan(legacy, OPTS);
  assert.deepEqual(snap.provider, { id: 'google-maps-web', version: 'grid-scan radial-v2 @13z' });
  assert.equal(snap.method.preset, 'mid');
  assert.equal(snap.method.observation.zoom, '13z');
  assert.equal(snap.method.observation.surface, 'maps-feed');
  assert.equal(snap.method.observation.loggedOut, true);
  assert.equal(snap.method.observation.passes, 1);
  assert.equal(snap.command, 'falloff convert legacy-grid-scan.json');
  assert.equal(snap.startedAt, legacy.pulled);
  assert.equal(snap.finishedAt, null, 'the source records one timestamp, so the end of the scan is not known');
  assert.match(snap.provenance.observationWindow, /unknown/);
  assert.match(snap.provenance.source, /not in this repository/);
  assert.equal(snap.provenance.observedAt, legacy.pulled);
  assert.equal(snap.provenance.convertedAt, OPTS.convertedAt);
  assert.equal(snap.provenance.converter, 'falloff/convert@1');
  assert.match(snap.provenance.note, /logged-out desktop browser at zoom 13/);
  assert.equal(snap.provenance.rankColumnDisagreements, 0, 'this file carries pid-first-v2; column and pack agree');
  assert.equal(snap.target.id, legacy.target.pid);
  assert.equal(snap.target.lat, legacy.target.lat);
});

test('results are carried in rank order with id from the place id', () => {
  const legacy = load();
  const snap = convertGridScan(legacy, OPTS);
  const found = snap.readings.find((r) => r.status === FOUND);
  const row = legacy.results.find((x) => x.row === found.ring && x.col === found.index);
  assert.equal(found.results.length, row.businesses.length);
  found.results.forEach((b, i) => {
    assert.equal(b.id, row.businesses[i].pid);
    assert.equal(b.rating, row.businesses[i].rating ?? null);
    assert.equal(b.reviews, row.businesses[i].reviews ?? null);
  });
  assert.equal(found.results[found.rank - 1].id, snap.target.id, 'the rank points at the target');
});

test('a legacy row marked unreachable becomes UNREACHED with its reason, never ABSENT', () => {
  const legacy = load();
  const doctored = legacy.results.find((x) => x.row === 3 && x.col === 2);
  delete doctored.businesses;
  delete doctored.count;
  doctored.rank = undefined;
  doctored.error = 'page.goto: Timeout 45000ms exceeded';
  doctored.unreachable = true;

  const snap = convertGridScan(legacy, OPTS);
  const r = snap.readings.find((x) => x.ring === 3 && x.index === 2);
  assert.equal(r.status, UNREACHED);
  assert.equal(r.error, 'page.goto: Timeout 45000ms exceeded');
  assert.equal(r.rank, null);
  assert.deepEqual(r.results, []);
  const t = tally(snap.readings);
  assert.equal(t.unreached, 1);
  assert.equal(t.absent, 56, 'the absent count must not absorb the failure');
  assert.equal(audit(snap).ok, true);
});

test('an unreachable row with no error still gets an explicit reason (the auditor demands one)', () => {
  const legacy = load();
  const doctored = legacy.results[10];
  delete doctored.businesses;
  doctored.rank = null;
  doctored.unreachable = true;
  const snap = convertGridScan(legacy, OPTS);
  const r = snap.readings[10];
  assert.equal(r.status, UNREACHED);
  assert.equal(r.error, 'unreachable (no reason recorded)');
  assert.equal(snap.provenance.unreachedWithoutReason, 1);
  assert.ok(!audit(snap).findings.some((f) => f.id === 'C3'));
});

test('[tamper] rank is re-derived from the pack by place id; a stated rank the pack does not support is counted, not copied', () => {
  const legacy = load();
  // Tamper: a row where the target is not in the list claims rank 2.
  const row = legacy.results.find((x) => x.rank == null && x.businesses?.length > 2);
  row.rank = 2;
  const snap = convertGridScan(legacy, OPTS);
  const r = snap.readings.find((x) => x.ring === row.row && x.index === row.col);
  assert.equal(r.status, ABSENT, 'a rank the captured list does not show is not a sighting');
  assert.equal(snap.provenance.rankColumnDisagreements, 1);
  assert.equal(audit(snap).ok, true);
});

test('[tamper] a moved legacy coordinate is refused rather than nudged', () => {
  const legacy = load();
  legacy.results[5].lat += 1e-6;
  assert.throws(() => convertGridScan(legacy, OPTS), /refusing rather than moving it/);
});

test('[tamper] a legacy label that does not match the replay is refused', () => {
  const legacy = load();
  legacy.results[5].label = '2.5 km SSW';
  assert.throws(() => convertGridScan(legacy, OPTS), /labelled/);
});

test('[tamper] a file whose row count does not match its preset is refused', () => {
  const legacy = load();
  legacy.results.pop();
  assert.throws(() => convertGridScan(legacy, OPTS), /not produced by this geometry/);
});

test('non-radial and radial-v1 files are refused with a clear message', () => {
  const legacy = load();
  legacy.mode = 'grid';
  assert.throws(() => convertGridScan(legacy, OPTS), /only kind=grid mode=radial/);
  const v1 = load();
  delete v1.preset;
  assert.throws(() => convertGridScan(v1, OPTS), /radial-v1 files have no preset/);
});

test('a multi-pass file without the identity stamp is refused (its median rank cannot be re-derived)', () => {
  const legacy = load();
  legacy.method.passes = 3;
  delete legacy.method.identity;
  assert.throws(() => convertGridScan(legacy, OPTS), /no identity stamp/);
});
