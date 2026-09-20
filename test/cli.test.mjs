/**
 * Tests for the command line, run as a real child process.
 *
 * The CLI is where the rules become visible to a user: a figure never
 * prints without its reproduce command, a failed audit exits 1 so it can
 * gate a pipeline, a usage mistake exits 2, and a secret never lands in a
 * snapshot. Everything runs offline against the committed fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, toCsv } from '../src/csv.mjs';

const BIN = fileURLToPath(new URL('../bin/falloff.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/legacy-grid-scan.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'falloff-cli-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

function run(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, FALLOFF_PLACES_KEY: '' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const p = (name) => join(dir, name);

test('help prints every command, the dated Places fact and the OSM limit, with no dashes used as separators', () => {
  const r = run('help');
  assert.equal(r.code, 0);
  for (const c of ['scan', 'plan', 'ingest', 'audit', 'report', 'render', 'compare', 'redact', 'convert']) {
    assert.match(r.out, new RegExp(`falloff ${c}\\b`), c);
  }
  assert.match(r.out, /--provider places\|osm/);
  assert.match(r.out, /5,000 free events a month/);
  assert.match(r.out, /checked\s+2026-09-19/);
  assert.match(r.out, /NOT TESTED LIVE/, 'the places provider has never been run against Google');
  assert.match(r.out, /OpenStreetMap has no ranking/);
  assert.match(r.out, /reads as falloff by construction past that radius/, 'the OSM radius limit');
  assert.match(r.out, /node bin\/falloff\.mjs/, 'a form that runs on Windows');
  assert.ok(!/[–—]/.test(r.out), 'en or em dash in help');
  assert.equal(run().out, r.out, 'no arguments prints the same help');
});

test('usage mistakes exit 2', () => {
  assert.equal(run('frobnicate').code, 2);
  assert.equal(run('scan', '--name', 'x').code, 2);
  assert.equal(run('audit').code, 2);
  assert.equal(run('convert', FIXTURE).code, 2, 'convert without --out');
  assert.equal(run('render', p('nope.json')).code, 2, 'render without --out');
  assert.equal(run('plan', '--lat', '35', '--lng', '-81').code, 2);
  assert.equal(run('scan', '--name', 'x', '--lat', '35', '--lng', '-81', '--query', 'dentist', '--provider', 'bing').code, 2);
  const noKey = run('scan', '--name', 'x', '--lat', '35', '--lng', '-81', '--query', 'dentist');
  assert.equal(noKey.code, 2);
  assert.match(noKey.err, /--provider osm/, 'points at the paths that need no key');
});

test('an unknown osm term is refused before any call is made', () => {
  const r = run('scan', '--name', 'x', '--lat', '35', '--lng', '-81', '--query', 'artisanal vibes', '--provider', 'osm');
  assert.equal(r.code, 1);
  assert.match(r.err, /no tag mapping/);
});

test('convert -> audit -> report -> redact -> render, each printing its reproduce command', () => {
  const conv = run('convert', FIXTURE, '--out', p('snap.json'));
  assert.equal(conv.code, 0, conv.err);
  assert.match(conv.out, /visible {6}24\/80 measured {2}30% {3}\(0 unreached, excluded\)/);
  assert.match(conv.out, /top-3 edge {3}6\.2 km {2}\(6\/6 on that ring\) {2}\[fragile\]/);
  assert.match(conv.out, /absent means not in the captured list at that point; those lists held 1-10 rows/);
  assert.match(conv.out, /reproduce: falloff convert legacy-grid-scan\.json/);

  const aud = run('audit', p('snap.json'));
  assert.equal(aud.code, 0);
  assert.match(aud.out, /PASS: internally consistent \(\d+ warning\(s\), 0 critical\)/);
  assert.ok(!/Safe to publish/.test(aud.out), 'the verdict does not claim the readings are true');
  assert.match(aud.out, /reproduce: /);

  const rep = run('report', p('snap.json'));
  assert.equal(rep.code, 0);
  assert.match(rep.out, /name withheld, query "dentist"/, 'the fixture is already name-withheld');
  assert.match(rep.out, /80 points, 2\.5-60 km, 8 rings/);
  assert.match(rep.out, /observed 2026-09-20 via google-maps-web \(grid-scan radial-v2 @13z\)/);
  assert.match(rep.out, /24\.2 km {2}█{3}·{17} {2}2\/12/);
  assert.match(rep.out, /reproduce: /);
  assert.ok(!/[–—]/.test(rep.out + aud.out + conv.out));

  const red = run('redact', p('snap.json'), '--out', p('public.json'), '--reason', 'public study', '--salt-file', p('snap.salt'));
  assert.equal(red.code, 0, red.err);
  assert.match(red.out, /WARN {2}A5 {2}names withheld/);
  assert.match(red.out, /Withheld is not anonymous/);
  assert.ok(existsSync(p('snap.salt')), 'the salt is written where .gitignore keeps it');
  assert.equal(JSON.parse(readFileSync(p('public.json'), 'utf8')).redaction.reason, 'public study');

  const ren = run('render', p('public.json'), '--out', p('report.html'));
  assert.equal(ren.code, 0);
  assert.match(ren.out, /visible 24\/80 measured \(0 unreached, excluded\), 80 points drawn/);
  assert.match(ren.out, /reproduce: /);
  const html = readFileSync(p('report.html'), 'utf8');
  assert.equal((html.match(/data-status=/g) ?? []).length, 80);
  assert.ok(html.includes('<h1>name withheld</h1>'));
});

test('[tamper] a tampered snapshot exits 1 from audit, report and render', () => {
  run('convert', FIXTURE, '--out', p('clean.json'));
  const snap = JSON.parse(readFileSync(p('clean.json'), 'utf8'));
  const absent = snap.readings.find((r) => r.status === 'absent');
  absent.rank = 1; // forge a rank on an absent point
  snap.method.rmax = 55; // and doctor a pin
  writeFileSync(p('tampered.json'), JSON.stringify(snap));

  const aud = run('audit', p('tampered.json'));
  assert.equal(aud.code, 1);
  assert.match(aud.out, /FAIL {2}C2 {2}absent carries rank 1/);
  assert.match(aud.out, /FAIL {2}D[234] /);
  assert.match(aud.out, /FAIL: not internally consistent \(\d+ critical/);
  const rep = run('report', p('tampered.json'));
  assert.equal(rep.code, 1);
  assert.match(rep.out, /does not pass audit/);
  assert.equal(run('render', p('tampered.json'), '--out', p('t.html')).code, 1);
  assert.ok(readFileSync(p('t.html'), 'utf8').includes('This snapshot does not pass audit'));
});

test('[tamper] a legacy file that does not fit the geometry is refused with exit 1 and nothing is written', () => {
  const legacy = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  legacy.results[9].lng += 0.001;
  writeFileSync(p('moved.json'), JSON.stringify(legacy));
  const r = run('convert', p('moved.json'), '--out', p('moved-out.json'));
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing rather than moving it/);
  assert.equal(existsSync(p('moved-out.json')), false);
});

test('plan -> fill the sheet -> ingest, and the recorded command is quoted and pasteable', () => {
  const pl = run('plan', '--lat', '25.8104', '--lng', '-80.2037', '--query', 'dentist', '--preset', 'tight', '--out', p('plan.json'), '--sheet', p('plan.csv'));
  assert.equal(pl.code, 0, pl.err);
  assert.match(pl.out, /60 points: the home point plus 7 rings at 1\.5, 2\.3, 3\.6, 5\.5, 8\.4, 13, 20 km/);
  assert.match(pl.out, /a blank row is recorded as unreached, never as absent/);
  assert.match(pl.out, /reproduce: falloff plan --lat 25\.8104 --lng -80\.2037 --query dentist --preset tight/);

  const recs = parseCsv(readFileSync(p('plan.csv'), 'utf8'));
  const rows = recs.map((r, i) => {
    if (i === 0) return r.fields;
    const f = [...r.fields];
    if (i <= 25) { f[6] = 'found'; f[7] = '2'; }
    else if (i === 30) { f[8] = 'ran out of time'; }
    else f[6] = 'absent';
    return f;
  });
  writeFileSync(p('filled.csv'), toCsv(rows));

  const ing = run('ingest', '--plan', p('plan.json'), '--sheet', p('filled.csv'), '--name', 'Example Dental & Co', '--observer', 'JO', '--observed', '2026-09-19T15:00:00Z', '--out', p('manual.json'));
  assert.equal(ing.code, 0, ing.err + ing.out);
  assert.match(ing.out, /Example Dental & Co, query "dentist"/);
  assert.match(ing.out, /visible {6}25\/59 measured {2}42% {3}\(1 unreached, excluded\)/);
  assert.match(ing.out, /observed 2026-09-19 via manual \(sheet@1\)/);
  const snap = JSON.parse(readFileSync(p('manual.json'), 'utf8'));
  assert.match(snap.command, /^falloff ingest --plan .* --name "Example Dental & Co" --observer JO /);
  assert.equal(snap.readings[29].error, 'ran out of time');
  assert.equal(run('audit', p('manual.json')).code, 0);
});

test('an ingest the sheet cannot support is refused with the line number and exit 1', () => {
  const recs = parseCsv(readFileSync(p('plan.csv'), 'utf8'));
  const rows = recs.map((r, i) => (i === 4 ? [...r.fields.slice(0, 6), 'found', '', ''] : r.fields));
  writeFileSync(p('bad.csv'), toCsv(rows));
  const r = run('ingest', '--plan', p('plan.json'), '--sheet', p('bad.csv'), '--name', 'x', '--out', p('bad.json'));
  assert.equal(r.code, 1);
  assert.match(r.err, /row 4 \(line 5\): "found" needs an integer rank/);
  assert.equal(existsSync(p('bad.json')), false);
});

/* ---------------- the recorded command ---------------- */

