/**
 * Tests for the HTML report.
 *
 * The report is where figures meet a reader, so these tests check the
 * things a reader relies on: every reading is drawn exactly once, every
 * figure shows its denominator, nothing renders as NaN or undefined, the
 * three statuses have three different marks, a name that was withheld
 * stays withheld, and nothing from the snapshot reaches the page unescaped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderReport } from '../src/render.mjs';
import { scan } from '../src/scan.mjs';
import { audit } from '../src/audit.mjs';
import { redact } from '../src/redact.mjs';
import { summarise } from '../src/metrics.mjs';
import { convertGridScan } from '../src/node/convert-grid-scan.mjs';

const count = (html, re) => (html.match(re) ?? []).length;

const TARGET = { name: 'Example Dental Co', id: 'p-target', lat: 25.8104, lng: -80.2037 };
const HIT = (rank) => {
  const others = [1, 2, 3, 4, 5].map((k) => ({ id: `p-${k}`, name: `Invented Shop ${k}`, rating: 4.5, reviews: 10 }));
  others.splice(rank - 1, 0, { id: 'p-target', name: TARGET.name, rating: 4.9, reviews: 80 });
  return others;
};
const MISS = [{ id: 'p-1', name: 'Invented Shop 1', rating: 4.5, reviews: 10 }];

/** tight preset: 26 found (20 in pack, 6 at rank 5), 2 unreached, 32 absent. */
async function mixedSnapshot(name = TARGET.name) {
  let i = 0;
  const provider = {
    id: 'fake', version: '1', pacingMs: 0, pins: { pointRadiusM: 3000 },
    async query() {
      const n = i++;
      if (n === 30 || n === 45) throw new Error('quota <exhausted> & "blocked"');
      if (n < 20) return { results: HIT(2) };
      if (n < 26) return { results: HIT(5) };
      return { results: MISS };
    },
  };
  const { snapshot } = await scan({ target: { ...TARGET, name }, query: 'dentist', preset: 'tight', provider, command: 'falloff scan --test --preset tight' });
  return snapshot;
}

test('the map draws exactly one marked element per reading', async () => {
  const snap = await mixedSnapshot();
  const html = renderReport(snap, audit(snap));
  assert.equal(count(html, /data-status=/g), snap.readings.length);
  assert.equal(count(html, /data-status="found"/g), 26);
  assert.equal(count(html, /data-status="absent"/g), 32);
  assert.equal(count(html, /data-status="unreached"/g), 2);
});

