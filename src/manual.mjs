/**
 * manual.mjs: the free path a person can run in about twenty minutes.
 *
 * No key, no API, no scraper. Falloff writes the plan and a sheet with one
 * row per sample point and a Google Maps link for each. The person opens
 * each link in a logged-out browser, reads the results list, and writes
 * down what they saw. Then `ingest` turns the filled sheet into a snapshot
 * that carries the same geometry, the same three statuses, and the same
 * audit as any machine-made one.
 *
 * WHY A BLANK ROW IS UNREACHED. A person who did not get to a point has not
 * measured it. The sheet does not let that become "absent" by default: a
 * blank status is recorded as UNREACHED with the note, or 'not recorded'.
 * If they looked and the business was not there, they write `absent`. The
 * difference is the whole tool.
 *
 * WHAT INGEST REFUSES. A `found` without an integer rank of 1 or more
 * (the row and line number are named). A status it does not know. A sheet
 * whose points do not match the plan it was made from: a moved coordinate,
 * a missing or duplicated point. The plan is the geometry; the sheet is
 * only allowed to fill it in.
 *
 * WHAT IT MEASURES. The provider pins say `surface: 'google-maps-web @13z'`
 * because that is what the links open. A rank read this way is the order
 * of the Maps results feed for that person, in that browser, at that
 * moment. The observer's initials are recorded so a reader knows a person
 * did the reading.
 */

import { samplePlan } from './sample.mjs';
import { reading, snapshot, FOUND, ABSENT, UNREACHED } from './schema.mjs';
import { parseCsv, toCsv } from './csv.mjs';

export const PLAN_SCHEMA = 'falloff/plan@1';
export const SHEET_HEADER = ['ring', 'index', 'label', 'lat', 'lng', 'mapsUrl', 'status', 'rank', 'note'];
export const ZOOM = '13z';
export const NOT_RECORDED = 'not recorded';

/** The link the person opens for one point. Zoom is pinned at 13. */
export function mapsUrl(term, lat, lng) {
  return `https://www.google.com/maps/search/${encodeURIComponent(term)}/@${lat},${lng},${ZOOM}`;
}

/**
 * A plan file: samplePlan output plus the query and a link per point.
 * Deterministic; no clock.
 */
export function makePlan({ lat, lng, query, preset, rmin, rmax, points }) {
  if (!query) throw new Error('plan: query is required; it goes into every link');
  const plan = samplePlan({ lat, lng, preset, rmin, rmax, points });
  return {
    schema: PLAN_SCHEMA,
    query,
    centre: { lat, lng },
    rings: plan.rings,
    budget: plan.budget,
    method: plan.method,
    points: plan.points.map((p) => ({ ...p, mapsUrl: mapsUrl(query, p.lat, p.lng) })),
  };
}

/** The CSV sheet for a plan. Status, rank and note are left blank. */
export function planSheet(plan) {
  const rows = [SHEET_HEADER];
  for (const p of plan.points) {
    rows.push([p.ring, p.index, p.label, p.lat, p.lng, p.mapsUrl, '', '', '']);
  }
  return toCsv(rows);
}

/**
 * How far a sheet's coordinates may sit from the plan's.
 *
 * The rows are keyed by ring and index, so the coordinate columns are a
 * cross-check, not the identity. A spreadsheet that reformats a number to ten
 * significant digits on save moves it by about 1e-8 degrees, roughly a
 * millimetre on the ground, and refusing that threw away twenty minutes of
 * someone's work for nothing. The tolerance is the auditor's own: 1e-5
 * degrees is about a metre, far below the resolution of anything measured
 * here, and still small enough that a row pasted from another point is
 * refused by its row number.
 */
const COORD_TOLERANCE_DEG = 1e-5;

/**
 * Build a snapshot from a plan and a filled sheet.
 *
 * @param {object} o
 * @param {object} o.plan         the plan file (from makePlan)
 * @param {string} o.csv          the filled sheet text
 * @param {string} o.name         the business
 * @param {string} [o.id]         any stable id for the business
 * @param {string} [o.observer]   initials of the person who read the links
 * @param {string} o.command      the ingest command line (the reproduce command)
 * @param {string} [o.observedAt] ISO time the sheet was filled; defaults to now
 */