import { commandLine, shellQuote } from '../src/node/command-line.mjs';

test('an API key never reaches the recorded command, in either flag form', () => {
  const argv = ['scan', '--name', 'Some Business', '--key', 'AIzaSECRET123', '--lat', '25.8104', '--lng', '-80.2037', '--query', 'dentist'];
  const c = commandLine(argv);
  assert.equal(c, 'falloff scan --name "Some Business" --lat 25.8104 --lng -80.2037 --query dentist');
  assert.ok(!c.includes('SECRET') && !c.includes('--key'));
  assert.ok(!commandLine(['scan', '--key=AIzaSECRET123', '--query', 'x']).includes('SECRET'));
  assert.ok(!commandLine(['scan', '--query', 'x', '--key', 'AIzaSECRET123']).includes('SECRET'), 'key as the last argument');
});

test('arguments are quoted so the recorded command can be pasted back into a shell', () => {
  assert.equal(shellQuote('dentist'), 'dentist');
  assert.equal(shellQuote('-80.2037'), '-80.2037');
  assert.equal(shellQuote('urgent care'), '"urgent care"');
  assert.equal(shellQuote('Bob\'s "Best" $5 BBQ'), '"Bob\'s \\"Best\\" \\$5 BBQ"');
  assert.equal(shellQuote(''), '""');
});
