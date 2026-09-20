/**
 * schema.mjs: what a reading is, and the one distinction everything rests on.
 *
 * ABSENT IS NOT THE SAME AS UNMEASURED.
 *
 * At every sampled point, one of three things is true:
 *
 *   FOUND      the business appeared, at rank N
 *   ABSENT     the point was measured and the business was not in the results
 *   UNREACHED  the point was never measured (timeout, block, quota, crash)
 *
 * A tool that merges the last two averages ABSENT and UNREACHED together as
 * "not visible", and every figure downstream is then quietly wrong in a
 * direction nobody can see: a scan that failed at 30 of 80 points reports the
 * same "37% visible" as a scan that completed and genuinely found nothing at
 * those points. `test/vacuum.test.mjs` builds both scans and shows the two
 * outputs.
 *
 * One of those says the business has no reach there. The other says we do not
 * know. So:
 *
 *   - `rank: null` with `status: 'absent'`  means MEASURED, NOT PRESENT
 *   - `status: 'unreached'`                 means NOT MEASURED
 *   - metrics take UNREACHED out of the denominator and report it separately
 *   - a snapshot that cannot say which is which does not publish
 *
 * Keeping these apart costs one field and is the whole reason the numbers
 * can be defended.
 */

/** A point was measured and the target appeared. */
export const FOUND = 'found';
/** A point was measured and the target did not appear. Real information. */
export const ABSENT = 'absent';
/** A point was not measured. Not information; an admission. */
export const UNREACHED = 'unreached';

export const STATUSES = [FOUND, ABSENT, UNREACHED];

/**
 * Ranks beyond this are recorded but sit outside the top 3.
 *
 * User-facing copy says "top 3". The constant keeps its API name so that
 * existing callers and recorded snapshots do not change meaning.
 */
export const PACK_SIZE = 3;

/**
 * ABSENT MEANS "NOT IN THE CAPTURED LIST OF THIS DEPTH".
 *
 * A provider hands back some number of rows per point, and that number is not
 * a constant: a Maps feed can return six rows at one point and ten at the
 * next. "Absent" therefore means the target was not in the rows that were
 * captured, and how many rows those were is part of the reading, not a
 * detail. Without it, a shallower capture looks like a smaller business.
 *
 * `listDepth` is the number of rows captured at that point. It is `null` when
 * the provider does not capture lists at all (the manual sheet records a rank
 * or an absence, not a list), and it is 0 for a provider that answered with
 * an empty list.
 */
/**
 * One reading, at one point.
 *
 * @param {object} o
 * @param {object} o.point      the planned point (from samplePlan)
 * @param {string} o.status     FOUND | ABSENT | UNREACHED
 * @param {number|null} o.rank  1-based rank when FOUND; null otherwise
 * @param {Array}  [o.results]  the competitor list seen at this point
 * @param {string} [o.error]    why, when UNREACHED
 * @param {number|null} [o.listDepth] rows captured here; null when no list was captured
 */
export function reading({ point, status, rank = null, results = [], error = null, listDepth = null }) {
  if (!STATUSES.includes(status)) {
    throw new Error(`reading: status must be one of ${STATUSES.join('|')}, got ${status}`);
  }
  if (status === FOUND && !(Number.isInteger(rank) && rank >= 1)) {
    throw new Error(`reading: FOUND requires an integer rank >= 1, got ${rank}`);
  }
  if (status !== FOUND && rank !== null) {
    throw new Error(`reading: only FOUND may carry a rank, got status=${status} rank=${rank}`);
  }
  if (status === UNREACHED && !error) {
    throw new Error('reading: UNREACHED must record why; an unexplained gap is indistinguishable from a lie');
  }
  if (listDepth !== null && !(Number.isInteger(listDepth) && listDepth >= 0)) {
    throw new Error(`reading: listDepth must be a non-negative integer or null, got ${listDepth}`);
  }
  if (listDepth !== null && listDepth !== results.length) {
    throw new Error(`reading: listDepth ${listDepth} does not match the ${results.length} row(s) recorded`);
  }
  if (status === UNREACHED && listDepth !== null) {
    throw new Error('reading: an UNREACHED point captured no list, so listDepth must be null');
  }
  return {
    ring: point.ring,
    index: point.index,
    lat: point.lat,
    lng: point.lng,
    dKm: point.dKm,
    bearing: point.bearing,
    label: point.label,
    status,
    rank,
    inPack: status === FOUND && rank <= PACK_SIZE,
    listDepth,
    results,
    error,
  };
}

/**
 * The capture depth across a set of readings: the shallowest and deepest list
 * the provider handed back. Recorded in `method.observation.listDepth` so a
 * reader can see what "absent" was absent from.
 *
 * @returns {{min: number, max: number}|null} null when no list was captured
 */
export function listDepthRange(readings) {
  const depths = readings.map((r) => r.listDepth).filter((d) => Number.isInteger(d));
  if (!depths.length) return null;
  return { min: Math.min(...depths), max: Math.max(...depths) };
}

/**
 * A complete snapshot: readings plus everything needed to reproduce them.
 *
 * `method` and `command` are not metadata. They are the difference between a
 * number and a claim. A snapshot without them cannot be audited, so it cannot
 * be published.
 */
export function snapshot({ target, query, plan, readings, provider, command, startedAt, finishedAt }) {
  if (!target?.name) throw new Error('snapshot: target.name is required');
  if (!query) throw new Error('snapshot: query is required');
  if (!command) throw new Error('snapshot: command is required; a figure without a way to reproduce it is not a figure');

  return {
    schema: 'falloff/snapshot@1',
    target,
    query,
    provider,
    // Everything that would change what the numbers MEAN, recorded so that
    // two snapshots can be compared honestly, or refused.
    method: {
      ...plan.method,
      provider: provider?.id ?? null,
      providerVersion: provider?.version ?? null,
      packSize: PACK_SIZE,
    },
    command,
    startedAt,
    finishedAt,
    readings,
  };
}

/** Counts by status. The denominator problem, made explicit. */
export function tally(readings) {
  const t = { found: 0, absent: 0, unreached: 0, total: readings.length };
  for (const r of readings) t[r.status]++;
  t.measured = t.found + t.absent;
  return t;
}
