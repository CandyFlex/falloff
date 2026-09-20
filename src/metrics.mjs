/**
 * metrics.mjs: the derived figures, and what each one is allowed to claim.
 *
 * Every metric here returns its own denominator and the count it came from,
 * not just a percentage. A bare "37%" is unfalsifiable; "30 of 80 measured,
 * 6 unreached" can be checked against the raw readings by anyone, including
 * the auditor.
 *
 * Rules that hold throughout:
 *   - UNREACHED points are never in a denominator. They are reported beside it.
 *   - A metric computed from too few points reports `reliable: false` and says
 *     why, rather than returning a confident-looking number.
 *   - Edges are ring-resolution figures. A falloff edge is only as precise as
 *     the gap between rings, and that gap is returned with it.
 *   - Decay is not assumed to be monotonic. Where a figure would only be true
 *     of a curve that falls away steadily, the shape is checked first and the
 *     figure is withheld when it does not hold.
 */

import { FOUND, ABSENT, UNREACHED, PACK_SIZE } from './schema.mjs';

/** A ring needs this many measured points before its share means anything. */
const MIN_RING_SAMPLE = 4;

/**
 * A ring with more than this share of its points unreached is not reportable,
 * however many points were measured. Twelve points with five gaps is not a
 * measurement of that ring; it is a measurement of part of it.
 */
const MAX_RING_UNREACHED_SHARE = 1 / 3;

/**
 * Below this margin an edge used to be called fragile. Kept because the count
 * is still worth printing, but `fragile` is now decided by an interval; see
 * `wilson`.
 */
const FRAGILE_MARGIN = 1;

/** z for a 95% two-sided normal interval. */
const Z95 = 1.959964;

/**
 * Wilson score interval for a binomial share.
 *
 * This is arithmetic, not a model: it is the interval of true shares for
 * which the observed count is not surprising at 95%. It is used instead of
 * "the ring could lose one point" because that test is blind to n. Eight of
 * eight and five of six both have margin 2 against a half threshold, but the
 * first excludes a true share of 0.5 and the second does not.
 *
 * @returns {{lo: number, hi: number}} bounds, clamped to 0..1
 */
