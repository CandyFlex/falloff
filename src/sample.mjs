/**
 * sample.mjs: where to measure from.
 *
 * Pure geometry. No network, no provider, no clock. Given a centre and a
 * reach, it returns the points to sample. Deterministic: the same arguments
 * always produce the same points, which is what makes two snapshots
 * comparable.
 *
 * THE METHOD, and why it is not a grid.
 *
 * A uniform grid spends most of its budget far from the business, where
 * nothing changes, and under-samples the near ring, where everything does.
 * A fixed number of spokes is worse: at 8 spokes, the 4 km ring has a point
 * every 3 km and the 120 km ring has one every 94 km, so the outer ring is
 * mostly gaps.
 *
 * Falloff allocates by CIRCUMFERENCE instead:
 *
 *   1. Ring radii follow a geometric ladder from rmin to rmax. Visibility
 *      decays with distance, so rings cluster where the decay happens.
 *   2. Points per ring are proportional to that ring's radius, floored at 6.
 *      Angular spacing therefore stays roughly constant at every distance.
 *   3. Each ring is rotated by the golden angle (2.39996 rad) relative to the
 *      last, so points never line up into radial lanes that leave wedges
 *      unsampled.
 *   4. The total is trimmed or grown to hit an exact call budget, so cost is
 *      known before the scan starts rather than discovered afterwards.
 *
 * Ring count uses growth ratio 1.55, a compromise between resolution and
 * budget found by scanning real towns. It is a pinned constant, not a tuning
 * knob: changing it changes what a snapshot means, so it lives in the method
 * block and any change is a visible, versioned act.
 *
 * THE EARTH MODEL IS A PIN TOO. Points are placed with a flat approximation:
 * one degree of latitude is KM_PER_DEG_LAT kilometres everywhere, and one
 * degree of longitude is KM_PER_DEG_LNG_EQUATOR * cos(lat). That is accurate
 * to well under a percent at the distances this tool samples, but the exact
 * constants decide the exact coordinates, and the auditor replays those
 * coordinates to 1e-6 degrees. An older scanner used 110.57 for latitude;
 * replayed with 110.574 its points drift by about 2e-5 degrees at 60 km and
 * fail the audit. The fix is not a looser tolerance. It is to record the
 * constant in the method block and replay with whatever was recorded, so a
 * snapshot says which earth it was measured on.
 */

/** Ring-to-ring rotation. Irrational multiple of 2π, so lanes never repeat. */
export const GOLDEN_ANGLE = 2.39996;

/** Ring ladder growth ratio. Pinned; see the module header. */
export const RING_GROWTH = 1.55;

/** Fewest points on any ring. Below this the inner rings lose their shape. */
export const MIN_RING_POINTS = 6;

/** Km per degree of latitude. Default pin; a snapshot may record another. */
export const KM_PER_DEG_LAT = 110.574;

/** Km per degree of longitude at the equator, scaled by cos(lat) elsewhere. */
export const KM_PER_DEG_LNG_EQUATOR = 111.32;

/** Presets. Reach is the question being asked, so it is named, not guessed. */
export const PRESETS = {
  /** Walk-in trade: coffee, barbers, nail salons. Street-level resolution. */
  tight: { rmin: 1.5, rmax: 20, points: 60 },
  /** Everyday drive: restaurants, dentists, mechanics. The default. */
  mid: { rmin: 2.5, rmax: 60, points: 80 },
  /** Regional draw: specialists, venues. */
  regional: { rmin: 3, rmax: 90, points: 90 },
  /** Destination: people plan a trip. */
  wide: { rmin: 4, rmax: 120, points: 100 },
};

/**
 * The sampler versions this build knows how to replay, and the pin values
 * each version defines.
 *
 * A snapshot records its pins so the auditor can replay the geometry from
 * them. Recorded pins are not decorative: for `radial-v2` the growth ratio,
 * the golden angle and the ring floor are part of what the version IS, so a
 * snapshot that records different values is not a radial-v2 snapshot and the
 * audit fails it. `kmPerDegLat` is listed in `mayVary` because an older
 * scanner used 110.57 and its files are still honest measurements; the
 * snapshot says which earth it was measured on and the replay uses that.
 *
 * A sampler name that is not in this table cannot be replayed at all, so the
 * audit refuses it rather than passing the geometry unchecked.
 */
