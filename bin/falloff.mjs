#!/usr/bin/env node
/**
 * falloff: command line.
 *
 * Every command that prints a figure also prints the command that reproduces
 * it. `audit` exits non-zero when anything fails, so it works as a gate in a
 * pipeline: nothing downstream runs on numbers that did not survive it.
 *
 * Exit codes: 0 ok. 1 the audit failed, or the input was refused. 2 usage.
 *
 * The API key is never written into a snapshot. The recorded reproduce
 * command drops `--key` and its value.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { scan } from '../src/scan.mjs';
import { audit, formatAudit } from '../src/audit.mjs';
import { summarise } from '../src/metrics.mjs';
import { PRESETS } from '../src/sample.mjs';
import { placesProvider, DEFAULT_POINT_RADIUS_M } from '../src/providers/places.mjs';
import { osmProvider, DEFAULT_POINT_RADIUS_M as OSM_DEFAULT_RADIUS_M } from '../src/providers/osm.mjs';
import { OSM_TERMS } from '../src/providers/osm-terms.mjs';
import { redact } from '../src/redact.mjs';
import { saltFor, hasher } from '../src/node/salt.mjs';
import { renderReport } from '../src/render.mjs';
import { makePlan, planSheet, ingestSheet } from '../src/manual.mjs';
import { compare, formatCompare } from '../src/compare.mjs';
import { convertGridScanFile } from '../src/node/convert-grid-scan.mjs';
import { commandLine as recordCommand } from '../src/node/command-line.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
/** A flag that must carry a value. */
function value(name) {
  const v = flag(name);
  return v === true ? undefined : v;
}
const num = (name) => {
  const v = value(name);
  return v === undefined ? undefined : Number(v);
};

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);

/** The command line as typed, minus any secret. */
const commandLine = () => recordCommand(argv);

function usage() {
  console.log(`falloff: where a business is visible on the map, and where it stops

  falloff scan    --name <business> --lat <n> --lng <n> --query <term>
                  [--provider places|osm] [--id <stable-id>]
                  [--preset ${Object.keys(PRESETS).join('|')}] [--rmin <km>] [--rmax <km>] [--points <n>]
                  [--out <snapshot.json>] [--key <places-api-key>] [--pacing <ms, osm only>]

  falloff plan    --lat <n> --lng <n> --query <term> --out <plan.json> [--sheet <plan.csv>]
                  [--preset ...] [--rmin <km>] [--rmax <km>] [--points <n>]
                  writes the sample points and a sheet with one Google Maps link per point

  falloff ingest  --plan <plan.json> --sheet <filled.csv> --name <business> --out <snapshot.json>
                  [--id <stable-id>] [--observer <initials>] [--observed <ISO time>]
                  turns the filled sheet into a snapshot

  falloff audit   <snapshot.json>      recomputes everything; exits 1 on any critical finding
  falloff report  <snapshot.json>      the figures, with their denominators
  falloff render  <snapshot.json> --out <report.html>      standalone HTML report
  falloff compare <a.json> <b.json>    two passes of the same plan, point by point
  falloff redact  <snapshot.json> --out <public.json> [--reason "<why>"] [--salt-file <f>]
                  hashes ids with an unpublished salt, withholds names, rounds
                  the centre to 0.01 degrees and recomputes the points from it
  falloff convert <legacy.json> --out <snapshot.json>
                  legacy grid-scan radial file to falloff/snapshot@1

On Windows, or in any shell where the function below is awkward, run every
command as: node bin/falloff.mjs <args>

Three ways to get readings:

  places  Google Places API (New), through Text Search. Pass --key or set
          FALLOFF_PLACES_KEY.
          NOT TESTED LIVE. The author has no key and has never run this
          provider against Google. Treat it as a documented request shape,
          not as a proven one, and check the response before trusting a scan.
          Requests ask for places.id and places.displayName only, which bills
          under the Text Search Pro SKU: 5,000 free events a month
          (developers.google.com/maps/billing-and-pricing/pricing, checked
          2026-09-19). An 80-point scan is 80 events.
          Each point is a search biased to a ${DEFAULT_POINT_RADIUS_M / 1000} km circle around that
          point, so a sighting much beyond that is unlikely by construction.

  osm     OpenStreetMap through Overpass. No key. OpenStreetMap has no ranking:
          this measures listing proximity order in the open map, not what
          Google shows. Each point is RESTRICTED to a ${OSM_DEFAULT_RADIUS_M / 1000} km circle, so a
          business further than that from a sample point cannot be returned at
          all: an OSM scan reads as falloff by construction past that radius.
          Terms: ${Object.keys(OSM_TERMS).join(', ')},
          or a raw tag such as shop=bakery. Use --id osm:node/<id> to identify
          the business by its OSM id. The public server throttles: throttled
          calls are retried twice, then recorded as unreached. Raise --pacing
          (default 1500 ms) if a scan comes back with gaps.

  manual  plan, open each link, fill the sheet, ingest. No key, about twenty
          minutes for the tight preset.

Exit codes: 0 ok. 1 audit failed or input refused. 2 usage.
This repository ships no scraper. Nothing here drives a browser.
`);
}