export function wilson(hits, n, z = Z95) {
  if (!(n > 0)) return { lo: 0, hi: 1 };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Visibility: measured points where the business appeared at all.
 * Denominator excludes unreached points.
 *
 * The denominator is the sample, not a population. Points are allocated by
 * ring circumference on a chosen preset, so this share is a property of the
 * scan design as much as of the business, and it is not comparable across
 * presets. Lead with the per-ring table and the edges.
 */
export function visibility(readings) {
  const measured = readings.filter((r) => r.status !== UNREACHED);
  const found = measured.filter((r) => r.status === FOUND);
  const unreached = readings.length - measured.length;
  return {
    found: found.length,
    measured: measured.length,
    unreached,
    share: measured.length ? found.length / measured.length : null,
    reliable: measured.length > 0,
    note: unreached
      ? `${unreached} point(s) never measured and excluded from the denominator`
      : null,
  };
}

/** Top-3 presence: measured points where the business ranked in the top N. */
export function packShare(readings, packSize = PACK_SIZE) {
  const measured = readings.filter((r) => r.status !== UNREACHED);
  const inPack = measured.filter((r) => r.status === FOUND && r.rank <= packSize);
  return {
    inPack: inPack.length,
    measured: measured.length,
    unreached: readings.length - measured.length,
    share: measured.length ? inPack.length / measured.length : null,
    packSize,
    reliable: measured.length > 0,
  };
}

/** Alias for `packShare`, under the name the output uses. */
export const top3Share = packShare;

/** Per-ring breakdown. The shape of the decay, before it is summarised away. */
export function byRing(readings, packSize = PACK_SIZE) {
  const rings = new Map();
  for (const r of readings) {
    if (!rings.has(r.ring)) {
      rings.set(r.ring, { ring: r.ring, dKm: r.dKm, found: 0, absent: 0, unreached: 0, inPack: 0 });
    }
    const g = rings.get(r.ring);
    g[r.status]++;
    if (r.status === FOUND && r.rank <= packSize) g.inPack++;
  }
  return [...rings.values()]
    .sort((a, b) => a.dKm - b.dKm)
    .map((g) => {
      const measured = g.found + g.absent;
      const planned = measured + g.unreached;
      const gapShare = planned ? g.unreached / planned : 0;
      const tooFew = measured < MIN_RING_SAMPLE;
      const tooManyGaps = gapShare > MAX_RING_UNREACHED_SHARE;
      return {
        ...g,
        measured,
        visibleShare: measured ? g.found / measured : null,
        packShare: measured ? g.inPack / measured : null,
        // A ring with 2 measured points cannot support a claim about that
        // ring, and neither can a ring where a third of the points are gaps.
        reliable: !tooFew && !tooManyGaps,
        note: tooFew
          ? `only ${measured} measured point(s); needs ${MIN_RING_SAMPLE} to be reportable`
          : tooManyGaps
            ? `${g.unreached} of ${planned} points unreached; more than a third of the ring is a gap`
            : null,
      };
    });
}

/**
 * The furthest ring still meeting a threshold, and how safely it holds.
 *
 * The edge is contiguous from the centre: it is the last reportable ring in
 * an unbroken run out from the home point. That is a definition, not an
 * assumption, and when a further ring also meets the threshold the result
 * says `nonMonotonic: true` and names those rings rather than hiding them.
 *
 * `fragile` is decided by a Wilson 95% interval on the qualifying ring and on
 * the next reportable ring out. If either interval contains the threshold,
 * a re-scan could move the edge, in or out.
 *
 * `censored: true` means the edge sits on the outermost ring scanned, so the
 * true edge is at least that far and the scan cannot say how much further.
 */
function edge(rings, predicate, threshold) {
  const reportable = rings.filter((r) => r.reliable);
  const meets = (ring) => {
    const need = Math.ceil(threshold * ring.measured);
    return need > 0 && predicate(ring) >= need;
  };

  let last = null;
  let lastPos = -1;
  for (let i = 0; i < reportable.length; i++) {
    if (!meets(reportable[i])) break;
    const ring = reportable[i];
    const hits = predicate(ring);
    const need = Math.ceil(threshold * ring.measured);
    last = { dKm: ring.dKm, ring: ring.ring, hits, measured: ring.measured, need, margin: hits - need };
    lastPos = i;
  }
  if (!last) return null;

  const beyond = reportable.slice(lastPos + 1).filter(meets).map((r) => r.dKm);
  const next = reportable[lastPos + 1] ?? null;
  const outermost = rings.length ? rings[rings.length - 1] : null;
  const censored = Boolean(outermost && outermost.ring === last.ring);

  const here = wilson(last.hits, last.measured);
  const there = next ? wilson(predicate(next), next.measured) : null;
  const hereContains = here.lo <= threshold && threshold <= here.hi;
  const thereContains = Boolean(there && there.lo <= threshold && threshold <= there.hi);
  const fragile = hereContains || thereContains;

  // `note` is the REASON only, with no lead-in, because every caller puts it
  // after a different sentence. Baking "a re-scan could move this" into it
  // produced "is fragile: a re-scan could move this edge: ..." in the audit.
  const why = [];
  if (hereContains) why.push(`this ring is ${last.hits}/${last.measured}, 95% interval ${fmtInterval(here)}, which contains ${threshold}`);
  if (thereContains) why.push(`the next ring out (${next.dKm} km) is ${predicate(next)}/${next.measured}, 95% interval ${fmtInterval(there)}, which contains ${threshold}`);

  return {
    ...last,
    interval: here,
    nextInterval: there,
    nextRingKm: next ? next.dKm : null,
    censored,
    nonMonotonic: beyond.length > 0,
    ...(beyond.length ? { qualifyingRingsBeyond: beyond } : {}),
    fragile,
    thinMargin: last.margin <= FRAGILE_MARGIN,
    note: fragile ? why.join('; ') : null,
  };
}

const fmtInterval = (i) => `${i.lo.toFixed(2)}-${i.hi.toFixed(2)}`;

/**
 * Every reportable ring meeting a threshold, whether or not it is contiguous
 * with the centre. Used to say "there is no edge, but these rings qualify"
 * instead of a bare null that reads as "never visible".
 */
export function qualifyingRingsKm(rings, predicate, threshold = 0.5) {
  return rings
    .filter((r) => r.reliable && r.measured && predicate(r) >= Math.ceil(threshold * r.measured))
    .map((r) => r.dKm);
}

/** Furthest ring where the business is in the top 3 at most points. */
export function packEdge(readings, packSize = PACK_SIZE, threshold = 0.5) {
  return edge(byRing(readings, packSize), (r) => r.inPack, threshold);
}

/** Alias for `packEdge`, under the name the output uses. */
export const top3Edge = packEdge;

/** Furthest ring where the business is visible at all at most points. */
export function reachEdge(readings, threshold = 0.5) {
  return edge(byRing(readings), (r) => r.found, threshold);
}

/**
 * Whether sightings fall away and stay away.
 *
 * `goneBy` used to be the first reportable ring with no sightings, which is
 * a false statement whenever the business turns up again further out. It is
 * now the first reportable zero ring after which no reportable ring has a
 * sighting. When sightings resume, there is no gone-by and the rings where
 * they resume are named.
 *
 * @returns {{goneBy: object|null, nonMonotonic: boolean, resumesAtKm: number[]}}
 */
export function decayShape(readings) {
  const reportable = byRing(readings).filter((r) => r.reliable);
  for (let i = 0; i < reportable.length; i++) {
    if (reportable[i].found !== 0) continue;
    const after = reportable.slice(i + 1);
    const resumes = after.filter((r) => r.found > 0);
    if (!resumes.length) {
      const r = reportable[i];
      return { goneBy: { dKm: r.dKm, ring: r.ring, measured: r.measured }, nonMonotonic: false, resumesAtKm: [] };
    }
    return { goneBy: null, nonMonotonic: true, resumesAtKm: resumes.map((r) => r.dKm) };
  }
  return { goneBy: null, nonMonotonic: false, resumesAtKm: [] };
}

/** The ring the business stops at, or null when it does not stop inside the scan. */
export function goneBy(readings) {
  return decayShape(readings).goneBy;
}

/**
 * Archetype thresholds.
 *
 * These are DESCRIPTIVE LABELS for a curve, chosen by reading the shapes this
 * tool produces. They are not validated against any outcome and they predict
 * nothing. They are named constants so that a reader can see what the label
 * means and disagree with it, and so that a change to one is a visible edit
 * rather than a number moved inside an expression.
 */
export const ARCHETYPE = {
  /** Visible at most of the inner ring and still most of the outer one. */
  BROAD_INNER: 0.8,
  BROAD_OUTER: 0.6,
  /** Strong at the centre, gone at the rim. */
  FALLOFF_INNER: 0.7,
  FALLOFF_OUTER: 0.2,
  /** Thin even at the centre. */
  WEAK_CORE_INNER: 0.4,
};

/**
 * The shape of the decay, named.
 *
 * Descriptive only. It is a label for a curve, not a diagnosis, and it is
 * derived from figures that carry their own denominators. The counts are
 * returned beside every share so the label can be printed with them.
 */
export function archetype(readings) {
  const rings = byRing(readings).filter((r) => r.reliable);
  if (rings.length < 3) {
    return { archetype: null, reliable: false, note: 'needs 3 reportable rings' };
  }
  const shares = rings.map((r) => r.visibleShare);
  const midIndex = Math.floor(shares.length / 2);
  const inner = shares[0];
  const outer = shares[shares.length - 1];
  const mid = shares[midIndex];
  const counts = {
    inner: { found: rings[0].found, measured: rings[0].measured, dKm: rings[0].dKm },
    mid: { found: rings[midIndex].found, measured: rings[midIndex].measured, dKm: rings[midIndex].dKm },
    outer: { found: rings[rings.length - 1].found, measured: rings[rings.length - 1].measured, dKm: rings[rings.length - 1].dKm },
  };
  const { nonMonotonic } = decayShape(readings);

  let name;
  // Order matters. "No sighting on any reportable ring" is its own shape:
  // calling it a weak core would imply there is a core. "Patchy" is tested
  // before the thresholds because a curve that comes back after a zero ring
  // is patchy whatever its inner share is; testing weak-core first used to
  // swallow exactly the case the patchy label exists for.
  if (shares.every((x) => x === 0)) name = 'absent';
  else if (nonMonotonic) name = 'patchy';
  else if (inner >= ARCHETYPE.BROAD_INNER && outer >= ARCHETYPE.BROAD_OUTER) name = 'broad';
  else if (inner >= ARCHETYPE.FALLOFF_INNER && outer <= ARCHETYPE.FALLOFF_OUTER) name = 'falloff';
  else if (inner <= ARCHETYPE.WEAK_CORE_INNER) name = 'weak-core';
  else name = 'tapered';

  return { archetype: name, inner, mid, outer, counts, rings: rings.length, reliable: true };
}

/** Everything, in one call. Each figure still carries its own denominator. */
export function summarise(readings, packSize = PACK_SIZE) {
  const shape = decayShape(readings);
  const pack = packShare(readings, packSize);
  const pEdge = packEdge(readings, packSize);
  const rings = byRing(readings, packSize);
  const rEdge = reachEdge(readings);
  return {
    // When no ring is an edge but some ring further out still qualifies, the
    // shape is not a falloff and the reader has to be told which rings.
    reachQualifyingRingsKm: rEdge ? [] : qualifyingRingsKm(rings, (r) => r.found),
    packQualifyingRingsKm: pEdge ? [] : qualifyingRingsKm(rings, (r) => r.inPack),
    visibility: visibility(readings),
    pack,
    // Aliases under the wording the output uses. Same objects.
    top3: pack,
    packEdge: pEdge,
    top3Edge: pEdge,
    reachEdge: rEdge,
    goneBy: shape.goneBy,
    nonMonotonic: shape.nonMonotonic,
    resumesAtKm: shape.resumesAtKm,
    archetype: archetype(readings),
    rings,
  };
}
