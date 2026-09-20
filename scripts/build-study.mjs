#!/usr/bin/env node
/**
 * build-study.mjs: turn one private legacy scan into one public study folder.
 *
 *   studies/<folder>/snapshot.json   redacted falloff/snapshot@1
 *   studies/<folder>/report.html     rendered from that snapshot
 *   studies/<folder>/README.md       generated: figures, provider, date, reproduce command
 *   studies/<folder>/study.json      the two things the snapshot cannot know: the place name and why the study is in the set
 *   studies/private/<folder>.json    the unredacted conversion (git-ignored)
 *
 * No figure in any of those files is typed. They all come from summarise()
 * and audit() on the redacted snapshot. The script refuses to write a study
 * that fails audit, and it refuses to write one in which any original name
 * (the target's, a competitor's, or a slug of the target's) can still be
 * found in any public file.
 *
 * Usage:
 *   node scripts/build-study.mjs --legacy <file.json> --folder <name> --place "Town, ST" --why "<one line>" [--role metro|quiet]
 *   node scripts/build-study.mjs --rebuild <folder>     redact studies/private/<folder>.json again and rewrite the study
 *   node scripts/build-study.mjs --refresh <folder>     re-render report.html and README.md from the committed snapshot
 *
 * The salt lives in studies/private/<folder>.salt, which is git-ignored. It
 * is made on the first build and reused after, so a rebuild produces the same
 * hashed ids and the committed study does not churn.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertGridScanFile } from '../src/node/convert-grid-scan.mjs';
import { redact, collectNames, nameVariants } from '../src/redact.mjs';
import { saltFor, hasher } from '../src/node/salt.mjs';
import { renderReport } from '../src/render.mjs';
import { audit, formatAudit } from '../src/audit.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STUDIES = join(ROOT, 'studies');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);

/** The generated README for a study. Every number comes from `a.metrics`. */
export function studyReadme(snap, a, meta, folder) {
  const s = a.metrics;
  const v = s.visibility;
  const p = s.pack;
  const observed = String(snap.startedAt).slice(0, 10);
  const edge = (e, why, beyond) => {
    if (!e) {
      return `not reportable: ${why}${beyond?.length ? `. Rings at ${beyond.join(', ')} km do meet the threshold, but not in an unbroken run out from the centre` : ''}`;
    }
    const parts = [`${e.censored ? 'at least ' : ''}${e.dKm} km (${e.hits}/${e.measured} measured on that ring, needs ${e.need})`];
    if (e.censored) parts.push('this is the outermost ring scanned, so the scan cannot say how much further it reaches');
    if (e.fragile) parts.push(`[fragile] a re-scan could move this edge: ${e.note}`);
    if (e.nonMonotonic) parts.push(`rings further out also meet the threshold (${e.qualifyingRingsBeyond.join(', ')} km)`);
    return parts.join('. ');
  };
  const rings = s.rings
    .map((r) => `| ${r.ring === 0 ? 'home' : `${r.dKm} km`} | ${r.found}/${r.measured} | ${r.inPack}/${r.measured} | ${r.unreached} | ${r.reliable ? '' : r.note} |`)
    .join('\n');
  const prov = snap.provenance;
  const depth = snap.method.observation?.listDepth;
  const c = s.archetype.counts;

  return `# "${snap.query}", ${meta.place}, observed ${observed}

This study was observed with an automated browser scan written by this
project's author. That scanner is not in this repository, and this repository
ships no scraper. The commands at the bottom of this page re-render the
recorded file; re-observing these points needs your own provider.

Business name withheld. Ids are hashed with a salt that is not published. The
centre is rounded to 0.01 degrees, about 1 km, and the sample points are
recomputed from the rounded centre, so the geometry still replays. The scan
itself was observed at the true coordinates. Withheld is not anonymous: the
town, the query and the date are kept.

${meta.why ? `Why this study is in the set: ${meta.why}.\n` : ''}
| figure | value |
|---|---|
| visible | ${v.found}/${v.measured} measured (${pct(v.share)}), ${v.unreached} unreached and excluded |
| in the top ${p.packSize} | ${p.inPack}/${p.measured} measured (${pct(p.share)}) |
| reach edge | ${edge(s.reachEdge, 'no reportable ring has the business at half or more of its measured points, counting out from the centre', s.reachQualifyingRingsKm)} |
| top-3 edge | ${edge(s.packEdge, 'no reportable ring has the business in the top 3 at half or more of its measured points, counting out from the centre', s.packQualifyingRingsKm)} |
| gone by | ${s.goneBy ? `${s.goneBy.dKm} km (0/${s.goneBy.measured} measured on that ring, and no reportable ring beyond it has a sighting)` : s.nonMonotonic ? `not reportable: sightings resume at ${s.resumesAtKm.join(', ')} km` : 'not reportable: no reportable ring inside the scan has zero sightings'} |
| shape | ${s.archetype.reliable ? `${s.archetype.archetype} (inner ${c.inner.found}/${c.inner.measured} at ${c.inner.dKm} km, middle ${c.mid.found}/${c.mid.measured} at ${c.mid.dKm} km, outer ${c.outer.found}/${c.outer.measured} at ${c.outer.dKm} km). A descriptive label for the curve, not a diagnosis` : `not reportable: ${s.archetype.note}`} |

The two share figures above are shares of the sample points on preset
\`${snap.method.preset}\`. Points are allocated by ring circumference, so the same
business scores differently on a different preset and these percentages are
not comparable across presets. The per-ring table and the edges are.

| ring | found / measured | in top 3 / measured | unreached | note |
|---|---|---|---|---|
${rings}

## What was measured

- Provider: \`${snap.provider.id}\` (${snap.provider.version}).
- Surface: ${prov?.note ?? 'see the method block in snapshot.json'}.
- Absent means the business was not in the list captured at that point. ${depth ? `Those lists held between ${depth.min} and ${depth.max} rows.` : 'This snapshot records no capture depth.'}
- Observed: ${snap.startedAt}. This is a dated observation, not a live claim. The observation window is unknown: the source file records one timestamp for the whole scan, and an 80-point scan is not instantaneous.
- Geometry: preset \`${snap.method.preset}\`, ${snap.method.budget} points, ${snap.method.rmin}-${snap.method.rmax} km, ${snap.method.rings} rings, ${snap.method.kmPerDegLat} km per degree of latitude.
- Published centre: ${snap.target.lat}, ${snap.target.lng}, rounded to ${2} decimal places. ${meta.placeSource ?? ''}
${prov ? `- Rank source: ${prov.rankSource}. The source file's own rank column disagreed with its captured lists at ${prov.rankColumnDisagreements} of ${snap.readings.length} points; the lists were used.` : ''}
- Passes: ${snap.method.observation?.passes ?? 'n/a'}. This is a single pass. Nothing in this repository measures how far individual points move between scans; \`falloff compare\` is the command that would, and no study has been run twice.

## Audit

\`\`\`
${formatAudit(a)}
\`\`\`

A pass means the file is internally consistent, not that the readings are
true. The README lists what the audit cannot know.

## Reproduce

\`\`\`sh
falloff audit  studies/${folder}/snapshot.json
falloff report studies/${folder}/snapshot.json
falloff render studies/${folder}/snapshot.json --out report.html
\`\`\`

The snapshot itself was produced by:

\`\`\`
${snap.command}
\`\`\`

The source file is a private, unredacted scan and is not in this repository,
so that last command documents provenance rather than something a reader can
run. The three commands above recompute every figure on this page from
\`snapshot.json\`. The rendered report is [report.html](report.html).
`;
}

