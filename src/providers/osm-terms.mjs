/**
 * providers/osm-terms.mjs: what a search term means in OpenStreetMap tags.
 *
 * OpenStreetMap has no search ranking and no free-text categories. A listing
 * is a set of tags, so "dentist" has to become `amenity=dentist` before
 * Overpass can answer. This table is that translation, and it is small
 * and explicit: an unknown term throws before a scan spends any calls,
 * rather than quietly matching nothing and reporting ABSENT everywhere.
 *
 * An alias maps to one or more CLAUSES (a union: any clause matches). Each
 * clause is a list of tag tests that must all hold. A test is `key=value`
 * (exact) or `key~regex` (Overpass regular expression on the value).
 *
 * A term that already looks like a tag test (`shop=bakery`, `cuisine~pizza`)
 * passes straight through, so anything the table lacks can still be scanned
 * by someone who knows the tag.
 */

export const OSM_TERMS = {
  tattoo: [['shop=tattoo']],
  restaurant: [['amenity=restaurant']],
  restaurants: [['amenity=restaurant']],
  bbq: [['amenity=restaurant', 'cuisine~barbecue']],
  barbecue: [['amenity=restaurant', 'cuisine~barbecue']],
  dentist: [['amenity=dentist']],
  brewery: [['craft=brewery'], ['microbrewery=yes']],
  bar: [['amenity~^(bar|pub)$']],
  coffee: [['amenity=cafe']],
  cafe: [['amenity=cafe']],
  mechanic: [['shop=car_repair']],
  plumber: [['craft=plumber']],
  hvac: [['craft=hvac']],
  arcade: [['leisure=amusement_arcade']],
};

const TAG_TEST = /^([a-z_:]+)([=~])(\S+)$/i;

/**
 * Resolve a term to clauses.
 * @returns {{ term: string, clauses: string[][], source: 'alias'|'raw' }}
 */
export function resolveTerm(term) {
  const t = String(term ?? '').trim();
  const key = t.toLowerCase();
  if (OSM_TERMS[key]) return { term: t, clauses: OSM_TERMS[key], source: 'alias' };
  if (TAG_TEST.test(t)) return { term: t, clauses: [[t]], source: 'raw' };
  throw new Error(
    `osm: no tag mapping for "${t}". Known terms: ${Object.keys(OSM_TERMS).join(', ')}. ` +
      'Or pass a raw tag test such as shop=bakery.',
  );
}

/** One tag test as Overpass QL: ["key"="value"] or ["key"~"regex"]. */
function tagTest(test) {
  const m = TAG_TEST.exec(test);
  if (!m) throw new Error(`osm: malformed tag test "${test}"`);
  const [, key, op, value] = m;
  return `["${key}"${op}"${value.replace(/"/g, '\\"')}"]`;
}

/** The filter part of the query, as recorded in provider pins. */
export function filterString(clauses) {
  return clauses.map((clause) => clause.map(tagTest).join('')).join(' | ');
}

/**
 * The full Overpass QL query for one sample point.
 * One clause:  [out:json][timeout:25]; nwr[...](around:R,lat,lng); out tags center 50;
 * Several:     the same with a union block.
 */
export function overpassQuery(clauses, { lat, lng, radiusM, maxResults, timeoutS = 25 }) {
  const around = `(around:${radiusM},${lat},${lng})`;
  const parts = clauses.map((clause) => `nwr${clause.map(tagTest).join('')}${around};`);
  const body = parts.length === 1 ? parts[0] : `(${parts.join('')});`;
  return `[out:json][timeout:${timeoutS}]; ${body} out tags center ${maxResults};`;
}
