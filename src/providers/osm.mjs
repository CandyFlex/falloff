/**
 * providers/osm.mjs: OpenStreetMap through the Overpass API. No key, no cost.
 *
 * THE LIMIT, FIRST. OpenStreetMap has no ranking. Nobody is ordering these
 * listings by relevance, prominence or anything else; Overpass returns
 * whatever matched the tag filter inside the radius. So this provider
 * imposes one rule, records it, and does not pretend it is more than it is:
 *
 *   rank = order by distance from the sample point, ascending; ties by id.
 *
 * That makes it a LISTING PROXIMITY instrument. A FOUND reading here means
 * "the business is mapped in OpenStreetMap under this tag, and it is the
 * nth-nearest such listing to this point". It is a measure of coverage and
 * completeness in the open map, and a way to exercise the whole pipeline
 * for free. It is not what Google shows anyone. Someone who wants Google's
 * ranking uses the Places provider or the manual sheet. The provider id
 * and the recorded pin `ranking: 'distance-asc'` make sure a snapshot from
 * this provider is never mistaken for one of those.
 *
 * FAILURE CONTRACT (the one every provider must honour): this throws on
 * anything that is not a measured answer. Non-2xx, a timeout, a body that
 * is not JSON, and an Overpass `remark` reporting a runtime error or a
 * timeout all throw and become UNREACHED. An empty `elements` array is a
 * real answer: nothing is mapped there under that tag. That is ABSENT.
 *
 * THE RADIUS IS A HARD RESTRICTION, AND IT SHAPES EVERY RESULT. Each point
 * asks Overpass for listings `around:<pointRadiusM>` of that point, so a
 * business further than that from the sample point CANNOT be returned, no
 * matter how prominent it is. At the default 3 km, every ring beyond 3 km is
 * absent by construction, and the presets put five to seven rings out there.
 * An OSM scan therefore measures local listing order and will read as a
 * falloff whatever the business does. The radius is recorded in
 * `provider.pins.pointRadiusM` and printed by `falloff report`. Raise it with
 * `osmProvider({ pointRadiusM })` if you want the outer rings to mean
 * anything, and expect the result cap below to start biting when you do.
 *
 * RESULT CAP. The query asks Overpass for at most `maxResults` elements.
 * When more than that fall inside the radius, the set Overpass returns is
 * not guaranteed to be the nearest ones. At the default 3 km radius and a
 * single category this rarely matters, and the cap is recorded as a pin so
 * a reader can tell when it might.
 *
 * Be a polite client: default pacing 1500 ms, a descriptive User-Agent, a
 * 25 s server-side timeout inside the query and a 30 s client-side one.
 *
 * THROTTLING IS NORMAL HERE. The public Overpass server is shared and free,
 * and it answers 429 or 504 when it is busy or when one address asks too
 * fast. The first live run of this provider (2026-09-19, tight preset, 1500
 * ms pacing) got 6 of 60 points answered and 54 throttled or dropped. So a
 * throttled call is retried a bounded number of times, waiting for the
 * server's Retry-After when it sends one and backing off otherwise. When the
 * retries run out it still throws: a point that could not be measured is
 * UNREACHED, and a scan with too many of them fails the audit. Retrying
 * changes how often a point gets measured, never what a measurement means,
 * so it is not a pin.
 */

import { resolveTerm, filterString, overpassQuery } from './osm-terms.mjs';
import { VERSION, REPOSITORY } from '../version.mjs';

export const ENDPOINT = 'https://overpass-api.de/api/interpreter';
export const DEFAULT_POINT_RADIUS_M = 3000;
export const MAX_RESULTS = 50;
export const DEFAULT_PACING_MS = 1500;
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_BACKOFF_MS = 5000;
export const MAX_RETRY_WAIT_MS = 60000;

/** Statuses that mean "busy, ask again later", not "you asked wrong". */
const RETRYABLE = new Set([429, 502, 503, 504]);

class RetryableError extends Error {
  constructor(message, waitMs = null) {
    super(message);
    this.retryable = true;
    this.waitMs = waitMs;
  }
}
export const USER_AGENT = `falloff/${VERSION} (+${REPOSITORY})`;

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in km. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Coordinates of an Overpass element: nodes carry them, ways and relations carry a centre. */
function coordsOf(el) {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return { lat: el.lat, lng: el.lon };
  if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
    return { lat: el.center.lat, lng: el.center.lon };
  }
  return null;
}

/**
 * Rank Overpass elements from a sample point. Exported so the rule can be
 * tested without a network.
 */