test('status is encoded by shape as well as colour: four distinct marks', async () => {
  const html = renderReport(await mixedSnapshot());
  assert.equal(count(html, /<circle class="pt found in-pack" data-status/g), 20, 'filled circle');
  assert.equal(count(html, /<circle class="pt found out-pack" data-status/g), 6, 'hollow circle');
  assert.equal(count(html, /<path class="pt absent" data-status/g), 32, 'small x');
  assert.equal(count(html, /<path class="pt unreached" data-status/g), 2, 'hatched diamond');
  assert.match(html, /\.pt\.unreached\{fill:url\(#hatch\)/);
  assert.match(html, /<pattern id="hatch"/);
  assert.match(html, /\.pt\.found\.out-pack\{fill:var\(--panel\)/, 'hollow means the fill is the background');
});

test('every figure is printed with its denominator and the unreached count', async () => {
  const snap = await mixedSnapshot();
  const s = summarise(snap.readings);
  const html = renderReport(snap);
  assert.equal(`${s.visibility.found}/${s.visibility.measured}`, '26/58');
  assert.ok(html.includes('26/58 measured'), 'visibility with denominator');
  assert.ok(html.includes('20/58 measured'), 'pack with denominator');
  assert.ok(html.includes('2 unreached, excluded'));
  for (const r of s.rings) assert.ok(html.includes(`<td>${r.found}/${r.measured}</td>`), `ring ${r.dKm} row`);
});

test('each point has a title with its label, status and rank', async () => {
  const snap = await mixedSnapshot();
  const html = renderReport(snap);
  assert.equal(count(html, /<title>[^<]+<\/title><\/(circle|path)>/g), snap.readings.length);
  assert.ok(html.includes('<title>home: found, rank 2 of 6 captured</title>'));
  assert.ok(html.includes(': absent: measured, not in the 1 row(s) captured here</title>'));
});

test('the page contains no NaN and no undefined, for a mixed scan, an empty scan and an all-unreached scan', async () => {
  const mixed = await mixedSnapshot();
  const allAbsent = (await scan({ target: TARGET, query: 'q', preset: 'tight', command: 'c', provider: { id: 'f', pacingMs: 0, query: async () => ({ results: [] }) } })).snapshot;
  const allFailed = (await scan({ target: TARGET, query: 'q', preset: 'tight', command: 'c', provider: { id: 'f', pacingMs: 0, query: async () => { throw new Error('down'); } } })).snapshot;
  for (const snap of [mixed, allAbsent, allFailed]) {
    const html = renderReport(snap);
    assert.ok(!/NaN/.test(html), 'NaN in output');
    assert.ok(!/undefined/.test(html), 'undefined in output');
    assert.equal(count(html, /data-status=/g), snap.readings.length);
  }
  const failed = renderReport(allFailed);
  assert.ok(failed.includes('not reportable: no point was measured'));
  assert.ok(failed.includes('This snapshot does not pass audit'));
  assert.ok(failed.includes('FAIL: '));
  const absent = renderReport(allAbsent);
  assert.ok(absent.includes('0/60 measured'));
  assert.ok(absent.includes('not reportable: no reportable ring has the business at half or more'));
});

test('a fragile edge is labelled fragile where it is printed', () => {
  const legacy = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/legacy-grid-scan.json', import.meta.url)), 'utf8'));
  const snap = convertGridScan(legacy, { basename: 'legacy-grid-scan.json', convertedAt: '2026-09-19T00:00:00.000Z' });
  const s = summarise(snap.readings);
  assert.equal(s.packEdge.fragile, true, 'fixture has a fragile pack edge');
  const html = renderReport(snap);
  assert.ok(
    html.includes('<tr><th scope="row">top-3 edge</th><td class="val">6.2 km [fragile]</td>'),
    'the top-3 edge is labelled where it is printed',
  );
  assert.equal(s.reachEdge.fragile, true, 'the next ring out is 2/6, whose 95% interval contains the threshold');
  assert.ok(
    html.includes('<tr><th scope="row">reach edge</th><td class="val">6.2 km [fragile]</td>'),
    'a fragile reach edge is labelled too',
  );
  assert.ok(html.includes('95% interval 0.10-0.70'), 'the reason is printed, not just the flag');
  assert.ok(html.includes('24/80 measured'));
  assert.ok(html.includes('WARN</span> <span class="fid">F1</span>'));
});

test('a redacted snapshot renders "name withheld" and shows the redaction block, with no name anywhere', async () => {
  const snap = await mixedSnapshot();
  const pub = redact(snap, { salt: 'z'.repeat(32), at: '2026-09-19T12:00:00.000Z' });
  const html = renderReport(pub, audit(pub));
  assert.ok(html.includes('<h1>name withheld</h1>'));
  assert.ok(html.includes('Business name withheld'));
  assert.ok(html.includes('Withheld is not anonymous'));
  assert.ok(html.includes('falloff/redaction@2'));
  assert.ok(html.includes('<span class="fid">A5</span>'));
  assert.ok(!html.includes('Example Ink'), 'target name leaked');
  assert.ok(!html.includes('Invented Shop'), 'competitor name leaked');
});

test('every string from the snapshot is HTML-escaped', async () => {
  const snap = await mixedSnapshot('<script>alert(1)</script> & "Sons"');
  snap.query = '<img src=x onerror=alert(2)>';
  snap.command = 'falloff scan --name "<b>x</b>"';
  const html = renderReport(snap);
  assert.ok(!html.includes('<script>alert(1)'), 'raw script tag from the name');
  assert.ok(!html.includes('<img src=x'), 'raw tag from the query');
  assert.ok(!html.includes('<b>x</b>'), 'raw tag from the command');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Sons&quot;'));
  assert.ok(html.includes('unreached: quota &lt;exhausted&gt; &amp; &quot;blocked&quot;'), 'error text in a point title');
  assert.equal(count(html, /<script/g), 0, 'the report ships no scripts at all');
});

test('the page is standalone: method pins verbatim, the reproduce command in a pre, light and dark, no external requests, no dashes', async () => {
  const snap = await mixedSnapshot();
  const html = renderReport(snap);
  for (const [k, v] of Object.entries(snap.method)) {
    assert.ok(html.includes(`<th scope="row">${k}</th>`), `method pin ${k}`);
    if (typeof v !== 'object' || v === null) assert.ok(html.includes(`<td>${String(v)}</td>`), `value of ${k}`);
  }
  assert.ok(html.includes('<td>[1.5,2.3,3.6,5.5,8.4,13,20]</td>'), 'array pins as compact JSON');
  assert.ok(html.includes('<pre>falloff scan --test --preset tight</pre>'));
  assert.ok(html.includes('prefers-color-scheme: dark'));
  assert.equal(count(html, /https?:\/\//g), 0, 'no URL of any kind in a report without provenance');
  assert.equal(count(html, /<link /g), 1, 'one link only');
  assert.ok(html.includes('<link rel="icon" href="data:,">'), 'and it is an empty inline icon, so no favicon request');
  assert.equal(count(html, /@import|url\((?!#)/g), 0);
  assert.ok(!/[–—]/.test(html), 'no en or em dashes in a rendered report');
  assert.ok(html.startsWith('<!doctype html>'));
});

test('ring bars are SVG rects whose width is the share found', async () => {
  const html = renderReport(await mixedSnapshot());
  assert.ok(count(html, /<rect class="bar-fg"/g) >= 7);
  assert.ok(html.includes('<rect class="bar-fg" x="0" y="0" width="120.00" height="10"/>'), 'a full ring is a full bar');
  assert.ok(html.includes('<rect class="bar-fg" x="0" y="0" width="0.00" height="10"/>'), 'an empty ring is an empty bar');
});

test('render refuses something that is not a snapshot', () => {
  assert.throws(() => renderReport({}), /not a snapshot/);
});
