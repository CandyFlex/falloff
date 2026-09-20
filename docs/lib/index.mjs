/**
 * falloff: measures where a local business is visible across a geography,
 * and where it stops.
 *
 * Every figure it produces carries the method that produced it and a command
 * that reproduces it. Figures that cannot be recomputed are not published.
 */
export {
  samplePlan, ringLadder, allocatePoints, windName,
  PRESETS, SAMPLERS, GOLDEN_ANGLE, RING_GROWTH, MIN_RING_POINTS, KM_PER_DEG_LAT, KM_PER_DEG_LNG_EQUATOR,
} from './sample.mjs';

export {
  reading, snapshot, tally, listDepthRange,
  FOUND, ABSENT, UNREACHED, STATUSES, PACK_SIZE,
} from './schema.mjs';

export {
  visibility, packShare, top3Share, byRing, packEdge, top3Edge, reachEdge,
  goneBy, decayShape, archetype, summarise, wilson, qualifyingRingsKm, ARCHETYPE,
} from './metrics.mjs';

export { audit, formatAudit, verdictLine } from './audit.mjs';
export { compare, formatCompare } from './compare.mjs';
export { validateProvider, locateTarget, normaliseName } from './providers/index.mjs';

export { scan } from './scan.mjs';
export { redact, collectNames, REDACTION_SCHEMA } from './redact.mjs';
export { renderReport } from './render.mjs';
export { makePlan, planSheet, ingestSheet, mapsUrl, SHEET_HEADER } from './manual.mjs';
export { parseCsv, toCsv } from './csv.mjs';
export { VERSION } from './version.mjs';
