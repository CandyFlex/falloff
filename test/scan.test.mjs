/**
 * Tests for the runner's failure policy.
 *
 * This is the file that matters most. Everything else in Falloff is
 * arithmetic; this is where a failure either becomes an honest UNREACHED or
 * silently becomes a zero that corrupts every figure downstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scan } from '../src/scan.mjs';
import { FOUND, ABSENT, UNREACHED, tally } from '../src/schema.mjs';
import { visibility } from '../src/metrics.mjs';
import { locateTarget } from '../src/providers/index.mjs';

const TARGET = { name: 'Example Dental Studio', id: 'p-target', lat: 25.8104, lng: -80.2037 };
const BASE = { target: TARGET, query: 'dentist', preset: 'tight', command: 'falloff scan --test' };

/** A provider whose behaviour is decided per call by `behave(callIndex)`. */
function fakeProvider(behave, opts = {}) {
  let calls = 0;
  return {
    id: 'fake',
    version: '1',
    pacingMs: 0,
    ...opts,
    async query() {
      const out = behave(calls++);
      if (out instanceof Error) throw out;
      return { results: out };
    },
  };
}

const HIT = [{ id: 'p-target', name: 'Example Dental Studio' }, { id: 'p-other', name: 'Someone Else' }];
const MISS = [{ id: 'p-other', name: 'Someone Else' }];

test('a provider that throws produces UNREACHED with a reason, not ABSENT', async () => {
  const provider = fakeProvider(() => new Error('quota exhausted'));
  const { snapshot, audit: a } = await scan({ ...BASE, provider });

  const t = tally(snapshot.readings);
  assert.equal(t.found, 0);
  assert.equal(t.absent, 0, 'a failure must never be recorded as a measured absence');
  assert.equal(t.unreached, snapshot.readings.length);
  for (const r of snapshot.readings) {
    assert.equal(r.status, UNREACHED);
    assert.match(r.error, /quota exhausted/);
  }
  assert.equal(a.ok, false, 'a fully-unreached scan cannot pass audit');
  assert.ok(a.findings.some((f) => f.id === 'B4'));
});

test('an empty result list is a measured absence', async () => {
  const provider = fakeProvider(() => []);
  const { snapshot } = await scan({ ...BASE, provider });
  const t = tally(snapshot.readings);
  assert.equal(t.absent, snapshot.readings.length);
  assert.equal(t.unreached, 0, 'empty means measured-and-not-there, not failed');
});

test('the two cases produce different numbers from the same point count', async () => {
  const total = 60;
  const half = Math.floor(total / 2);

  // Scan A: half the points genuinely found nothing.
  const { snapshot: absentScan } = await scan({
    ...BASE,
    provider: fakeProvider((i) => (i < half ? HIT : MISS)),
  });
  // Scan B: half the points never got measured.
  const { snapshot: failedScan } = await scan({
    ...BASE,
    provider: fakeProvider((i) => (i < half ? HIT : new Error('blocked'))),
  });

  const a = visibility(absentScan.readings);
  const b = visibility(failedScan.readings);

  assert.equal(a.found, b.found, 'both saw the same number of sightings');
  assert.ok(a.measured > b.measured, 'the failed scan measured fewer points');
  assert.ok(
    b.share > a.share,
    `a scan with gaps must not report the same visibility as one that measured and found nothing ` +
      `(absent scan ${a.share}, failed scan ${b.share})`,
  );
  assert.equal(b.unreached, absentScan.readings.length - half);
  assert.match(b.note, /never measured/);
});

test('found points carry a real rank', async () => {
  const provider = fakeProvider(() => HIT);
  const { snapshot } = await scan({ ...BASE, provider });
  for (const r of snapshot.readings) {
    assert.equal(r.status, FOUND);
    assert.equal(r.rank, 1);
    assert.equal(r.inPack, true);
  }
});

test('a clean scan passes its own audit', async () => {
  const provider = fakeProvider((i) => (i < 40 ? HIT : MISS));
  const { audit: a } = await scan({ ...BASE, provider });
  assert.equal(a.ok, true, JSON.stringify(a.findings, null, 2));
});

test('an abort records the remainder as unreached instead of truncating', async () => {
  const ctl = new AbortController();
  let seen = 0;
  const provider = fakeProvider(() => {
    if (++seen === 10) ctl.abort();
    return HIT;
  });
  const { snapshot } = await scan({ ...BASE, provider, signal: ctl.signal });

  assert.equal(
    snapshot.readings.length,
    snapshot.method.budget,
    'a truncated snapshot would silently change every denominator',
  );
  const t = tally(snapshot.readings);
  assert.ok(t.unreached > 0);
  assert.ok(
    snapshot.readings.filter((r) => r.status === UNREACHED).every((r) => r.error === 'aborted'),
    'aborted points must say so',
  );
});

test('scan refuses to run without a reproduce command', async () => {
  const provider = fakeProvider(() => HIT);
  await assert.rejects(
    scan({ ...BASE, provider, command: undefined }),
    /command is required/,
  );
});

test('scan refuses an invalid provider', async () => {
  await assert.rejects(scan({ ...BASE, provider: { id: 'x' } }), /invalid provider/);
  await assert.rejects(scan({ ...BASE, provider: null }), /invalid provider/);
});

test('the snapshot records which provider produced it', async () => {
  const provider = fakeProvider(() => HIT);
  const { snapshot } = await scan({ ...BASE, provider });
  assert.equal(snapshot.provider.id, 'fake');
  assert.equal(snapshot.method.provider, 'fake');
});

test('progress is reported for every point', async () => {
  const provider = fakeProvider(() => MISS);
  const seen = [];
  const { snapshot } = await scan({ ...BASE, provider, onPoint: (p) => seen.push(p) });
  assert.equal(seen.length, snapshot.readings.length);
  assert.equal(seen[seen.length - 1].done, seen[seen.length - 1].total);
});

/* ---------------- identity ---------------- */

test('a target with an id never falls back to name matching', () => {
  // The failure this prevents: a competitor with a similar name silently
  // donating their rank to the target.
  const results = [{ id: 'p-other', name: 'Example Dental Studio' }];
  assert.equal(
    locateTarget(results, { id: 'p-target', name: 'Example Dental Studio' }),
    null,
    'same name, different id, must be absent',
  );
});

test('name matching is used only when there is no id, and normalises', () => {
  const results = [{ name: 'The Example Dental Studio Co.' }];
  assert.equal(locateTarget(results, { name: 'Example Dental Studio' }), 1);
});

test('name matching does not match a different business', () => {
  const results = [{ name: 'Example Ink Landscaping' }];
  assert.equal(locateTarget(results, { name: 'Example Dental Studio' }), null);
});
