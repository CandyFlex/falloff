/**
 * The showcase page is a published claim, so it is tested like the studies.
 *
 * docs/data.js, the generated blocks in docs/index.html and the report
 * copies in docs/studies/ must be exactly what scripts/build-docs-data.mjs
 * writes today. Nothing under docs/ may carry a business name, load
 * anything from another origin, or use an em or en dash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { build, staleReports } from '../scripts/build-docs-data.mjs';
import { collectNames } from '../src/redact.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const PRIVATE = join(ROOT, 'studies', 'private');
const TEXT = /\.(html|css|js|mjs|json|svg|txt|md)$/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const textFiles = () => walk(DOCS).filter((f) => TEXT.test(f));
const rel = (f) => relative(ROOT, f).split('\\').join('/');

test('docs/data.js, the generated page blocks and the report copies are current (run: npm run docs-data)', async () => {
  const { files, data } = await build();
  for (const [file, text] of Object.entries(files)) {
    assert.ok(existsSync(file), `${rel(file)} is missing`);
    assert.equal(readFileSync(file, 'utf8'), text, `${rel(file)} is stale`);
  }
  assert.deepEqual(staleReports(files).map(rel), [], 'report copies that no study accounts for');
  assert.ok(data.studies.length >= 2);
  assert.ok(data.studies.some((s) => s.folder === data.hero));
});

test('data.js carries no name and no result list, only what the figures need', async () => {
  const { DATA } = await import('../docs/data.js');
  const text = readFileSync(join(DOCS, 'data.js'), 'utf8');
  assert.ok(!/"name"\s*:\s*"(?!tight|mid|regional|wide)/.test(text), 'a name field other than a preset name is in data.js');
  assert.ok(!text.includes('"results"'), 'a result list is in data.js');
  for (const s of DATA.studies) {
    assert.equal(s.redacted, true, s.folder);
    assert.equal(s.points.length, s.budget, `${s.folder}: every planned point is on the page`);
  }
  assert.equal(DATA.tampered.exitCode, 1);
  assert.match(DATA.tampered.output, /FAIL {2}D4 /);
});

test('nothing under docs/ contains a business name from the unredacted studies', (t) => {
  if (!existsSync(PRIVATE)) return t.skip('studies/private/ is not present (it is never committed)');
  const names = new Set();
  for (const f of readdirSync(PRIVATE).filter((x) => x.endsWith('.json'))) {
    for (const n of collectNames(JSON.parse(readFileSync(join(PRIVATE, f), 'utf8')))) names.add(n);
  }
  assert.ok(names.size > 0, 'no names were collected, so this test would prove nothing');
  const hits = [];
  for (const file of textFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const n of names) if (text.includes(n)) hits.push(`${rel(file)}: ${n}`);
  }
  assert.deepEqual(hits, []);
});

test('the page loads nothing from another origin and uses no em or en dash', () => {
  for (const file of textFiles()) {
    if (file.endsWith('LICENSE.txt')) continue;
    const text = readFileSync(file, 'utf8');
    assert.ok(!/[\u2013\u2014]/.test(text), `${rel(file)}: dash`);
    if (file.startsWith(join(DOCS, 'lib'))) continue; // the library names API endpoints; the page never calls them
    const loads = [...text.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']|url\(\s*["']?https?:|@import|import\s*\(?\s*["']https?:|fetch\(/g)]
      .map((m) => m[0])
      .filter((m) => !/^href\s*=\s*["']https:\/\/github\.com\/CandyFlex\/falloff["']$/.test(m));
    assert.deepEqual(loads, [], rel(file));
  }
});
