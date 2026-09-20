/**
 * audit.mjs: the adversarial check. Arithmetic on raw readings, never judgment.
 *
 * The scanner is never trusted to grade itself. This recomputes everything
 * from the snapshot and reports concrete PASS/FAIL. Nothing here calls a
 * model, reads a summary, or takes a stated figure on faith.
 *
 * THE RULE: if a claim cannot be recomputed here, it is not a claim the
 * report may make.
 *
 * WHAT A PASS MEANS, AND WHAT IT DOES NOT.
 *
 * A pass says the file is internally consistent: the geometry replays from
 * the pins it records, every planned point has exactly one reading, the
 * statuses and ranks agree with the lists that were captured, and the
 * accounting adds up. It is NOT a certificate that the readings are true.
 * A file can be internally consistent and still be a forgery, because some
 * facts are simply not in it:
 *
 *   - A fabricated results list. Rows can be invented and the target's id
 *     inserted; nothing in the file contradicts that. Recording `listDepth`
 *     per point narrows this (a row added or removed no longer matches the
 *     recorded depth, and a depth outside the observed range fails), but a
 *     list forged whole, at the right depth, is consistent.
 *   - An unreached point rewritten as absent. The reason is deleted with it,
 *     so the file simply says a point was measured and nothing was there.
 *   - Two readings swapped between points that captured lists of the same
 *     depth. Nothing ties a captured list to a coordinate.
 *   - The query, the timestamps and the reproduce command. They are recorded,
 *     not authenticated.
 *
 * Those limits are printed in README under "what the audit cannot know" so
 * that a pass is never read as more than it is.
 *
 * Exit codes: 0 = clean, 1 = a FAIL was found.
 */

import { FOUND, ABSENT, UNREACHED, STATUSES, PACK_SIZE } from './schema.mjs';
import { samplePlan, SAMPLERS, KM_PER_DEG_LAT } from './sample.mjs';
import { summarise } from './metrics.mjs';

const CRITICAL = 'CRITICAL';
const WARN = 'WARN';

/** How far a replayed coordinate may sit from the recorded one, in degrees. */
const COORD_TOLERANCE_DEG = 1e-6;
/** Bearings are recorded to one decimal place. */
const BEARING_TOLERANCE_DEG = 0.05;
/** Ring radii are recorded to one decimal place. */
const DKM_TOLERANCE_KM = 0.05;

function finding(level, id, message, detail = null) {
  return { level, id, message, detail };
}

/** Does this snapshot capture competitor lists at all? */
function capturesLists(snap) {
  return (snap.readings ?? []).some((r) => Number.isInteger(r.listDepth) || (r.results ?? []).length > 0);
}