const isRedacted = (snap) => Boolean(snap.redaction) || snap.target?.name === 'withheld';

/** Figures are printed with their denominators. A bare percentage is unfalsifiable. */
function printSummary(snap) {
  const s = summarise(snap.readings, snap.method.packSize);
  const v = s.visibility;
  const p = s.pack;
  const who = isRedacted(snap) ? 'name withheld' : snap.target.name;
  const via = `${snap.provider.id}${snap.provider.version ? ` (${snap.provider.version})` : ''}`;

  console.log(`\n  ${who}, query "${snap.query}"`);
  console.log(`  ${snap.method.budget} points, ${snap.method.rmin}-${snap.method.rmax} km, ${snap.method.rings} rings, preset ${snap.method.preset}`);
  console.log(`  observed ${String(snap.startedAt).slice(0, 10)} via ${via}`);
  const radiusM = snap.provider.pins?.pointRadiusM;
  if (radiusM) {
    console.log(`  each point searched a ${radiusM / 1000} km circle: a sighting beyond that is not possible from that point`);
  }
  const depth = snap.method.observation?.listDepth;
  console.log(
    depth
      ? `  absent means not in the captured list at that point; those lists held ${depth.min}-${depth.max} rows`
      : '  absent means the point was measured and the business was not seen; no capture depth is recorded',
  );
  console.log('');

  const gaps = `   (${v.unreached} unreached, excluded)`;
  const presetNote = `  (share of sample points, preset ${snap.method.preset}; not comparable across presets)`;
  if (v.measured === 0) {
    console.log(`  visible      not reportable: no point was measured${gaps}`);
    console.log('  in the top 3 not reportable: no point was measured');
  } else {
    console.log(`  visible      ${v.found}/${v.measured} measured  ${pct(v.share)}${gaps}`);
    console.log(`  in the top 3 ${p.inPack}/${p.measured} measured  ${pct(p.share)}`);
    console.log(presetNote);
  }

  const edgeLine = (label, e, why, beyond) => {
    if (!e) {
      const extra = beyond?.length ? `; rings at ${beyond.join(', ')} km do meet it, but not in an unbroken run out from the centre` : '';
      return `  ${label} not reportable: ${why}${extra}`;
    }
    const at = `${e.censored ? 'at least ' : ''}${e.dKm} km`;
    return `  ${label} ${at}  (${e.hits}/${e.measured} on that ring)${e.fragile ? '  [fragile]' : ''}${e.censored ? '  [outermost ring scanned]' : ''}`;
  };
  console.log(
    edgeLine('reach edge  ', s.reachEdge, 'no ring has the business at half or more of its measured points, counting out from the centre', s.reachQualifyingRingsKm),
  );
  if (s.reachEdge?.fragile) console.log(`               a re-scan could move this edge: ${s.reachEdge.note}`);
  console.log(
    edgeLine('top-3 edge  ', s.packEdge, 'no ring has the business in the top 3 at half or more of its measured points, counting out from the centre', s.packQualifyingRingsKm),
  );
  if (s.packEdge?.fragile) console.log(`               a re-scan could move this edge: ${s.packEdge.note}`);
  console.log(
    s.goneBy
      ? `  gone by      ${s.goneBy.dKm} km  (0/${s.goneBy.measured} on that ring, and nothing beyond it)`
      : s.nonMonotonic
        ? `  gone by      not reportable: sightings resume at ${s.resumesAtKm.join(', ')} km`
        : '  gone by      not reportable: no ring inside the scan has zero sightings',
  );
  if (s.archetype.reliable) {
    const c = s.archetype.counts;
    console.log(`  shape        ${s.archetype.archetype}  (inner ${c.inner.found}/${c.inner.measured}, middle ${c.mid.found}/${c.mid.measured}, outer ${c.outer.found}/${c.outer.measured})`);
  } else {
    console.log(`  shape        not reportable: ${s.archetype.note}`);
  }

  console.log('\n  by ring');
  for (const r of s.rings) {
    if (r.ring === 0) continue;
    const bar = '█'.repeat(Math.round((r.visibleShare ?? 0) * 20)).padEnd(20, '·');
    const un = r.unreached ? `  (${r.unreached} unreached)` : '';
    const note = r.reliable ? '' : `  ${r.note}`;
    console.log(`    ${String(r.dKm).padStart(6)} km  ${bar}  ${r.found}/${r.measured}${un}${note}`);
  }
  if (snap.redaction) {
    console.log('\n  Business name withheld. Ids are hashed with a salt that is not published.');
    console.log('  The centre is rounded to 0.01 degrees, about 1 km, and the sample points are');
    console.log('  recomputed from the rounded centre. The scan was observed at the true coordinates.');
    console.log(`  ${snap.redaction.warning ?? ''}`.trimEnd());
  } else if (isRedacted(snap)) {
    console.log('\n  Business name withheld. This file carries no redaction block, so nothing else was changed.');
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function writeOut(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function usageError(msg) {
  console.error(`${msg}\n`);
  usage();
  process.exit(2);
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || flag('help')) return usage();

  if (cmd === 'scan') {
    const name = value('name');
    const lat = num('lat');
    const lng = num('lng');
    const query = value('query');
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || !query) {
      return usageError('scan needs --name, --lat, --lng and --query');
    }
    const which = value('provider') ?? 'places';
    let provider;
    if (which === 'places') {
      const key = value('key') || process.env.FALLOFF_PLACES_KEY;
      if (!key) {
        console.error('no API key. Pass --key or set FALLOFF_PLACES_KEY.');
        console.error('Or use a path that needs no key: --provider osm, or falloff plan + falloff ingest.');
        return process.exit(2);
      }
      provider = placesProvider({ apiKey: key });
    } else if (which === 'osm') {
      const pacingMs = num('pacing');
      if (pacingMs !== undefined && !(pacingMs >= 0)) return usageError('--pacing must be a number of milliseconds');
      provider = osmProvider({ term: query, ...(pacingMs !== undefined ? { pacingMs } : {}) }); // throws on an unknown term, before any call
    } else {
      return usageError(`unknown provider "${which}"; use places or osm`);
    }

    const command = commandLine();
    const { snapshot: snap, audit: a } = await scan({
      target: { name, id: value('id'), lat, lng },
      query,
      provider,
      preset: value('preset') ?? 'mid',
      rmin: num('rmin'),
      rmax: num('rmax'),
      points: num('points'),
      command,
      onPoint: ({ done, total }) => process.stderr.write(`\r  ${done}/${total}`),
    });
    process.stderr.write('\r');

    const out = value('out');
    if (out) writeOut(out, JSON.stringify(snap, null, 2));

    printSummary(snap);
    console.log(`\n${formatAudit(a)}`);
    console.log(`\n  reproduce: ${command}`);
    if (out) console.log(`  snapshot:  ${out}`);
    return process.exit(a.ok ? 0 : 1);
  }

  if (cmd === 'plan') {
    const lat = num('lat');
    const lng = num('lng');
    const query = value('query');
    const out = value('out');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !query || !out) {
      return usageError('plan needs --lat, --lng, --query and --out');
    }
    const plan = makePlan({ lat, lng, query, preset: value('preset') ?? 'mid', rmin: num('rmin'), rmax: num('rmax'), points: num('points') });
    writeOut(out, JSON.stringify(plan, null, 2));
    const sheet = value('sheet');
    if (sheet) writeOut(sheet, planSheet(plan));

    console.log(`\n  ${plan.points.length} points: the home point plus ${plan.rings.length} rings at ${plan.rings.join(', ')} km`);
    console.log(`  plan:   ${out}`);
    if (sheet) {
      console.log(`  sheet:  ${sheet}`);
      console.log('\n  Open each mapsUrl in a logged-out browser window. In the status column write');
      console.log('  found (and the rank), or absent. Leave a row blank if you did not get to it:');
      console.log('  a blank row is recorded as unreached, never as absent.');
    }
    console.log(`\n  reproduce: ${commandLine()}`);
    return;
  }

  if (cmd === 'ingest') {
    const planFile = value('plan');
    const sheetFile = value('sheet');
    const name = value('name');
    const out = value('out');
    if (!planFile || !sheetFile || !name || !out) {
      return usageError('ingest needs --plan, --sheet, --name and --out');
    }
    const command = commandLine();
    const snap = ingestSheet({
      plan: readJson(planFile),
      csv: readFileSync(sheetFile, 'utf8'),
      name,
      id: value('id') ?? null,
      observer: value('observer') ?? null,
      observedAt: value('observed'),
      command,
    });
    const a = audit(snap);
    writeOut(out, JSON.stringify(snap, null, 2));
    printSummary(snap);
    console.log(`\n${formatAudit(a)}`);
    console.log(`\n  reproduce: ${command}`);
    console.log(`  snapshot:  ${out}`);
    return process.exit(a.ok ? 0 : 1);
  }

  if (cmd === 'convert') {
    const file = argv[1];
    const out = value('out');
    if (!file || file.startsWith('--') || !out) return usageError('convert needs <legacy.json> and --out <snapshot.json>');
    const snap = convertGridScanFile(file);
    const a = audit(snap);
    writeOut(out, JSON.stringify(snap, null, 2));
    printSummary(snap);
    if (snap.provenance.rankColumnDisagreements) {
      console.log(`\n  note: the source file's rank column disagreed with its own captured lists at ${snap.provenance.rankColumnDisagreements} point(s).`);
      console.log('        Ranks here are the position of the target place id in each list.');
    }
    console.log(`\n${formatAudit(a)}`);
    console.log(`\n  reproduce: ${snap.command}`);
    console.log(`  snapshot:  ${out}`);
    if (!a.ok) console.log('\n  NOTE: the converted snapshot does not pass audit. It was written for inspection, not publication.');
    return process.exit(a.ok ? 0 : 1);
  }

  if (cmd === 'redact') {
    const file = argv[1];
    const out = value('out');
    if (!file || file.startsWith('--') || !out) return usageError('redact needs <snapshot.json> and --out <public.json>');
    // The salt is the whole privacy claim. It is written next to the private
    // file, which .gitignore keeps out of the repository, and never beside
    // the output.
    const saltFile = value('salt-file') ?? `${file.replace(/\.json$/, '')}.salt`;
    const { salt, created } = saltFor(saltFile);
    const pub = redact(readJson(file), { salt, hash: hasher, reason: value('reason') });
    const a = audit(pub);
    writeOut(out, JSON.stringify(pub, null, 2));
    console.log(`\n  ${out}`);
    console.log(`  withheld: ${pub.redaction.fields.join(', ')}`);
    console.log(`  salt:     ${saltFile}${created ? ' (new)' : ' (existing)'}. Keep it out of the repository; it is not recoverable from the output.`);
    console.log(`  ${pub.redaction.warning}`);
    console.log(formatAudit(a));
    console.log(`\n  reproduce: ${pub.command}`);
    return process.exit(a.ok ? 0 : 1);
  }

  if (cmd === 'compare') {
    const [, fileA, fileB] = argv;
    if (!fileA || !fileB || fileA.startsWith('--') || fileB.startsWith('--')) {
      return usageError('compare needs two snapshot files');
    }
    let result;
    try {
      result = compare(readJson(fileA), readJson(fileB));
    } catch (e) {
      console.error(`\n${e.message}`);
      return process.exit(1);
    }
    console.log(formatCompare(result));
    console.log(`\n  reproduce: ${commandLine()}`);
    return;
  }

  if (cmd === 'render') {
    const file = argv[1];
    const out = value('out');
    if (!file || file.startsWith('--') || !out) return usageError('render needs <snapshot.json> and --out <report.html>');
    const snap = readJson(file);
    const a = audit(snap);
    writeOut(out, renderReport(snap, a));
    const v = a.metrics.visibility;
    console.log(`\n  ${out}`);
    console.log(`  visible ${v.found}/${v.measured} measured (${v.unreached} unreached, excluded), ${snap.readings.length} points drawn`);
    console.log(formatAudit(a));
    console.log(`\n  reproduce: ${snap.command}`);
    return process.exit(a.ok ? 0 : 1);
  }

  if (cmd === 'audit' || cmd === 'report') {
    const file = argv[1];
    if (!file) return usageError(`${cmd} needs a snapshot file`);
    const snap = readJson(file);
    const a = audit(snap);

    if (cmd === 'report') {
      printSummary(snap);
      console.log(`\n  reproduce: ${snap.command}`);
      if (!a.ok) console.log('\n  NOTE: this snapshot does not pass audit. Figures above are not publishable.');
    } else {
      console.log(`\n  ${file}`);
      console.log(formatAudit(a));
      console.log(`\n  reproduce: ${snap.command}`);
    }
    return process.exit(a.ok ? 0 : 1);
  }

  usageError(`unknown command: ${cmd}`);
}

main().catch((e) => {
  console.error(`\nfalloff: ${e.message}`);
  process.exit(1);
});
