/**
 * The published studies are claims, so they are tested like code.
 *
 * Every committed study must pass audit, must be redacted, must have a
 * report that is exactly what the renderer produces from its snapshot
 * today, and must appear in an INDEX.md that is exactly what the index
 * script would write. A figure that was typed by hand, or a report left
 * behind by an older renderer, fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadStudies, buildIndex } from '../scripts/studies-index.mjs';
import { renderReport } from '../src/render.mjs';
import { audit } from '../src/audit.mjs';
import { tally } from '../src/schema.mjs';

const STUDIES = fileURLToPath(new URL('../studies/', import.meta.url));
const studies = loadStudies();

test('there are committed studies, and every one passes audit with zero critical findings', () => {
  assert.ok(studies.length >= 2, `expected at least 2 studies, found ${studies.length}`);
  for (const s of studies) {
    assert.equal(s.audit.ok, true, `${s.folder}: ${JSON.stringify(s.audit.findings.filter((f) => f.level === 'CRITICAL'))}`);
    const t = tally(s.snap.readings);
    assert.equal(t.total, s.snap.method.budget, `${s.folder}: every planned point has a reading`);
  }
});

test('every study is redacted: no target name, no result names, and the audit says so', () => {
  for (const s of studies) {
    assert.equal(s.snap.target.name, 'withheld', s.folder);
    assert.equal(s.snap.redaction?.schema, 'falloff/redaction@2', s.folder);
    assert.ok(s.snap.readings.every((r) => r.results.every((b) => !('name' in b))), `${s.folder}: a result still has a name`);
    assert.ok(s.audit.findings.some((f) => f.id === 'A5'), s.folder);
    assert.match(s.snap.target.id, /^h:[0-9a-f]{16}$/, `${s.folder}: the id is a salted hash, not a Google feature id`);
    for (const r of s.snap.readings) for (const b of r.results) assert.match(b.id, /^h:[0-9a-f]{16}$/, `${s.folder}: a raw id survived`);
    const decimals = (x) => (String(x).split('.')[1] ?? '').length;
    assert.ok(decimals(s.snap.target.lat) <= 2 && decimals(s.snap.target.lng) <= 2, `${s.folder}: the centre is rounded to 0.01 degrees`);
  }
});

test('no tracked study file carries a descriptor from the source file name', () => {
  // An early study published a file name that still carried the trade
  // description: the name scrub matched the name and left the rest behind.
  for (const s of studies) {
    for (const name of ['snapshot.json', 'report.html', 'README.md', 'study.json']) {
      const text = readFileSync(join(STUDIES, s.folder, name), 'utf8');
      const hits = text.match(/grid-[a-z0-9-]+__/g) ?? [];
      assert.deepEqual(hits, [], `${s.folder}/${name}: a source file slug survived`);
    }
  }
});

test('every report.html is byte-for-byte what the renderer produces from its snapshot', () => {
  for (const s of studies) {
    const onDisk = readFileSync(join(STUDIES, s.folder, 'report.html'), 'utf8');
    assert.equal(onDisk, renderReport(s.snap, audit(s.snap)), `${s.folder}: run node scripts/build-study.mjs --refresh ${s.folder}`);
  }
});

test('every study folder has its generated README with the withheld sentence and the visibility figure', () => {
  for (const s of studies) {
    const readme = readFileSync(join(STUDIES, s.folder, 'README.md'), 'utf8');
    assert.ok(readme.includes('Business name withheld.'), s.folder);
    assert.ok(readme.includes('Withheld is not anonymous'), s.folder);
    assert.ok(readme.includes('automated browser scan written by this'), `${s.folder}: the README says where the readings came from`);
    assert.ok(readme.includes('re-observing these points needs your own provider'), s.folder);
    const v = s.audit.metrics.visibility;
    assert.ok(readme.includes(`${v.found}/${v.measured} measured`), `${s.folder}: README figure does not match the snapshot`);
    assert.ok(readme.includes(s.snap.command), s.folder);
    assert.ok(!/[–—]/.test(readme), `${s.folder}: dash in README`);
  }
});

test('studies/INDEX.md is exactly what the index script generates', () => {
  const file = join(STUDIES, 'INDEX.md');
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8'), buildIndex(studies), 'run: node scripts/studies-index.mjs');
});

test('[tamper] the committed tampered example fails audit for exactly the four edits it documents', () => {
  const snap = JSON.parse(readFileSync(fileURLToPath(new URL('../snapshots/tampered.json', import.meta.url)), 'utf8'));
  const a = audit(snap);
  assert.equal(a.ok, false);
  assert.equal(snap.tampered.edits.length, 4);
  assert.deepEqual(a.findings.filter((f) => f.level === 'CRITICAL').map((f) => f.id), ['A3b', 'C7', 'C2', 'D4']);
  assert.equal(snap.target.name, 'withheld');
});
