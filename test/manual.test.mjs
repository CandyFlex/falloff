/**
 * Tests for the manual sheet: plan -> sheet -> a person fills it -> ingest.
 *
 * The sheet is the one place a human types into this tool, so it is the one
 * place a blank could quietly become an absence. These tests pin that it
 * cannot, and that the sheet can fill a plan in but never move it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, toCsv, csvField } from '../src/csv.mjs';
import { makePlan, planSheet, ingestSheet, mapsUrl, SHEET_HEADER, NOT_RECORDED } from '../src/manual.mjs';
import { samplePlan } from '../src/sample.mjs';
import { audit } from '../src/audit.mjs';
import { visibility } from '../src/metrics.mjs';
import { tally, FOUND, ABSENT, UNREACHED } from '../src/schema.mjs';

const CENTRE = { lat: 25.8104, lng: -80.2037 };
const COMMAND = 'falloff ingest --plan plan.json --sheet filled.csv --name "Example Co" --out snap.json';
const AT = '2026-09-19T15:00:00.000Z';

/* ---------------- csv ---------------- */

test('csv: quoted fields, doubled quotes, embedded commas and newlines, CRLF', () => {
  const text = 'a,b,c\r\n1,"two, with comma","say ""hi"""\r\n2,"line one\nline two",x\r\n';
  const recs = parseCsv(text);
  assert.deepEqual(recs.map((r) => r.fields), [
    ['a', 'b', 'c'],
    ['1', 'two, with comma', 'say "hi"'],
    ['2', 'line one\nline two', 'x'],
  ]);
  assert.deepEqual(recs.map((r) => r.line), [1, 2, 3]);
});

test('csv: line numbers account for newlines inside quoted fields', () => {
  const recs = parseCsv('h\n"a\nb\nc"\nlast\n');
  assert.deepEqual(recs.map((r) => r.line), [1, 2, 5]);
});

test('csv: round trips through toCsv, tolerates a BOM, a missing final newline and blank trailing lines', () => {
  const rows = [['x', 'y'], ['has,comma', 'has "quote"'], ['', 'multi\nline']];
  assert.deepEqual(parseCsv(toCsv(rows)).map((r) => r.fields), rows);
  assert.deepEqual(parseCsv('﻿a,b\n1,2').map((r) => r.fields), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\n1\n\n\n').map((r) => r.fields), [['a'], ['1']]);
  assert.equal(csvField(null), '');
});

test('csv: an unterminated quote is an error, not a silent truncation', () => {
  assert.throws(() => parseCsv('a,b\n1,"never closed\n2,3\n'), /unterminated/);
});

/* ---------------- plan + sheet ---------------- */

test('plan carries the geometry, the query, and a pinned-zoom link for every point', () => {
  const plan = makePlan({ ...CENTRE, query: 'dental clinic', preset: 'tight' });
  const ref = samplePlan({ ...CENTRE, preset: 'tight' });
  assert.equal(plan.schema, 'falloff/plan@1');
  assert.equal(plan.points.length, 60);
  assert.deepEqual(plan.method, ref.method);
  plan.points.forEach((p, i) => {
    assert.equal(p.lat, ref.points[i].lat);
    assert.equal(p.mapsUrl, `https://www.google.com/maps/search/dental%20clinic/@${p.lat},${p.lng},13z`);
  });
  assert.equal(mapsUrl('bbq & ribs', 1, 2), 'https://www.google.com/maps/search/bbq%20%26%20ribs/@1,2,13z');
  assert.throws(() => makePlan({ ...CENTRE, preset: 'tight' }), /query is required/);
});

test('the sheet has the documented header and one blank row per point', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const recs = parseCsv(planSheet(plan));
  assert.deepEqual(recs[0].fields, SHEET_HEADER);
  assert.deepEqual(SHEET_HEADER, ['ring', 'index', 'label', 'lat', 'lng', 'mapsUrl', 'status', 'rank', 'note']);
  assert.equal(recs.length, 61);
  for (const r of recs.slice(1)) assert.deepEqual(r.fields.slice(6), ['', '', '']);
});

