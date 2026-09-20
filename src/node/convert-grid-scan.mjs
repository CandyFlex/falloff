/**
 * node/convert-grid-scan.mjs: turn a legacy grid-scan radial snapshot into
 * falloff/snapshot@1.
 *
 * WHY THIS EXISTS. Before Falloff, the author wrote an automated browser scan
 * that walked the same radial-v2 geometry and saved its own JSON. That scanner
 * is not in this repository and is not shipped. Its files are real, dated
 * observations of the Google Maps results feed, and they are the only
 * measurements this project has that were taken on that surface. They are
 * worth keeping, but only if they can be audited like everything else. So
 * this converter does not copy figures across. It rebuilds the snapshot from
 * the raw rows and lets `audit` decide.
 *
 * WHAT IS TRUSTED AND WHAT IS RECOMPUTED.
 *
 *   - Geometry is recomputed. The legacy scanner used 110.57 km per degree of
 *     latitude, so the plan is replayed with that pin, and every legacy point
 *     must land on the replayed point to 1e-9 degrees with the same label.
 *     If it does not, the file was not produced by this geometry and the
 *     conversion refuses. Nothing is nudged into place.
 *
 *   - Status is mapped, not inferred. The legacy format already kept the
 *     distinction Falloff is built on: a failed point carries
 *     `unreachable: true` and an `error`, and a measured point with no
 *     sighting carries `rank: null`. UNREACHED stays UNREACHED with its reason
 *     (or an explicit "no reason recorded", which the auditor accepts as a
 *     reason but a reader will notice). It never becomes ABSENT.
 *
 *   - Rank is re-derived from the captured result list by place id. The
 *     legacy scanner's own source says files without the identity stamp
 *     `pid-first-v2` were written by a matcher that let a 0.6 token overlap
 *     count as identity (two different businesses sharing the words
 *     "Bar" and "Grill" counted as the same one), so their stated rank
 *     column cannot be trusted. Rather than trust some files and not others, the rank at
 *     every point is the position of the target's place id in that point's
 *     list, and the number of rows where the stated column disagreed is
 *     recorded in `provenance`. When the legacy scan took several passes the
 *     stated rank is a median the pack cannot reproduce, and the conversion
 *     refuses unless the file carries the identity stamp.
 *
 * WHAT THE RESULT MEANS. Ranks are the order of the Google Maps results feed
 * as seen by a logged-out desktop browser at zoom 13. A Places API re-scan of
 * the same coordinates measures a different surface and may differ. The
 * provider id says so, and the provenance block says so in words.
 */

import { readFileSync } from 'node:fs';
import { basename as pathBasename } from 'node:path';

import { samplePlan, PRESETS } from '../sample.mjs';
import { reading, snapshot, listDepthRange, FOUND, ABSENT, UNREACHED } from '../schema.mjs';

/** The latitude constant the legacy scanner used. Recorded, not assumed. */
export const LEGACY_KM_PER_DEG_LAT = 110.57;

/** Coordinate agreement required between a legacy point and its replay. */
export const COORD_TOLERANCE_DEG = 1e-9;

export const CONVERTER = 'falloff/convert@1';

const SURFACE_NOTE =
  'ranks are the order of the Google Maps results feed as seen by a logged-out desktop browser at zoom 13; ' +
  'a Places API re-scan measures a different surface and may differ';

function refuse(msg) {
  throw new Error(`convert: ${msg}`);
}

/** Position (1-based) of the target's place id in a legacy business list. */
function rankById(businesses, pid) {
  if (!pid) return null;
  const i = (businesses ?? []).findIndex((b) => b.pid && b.pid === pid);
  return i >= 0 ? i + 1 : null;
}

/**
 * Convert a parsed legacy file.
 *
 * @param {object} legacy        the parsed grid-scan JSON
 * @param {object} [opts]
 * @param {string} [opts.basename]     file name to record in the reproduce command
 * @param {string} [opts.convertedAt]  ISO timestamp; injectable for deterministic output
 * @returns {object} a falloff/snapshot@1 (not yet audited)
 */