/** A. Structure: does the snapshot even describe what it did? */
function auditStructure(snap) {
  const out = [];
  if (snap.schema !== 'falloff/snapshot@1') {
    out.push(finding(CRITICAL, 'A1', `unknown schema "${snap.schema}"`));
  }
  if (!snap.command) {
    out.push(finding(CRITICAL, 'A2', 'no reproduce command recorded'));
  }
  for (const pin of ['sampler', 'rmin', 'rmax', 'budget', 'growth', 'goldenAngle', 'packSize']) {
    if (snap.method?.[pin] === undefined) {
      out.push(finding(CRITICAL, 'A3', `method pin missing: ${pin}`));
    }
  }
  // packSize is not a free field. Widening it turns every sighting into a
  // top-3 sighting, which is the cheapest lie in the file.
  if (snap.method?.packSize !== undefined && snap.method.packSize !== PACK_SIZE) {
    out.push(
      finding(CRITICAL, 'A3b', `method.packSize is ${snap.method.packSize} but this build measures the top ${PACK_SIZE}`),
    );
  }
  if (!snap.provider?.id) {
    out.push(finding(CRITICAL, 'A4', 'no provider recorded; the reading cannot be attributed'));
  }

  if (snap.redaction) {
    // A redaction block is a claim that the names are gone. Check it.
    const leaks = [];
    if (snap.target?.name && snap.target.name !== 'withheld') leaks.push(`target.name is "${snap.target.name}"`);
    let named = 0;
    for (const r of snap.readings ?? []) {
      for (const b of r.results ?? []) if (b && Object.prototype.hasOwnProperty.call(b, 'name')) named++;
    }
    if (named) leaks.push(`${named} result row(s) still carry a name key`);
    if (leaks.length) {
      out.push(finding(CRITICAL, 'A5', `redaction block claims names are withheld, but ${leaks.join('; ')}`));
    } else {
      out.push(
        finding(
          WARN,
          'A5',
          `names withheld (${(snap.redaction.fields ?? []).join(', ')}); no name survives in this file and the figures are unaffected`,
        ),
      );
    }
  }

  // The identity of who answered is part of the method. The two places it is
  // written have to agree, or one of them was edited.
  if (snap.provider?.id && snap.method?.provider !== undefined && snap.method.provider !== snap.provider.id) {
    out.push(
      finding(CRITICAL, 'A7', `method.provider is "${snap.method.provider}" but provider.id is "${snap.provider.id}"`),
    );
  }
  if (snap.provider && snap.method?.providerVersion !== undefined && (snap.provider.version ?? null) !== snap.method.providerVersion) {
    out.push(
      finding(
        CRITICAL,
        'A7',
        `method.providerVersion is "${snap.method.providerVersion}" but provider.version is "${snap.provider.version ?? null}"`,
      ),
    );
  }

  // A rank cannot be checked against a list unless the target has an id.
  const anyResultIds = (snap.readings ?? []).some((r) => (r.results ?? []).some((b) => b?.id));
  if (anyResultIds && !snap.target?.id) {
    out.push(
      finding(CRITICAL, 'A8', 'results carry ids but target.id is missing, so no rank in this file can be checked'),
    );
  }
  return out;
}

/** B. Reachability: the accounting has to add up, exactly. */
function auditTally(snap) {
  const out = [];
  const rs = snap.readings ?? [];
  const counts = { found: 0, absent: 0, unreached: 0 };
  for (const r of rs) {
    if (!STATUSES.includes(r.status)) {
      out.push(finding(CRITICAL, 'B1', `unknown status "${r.status}" at ${r.label}`));
      continue;
    }
    counts[r.status]++;
  }
  if (snap.method?.budget && rs.length !== snap.method.budget) {
    out.push(
      finding(WARN, 'B3', `budget was ${snap.method.budget} but ${rs.length} readings recorded`),
    );
  }
  const unreachedShare = rs.length ? counts.unreached / rs.length : 0;
  if (unreachedShare > 0.1) {
    out.push(
      finding(
        CRITICAL,
        'B4',
        `${counts.unreached}/${rs.length} points unreached (${(unreachedShare * 100).toFixed(0)}%); too many gaps to publish`,
      ),
    );
  }
  return out;
}

