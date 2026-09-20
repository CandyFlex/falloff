#!/usr/bin/env node
/**
 * make-tampered.mjs: write snapshots/tampered.json, the example the README
 * and the page use to show the auditor catching a doctored file.
 *
 * It starts from the published Miami study (already redacted, already
 * passing audit) and makes four edits someone would make to improve a result.
 * Two are obvious: a rank written onto a point where the business was not
 * seen, and a method pin changed so the scan claims a different reach. Two
 * are the kind that used to pass: the top-3 size widened so that every
 * sighting counts as a top-3 sighting, and a competitor's id in one captured
 * list swapped for the target's own, so an absent point is contradicted by
 * its own evidence. Nothing else is touched, so the audit output shows
 * exactly those four lies and nothing incidental.
 *
 * Deterministic: same study in, same bytes out. The output is committed so
 * `falloff audit snapshots/tampered.json` works from a fresh clone.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'studies', '2026-09-20-dentist-miami-fl', 'snapshot.json');
const OUT = join(ROOT, 'snapshots', 'tampered.json');

const snap = JSON.parse(readFileSync(SOURCE, 'utf8'));

// Lie 1: the first absent point on the 24.2 km ring now claims rank 1.
const victim = snap.readings.find((r) => r.status === 'absent' && r.dKm === 24.2);
victim.rank = 1;

// Lie 2: the method block now claims the scan reached 55 km instead of 60.
snap.method.rmax = 55;

// Lie 3: widen the top-3 size, so every sighting anywhere counts as a top-3
// sighting and the headline share jumps without a single reading changing.
const wasPackSize = snap.method.packSize;
snap.method.packSize = 20;

// Lie 4: an absent point's own captured list now contains the target's id.
// The list length is untouched, so only the contradiction shows.
const planted = snap.readings.find(
  (r) => r.status === 'absent' && (r.results ?? []).length > 1 && r !== victim,
);
const replacedId = planted.results[1].id;
planted.results[1].id = snap.target.id;

snap.tampered = {
  note: 'This file is deliberately doctored to demonstrate the audit. Do not cite it.',
  source: 'studies/2026-09-20-dentist-miami-fl/snapshot.json',
  edits: [
    `readings[ring ${victim.ring}, index ${victim.index}] (${victim.label}): rank null -> 1 while status stays absent`,
    'method.rmax: 60 -> 55',
    `method.packSize: ${wasPackSize} -> 20`,
    `readings[ring ${planted.ring}, index ${planted.index}] (${planted.label}): results[1].id ${replacedId} -> the target's own id, while the point stays absent`,
  ],
};

mkdirSync(join(ROOT, 'snapshots'), { recursive: true });
writeFileSync(OUT, JSON.stringify(snap, null, 2) + '\n');
console.log(`snapshots/tampered.json written (${snap.tampered.edits.length} edits)`);