/** Fill a sheet the way a person would: `fill(point, i)` returns [status, rank, note]. */
function fillSheet(plan, fill) {
  const recs = parseCsv(planSheet(plan));
  const rows = [recs[0].fields];
  recs.slice(1).forEach((r, i) => {
    const [status = '', rank = '', note = ''] = fill(plan.points[i], i) ?? [];
    rows.push([...r.fields.slice(0, 6), status, rank, note]);
  });
  return toCsv(rows);
}

test('round trip: plan -> sheet -> filled -> ingest gives an audited snapshot with the same geometry', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const csv = fillSheet(plan, (p, i) => {
    if (p.dKm <= 5.5) return ['found', String(1 + (i % 4))];
    if (i === 40) return ['unreached', '', 'link would not load, tried twice'];
    if (i === 41) return ['', '', ''];
    return ['Absent'];
  });
  const snap = ingestSheet({ plan, csv, name: 'Example Co', id: 'any-id', observer: 'JO', command: COMMAND, observedAt: AT });

  assert.equal(snap.schema, 'falloff/snapshot@1');
  assert.equal(snap.readings.length, 60);
  const t = tally(snap.readings);
  assert.equal(t.found, 25, 'home + four rings of six');
  assert.equal(t.unreached, 2);
  assert.equal(t.absent, 33);
  assert.deepEqual(snap.provider, { id: 'manual', version: 'sheet@1', pins: { observer: 'JO', surface: 'google-maps-web @13z' } });
  assert.equal(snap.command, COMMAND);
  assert.equal(snap.startedAt, AT);
  assert.deepEqual(snap.target, { name: 'Example Co', id: 'any-id', ...CENTRE });
  assert.equal(snap.method.preset, 'tight');

  const v = visibility(snap.readings);
  assert.equal(v.measured, 58, 'the two unreached rows are out of the denominator');
  const a = audit(snap);
  assert.equal(a.ok, true, JSON.stringify(a.findings, null, 2));
  assert.ok(!a.findings.some((f) => f.id.startsWith('D')), 'geometry replays from the plan pins');
});

test('blank rows become UNREACHED "not recorded", never ABSENT', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const snap = ingestSheet({ plan, csv: planSheet(plan), name: 'Example Co', command: COMMAND, observedAt: AT });
  const t = tally(snap.readings);
  assert.equal(t.unreached, 60);
  assert.equal(t.absent, 0);
  assert.ok(snap.readings.every((r) => r.status === UNREACHED && r.error === NOT_RECORDED));
  const a = audit(snap);
  assert.equal(a.ok, false, 'an unfilled sheet is not a publishable scan');
  assert.ok(a.findings.some((f) => f.id === 'B4'));
});

test('an unreached row keeps the note the person wrote as its reason', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const csv = fillSheet(plan, (p, i) => (i === 3 ? ['unreached', '', 'captcha, gave up'] : ['absent']));
  const snap = ingestSheet({ plan, csv, name: 'Example Co', command: COMMAND, observedAt: AT });
  assert.equal(snap.readings[3].status, UNREACHED);
  assert.equal(snap.readings[3].error, 'captcha, gave up');
});

test('a "found" without a rank is refused, and the error names the line', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const csv = fillSheet(plan, (p, i) => (i === 6 ? ['found', ''] : ['absent']));
  assert.throws(
    () => ingestSheet({ plan, csv, name: 'Example Co', command: COMMAND }),
    /row 7 \(line 8\): "found" needs an integer rank of 1 or more, got ""/,
  );
  for (const bad of ['0', '-1', '2.5', 'third', '1st']) {
    const c = fillSheet(plan, (p, i) => (i === 6 ? ['found', bad] : ['absent']));
    assert.throws(() => ingestSheet({ plan, csv: c, name: 'Example Co', command: COMMAND }), /line 8\): "found" needs an integer rank/, bad);
  }
});

test('an "absent" with a rank, and an unknown status, are refused with the line', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const withRank = fillSheet(plan, (p, i) => (i === 2 ? ['absent', '4'] : ['absent']));
  assert.throws(() => ingestSheet({ plan, csv: withRank, name: 'Example Co', command: COMMAND }), /line 4\): "absent" cannot carry a rank/);
  const unknown = fillSheet(plan, (p, i) => (i === 2 ? ['maybe'] : ['absent']));
  assert.throws(() => ingestSheet({ plan, csv: unknown, name: 'Example Co', command: COMMAND }), /line 4\): unknown status "maybe"/);
});