/** C. The distinction. The single most important check in the file. */
function auditAbsenceIntegrity(snap) {
  const out = [];
  const targetId = snap.target?.id;
  const lists = capturesLists(snap);
  const depthRange = snap.method?.observation?.listDepth ?? null;

  for (const r of snap.readings ?? []) {
    const results = r.results ?? [];
    if (r.status === FOUND && !(Number.isInteger(r.rank) && r.rank >= 1)) {
      out.push(finding(CRITICAL, 'C1', `FOUND without a valid rank at ${r.label}`, r.rank));
    }
    if (r.status !== FOUND && r.rank !== null) {
      out.push(finding(CRITICAL, 'C2', `${r.status} carries rank ${r.rank} at ${r.label}`));
    }
    if (r.status === UNREACHED && !r.error) {
      out.push(finding(CRITICAL, 'C3', `UNREACHED with no reason at ${r.label}`));
    }
    if (r.status === ABSENT && r.error) {
      out.push(
        finding(CRITICAL, 'C4', `ABSENT but carries an error at ${r.label}; that is UNREACHED`, r.error),
      );
    }
    if (r.status === UNREACHED && results.length) {
      out.push(finding(CRITICAL, 'C5', `UNREACHED but has results at ${r.label}`));
    }

    // A rank is a position in a list. When the list and the ids are both
    // recorded, the position has to hold the target. Otherwise the rank was
    // stated, not observed.
    const rowIds = results.map((b) => b?.id).filter(Boolean);
    if (r.status === FOUND && Number.isInteger(r.rank)) {
      if (lists && r.rank > results.length) {
        out.push(
          finding(
            CRITICAL,
            'C6',
            `FOUND at rank ${r.rank} at ${r.label}, but only ${results.length} row(s) were captured there`,
          ),
        );
      } else if (targetId && rowIds.length) {
        const atRank = results[r.rank - 1];
        if (!atRank?.id) {
          out.push(finding(CRITICAL, 'C6', `FOUND at rank ${r.rank} at ${r.label}, but the row at that rank carries no id`));
        } else if (atRank.id !== targetId) {
          out.push(
            finding(CRITICAL, 'C6', `FOUND at rank ${r.rank} at ${r.label}, but the result at that rank is a different id`, atRank.id),
          );
        }
      } else if (targetId && lists && results.length) {
        out.push(
          finding(CRITICAL, 'C6', `FOUND at rank ${r.rank} at ${r.label}, but no row in the captured list carries an id to check it against`),
        );
      }
    }

    // A list that contains the target is not an absence.
    if (r.status === ABSENT && targetId && rowIds.includes(targetId)) {
      out.push(
        finding(CRITICAL, 'C7', `ABSENT at ${r.label}, but the captured list contains the target's own id`, targetId),
      );
    }

    // The capture depth is part of the reading, so it has to match the rows.
    if (r.status !== UNREACHED) {
      if (Number.isInteger(r.listDepth)) {
        if (r.listDepth !== results.length) {
          out.push(
            finding(CRITICAL, 'C8', `listDepth ${r.listDepth} at ${r.label} but ${results.length} row(s) recorded`),
          );
        }
        if (depthRange && (r.listDepth < depthRange.min || r.listDepth > depthRange.max)) {
          out.push(
            finding(
              CRITICAL,
              'C8',
              `listDepth ${r.listDepth} at ${r.label} is outside the recorded range ${depthRange.min}-${depthRange.max}`,
            ),
          );
        }
      } else if (results.length) {
        out.push(finding(CRITICAL, 'C8', `${results.length} row(s) captured at ${r.label} but no listDepth recorded`));
      } else if (lists) {
        out.push(
          finding(WARN, 'C9', `${r.status} at ${r.label} with no captured list, in a snapshot whose other points captured one`),
        );
      }
    }
    if (r.status === UNREACHED && r.listDepth != null) {
      out.push(finding(CRITICAL, 'C8', `UNREACHED at ${r.label} but a listDepth is recorded`));
    }
  }
  return out;
}

