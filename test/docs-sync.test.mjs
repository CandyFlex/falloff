/**
 * The showcase page runs the real code. This test is what makes that
 * sentence true: docs/lib/ must be a byte-for-byte copy of the browser-safe
 * part of src/, with nothing missing and nothing extra, and the copy must
 * load and compute on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { diff, browserSafeFiles, SRC, LIB } from '../scripts/sync-docs.mjs';

test('docs/lib is byte-for-byte the browser-safe part of src (run: node scripts/sync-docs.mjs)', () => {
  const d = diff();
  assert.deepEqual(d.missing, [], 'files missing from docs/lib');
  assert.deepEqual(d.different, [], 'files that differ from src');
  assert.deepEqual(d.stale, [], 'files in docs/lib that are not in src');
  for (const f of browserSafeFiles()) {
    assert.ok(readFileSync(join(SRC, f)).equals(readFileSync(join(LIB, f))), f);
  }
});

test('the browser-safe set is what the page needs, and excludes src/node', () => {
  const files = browserSafeFiles();
  for (const need of ['index.mjs', 'sample.mjs', 'schema.mjs', 'metrics.mjs', 'audit.mjs', 'scan.mjs', 'render.mjs', 'redact.mjs', 'providers/index.mjs']) {
    assert.ok(files.includes(need), need);
  }
  assert.ok(!files.some((f) => f.startsWith('node/')), 'src/node must not be copied');
});

test('no browser-safe module imports a node builtin or reaches into src/node', () => {
  for (const f of browserSafeFiles()) {
    const text = readFileSync(join(SRC, f), 'utf8');
    const specs = [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const s of specs) {
      assert.ok(!s.startsWith('node:'), `${f} imports ${s}`);
      assert.ok(!/(^|\/)node\//.test(s), `${f} imports ${s}`);
      assert.ok(s.startsWith('./') || s.startsWith('../'), `${f} imports a bare specifier: ${s}`);
    }
    assert.ok(!/\bprocess\.|\brequire\(|\bBuffer\b/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${f} uses a node global`);
  }
});

test('the copy loads on its own and computes the same plan as src', async () => {
  const lib = await import(pathToFileURL(join(LIB, 'index.mjs')).href);
  const src = await import(pathToFileURL(join(SRC, 'index.mjs')).href);
  const a = lib.samplePlan({ lat: 25.8104, lng: -80.2037, preset: 'mid' });
  const b = src.samplePlan({ lat: 25.8104, lng: -80.2037, preset: 'mid' });
  assert.deepEqual(a, b);
  assert.equal(typeof lib.audit, 'function');
  assert.equal(typeof lib.summarise, 'function');
});
