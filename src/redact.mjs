/**
 * redact.mjs: make a snapshot publishable without changing what it measured.
 *
 * WHY THE OLD VERSION WAS NOT ENOUGH. It replaced names and kept the ids and
 * the exact coordinates, on the theory that a stable id "does not read as a
 * name". A Google feature id does. It has the form `0x<hex>:0x<hex>`, and the
 * second half is the CID: convert it to decimal and `google.com/maps?cid=`
 * plus that number opens the listing. Keeping the centre to seven decimals
 * alongside the town and the query finished the job. "Names withheld" was
 * true and beside the point.
 *
 * WHAT THIS DOES NOW.
 *
 *   ids            every id, the target's and every competitor's, becomes
 *                  'h:' + the first 16 hex of SHA-256(salt + id). Equality is
 *                  preserved, so the rank checks in `audit` still work, and
 *                  the salt is per study and is never published. Without the
 *                  salt the hash cannot be walked back: the id space is
 *                  enormous, but it is also enumerable from a bulk export,
 *                  which is exactly what an unsalted hash would not survive.
 *   target.name    -> 'withheld'
 *   result names   removed
 *   centre         rounded to 2 decimal places, about 1 km
 *   every point    RECOMPUTED from the rounded centre with the snapshot's own
 *                  recorded pins, so the geometry still replays and the file
 *                  still passes `audit`. Moving the centre without moving the
 *                  points would have produced a file that fails its own
 *                  geometry check.
 *   command,       the source file name is replaced wholesale with
 *   provenance     'withheld.json'. Replacing only the part that matched the
 *                  business name left descriptors behind: one study published
 *                  a scrubbed file name that still said "food truck", in a
 *                  folder that said which town and which query.
 *
 * WHAT IS KEPT, AND WHY THAT MATTERS. The town, the query, the date, the
 * ranks and the ring geometry all stay, because without them the study is not
 * a measurement of anything. WITHHELD IS NOT ANONYMOUS. A reader who knows
 * the town and the trade can narrow the list of candidates a long way. The
 * redaction block says so in those words.
 *
 * Browser-safe: this module imports nothing from node. The hash function can
 * be passed in (`src/node/salt.mjs` passes node:crypto); the fallback is the
 * pure implementation in `sha256.mjs`.
 *
 * Deterministic: the same snapshot and the same salt give the same bytes.
 */

import { sha256Hex } from './sha256.mjs';
import { samplePlan } from './sample.mjs';

export const REDACTION_SCHEMA = 'falloff/redaction@2';
export const WITHHELD = 'withheld';
export const WITHHELD_FILE = 'withheld.json';

/** Decimal places kept on the published centre. Two is about 1 km. */
export const CENTRE_DECIMALS = 2;

/** Hex characters kept from each hashed id. */
export const ID_HASH_CHARS = 16;

export const DEFAULT_REASON =
  'business names withheld and ids hashed for publication; the town, the query, the date and the ring geometry are kept so the scan can be recomputed';

/** The sentence the page, the report and this block all have to carry. */
export const NOT_ANONYMOUS =
  'Withheld is not anonymous: the town, the query and the date are kept, and they narrow the candidates a long way.';

/** The slug an older scanner used in file names: lowercase, [a-z0-9], hyphens. */
export function slugOf(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '-');
}

/** Every text form of a name that could leak it: the name, its slug, and slug variants. */
export function nameVariants(name) {
  const out = new Set();
  const raw = String(name || '').trim();
  if (raw.length >= 3) out.add(raw);
  const slug = slugOf(raw);
  if (slug.length >= 3) {
    out.add(slug);
    out.add(slug.replace(/-/g, ' '));
    out.add(slug.replace(/-/g, '_'));
    out.add(slug.replace(/-/g, ''));
  }
  return [...out].sort((a, b) => b.length - a.length); // longest first
}

/** Names present in an unredacted snapshot. Used by tests to prove they are gone. */
export function collectNames(snap) {
  const names = new Set();
  if (snap?.target?.name && snap.target.name !== WITHHELD) names.add(snap.target.name);
  for (const r of snap?.readings ?? []) {
    for (const b of r.results ?? []) if (b?.name) names.add(b.name);
  }
  return [...names];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace every variant of `name` in `text` with 'withheld'. Case-insensitive. */
export function scrubText(text, name) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const v of nameVariants(name)) {
    out = out.replace(new RegExp(escapeRegExp(v), 'gi'), WITHHELD);
  }
  return out;
}

/**
 * Scrub a recorded command: the name in any flag, and the whole of any file
 * name.
 *
 * Replacing only the part that matched the business name is not enough. The
 * rest of a scanner's file name is still a description: one study published
 * a scrubbed file name that still read "food truck", in a folder that named
 * the town and the query. Any token ending in `.json` is replaced wholesale.
 */
export function scrubCommand(command, name) {
  if (typeof command !== 'string' || !command) return command;
  const named = name ? scrubText(command, name) : command;
  return named.replace(/\S*\.json\b/g, WITHHELD_FILE);
}

