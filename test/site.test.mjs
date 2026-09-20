/**
 * The landing page and the case study type no figures: they assemble every
 * number from docs/site-data.js. So three things have to hold. The data file
 * must be exactly what scripts/build-site-data.mjs writes today. The pages
 * must load nothing from another origin. And the public copy must keep the
 * repository's copy rules (no em or en dashes, no banned words).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildSiteData, siteDataJs } from '../scripts/build-site-data.mjs';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const FILES = ['index.html', 'case-study.html', 'site.css', 'site.mjs', 'case-study.mjs', 'common.mjs', 'draw.mjs'];
const read = (f) => readFileSync(join(DOCS, f), 'utf8');

test('docs/site-data.js is current (run: npm run site-data)', () => {
  assert.equal(read('site-data.js'), siteDataJs(buildSiteData()));
});

test('the site data holds a metro and a quiet study, both passing audit, with no names', () => {
  const d = buildSiteData();
  for (const s of [d.metro, d.quiet]) {
    assert.equal(s.auditOk, true);
    assert.ok(s.field.length > 0 && s.field.filter((r) => r.isTarget).length === 1, 'exactly one target in the field');
    assert.ok(s.field.every((r) => /^Business \d+$/.test(r.label)), 'every business is a number, never a name');
    assert.ok(!Object.keys(s.field[0]).includes('name'));
  }
});

test('the pages load nothing from another origin', () => {
  for (const f of ['index.html', 'case-study.html']) {
    const html = read(f);
    const loads = [...html.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*?(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(loads.length > 0, `${f}: expected local assets`);
    for (const u of loads) assert.ok(!/^(?:https?:)?\/\//.test(u), `${f} loads ${u}`);
  }
  assert.ok(!/url\(\s*['"]?(?:https?:)?\/\//.test(read('site.css')), 'site.css loads a remote file');
  for (const f of ['site.mjs', 'case-study.mjs', 'common.mjs', 'draw.mjs']) {
    assert.ok(!/(?:fetch|import)\s*\(\s*['"`]https?:/.test(read(f)), `${f} fetches a remote file`);
  }
});

test('public copy keeps the copy rules', () => {
  const banned = /\b(seamless|elevate|unleash|revolutioni[sz]e|next-gen|cutting-edge|robust|powerful|effortless|delve|leverage|harness|empower|game-changer)\b/i;
  for (const f of FILES) {
    const text = read(f);
    assert.ok(!/[–—]/.test(text), `${f} contains an em or en dash`);
    assert.ok(!banned.test(text), `${f} contains a banned word: ${text.match(banned)?.[0]}`);
  }
});