/** D. Geometry: do the recorded points match the method that claims to produce them? */
function auditGeometry(snap) {
  const out = [];
  const m = snap.method;
  const readings = snap.readings ?? [];
  if (!m) {
    out.push(finding(CRITICAL, 'D0', 'no method block; the geometry cannot be replayed'));
    return out;
  }
  const spec = SAMPLERS[m.sampler];
  if (!spec) {
    // Refusing an unknown sampler is the point. Returning early on one meant
    // that renaming the sampler skipped every geometry check in this file.
    out.push(
      finding(
        CRITICAL,
        'D0',
        `unknown sampler "${m.sampler}"; this build can replay ${Object.keys(SAMPLERS).join(', ')} and will not pass geometry it cannot check`,
      ),
    );
    return out;
  }

  // Pins are part of what a sampler version IS. Only the ones the version
  // says may vary are allowed to.
  for (const [pin, want] of Object.entries(spec.pins)) {
    const got = m[pin];
    if (spec.mayVary.includes(pin)) continue;
    if (got !== want) {
      out.push(
        finding(CRITICAL, 'D5', `method.${pin} is ${got} but sampler ${m.sampler} is defined with ${want}`),
      );
    }
  }
  if (out.length) return out; // a replay from impossible pins says nothing useful

  const home = readings.find((r) => r.ring === 0);
  if (!home) {
    out.push(finding(CRITICAL, 'D1', 'no home point in readings'));
    return out;
  }
  // The home reading and the target have to be the same place. Nothing else
  // in the file ties the scan to the business it claims to be about.
  if (Number.isFinite(snap.target?.lat) && Number.isFinite(snap.target?.lng)) {
    const off = Math.abs(snap.target.lat - home.lat) + Math.abs(snap.target.lng - home.lng);
    if (!(off <= COORD_TOLERANCE_DEG)) {
      out.push(
        finding(
          CRITICAL,
          'D6',
          `target is at ${snap.target.lat},${snap.target.lng} but the home point is at ${home.lat},${home.lng} (${off.toExponential(2)} deg apart)`,
        ),
      );
    }
  } else {
    out.push(finding(CRITICAL, 'D6', 'target has no coordinates to check the home point against'));
  }

  let replan;
  try {
    // Replay on the pins the snapshot recorded, not on this module's
    // constants. A recorded pin that is only read back by the thing that
    // wrote it is decoration.
    replan = samplePlan({
      lat: home.lat,
      lng: home.lng,
      rmin: m.rmin,
      rmax: m.rmax,
      points: m.budget,
      kmPerDegLat: m.kmPerDegLat ?? KM_PER_DEG_LAT,
      growth: m.growth,
      goldenAngle: m.goldenAngle,
      minRingPoints: m.minRingPoints,
    });
  } catch (e) {
    out.push(finding(CRITICAL, 'D2', `method pins do not produce a valid plan: ${e.message}`));
    return out;
  }
  if (replan.points.length !== readings.length) {
    out.push(
      finding(
        CRITICAL,
        'D3',
        `replanning from the recorded pins yields ${replan.points.length} points, snapshot has ${readings.length}`,
      ),
    );
  }

  // Exactly one reading per planned point. Comparing lengths is not enough:
  // a duplicated reading and a deleted one keep the count.
  const planned = new Map(replan.points.map((p) => [`${p.ring}:${p.index}`, p]));
  const seen = new Map();
  let drift = 0;
  const mismatches = [];
  for (const r of readings) {
    const key = `${r.ring}:${r.index}`;
    const p = planned.get(key);
    if (!p) {
      out.push(finding(CRITICAL, 'D7', `reading at ring ${r.ring} index ${r.index} (${r.label}) has no planned counterpart`));
      continue;
    }
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) > 1) {
      out.push(finding(CRITICAL, 'D8', `planned point ${key} has ${seen.get(key)} readings; exactly one is allowed`));
      continue;
    }
    drift = Math.max(drift, Math.abs(p.lat - r.lat) + Math.abs(p.lng - r.lng));
    // Everything the plan decides is checked, not just the coordinates.
    // Doubling every dKm used to move the printed edges without a finding.
    if (!(Math.abs((r.dKm ?? NaN) - p.dKm) <= DKM_TOLERANCE_KM)) {
      mismatches.push(`${key}: dKm ${r.dKm} but the plan puts that point at ${p.dKm} km`);
    }
    const bearingOff =
      p.bearing === null ? (r.bearing === null ? 0 : Infinity) : Math.abs((r.bearing ?? NaN) - p.bearing);
    if (!(bearingOff <= BEARING_TOLERANCE_DEG)) {
      mismatches.push(`${key}: bearing ${r.bearing} but the plan gives ${p.bearing}`);
    }
    if (r.label !== p.label) {
      mismatches.push(`${key}: label "${r.label}" but the plan gives "${p.label}"`);
    }
  }
  for (const key of planned.keys()) {
    if (!seen.has(key)) out.push(finding(CRITICAL, 'D9', `planned point ${key} has no reading`));
  }
  if (drift > COORD_TOLERANCE_DEG) {
    // Every point has moved, so the labels and radii have moved with them.
    // Listing each one buries the finding that matters.
    out.push(
      finding(
        CRITICAL,
        'D4',
        `recorded points drift from the method by ${drift.toExponential(2)} deg${mismatches.length ? `, and ${mismatches.length} point(s) also disagree on distance, bearing or label` : ''}`,
      ),
    );
    return out;
  }
  // The coordinates match, so anything else that disagrees was edited on its
  // own. Doubling every dKm used to move the printed edges in silence.
  for (const msg of mismatches.slice(0, 5)) {
    out.push(finding(CRITICAL, 'D10', `recorded point disagrees with the replay: ${msg}`));
  }
  if (mismatches.length > 5) {
    out.push(finding(CRITICAL, 'D10', `and ${mismatches.length - 5} more point(s) disagree with the replay`));
  }
  return out;
}