export const SAMPLERS = {
  'radial-v2': {
    pins: {
      growth: RING_GROWTH,
      goldenAngle: GOLDEN_ANGLE,
      minRingPoints: MIN_RING_POINTS,
      kmPerDegLat: KM_PER_DEG_LAT,
    },
    mayVary: ['kmPerDegLat'],
  },
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass label for a bearing in radians, measured clockwise from north. */
export function windName(radians) {
  const deg = ((radians * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 22.5) % 16];
}

/** Km per degree of longitude shrinks with latitude. */
function kmPerDegLng(lat) {
  return KM_PER_DEG_LNG_EQUATOR * Math.cos((lat * Math.PI) / 180);
}

/**
 * Ring radii: a geometric ladder from rmin to rmax.
 * @returns {number[]} radii in km, ascending, one decimal place
 */
export function ringLadder(rmin, rmax, growth = RING_GROWTH) {
  if (!(rmin > 0) || !(rmax > rmin)) {
    throw new Error(`ringLadder: need 0 < rmin < rmax, got rmin=${rmin} rmax=${rmax}`);
  }
  const count = Math.max(3, Math.round(Math.log(rmax / rmin) / Math.log(growth)) + 1);
  return [...Array(count)].map(
    (_, i) => +(rmin * Math.pow(rmax / rmin, i / (count - 1))).toFixed(1),
  );
}

/**
 * Points per ring, proportional to radius, floored, then reconciled to budget.
 * @returns {number[]} one count per ring; sums to budget - 1 (the home point)
 */
export function allocatePoints(radii, budget, minRingPoints = MIN_RING_POINTS) {
  const spend = budget - 1; // home point costs one call
  if (!(minRingPoints >= 1)) {
    throw new Error(`allocatePoints: minRingPoints must be 1 or more, got ${minRingPoints}`);
  }
  if (spend < radii.length * minRingPoints) {
    throw new Error(
      `allocatePoints: budget ${budget} cannot cover ${radii.length} rings ` +
        `at ${minRingPoints} points each (need at least ${radii.length * minRingPoints + 1})`,
    );
  }
  const weightSum = radii.reduce((a, r) => a + r, 0);
  const counts = radii.map((r) => Math.max(minRingPoints, Math.round((spend * r) / weightSum)));

  // Reconcile to the exact budget. Take from the largest ring, give to the
  // outermost; the outer ring has the most circumference to spare.
  let total = counts.reduce((a, b) => a + b, 0);
  while (total > spend) {
    const i = counts.indexOf(Math.max(...counts));
    if (counts[i] <= minRingPoints) break; // never starve a ring
    counts[i]--;
    total--;
  }
  while (total < spend) {
    counts[counts.length - 1]++;
    total++;
  }
  return counts;
}

/**
 * The sample plan: every point to measure from.
 *
 * @param {object} opts
 * @param {number} opts.lat        centre latitude
 * @param {number} opts.lng        centre longitude
 * @param {string} [opts.preset]   one of PRESETS; ignored if rmin/rmax given
 * @param {number} [opts.rmin]     innermost ring, km
 * @param {number} [opts.rmax]     outermost ring, km
 * @param {number} [opts.points]   call budget, including the home point
 * @param {number} [opts.kmPerDegLat] latitude scale pin; default KM_PER_DEG_LAT.
 *                                    Only set this to replay a snapshot that
 *                                    recorded a different constant.
 * @param {number} [opts.growth]        ring ladder growth pin; replay only
 * @param {number} [opts.goldenAngle]   ring rotation pin; replay only
 * @param {number} [opts.minRingPoints] floor per ring pin; replay only
 * @returns {{points: Array, rings: number[], budget: number, method: object}}
 */
export function samplePlan({
  lat,
  lng,
  preset = 'mid',
  rmin,
  rmax,
  points,
  kmPerDegLat = KM_PER_DEG_LAT,
  growth = RING_GROWTH,
  goldenAngle = GOLDEN_ANGLE,
  minRingPoints = MIN_RING_POINTS,
}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`samplePlan: lat/lng must be finite, got ${lat},${lng}`);
  }
  if (!(kmPerDegLat > 0)) {
    throw new Error(`samplePlan: kmPerDegLat must be a positive number, got ${kmPerDegLat}`);
  }
  if (!(growth > 1)) {
    throw new Error(`samplePlan: growth must be greater than 1, got ${growth}`);
  }
  if (!Number.isFinite(goldenAngle)) {
    throw new Error(`samplePlan: goldenAngle must be finite, got ${goldenAngle}`);
  }
  const base = PRESETS[preset] || PRESETS.mid;
  const r0 = rmin ?? base.rmin;
  const r1 = rmax ?? base.rmax;
  const budget = points ?? base.points;

  const rings = ringLadder(r0, r1, growth);
  const counts = allocatePoints(rings, budget, minRingPoints);
  const kx = kmPerDegLng(lat);

  const plan = [{ ring: 0, index: 0, lat, lng, dKm: 0, bearing: null, label: 'home' }];

  rings.forEach((radius, ringIndex) => {
    const n = counts[ringIndex];
    const offset = ringIndex * goldenAngle;
    for (let i = 0; i < n; i++) {
      const angle = offset + (i / n) * 2 * Math.PI;
      plan.push({
        ring: ringIndex + 1,
        index: i,
        lat: lat + (Math.cos(angle) * radius) / kmPerDegLat,
        lng: lng + (Math.sin(angle) * radius) / kx,
        dKm: radius,
        bearing: +(((angle * 180) / Math.PI + 360) % 360).toFixed(1),
        label: `${radius} km ${windName(angle)}`,
      });
    }
  });

  return {
    points: plan,
    rings,
    budget,
    // The method block travels with the data. Two snapshots are comparable
    // only if these match, so they are recorded, not assumed.
    method: {
      sampler: 'radial-v2',
      preset: rmin || rmax || points ? 'custom' : preset,
      rmin: r0,
      rmax: r1,
      budget,
      rings: rings.length,
      ringRadiiKm: rings,
      pointsPerRing: counts,
      growth,
      goldenAngle,
      minRingPoints,
      kmPerDegLat,
      kmPerDegLngEquator: KM_PER_DEG_LNG_EQUATOR,
      lngScale: 'cos-lat',
    },
  };
}