export function rankElements(elements, { lat, lng }) {
  const rows = [];
  for (const el of elements ?? []) {
    const c = coordsOf(el);
    if (!c) continue; // nothing to measure a distance to; not a listing we can place
    rows.push({
      id: `osm:${el.type}/${el.id}`,
      name: el.tags?.name ?? '',
      rating: null,
      reviews: null,
      distanceM: Math.round(haversineKm(lat, lng, c.lat, c.lng) * 1000),
    });
  }
  rows.sort((a, b) => a.distanceM - b.distanceM || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

/**
 * @param {object} opts
 * @param {string} opts.term                 the search term; resolved to tags now, so an unknown term fails before any call
 * @param {number} [opts.pointRadiusM]       how far a point "sees"; pinned
 * @param {number} [opts.pacingMs]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.endpoint]
 * @param {number} [opts.retries]            extra attempts after a throttled or dropped call
 * @param {number} [opts.backoffMs]          wait before retry n is backoffMs * 2^n, unless the server says Retry-After
 * @param {function} [opts.fetchImpl]        injected for tests; defaults to global fetch
 * @param {function} [opts.sleepImpl]        injected for tests; defaults to setTimeout
 */
export function osmProvider({
  term,
  pointRadiusM = DEFAULT_POINT_RADIUS_M,
  pacingMs = DEFAULT_PACING_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  endpoint = ENDPOINT,
  retries = DEFAULT_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!term) throw new Error('osmProvider: term is required so the tag filter can be resolved up front');
  if (typeof fetchImpl !== 'function') throw new Error('osmProvider: no fetch available');
  const { clauses } = resolveTerm(term);
  const filter = filterString(clauses);

  const provider = {
    id: 'osm-overpass',
    version: 'overpass@1',
    pacingMs,
    pins: {
      pointRadiusM,
      radiusMode: 'restriction',
      radiusNote: `a business further than ${pointRadiusM / 1000} km from a sample point cannot be returned at that point`,
      maxResults: MAX_RESULTS,
      ranking: 'distance-asc',
      filter,
      term,
    },

    async query({ lat, lng, term: t, signal }) {
      if (t && t !== term) {
        throw new Error(`osm: provider was built for term "${term}" but was asked for "${t}"`);
      }
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await provider.attempt({ lat, lng, signal });
        } catch (err) {
          lastError = err;
          if (!err.retryable || attempt === retries || signal?.aborted) break;
          const wait = Math.min(err.waitMs ?? backoffMs * 2 ** attempt, MAX_RETRY_WAIT_MS);
          await sleepImpl(wait);
        }
      }
      const tries = lastError.retryable && retries > 0 ? ` (after ${retries + 1} attempts)` : '';
      throw new Error(`${lastError.message}${tries}`);
    },

    /** One request. Throws RetryableError for throttling and dropped connections. */
    async attempt({ lat, lng, signal }) {
      const ql = overpassQuery(clauses, { lat, lng, radiusM: pointRadiusM, maxResults: MAX_RESULTS });

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error(`osm: no response in ${timeoutMs} ms`)), timeoutMs);
      const onOuterAbort = () => ctl.abort(signal?.reason ?? new Error('aborted'));
      if (signal) {
        if (signal.aborted) onOuterAbort();
        else signal.addEventListener('abort', onOuterAbort, { once: true });
      }

      let res;
      let text;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: `data=${encodeURIComponent(ql)}`,
        });
        text = await res.text();
      } catch (err) {
        const timedOutOrAborted = ctl.signal.aborted;
        const reason = timedOutOrAborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : err;
        const message = `osm: ${reason?.message ?? reason}`;
        // A dropped connection is worth another try. Our own timeout or the caller's abort is not.
        throw timedOutOrAborted ? new Error(message) : new RetryableError(message);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onOuterAbort);
      }

      if (!res.ok) {
        // Throwing is the point. This becomes UNREACHED, not ABSENT.
        const message = `osm ${res.status}: ${String(text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`;
        if (RETRYABLE.has(res.status)) {
          const after = Number(res.headers?.get?.('retry-after'));
          throw new RetryableError(message, Number.isFinite(after) && after > 0 ? after * 1000 : null);
        }
        throw new Error(message);
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`osm: response was not JSON (${String(text ?? '').slice(0, 120)})`);
      }
      if (typeof json.remark === 'string' && /runtime error|timed out/i.test(json.remark)) {
        throw new Error(`osm: ${json.remark}`);
      }
      if (!Array.isArray(json.elements)) {
        throw new Error('osm: response had no elements array');
      }
      return { results: rankElements(json.elements, { lat, lng }) };
    },
  };
  return provider;
}