/** E. Field plausibility. */
function auditFields(snap) {
  const out = [];
  for (const r of snap.readings ?? []) {
    for (const b of r.results ?? []) {
      if (b.rating != null && !(b.rating >= 1 && b.rating <= 5)) {
        out.push(finding(WARN, 'E1', `rating ${b.rating} out of range at ${r.label}`, b.name ?? b.id));
      }
      if (b.reviews != null && b.reviews < 0) {
        out.push(finding(WARN, 'E2', `negative review count at ${r.label}`, b.name ?? b.id));
      }
    }
    const ids = (r.results ?? []).map((b) => b.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) {
      out.push(finding(CRITICAL, 'E3', `duplicate business within one point at ${r.label}`));
    }
  }
  return out;
}

/** F. Fragility: figures that a re-scan would move should not be headlined. */
function auditFragility(snap) {
  const out = [];
  const s = summarise(snap.readings ?? [], snap.method?.packSize);
  if (s.packEdge?.fragile) {
    out.push(finding(WARN, 'F1', `top-3 edge ${s.packEdge.dKm} km is fragile, so a re-scan could move it: ${s.packEdge.note}`));
  }
  if (s.reachEdge?.fragile) {
    out.push(finding(WARN, 'F1', `reach edge ${s.reachEdge.dKm} km is fragile, so a re-scan could move it: ${s.reachEdge.note}`));
  }
  if (s.packEdge?.censored) {
    out.push(finding(WARN, 'F3', `top-3 edge sits on the outermost ring scanned; the true edge is at least ${s.packEdge.dKm} km`));
  }
  if (s.reachEdge?.censored) {
    out.push(finding(WARN, 'F3', `reach edge sits on the outermost ring scanned; the true edge is at least ${s.reachEdge.dKm} km`));
  }
  if (s.nonMonotonic) {
    out.push(
      finding(
        WARN,
        'F4',
        `sightings resume beyond a ring with none (at ${s.resumesAtKm.join(', ')} km), so there is no gone-by distance to report`,
      ),
    );
  }
  for (const ring of s.rings) {
    if (ring.ring === 0) continue; // the home point is a single point by design
    if (!ring.reliable) {
      out.push(finding(WARN, 'F2', `ring ${ring.dKm} km is not reportable: ${ring.note}`));
    }
  }
  return out;
}

/**
 * Audit a snapshot.
 * @returns {{ok: boolean, findings: Array, counts: object, metrics: object}}
 */
export function audit(snap) {
  const findings = [
    ...auditStructure(snap),
    ...auditTally(snap),
    ...auditAbsenceIntegrity(snap),
    ...auditGeometry(snap),
    ...auditFields(snap),
    ...auditFragility(snap),
  ];
  const critical = findings.filter((f) => f.level === CRITICAL).length;
  return {
    ok: critical === 0,
    findings,
    counts: { critical, warn: findings.length - critical },
    metrics: summarise(snap.readings ?? [], snap.method?.packSize),
  };
}

/**
 * The verdict line, in the words it is allowed to use.
 *
 * It used to read "Safe to publish", which claims more than arithmetic on one
 * file can support. The audit detects inconsistency, not forgery.
 */
export function verdictLine(result) {
  return result.ok
    ? `PASS: internally consistent (${result.counts.warn} warning(s), 0 critical).`
    : `FAIL: not internally consistent (${result.counts.critical} critical, ${result.counts.warn} warning(s)). Nothing publishes.`;
}

/** Human-readable report. */
export function formatAudit(result) {
  const lines = [];
  for (const f of result.findings) {
    lines.push(`  ${f.level === CRITICAL ? 'FAIL' : 'WARN'}  ${f.id}  ${f.message}${f.detail ? ` (${f.detail})` : ''}`);
  }
  lines.push(`\n  ${verdictLine(result)}`);
  return lines.join('\n');
}
