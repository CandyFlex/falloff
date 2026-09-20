#!/usr/bin/env node
/**
 * build-field.mjs: the whole field from one study, not only its target.
 *
 * A scan records the full list at every sample point, so the same file holds
 * a reading for every business that appeared anywhere in it. This script
 * rebuilds those readings per business and runs the library's own
 * visibility() and byRing() on each. No figure is typed.
 *
 * It reads the REDACTED snapshot, so there is no name to leak: a business is
 * its hashed id, and its label ("Business 001") is its place in the sort
 * order. The sort is visible points descending, then id, so the same snapshot
 * gives the same labels.
 *
 * One limit, stated in the output: the rings are centred on the study's
 * target. For every other business the per-ring counts say how it fared at
 * those distances from the target, not from its own door. The visible count
 * (n of the measured points) does not depend on the centre.
 *
 * Usage:
 *   node scripts/build-field.mjs <folder>          write studies/<folder>/field.json
 *   node scripts/build-field.mjs <folder> --check  exit 1 if field.json is not what would be written
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { visibility, packShare, byRing } from '../src/metrics.mjs';
import { FOUND, ABSENT, UNREACHED } from '../src/schema.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIELD_SCHEMA = 'falloff/field@1';
export const CENTRE_NOTE =
  'Rings are centred on the study target. For any other business the per-ring counts are distances from the target, not from that business.';

/** Readings for one business id, rebuilt from the lists captured at every point. */
export function readingsFor(snap, id) {
  return snap.readings.map((r) => {
    if (r.status === UNREACHED) return { ring: r.ring, index: r.index, dKm: r.dKm, status: UNREACHED };
    const i = (r.results ?? []).findIndex((b) => b.id === id);
    return i === -1
      ? { ring: r.ring, index: r.index, dKm: r.dKm, status: ABSENT }
      : { ring: r.ring, index: r.index, dKm: r.dKm, status: FOUND, rank: i + 1 };
  });
}

export function buildField(snap) {
  const seen = new Map();
  for (const r of snap.readings) {
    for (const b of r.results ?? []) {
      if (!seen.has(b.id)) seen.set(b.id, { id: b.id, rating: b.rating ?? null, reviews: b.reviews ?? null });
    }
  }
  const rows = [...seen.values()].map((b) => {
    const readings = readingsFor(snap, b.id);
    const v = visibility(readings);
    const p = packShare(readings);
    const ranks = readings.filter((r) => r.status === FOUND).map((r) => r.rank).sort((x, y) => x - y);
    return {
      id: b.id,
      isTarget: b.id === snap.target.id,
      rating: b.rating,
      reviews: b.reviews,
      found: v.found,
      measured: v.measured,
      unreached: v.unreached,
      inPack: p.inPack,
      bestRank: ranks[0] ?? null,
      rings: byRing(readings).map((g) => ({ dKm: g.dKm, found: g.found, measured: g.found + g.absent })),
      points: readings.map((r) => (r.status === FOUND ? r.rank : r.status === ABSENT ? 0 : -1)),
    };
  });
  rows.sort((a, b) => b.found - a.found || (a.id < b.id ? -1 : 1));
  const width = Math.max(3, String(rows.length).length);
  rows.forEach((r, i) => { r.label = `Business ${String(i + 1).padStart(width, '0')}`; });
  return {
    schema: FIELD_SCHEMA,
    query: snap.query,
    observed: String(snap.startedAt).slice(0, 10),
    businesses: rows.length,
    points: snap.readings.length,
    pointsEncoding: 'one entry per reading, in snapshot order: rank when found, 0 when absent, -1 when unreached',
    note: CENTRE_NOTE,
    rows,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const folder = process.argv[2];
  if (!folder) { console.error('usage: node scripts/build-field.mjs <folder> [--check]'); process.exit(2); }
  const dir = join(ROOT, 'studies', folder);
  const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  const text = JSON.stringify(buildField(snap), null, 1) + '\n';
  const out = join(dir, 'field.json');
  if (process.argv.includes('--check')) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== text) { console.error(`field.json is stale for ${folder}`); process.exit(1); }
    console.log(`field.json is current for ${folder}`);
  } else {
    writeFileSync(out, text);
    const f = JSON.parse(text);
    console.log(`${folder}: ${f.businesses} businesses across ${f.points} points -> field.json`);
  }
}