test('[tamper] a sheet with a moved coordinate is refused', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const recs = parseCsv(fillSheet(plan, () => ['absent']));
  const rows = recs.map((r) => [...r.fields]);
  rows[10][3] = String(Number(rows[10][3]) + 0.0001); // nudge lat by about 11 m
  assert.throws(
    () => ingestSheet({ plan, csv: toCsv(rows), name: 'Example Co', command: COMMAND }),
    /line 11\): coordinates .* are 1\.00e-4 deg from the plan/,
  );
});

test('a sheet rounded by a spreadsheet is accepted, and the coordinates come from the plan', () => {
  // A general number format commonly writes back ten significant digits. The
  // rows are keyed by ring and index, so refusing that threw twenty minutes
  // of someone's work away for about a millimetre.
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const rows = parseCsv(fillSheet(plan, () => ['absent'])).map((r) => [...r.fields]);
  for (let i = 1; i < rows.length; i++) {
    rows[i][3] = String(Number(rows[i][3]).toPrecision(10));
    rows[i][4] = String(Number(rows[i][4]).toPrecision(10));
  }
  const snap = ingestSheet({ plan, csv: toCsv(rows), name: 'Example Co', command: COMMAND, observedAt: '2026-09-19T00:00:00.000Z' });
  assert.equal(snap.readings.length, plan.points.length);
  for (const r of snap.readings) {
    const p = plan.points.find((q) => q.ring === r.ring && q.index === r.index);
    assert.equal(r.lat, p.lat, 'the plan is the geometry, not the sheet');
    assert.equal(r.lng, p.lng);
  }
});

test('[tamper] a sheet with a missing, duplicated or foreign point is refused', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const rows = parseCsv(fillSheet(plan, () => ['absent'])).map((r) => [...r.fields]);
  const missing = toCsv(rows.filter((_, i) => i !== 5));
  assert.throws(() => ingestSheet({ plan, csv: missing, name: 'Example Co', command: COMMAND }), /missing 1 plan point\(s\): 1:3/);
  const dup = toCsv([...rows, rows[5]]);
  assert.throws(() => ingestSheet({ plan, csv: dup, name: 'Example Co', command: COMMAND }), /appears twice/);
  const foreign = rows.map((r) => [...r]);
  foreign[5][0] = '42';
  assert.throws(() => ingestSheet({ plan, csv: toCsv(foreign), name: 'Example Co', command: COMMAND }), /not in the plan/);
});

test('a sheet that lost a column, or a plan that is not a plan, is refused', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const rows = parseCsv(planSheet(plan)).map((r) => r.fields.filter((_, i) => i !== 6));
  assert.throws(() => ingestSheet({ plan, csv: toCsv(rows), name: 'Example Co', command: COMMAND }), /missing the "status" column/);
  assert.throws(() => ingestSheet({ plan: { points: [] }, csv: '', name: 'x', command: COMMAND }), /not falloff\/plan@1/);
  assert.throws(() => ingestSheet({ plan, csv: planSheet(plan), command: COMMAND }), /--name is required/);
});

test('a sheet saved by a spreadsheet (CRLF, BOM, reordered and extra columns) still ingests', () => {
  const plan = makePlan({ ...CENTRE, query: 'dentist', preset: 'tight' });
  const recs = parseCsv(fillSheet(plan, (p) => (p.ring <= 2 ? ['FOUND ', ' 2 '] : ['absent'])));
  const order = [6, 7, 8, 0, 1, 2, 3, 4, 5];
  const rows = recs.map((r, i) => [...order.map((k) => r.fields[k]), i === 0 ? 'my notes' : 'x']);
  const csv = '﻿' + toCsv(rows).replace(/\n/g, '\r\n');
  const snap = ingestSheet({ plan, csv, name: 'Example Co', command: COMMAND, observedAt: AT });
  assert.equal(tally(snap.readings).found, 13);
  assert.ok(snap.readings.filter((r) => r.status === FOUND).every((r) => r.rank === 2));
  assert.equal(snap.readings.filter((r) => r.status === ABSENT).length, 47);
  assert.equal(audit(snap).ok, true);
});
