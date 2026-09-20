/**
 * Tests for `falloff compare`.
 *
 * The README has claimed since the first draft that individual points move
 * between scans, and nothing in the repository measured it. This is the
 * instrument that would. Its job is to refuse anything that is not the same
 * plan, and then to count without averaging.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compare, formatCompare } from '../src/compare.mjs';
import { scan } from '../src/scan.mjs';

const TARGET = { name: 'Example Dental Co', id: 'p-target', lat: 25.8104, lng: -80.2037 };
const other = (k) => ({ id: `p-${k}`, name: `Invented Shop ${k}` });

/**
 * A scan whose answer at point n is decided by `decide`.
 * @param {(n: number) => ('hit'|'miss'|'fail')} decide
 */
async function pass(decide, { rank = 2, preset = 'tight' } = {}) {
  let n = 0;
  const provider = {
    id: 'fake',
    version: '1',
    pacingMs: 0,
    async query() {
      const what = decide(n++);
      if (what === 'fail') throw new Error('quota');
      const rows = [other(1), other(2), other(3)];
      if (what === 'hit') rows.splice(rank - 1, 0, { id: 'p-target', name: TARGET.name });
      return { results: rows };
    },
  };
  const { snapshot } = await scan({ target: TARGET, query: 'dentist', preset, provider, command: 'falloff scan --test' });
  return snapshot;
}

test('two identical passes agree at every point', async () => {
  const a = await pass((n) => (n < 20 ? 'hit' : 'miss'));
  const b = await pass((n) => (n < 20 ? 'hit' : 'miss'));
  const c = compare(a, b);
  assert.equal(c.counts.bothFound, 20);
  assert.equal(c.counts.bothAbsent, 40);
  assert.equal(c.counts.changed, 0);
  assert.equal(c.counts.eitherUnreached, 0);
  assert.equal(c.agreementShare, 1);
  assert.deepEqual(c.rankChange, [{ delta: 0, points: 20 }]);
});

test('points that flipped are counted and named, and rank movement is a distribution', async () => {
  const a = await pass((n) => (n < 20 ? 'hit' : 'miss'));
  const b = await pass((n) => (n < 18 ? 'hit' : n === 40 ? 'hit' : 'miss'), { rank: 3 });
  const c = compare(a, b);
  assert.equal(c.counts.changed, 3, 'two lost, one gained');
  assert.equal(c.counts.bothFound, 18);
  assert.equal(c.changes.filter((x) => x.from === 'found' && x.to === 'absent').length, 2);
  assert.equal(c.changes.filter((x) => x.from === 'absent' && x.to === 'found').length, 1);
  // Every shared sighting moved from rank 2 to rank 3.
  assert.deepEqual(c.rankChange, [{ delta: 1, points: 18 }]);
  assert.equal(c.rankUnchanged, 0);
});

test('a point unreached in either pass is not agreement and is not a change', async () => {
  const a = await pass((n) => (n === 5 ? 'fail' : n < 20 ? 'hit' : 'miss'));
  const b = await pass((n) => (n < 20 ? 'hit' : 'miss'));
  const c = compare(a, b);
  assert.equal(c.counts.eitherUnreached, 1);
  assert.equal(c.counts.changed, 0, 'a gap is not a flip');
  assert.equal(c.compared, a.readings.length - 1);
  assert.match(formatCompare(c), /either unreached 1 \(not compared, not counted as agreement\)/);
});

test('compare refuses two different queries', async () => {
  const a = await pass(() => 'miss');
  const b = await pass(() => 'miss');
  b.query = 'dentists';
  assert.throws(() => compare(a, b), /the queries differ/);
});

test('compare refuses two different geometries, and names every pin that differs', async () => {
  const a = await pass(() => 'miss', { preset: 'tight' });
  const b = await pass(() => 'miss', { preset: 'mid' });
  assert.throws(() => compare(a, b), /the method pins differ/);
  assert.throws(() => compare(a, b), /rmax 20 vs 60/);

  const doctored = structuredClone(a);
  doctored.method.growth = 1.7;
  assert.throws(() => compare(a, doctored), /growth 1\.55 vs 1\.7/);
});

test('compare refuses a snapshot that is missing points from the other', async () => {
  const a = await pass(() => 'miss');
  const b = structuredClone(a);
  b.readings.splice(4, 1);
  assert.throws(() => compare(a, b), /have no counterpart/);
});

test('the printed comparison carries denominators and no dashes used as separators', async () => {
  const a = await pass((n) => (n < 20 ? 'hit' : 'miss'));
  const b = await pass((n) => (n < 15 ? 'hit' : 'miss'));
  const text = formatCompare(compare(a, b));
  assert.match(text, /both found {7}15\/60 compared/);
  assert.match(text, /changed {10}5\/60 compared/);
  assert.match(text, /agreement {8}92% of compared points/);
  assert.ok(!/[–—]/.test(text), 'en or em dash in the comparison output');
});
