/**
 * The guard against publishing a real business, written so that it runs in CI.
 *
 * The old guard read the names out of `studies/private/`, which is never
 * committed, so on every machine but the author's it printed SKIP and proved
 * nothing. It also only looked under `docs/`, and it matched the names
 * verbatim, so slug residue such as `withheld-food-truck` walked straight
 * through it.
 *
 * This one is structural. It needs no private file and no name list: it
 * asserts the SHAPE a published file has to have, over every tracked file in
 * the repository. A real name cannot be in a published snapshot if there is
 * no name key in one, and an id cannot be walked back to a listing if every
 * id is a salted hash.
 *
 * The private files are still checked when they happen to be present, as a
 * second opinion, but nothing here depends on them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { collectNames } from '../src/redact.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRIVATE = join(ROOT, 'studies', 'private');
const TEXT = /\.(html|css|js|mjs|json|svg|txt|md|yml|yaml)$/;

/** Every file git tracks. Works in a fresh clone; needs nothing untracked. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

/** Every tracked snapshot: the studies, the tampered example, the fixtures. */
function trackedSnapshots() {
  return trackedFiles()
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, json: JSON.parse(readFileSync(join(ROOT, f), 'utf8')) }))
    .filter(({ json }) => json?.schema === 'falloff/snapshot@1');
}

test('there are tracked snapshots to check, or this file proves nothing', () => {
  assert.ok(trackedSnapshots().length >= 3, 'expected the two studies and the tampered example');
});

test('every tracked snapshot has its target name withheld', () => {
  for (const { file, json } of trackedSnapshots()) {
    assert.equal(json.target?.name, 'withheld', file);
  }
});

test('no tracked snapshot has a name key on any result row', () => {
  for (const { file, json } of trackedSnapshots()) {
    for (const r of json.readings ?? []) {
      for (const b of r.results ?? []) {
        assert.ok(!Object.prototype.hasOwnProperty.call(b, 'name'), `${file}: a result row carries a name`);
      }
    }
  }
});

test('every id in a tracked snapshot is a salted hash', () => {
  const shape = /^h:[0-9a-f]{16}$/;
  for (const { file, json } of trackedSnapshots()) {
    if (json.target?.id) assert.match(json.target.id, shape, `${file}: target.id`);
    for (const r of json.readings ?? []) {
      for (const b of r.results ?? []) {
        if (b?.id) assert.match(b.id, shape, `${file}: a result id is not hashed`);
      }
    }
  }
});

test('no tracked snapshot publishes a centre finer than two decimal places', () => {
  const decimals = (x) => (String(x).split('.')[1] ?? '').length;
  for (const { file, json } of trackedSnapshots()) {
    const home = (json.readings ?? []).find((r) => r.ring === 0);
    for (const [what, v] of [
      ['target.lat', json.target?.lat],
      ['target.lng', json.target?.lng],
      ['home.lat', home?.lat],
      ['home.lng', home?.lng],
    ]) {
      if (v === undefined) continue;
      assert.ok(decimals(v) <= 2, `${file}: ${what} is ${v}, which is finer than 0.01 degrees`);
    }
  }
});

test('no tracked file carries a source file slug from the private scanner', () => {
  // A scrubbed file name that still read "food truck" passed the old
  // name-based scrub and went to the page. The only slug allowed in a
  // published command is none at all.
  const slug = /grid-[a-z0-9][a-z0-9-]*__/g;
  const hits = [];
  for (const f of trackedFiles()) {
    if (!TEXT.test(f)) continue;
    if (f === 'test/leak.test.mjs') continue; // this file names the pattern
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const m of text.match(slug) ?? []) hits.push(`${f}: ${m}`);
  }
  assert.deepEqual(hits, []);
});

test('no salt is tracked', () => {
  assert.deepEqual(trackedFiles().filter((f) => f.endsWith('.salt')), []);
  assert.deepEqual(trackedFiles().filter((f) => f.startsWith('studies/private/')), []);
});

test('when the private studies are present, none of their names is in a tracked file', (t) => {
  // A second opinion, not the guard. It runs on the author's machine only.
  if (!existsSync(PRIVATE)) return t.skip('studies/private/ is not present (it is never committed)');
  const names = new Set();
  for (const f of readdirSync(PRIVATE).filter((x) => x.endsWith('.json'))) {
    for (const n of collectNames(JSON.parse(readFileSync(join(PRIVATE, f), 'utf8')))) {
      if (n.trim().length >= 4) names.add(n.trim().toLowerCase());
    }
  }
  assert.ok(names.size > 0, 'no names were collected, so this test would prove nothing');
  const hits = [];
  for (const f of trackedFiles()) {
    if (!TEXT.test(f)) continue;
    const text = readFileSync(join(ROOT, f), 'utf8').toLowerCase();
    for (const n of names) if (text.includes(n)) hits.push(`${f}: ${n}`);
  }
  assert.deepEqual(hits, []);
});

test('when the private studies are present, no published id matches a private one', (t) => {
  if (!existsSync(PRIVATE)) return t.skip('studies/private/ is not present (it is never committed)');
  const ids = new Set();
  for (const f of readdirSync(PRIVATE).filter((x) => x.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(join(PRIVATE, f), 'utf8'));
    if (json.target?.id) ids.add(json.target.id);
    for (const r of json.readings ?? []) for (const b of r.results ?? []) if (b?.id) ids.add(b.id);
  }
  assert.ok(ids.size > 100, 'expected the private conversions to carry hundreds of ids');
  const hits = [];
  for (const f of trackedFiles()) {
    if (!TEXT.test(f)) continue;
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const id of ids) if (text.includes(id)) hits.push(`${f}: ${id}`);
  }
  assert.deepEqual(hits, []);
});