export function convertGridScan(legacy, { basename = 'legacy.json', convertedAt = new Date().toISOString() } = {}) {
  if (!legacy || typeof legacy !== 'object') refuse('input is not an object');
  if (legacy.kind !== 'grid' || legacy.mode !== 'radial') {
    refuse(`only kind=grid mode=radial files convert; got kind=${legacy.kind} mode=${legacy.mode}`);
  }
  const preset = legacy.preset;
  if (!PRESETS[preset]) {
    refuse(`preset "${preset}" is not one of ${Object.keys(PRESETS).join('/')}; radial-v1 files have no preset and do not convert`);
  }
  const t = legacy.target ?? {};
  if (!t.name) refuse('target.name is missing');
  if (!Number.isFinite(t.lat) || !Number.isFinite(t.lng)) refuse('target.lat/lng are missing');
  if (!legacy.query) refuse('query is missing');
  if (!Array.isArray(legacy.results)) refuse('results is not an array');
  if (!legacy.pulled) refuse('pulled (observation time) is missing');

  const passes = legacy.method?.passes ?? 1;
  const identity = legacy.method?.identity ?? null;
  if (passes > 1 && identity !== 'pid-first-v2') {
    refuse(`file took ${passes} passes and carries no identity stamp; its median rank cannot be re-derived from the pack`);
  }

  // Replay the plan on the legacy earth. Same formula, the constant it used.
  const plan = samplePlan({ lat: t.lat, lng: t.lng, preset, kmPerDegLat: LEGACY_KM_PER_DEG_LAT });
  if (plan.points.length !== legacy.results.length) {
    refuse(
      `preset ${preset} replans to ${plan.points.length} points but the file has ${legacy.results.length} rows; ` +
        'the file was not produced by this geometry',
    );
  }
  const byKey = new Map(plan.points.map((p) => [`${p.ring}:${p.index}`, p]));

  const readings = [];
  let disagreements = 0;
  let directRows = 0;
  let unreachedNoReason = 0;
  const seen = new Set();

  for (const row of legacy.results) {
    const key = `${row.row}:${row.col}`;
    const point = byKey.get(key);
    if (!point) refuse(`legacy row ${key} has no counterpart in the replanned geometry`);
    if (seen.has(key)) refuse(`legacy row ${key} appears twice`);
    seen.add(key);

    const drift = Math.abs(point.lat - row.lat) + Math.abs(point.lng - row.lng);
    if (!(drift <= COORD_TOLERANCE_DEG)) {
      refuse(
        `legacy point ${key} (${row.label}) is at ${row.lat},${row.lng} but the replay puts it at ` +
          `${point.lat},${point.lng} (drift ${drift.toExponential(2)} deg); refusing rather than moving it`,
      );
    }
    if (point.label !== row.label) {
      refuse(`legacy point ${key} is labelled "${row.label}" but the replay labels it "${point.label}"`);
    }

    if (row.unreachable) {
      const error = row.error || 'unreachable (no reason recorded)';
      if (!row.error) unreachedNoReason++;
      readings.push(reading({ point, status: UNREACHED, error }));
      continue;
    }

    if (row.direct) directRows++;
    const businesses = row.businesses ?? [];
    const results = businesses.map((b) => ({
      id: b.pid ?? null,
      name: b.name ?? '',
      rating: b.rating ?? null,
      reviews: b.reviews ?? null,
    }));

    // Rank comes from the list, not from the column. The column is checked.
    const rank = passes > 1 ? (Number.isInteger(row.rank) && row.rank >= 1 ? row.rank : null) : rankById(businesses, t.pid);
    const stated = Number.isInteger(row.rank) && row.rank >= 1 ? row.rank : null;
    if (stated !== rank) disagreements++;

    // The legacy files captured between six and ten rows per point. That
    // depth is what "absent" was absent from, so it is carried across rather
    // than thrown away.
    const listDepth = results.length;
    readings.push(
      rank
        ? reading({ point, status: FOUND, rank, results, listDepth })
        : reading({ point, status: ABSENT, results, listDepth }),
    );
  }

  const snap = snapshot({
    target: { name: t.name, id: t.pid ?? null, lat: t.lat, lng: t.lng },
    query: legacy.query,
    plan,
    readings,
    provider: { id: 'google-maps-web', version: 'grid-scan radial-v2 @13z' },
    command: `falloff convert ${basename}`,
    startedAt: legacy.pulled,
    // The legacy files record one timestamp, the moment the scan was pulled.
    // An 80-point scan is not instantaneous, so the end is not known and is
    // not invented here.
    finishedAt: null,
  });

  // The surface pins. They are what make this snapshot comparable to
  // another one from the same instrument, and not to one from Places.
  snap.method.observation = {
    zoom: legacy.method?.zoom ?? null,
    surface: legacy.method?.surface ?? null,
    loggedOut: legacy.method?.loggedOut ?? null,
    passes,
    locale: legacy.method?.locale ?? null,
    identity,
    // What "absent" was absent from: the shallowest and deepest list captured.
    listDepth: listDepthRange(readings),
    observationWindow: 'unknown; the source file records one timestamp for the whole scan',
  };

  const found = readings.filter((r) => r.status === FOUND).length;
  snap.provenance = {
    source: "an automated browser scan written by this project's author; that scanner is not in this repository",
    sourceFile: basename,
    observedAt: legacy.pulled,
    observationWindow: 'unknown; the source file records one timestamp for the whole scan',
    reobserve: 'this command re-renders the recorded file; re-observing these points needs your own provider',
    convertedAt,
    converter: CONVERTER,
    note: SURFACE_NOTE,
    rankSource:
      passes > 1
        ? 'stated rank column (median across passes; file carries identity pid-first-v2)'
        : 'position of the target place id in each point\'s captured list',
    rankColumnDisagreements: disagreements,
    sourceStated: { ok: legacy.ok ?? null, failed: legacy.failed ?? null, found: legacy.found ?? null },
    derived: { found, unreached: readings.length - readings.filter((r) => r.status !== UNREACHED).length },
    ...(directRows ? { directRows, directNote: 'brand search landed on a place page; the single landed listing is the result list' } : {}),
    ...(unreachedNoReason ? { unreachedWithoutReason: unreachedNoReason } : {}),
  };

  return snap;
}

/** Read and convert a legacy file from disk. */
export function convertGridScanFile(path, opts = {}) {
  const legacy = JSON.parse(readFileSync(path, 'utf8'));
  return convertGridScan(legacy, { basename: pathBasename(path), ...opts });
}
