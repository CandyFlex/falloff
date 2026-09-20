/**
 * providers/places.mjs: Google Places API (New) adapter. Bring your own key.
 *
 * THIS PROVIDER HAS NEVER BEEN RUN LIVE. The author has no Google Maps
 * Platform key and has never made a single successful call with it. What is
 * here is a request shape written against Google's published reference, and
 * an offline test that asserts the shape. It is not a tested provider and it
 * is not the reference provider. Check the first response yourself.
 *
 * It POSTed `textQuery` to `places:searchNearby` until 2026-09-19. Nearby
 * Search (New) has no such field: its body takes `includedTypes`,
 * `excludedTypes`, `includedPrimaryTypes`, `excludedPrimaryTypes`,
 * `locationRestriction`, `maxResultCount`, `rankPreference`, `languageCode`,
 * `regionCode` and `includeFutureOpeningBusinesses`. Google rejects unknown
 * JSON fields with a 400, so every point would have become UNREACHED. The
 * endpoint is now `places:searchText`, which is where `textQuery` belongs.
 * (developers.google.com/maps/documentation/places/web-service/nearby-search
 * and .../text-search, both checked 2026-09-19.)
 *
 * BIAS, NOT RESTRICTION. A restriction is a hard circle: a business outside
 * it cannot be returned, so a scan with a restricted radius reads as falloff
 * by construction at every ring beyond that radius, whatever the business
 * actually does. `locationBias` weights the search towards the circle and
 * still allows a far sighting, which is the thing this tool is trying to
 * measure. The radius is pinned into the snapshot either way.
 *
 * COST, WITH A DATE ON IT. The field mask asks for `places.id` and
 * `places.displayName` and nothing else. `places.id` bills under Text Search
 * Essentials ID Only and `places.displayName` under Text Search Pro, so a
 * call billing both bills as Text Search Pro: a free monthly cap of 5,000
 * events (developers.google.com/maps/billing-and-pricing/pricing, checked
 * 2026-09-19). An 80-point scan is 80 events, so about sixty scans a month
 * cost nothing. `places.rating` and `places.userRatingCount` were in the mask
 * and are Enterprise SKU fields, which made the old cost claim wrong as well
 * as the endpoint; they are gone, and the published snapshots do not need
 * them.
 *
 * THE CONTRACT THAT MATTERS: this throws on failure. It never returns an
 * empty list to mean "something went wrong". Empty means the API answered
 * and there was nothing there.
 */

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/** How wide a single point "sees". Pinned: changing it changes what rank means. */
export const DEFAULT_POINT_RADIUS_M = 3000;

/** Text Search caps a page at 20. Rank beyond that is not observable here. */
export const MAX_RESULTS = 20;

/** Only what a rank check needs. Anything more moves the SKU. */
export const FIELD_MASK = 'places.id,places.displayName';

/** The SKU those fields bill under, with the date the claim was checked. */
export const BILLING = {
  sku: 'Text Search Pro',
  freeEventsPerMonth: 5000,
  checked: '2026-09-19',
  source: 'https://developers.google.com/maps/billing-and-pricing/pricing',
};

/**
 * @param {object} opts
 * @param {string} opts.apiKey                 your Google Maps Platform key
 * @param {number} [opts.pointRadiusM]         bias radius per point, metres
 * @param {number} [opts.pacingMs]             gap between calls
 * @param {string} [opts.languageCode]
 * @param {string} [opts.regionCode]
 */
export function placesProvider({
  apiKey,
  pointRadiusM = DEFAULT_POINT_RADIUS_M,
  pacingMs = 250,
  languageCode = 'en',
  regionCode = 'US',
} = {}) {
  if (!apiKey) throw new Error('placesProvider: apiKey is required');

  return {
    id: 'google-places-text',
    version: 'v1',
    pacingMs,

    // Recorded into the snapshot so a reader knows what "rank" meant here,
    // including that this provider has never been run against Google.
    pins: {
      endpoint: 'places:searchText',
      pointRadiusM,
      radiusMode: 'bias',
      maxResults: MAX_RESULTS,
      fieldMask: FIELD_MASK,
      languageCode,
      regionCode,
      billing: BILLING,
      tested: 'never run live by the author; the request shape follows the published reference and is asserted offline only',
    },

    async query({ lat, lng, term, signal }) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: term,
          pageSize: MAX_RESULTS,
          languageCode,
          regionCode,
          locationBias: {
            circle: { center: { latitude: lat, longitude: lng }, radius: pointRadiusM },
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Throwing is the point. This becomes UNREACHED, not ABSENT.
        throw new Error(`places ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = await res.json();
      return {
        results: (json.places ?? []).map((p) => ({
          id: p.id,
          name: p.displayName?.text ?? '',
        })),
      };
    },
  };
}
