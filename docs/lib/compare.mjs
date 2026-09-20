/**
 * compare.mjs: two snapshots of the same scan, point by point.
 *
 * Every study in this repository is a single pass. "Individual points move
 * between scans" was asserted in the README for months without anything in
 * the repo measuring it, and "fragile" was calibrated against nothing. This
 * is the instrument that would settle it: run the same plan twice and see how
 * many points changed.
 *
 * WHAT IT REFUSES. Two snapshots are comparable only if they measured the
 * same thing in the same way. The pins that decide that are the sampler, the
 * ring bounds, the budget, the growth ratio, the golden angle, the ring
 * floor, the latitude constant and the top-3 size, plus the query itself.
 * Any disagreement is refused by name rather than papered over: a diff
 * between two different geometries is not a diff, it is a coincidence.
 *
 * WHAT IT REPORTS. Per point, one of:
 *
 *   bothFound     seen in both passes (the rank change is counted separately)
 *   bothAbsent    measured in both, not there in either
 *   changed       found in one pass and absent in the other
 *   eitherUnreached  at least one pass never measured that point
 *
 * An unreached point in either pass is never counted as agreement or as a
 * change. It is not a comparison at all, and it keeps its own bucket for the
 * same reason ABSENT and UNREACHED keep theirs.
 */

/** Pins that must match before two snapshots may be compared. */
export const COMPARABLE_PINS = [
  'sampler',
  'rmin',
  'rmax',
  'budget',
  'growth',
  'goldenAngle',
  'minRingPoints',
  'kmPerDegLat',
  'packSize',
];

const key = (r) => `${r.ring}:${r.index}`;

/**
 * Compare two snapshots of the same plan.
 *
 * @param {object} a  the earlier snapshot
 * @param {object} b  the later snapshot
 * @returns {object}  counts, rank changes, and the changed points
 * @throws when the pins or the query differ
 */
export function compare(a, b) {
  if (!Array.isArray(a?.readings) || !Array.isArray(b?.readings)) {
    throw new Error('compare: both inputs must be snapshots with a readings array');
  }
  if (a.query !== b.query) {
    throw new Error(`compare: refusing, the queries differ ("${a.query}" and "${b.query}")`);
  }
  const differing = COMPARABLE_PINS.filter((p) => (a.method?.[p] ?? null) !== (b.method?.[p] ?? null));
  if (differing.length) {
    const detail = differing.map((p) => `${p} ${a.method?.[p] ?? 'unset'} vs ${b.method?.[p] ?? 'unset'}`).join(', ');
    throw new Error(`compare: refusing, the method pins differ (${detail}); these snapshots do not measure the same thing`);
  }

  const bByKey = new Map(b.readings.map((r) => [key(r), r]));
  const counts = { bothFound: 0, bothAbsent: 0, changed: 0, eitherUnreached: 0 };
  const changes = [];
  const rankDeltas = [];
  let missing = 0;

  for (const ra of a.readings) {
    const rb = bByKey.get(key(ra));
    if (!rb) {
      missing++;
      continue;
    }
    if (ra.status === 'unreached' || rb.status === 'unreached') {
      counts.eitherUnreached++;
      continue;
    }
    if (ra.status === 'found' && rb.status === 'found') {
      counts.bothFound++;
      rankDeltas.push(rb.rank - ra.rank);
      continue;
    }
    if (ra.status === 'absent' && rb.status === 'absent') {
      counts.bothAbsent++;
      continue;
    }
    counts.changed++;
    changes.push({
      ring: ra.ring,
      index: ra.index,
      dKm: ra.dKm,
      label: ra.label,
      from: ra.status,
      to: rb.status,
      fromRank: ra.rank,
      toRank: rb.rank,
    });
  }
  if (missing) {
    throw new Error(`compare: refusing, ${missing} point(s) in the first snapshot have no counterpart in the second`);
  }

  // The distribution of rank movement, as counts and not as an average: a
  // mean of a handful of ranks hides whether anything moved a long way.
  const deltaCounts = new Map();
  for (const d of rankDeltas) deltaCounts.set(d, (deltaCounts.get(d) ?? 0) + 1);
  const rankChange = [...deltaCounts.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([delta, n]) => ({ delta, points: n }));

  const compared = counts.bothFound + counts.bothAbsent + counts.changed;
  return {
    query: a.query,
    points: a.readings.length,
    counts,
    compared,
    agreementShare: compared ? (counts.bothFound + counts.bothAbsent) / compared : null,
    rankChange,
    rankUnchanged: deltaCounts.get(0) ?? 0,
    changes,
    observedA: a.startedAt ?? null,
    observedB: b.startedAt ?? null,
  };
}

/** Human-readable comparison. Counts, with their denominator. */
export function formatCompare(c) {
  const lines = [];
  lines.push(`\n  query "${c.query}", ${c.points} planned points`);
  lines.push(`  first observed ${String(c.observedA).slice(0, 10)}, second ${String(c.observedB).slice(0, 10)}\n`);
  lines.push(`  both found       ${c.counts.bothFound}/${c.compared} compared`);
  lines.push(`  both absent      ${c.counts.bothAbsent}/${c.compared} compared`);
  lines.push(`  changed          ${c.counts.changed}/${c.compared} compared`);
  lines.push(`  either unreached ${c.counts.eitherUnreached} (not compared, not counted as agreement)`);
  lines.push(
    c.compared
      ? `  agreement        ${((c.agreementShare ?? 0) * 100).toFixed(0)}% of compared points`
      : '  agreement        not reportable: no point was measured in both passes',
  );
  lines.push('\n  rank change, for points found in both');
  if (!c.rankChange.length) {
    lines.push('    no point was found in both passes');
  } else {
    for (const { delta, points } of c.rankChange) {
      const word = delta === 0 ? 'unchanged' : delta > 0 ? `${delta} worse` : `${-delta} better`;
      lines.push(`    ${String(word).padStart(12)}  ${points} point(s)`);
    }
  }
  if (c.changes.length) {
    lines.push('\n  points that changed state');
    for (const ch of c.changes.slice(0, 20)) {
      lines.push(`    ${String(ch.label).padEnd(14)} ${ch.from}${ch.fromRank ? ` (rank ${ch.fromRank})` : ''} -> ${ch.to}${ch.toRank ? ` (rank ${ch.toRank})` : ''}`);
    }
    if (c.changes.length > 20) lines.push(`    and ${c.changes.length - 20} more`);
  }
  return lines.join('\n');
}