const round = (x, places) => {
  const f = Math.pow(10, places);
  return Math.round(x * f) / f;
};

/**
 * Redact a snapshot.
 *
 * @param {object} snap
 * @param {object} opts
 * @param {string} opts.salt       per-study secret; never published
 * @param {function} [opts.hash]   (text) => hex; defaults to the pure sha256 here
 * @param {string} [opts.reason]   why; recorded verbatim
 * @param {string} [opts.at]       ISO timestamp; injectable for deterministic output
 * @returns {object} a new snapshot; the input is not modified
 */
export function redact(snap, { salt, hash = sha256Hex, reason, at } = {}) {
  if (!snap || typeof snap !== 'object') throw new Error('redact: snapshot must be an object');
  if (!salt || String(salt).length < 16) {
    throw new Error('redact: a salt of at least 16 characters is required, and it must not be published');
  }
  const out = structuredClone(snap);
  const fields = ['target.name', 'readings[].results[].name', 'ids', 'target.lat', 'target.lng', 'readings[].lat', 'readings[].lng'];

  // Idempotent: an id that is already a hash is left alone, so redacting a
  // redacted file changes nothing.
  const hashId = (id) => (!id || String(id).startsWith('h:') ? id : `h:${hash(`${salt}${id}`).slice(0, ID_HASH_CHARS)}`);

  if (out.target) {
    out.target.name = WITHHELD;
    if (out.target.id) out.target.id = hashId(out.target.id);
  }
  for (const r of out.readings ?? []) {
    for (const b of r.results ?? []) {
      delete b.name;
      if (b.id) b.id = hashId(b.id);
    }
  }

  // Move the centre, then move the scan with it. A rounded centre and
  // unrounded points would publish the true location twice over and fail the
  // geometry replay besides.
  const m = out.method ?? {};
  const homeLat = round(snap.target?.lat ?? snap.readings?.find((r) => r.ring === 0)?.lat, CENTRE_DECIMALS);
  const homeLng = round(snap.target?.lng ?? snap.readings?.find((r) => r.ring === 0)?.lng, CENTRE_DECIMALS);
  if (!Number.isFinite(homeLat) || !Number.isFinite(homeLng)) {
    throw new Error('redact: the snapshot has no centre coordinate to round');
  }
  const replan = samplePlan({
    lat: homeLat,
    lng: homeLng,
    rmin: m.rmin,
    rmax: m.rmax,
    points: m.budget,
    kmPerDegLat: m.kmPerDegLat,
    growth: m.growth,
    goldenAngle: m.goldenAngle,
    minRingPoints: m.minRingPoints,
  });
  const moved = new Map(replan.points.map((p) => [`${p.ring}:${p.index}`, p]));
  for (const r of out.readings ?? []) {
    const p = moved.get(`${r.ring}:${r.index}`);
    if (!p) throw new Error(`redact: reading ${r.ring}:${r.index} has no counterpart in the replanned geometry`);
    r.lat = p.lat;
    r.lng = p.lng;
  }
  if (out.target) {
    out.target.lat = homeLat;
    out.target.lng = homeLng;
  }

  const originalName = snap.target?.name;
  let scrubbed = scrubCommand(out.command, originalName !== WITHHELD ? originalName : null);
  // The command can carry the true centre as `--lat 25.8104 --lng -80.2037`,
  // which would hand back everything the rounding just took away.
  if (typeof scrubbed === 'string') {
    for (const [was, now] of [
      [snap.target?.lat, homeLat],
      [snap.target?.lng, homeLng],
    ]) {
      if (Number.isFinite(was) && was !== now) scrubbed = scrubbed.split(String(was)).join(String(now));
    }
  }
  if (scrubbed !== out.command) {
    out.command = scrubbed;
    fields.push('command');
  }
  if (out.provenance?.sourceFile) {
    out.provenance.sourceFile = WITHHELD_FILE;
    fields.push('provenance.sourceFile');
  }

  const existing = snap.redaction;
  // Carry forward what an earlier pass recorded, so redacting twice does not
  // quietly shorten the list of what was taken out.
  for (const f of existing?.fields ?? []) if (!fields.includes(f)) fields.push(f);
  out.redaction = {
    schema: REDACTION_SCHEMA,
    fields,
    ids: `hashed: h: plus the first ${ID_HASH_CHARS} hex characters of SHA-256(salt + id), with a per-study salt that is not published`,
    centre: `rounded to ${CENTRE_DECIMALS} decimal places, about 1 km`,
    points: 'recomputed from the rounded centre with the recorded pins, so the geometry still replays',
    observedAt: 'the scan was observed at the true coordinates; the published ones are the rounded centre and its replanned points',
    names: 'withheld',
    warning: NOT_ANONYMOUS,
    reason: reason ?? existing?.reason ?? DEFAULT_REASON,
    at: existing?.at ?? at ?? new Date().toISOString(),
  };
  return out;
}