function leakCheck(names, targetName, files, allow) {
  const needles = new Set();
  for (const n of names) if (n.trim().length >= 4) needles.add(n.trim().toLowerCase());
  for (const v of nameVariants(targetName)) needles.add(v.toLowerCase());
  const leaks = [];
  for (const [file, text] of Object.entries(files)) {
    const hay = text.toLowerCase();
    for (const n of needles) {
      if (allow.some((a) => a.toLowerCase().includes(n))) continue; // a name that is just the query or the place
      if (hay.includes(n)) leaks.push(`${file}: "${n}"`);
    }
  }
  return leaks;
}

function writeStudy(folder, snap, meta, { names = [], targetName = '' } = {}) {
  const a = audit(snap);
  if (!a.ok) {
    console.error(formatAudit(a));
    throw new Error(`study ${folder} does not pass audit; nothing written`);
  }
  const files = {
    'snapshot.json': JSON.stringify(snap, null, 2) + '\n',
    'report.html': renderReport(snap, a),
    'README.md': studyReadme(snap, a, meta, folder),
    'study.json': JSON.stringify(meta, null, 2) + '\n',
  };
  const leaks = leakCheck(names, targetName, files, [snap.query, meta.place]);
  if (leaks.length) throw new Error(`study ${folder}: names survived redaction:\n  ${leaks.slice(0, 10).join('\n  ')}`);

  const dir = join(STUDIES, folder);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const v = a.metrics.visibility;
  console.log(`  ${folder}: visible ${v.found}/${v.measured} measured (${v.unreached} unreached), ${a.counts.warn} warning(s), ${names.length} names checked`);
}

/** Redact one private conversion and write the public study folder. */
function publish(folder, full, meta) {
  const { salt, created } = saltFor(join(STUDIES, 'private', `${folder}.salt`));
  if (created) console.log(`  ${folder}: new salt written to studies/private/${folder}.salt (git-ignored)`);
  const pub = redact(full, { salt, hash: hasher });
  writeStudy(folder, pub, meta, { names: collectNames(full), targetName: full.target.name });
}

const refresh = arg('refresh');
const rebuild = arg('rebuild');
if (refresh) {
  const dir = join(STUDIES, basename(refresh));
  const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(dir, 'study.json'), 'utf8'));
  writeStudy(basename(refresh), snap, meta);
} else if (rebuild) {
  // Re-derive the public study from the private conversion. Used when the
  // redaction rules change, which is the only time the published ids and
  // coordinates are allowed to move.
  const folder = basename(rebuild);
  const privateFile = join(STUDIES, 'private', `${folder}.json`);
  if (!existsSync(privateFile)) throw new Error(`no private conversion at ${privateFile}`);
  const full = JSON.parse(readFileSync(privateFile, 'utf8'));
  const meta = JSON.parse(readFileSync(join(STUDIES, folder, 'study.json'), 'utf8'));
  publish(folder, full, meta);
} else {
  const legacy = arg('legacy');
  const folder = arg('folder');
  const place = arg('place');
  if (!legacy || !folder || !place) {
    console.error('usage: node scripts/build-study.mjs --legacy <file.json> --folder <name> --place "Town, ST" [--why "..."] [--place-source "..."]\n       node scripts/build-study.mjs --rebuild <folder>\n       node scripts/build-study.mjs --refresh <folder>');
    process.exit(2);
  }
  if (!existsSync(legacy)) throw new Error(`no such file: ${legacy}`);
  const full = convertGridScanFile(legacy);
  mkdirSync(join(STUDIES, 'private'), { recursive: true });
  writeFileSync(join(STUDIES, 'private', `${folder}.json`), JSON.stringify(full, null, 2) + '\n');
  const meta = { place, why: arg('why') ?? null, placeSource: arg('place-source') ?? null, ...(arg('role') ? { role: arg('role') } : {}) };
  publish(folder, full, meta);
}