export function ingestSheet({ plan, csv, name, id = null, observer = null, command, observedAt }) {
  if (plan?.schema !== PLAN_SCHEMA) throw new Error(`ingest: plan is not ${PLAN_SCHEMA}`);
  if (!name) throw new Error('ingest: --name is required');
  if (!command) throw new Error('ingest: command is required');

  const records = parseCsv(csv);
  if (!records.length) throw new Error('ingest: the sheet is empty');
  const header = records[0].fields.map((h) => h.trim());
  const col = {};
  for (const h of SHEET_HEADER) {
    const i = header.indexOf(h);
    if (i === -1) throw new Error(`ingest: sheet header is missing the "${h}" column (line ${records[0].line})`);
    col[h] = i;
  }

  const byKey = new Map(plan.points.map((p) => [`${p.ring}:${p.index}`, p]));
  const seen = new Set();
  const readings = [];

  for (const rec of records.slice(1)) {
    const f = (k) => (rec.fields[col[k]] ?? '').trim();
    const where = `row ${rec.line - 1} (line ${rec.line})`;
    const ring = Number(f('ring'));
    const index = Number(f('index'));
    if (!Number.isInteger(ring) || !Number.isInteger(index)) {
      throw new Error(`ingest: ${where}: ring/index are not integers`);
    }
    const key = `${ring}:${index}`;
    const point = byKey.get(key);
    if (!point) throw new Error(`ingest: ${where}: point ${key} is not in the plan`);
    if (seen.has(key)) throw new Error(`ingest: ${where}: point ${key} appears twice`);
    seen.add(key);

    const lat = Number(f('lat'));
    const lng = Number(f('lng'));
    const drift = Math.abs(lat - point.lat) + Math.abs(lng - point.lng);
    if (!(drift <= COORD_TOLERANCE_DEG)) {
      throw new Error(
        `ingest: ${where}: coordinates ${lat},${lng} are ${drift.toExponential(2)} deg from the plan's ` +
          `${point.lat},${point.lng} for ${key}, past the ${COORD_TOLERANCE_DEG} deg tolerance; ` +
          'the sheet may only fill the plan in, not move it',
      );
    }

    const status = f('status').toLowerCase();
    const rankText = f('rank');
    const note = f('note');

    if (status === 'found') {
      const rank = /^\d+$/.test(rankText) ? Number(rankText) : NaN;
      if (!(Number.isInteger(rank) && rank >= 1)) {
        throw new Error(`ingest: ${where}: "found" needs an integer rank of 1 or more, got "${rankText}"`);
      }
      readings.push(reading({ point, status: FOUND, rank, results: [] }));
    } else if (status === 'absent') {
      if (rankText) throw new Error(`ingest: ${where}: "absent" cannot carry a rank (got "${rankText}")`);
      readings.push(reading({ point, status: ABSENT, results: [] }));
    } else if (status === '' || status === 'unreached') {
      if (rankText) throw new Error(`ingest: ${where}: an unreached row cannot carry a rank (got "${rankText}")`);
      readings.push(reading({ point, status: UNREACHED, error: note || NOT_RECORDED }));
    } else {
      throw new Error(`ingest: ${where}: unknown status "${status}"; use found, absent, unreached, or leave it blank`);
    }
  }

  if (seen.size !== plan.points.length) {
    const missing = plan.points.filter((p) => !seen.has(`${p.ring}:${p.index}`)).map((p) => `${p.ring}:${p.index}`);
    throw new Error(`ingest: the sheet is missing ${missing.length} plan point(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}`);
  }

  readings.sort((a, b) => a.ring - b.ring || a.index - b.index);
  const at = observedAt ?? new Date().toISOString();

  const snap = snapshot({
    target: { name, id, lat: plan.centre.lat, lng: plan.centre.lng },
    query: plan.query,
    plan: { method: plan.method },
    readings,
    provider: { id: 'manual', version: 'sheet@1', pins: { observer, surface: `google-maps-web @${ZOOM}` } },
    command,
    startedAt: at,
    finishedAt: at,
  });
  // The sheet records a rank or an absence, never the list it was read from,
  // so there is no capture depth. "Absent" here means the person looked and
  // did not see it, at whatever depth they scrolled.
  snap.method.observation = {
    surface: `google-maps-web @${ZOOM}`,
    passes: 1,
    listDepth: null,
    listDepthNote: 'the sheet records no list, so the depth a reader scrolled to is not known',
  };
  return snap;
}
