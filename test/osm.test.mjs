/**
 * Tests for the OpenStreetMap provider. Fully offline: fetch is injected.
 *
 * What matters here is the failure contract. Every way Overpass can fail to
 * answer must throw (UNREACHED), and the one way it can answer with nothing
 * (an empty elements array) must not (ABSENT).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { osmProvider, rankElements, haversineKm, USER_AGENT, ENDPOINT } from '../src/providers/osm.mjs';
import { resolveTerm, overpassQuery, filterString, OSM_TERMS } from '../src/providers/osm-terms.mjs';
import { validateProvider } from '../src/providers/index.mjs';
import { scan } from '../src/scan.mjs';
import { tally } from '../src/schema.mjs';

const POINT = { lat: 25.8104, lng: -80.2037 };

/** A fetch that answers with a fixed status and body, and records what it was asked. */
function fakeFetch({ status = 200, body = '{"elements":[]}' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const el = (type, id, lat, lon, name) =>
  type === 'node'
    ? { type, id, lat, lon, tags: name ? { name } : {} }
    : { type, id, center: { lat, lon }, tags: name ? { name } : {} };

/* ---------------- terms ---------------- */

test('known terms resolve to tag filters; every alias in the table builds a query', () => {
  assert.deepEqual(resolveTerm('tattoo').clauses, [['shop=tattoo']]);
  assert.deepEqual(resolveTerm('BBQ').clauses, [['amenity=restaurant', 'cuisine~barbecue']]);
  assert.equal(resolveTerm('brewery').clauses.length, 2, 'brewery is a union of two tags');
  for (const term of Object.keys(OSM_TERMS)) {
    const q = overpassQuery(resolveTerm(term).clauses, { ...POINT, radiusM: 3000, maxResults: 50 });
    assert.match(q, /^\[out:json\]\[timeout:25\]; /);
    assert.match(q, /out tags center 50;$/);
  }
});

test('the query has the documented shape', () => {
  const q = overpassQuery(resolveTerm('tattoo').clauses, { ...POINT, radiusM: 3000, maxResults: 50 });
  assert.equal(q, '[out:json][timeout:25]; nwr["shop"="tattoo"](around:3000,25.8104,-80.2037); out tags center 50;');
  const u = overpassQuery(resolveTerm('brewery').clauses, { ...POINT, radiusM: 3000, maxResults: 50 });
  assert.equal(
    u,
    '[out:json][timeout:25]; (nwr["craft"="brewery"](around:3000,25.8104,-80.2037);nwr["microbrewery"="yes"](around:3000,25.8104,-80.2037);); out tags center 50;',
  );
  assert.equal(filterString(resolveTerm('bbq').clauses), '["amenity"="restaurant"]["cuisine"~"barbecue"]');
});

test('a raw key=value term passes through', () => {
  const r = resolveTerm('shop=bakery');
  assert.equal(r.source, 'raw');
  assert.deepEqual(r.clauses, [['shop=bakery']]);
});

test('an unknown term throws when the provider is built, before any call is spent', () => {
  const f = fakeFetch();
  assert.throws(() => osmProvider({ term: 'artisanal vibes', fetchImpl: f }), /no tag mapping/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => osmProvider({ fetchImpl: f }), /term is required/);
});

/* ---------------- failure contract ---------------- */

/** A sleep that records what it was asked to wait and returns at once. */
function fakeSleep() {
  const waits = [];
  const impl = async (ms) => { waits.push(ms); };
  impl.waits = waits;
  return impl;
}

test('HTTP 429 throws', async () => {
  const p = osmProvider({ term: 'dentist', retries: 0, fetchImpl: fakeFetch({ status: 429, body: 'rate limited' }) });
  await assert.rejects(p.query({ ...POINT, term: 'dentist' }), /osm 429: rate limited$/);
});

test('a throttled call is retried with backoff, and still throws when the retries run out', async () => {
  const f = fakeFetch({ status: 429, body: 'rate limited' });
  const sleepImpl = fakeSleep();
  const p = osmProvider({ term: 'dentist', fetchImpl: f, sleepImpl });
  await assert.rejects(p.query({ ...POINT }), /osm 429: rate limited \(after 3 attempts\)/);
  assert.equal(f.calls.length, 3, 'one call plus two retries, and no more');
  assert.deepEqual(sleepImpl.waits, [5000, 10000], 'backoff doubles');
});

test('a retry that succeeds returns the measurement; an empty answer after a 504 is still ABSENT', async () => {
  let n = 0;
  const flaky = async () => (++n === 1
    ? { ok: false, status: 504, text: async () => 'gateway timeout' }
    : { ok: true, status: 200, text: async () => '{"elements":[]}' });
  const sleepImpl = fakeSleep();
  const p = osmProvider({ term: 'dentist', fetchImpl: flaky, sleepImpl });
  assert.deepEqual(await p.query({ ...POINT }), { results: [] });
  assert.equal(n, 2);
  assert.deepEqual(sleepImpl.waits, [5000]);
});

test('the server\'s Retry-After is honoured, capped at 60 s', async () => {
  const mk = (after) => async () => ({ ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? after : null) }, text: async () => 'slow down' });
  const s1 = fakeSleep();
  await assert.rejects(osmProvider({ term: 'dentist', retries: 1, fetchImpl: mk('12'), sleepImpl: s1 }).query({ ...POINT }));
  assert.deepEqual(s1.waits, [12000]);
  const s2 = fakeSleep();
  await assert.rejects(osmProvider({ term: 'dentist', retries: 1, fetchImpl: mk('3600'), sleepImpl: s2 }).query({ ...POINT }));
  assert.deepEqual(s2.waits, [60000]);
});

test('what is not throttling is not retried: a 400, a runtime-error remark, a non-JSON body, our own timeout', async () => {
  const sleepImpl = fakeSleep();
  const bad = fakeFetch({ status: 400, body: 'parse error' });
  await assert.rejects(osmProvider({ term: 'dentist', fetchImpl: bad, sleepImpl }).query({ ...POINT }), /osm 400: parse error$/);
  assert.equal(bad.calls.length, 1);
  const remark = fakeFetch({ body: JSON.stringify({ elements: [], remark: 'runtime error: out of memory' }) });
  await assert.rejects(osmProvider({ term: 'dentist', fetchImpl: remark, sleepImpl }).query({ ...POINT }), /runtime error/);
  assert.equal(remark.calls.length, 1);
  const html = fakeFetch({ body: '<html>busy</html>' });
  await assert.rejects(osmProvider({ term: 'dentist', fetchImpl: html, sleepImpl }).query({ ...POINT }), /not JSON/);
  assert.equal(html.calls.length, 1);
  let hangs = 0;
  const hang = (url, init) => { hangs++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
  await assert.rejects(osmProvider({ term: 'dentist', fetchImpl: hang, timeoutMs: 20, sleepImpl }).query({ ...POINT }), /no response in 20 ms$/);
  assert.equal(hangs, 1, 'a 30 s timeout is not tripled');
  assert.deepEqual(sleepImpl.waits, []);
});

test('a remark reporting a runtime error throws, even with status 200', async () => {
  const body = JSON.stringify({ elements: [], remark: 'runtime error: Query run out of memory using about 2048 MB of RAM.' });
  const p = osmProvider({ term: 'dentist', fetchImpl: fakeFetch({ body }) });
  await assert.rejects(p.query({ ...POINT }), /runtime error/);
});

test('a remark reporting a timeout throws', async () => {
  const body = JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' });
  const p = osmProvider({ term: 'dentist', fetchImpl: fakeFetch({ body }) });
  await assert.rejects(p.query({ ...POINT }), /timed out/);
});

test('a body that is not JSON throws', async () => {
  const p = osmProvider({ term: 'dentist', fetchImpl: fakeFetch({ body: '<html>The server is probably too busy</html>' }) });
  await assert.rejects(p.query({ ...POINT }), /not JSON/);
});

test('a JSON body with no elements array throws', async () => {
  const p = osmProvider({ term: 'dentist', fetchImpl: fakeFetch({ body: '{"version":0.6}' }) });
  await assert.rejects(p.query({ ...POINT }), /no elements array/);
});

test('a fetch that never answers is cut off by the client timeout and throws', async () => {
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const p = osmProvider({ term: 'dentist', fetchImpl: hang, timeoutMs: 20 });
  await assert.rejects(p.query({ ...POINT }), /no response in 20 ms/);
});

test('a network error is retried, then throws', async () => {
  let n = 0;
  const sleepImpl = fakeSleep();
  const p = osmProvider({ term: 'dentist', sleepImpl, fetchImpl: async () => { n++; throw new Error('getaddrinfo ENOTFOUND'); } });
  await assert.rejects(p.query({ ...POINT }), /ENOTFOUND \(after 3 attempts\)/);
  assert.equal(n, 3);
});

test('an empty elements array is a legitimate measured absence', async () => {
  const p = osmProvider({ term: 'dentist', fetchImpl: fakeFetch() });
  assert.deepEqual(await p.query({ ...POINT }), { results: [] });
});

/* ---------------- ranking rule ---------------- */

test('ranking is distance ascending, ties by id, and is stable under input order', () => {
  const elements = [
    el('node', 30, 25.8280, -80.2037, 'Far'),
    el('way', 20, 25.8114, -80.2037, 'Near B'),
    el('node', 10, 25.8114, -80.2037, 'Near A'),
    el('relation', 5, 25.8180, -80.2037, 'Middle'),
    { type: 'node', id: 99, tags: { name: 'No coordinates' } },
  ];
  const a = rankElements(elements, POINT).map((r) => r.id);
  const b = rankElements([...elements].reverse(), POINT).map((r) => r.id);
  assert.deepEqual(a, ['osm:node/10', 'osm:way/20', 'osm:relation/5', 'osm:node/30']);
  assert.deepEqual(b, a, 'order must not depend on the order Overpass returned');
});

test('results carry id, name, null rating and reviews, and distance in metres', async () => {
  const body = JSON.stringify({ elements: [el('node', 1, 25.8194, -80.2037, 'Listed Shop'), el('way', 2, 25.8105, -80.2037)] });
  const p = osmProvider({ term: 'dentist', fetchImpl: fakeFetch({ body }) });
  const { results } = await p.query({ ...POINT });
  assert.equal(results[0].id, 'osm:way/2');
  assert.equal(results[0].name, '', 'an unnamed listing is still a listing');
  assert.deepEqual(
    { rating: results[1].rating, reviews: results[1].reviews, name: results[1].name },
    { rating: null, reviews: null, name: 'Listed Shop' },
  );
  const expected = Math.round(haversineKm(POINT.lat, POINT.lng, 25.8194, -80.2037) * 1000);
  assert.equal(results[1].distanceM, expected);
  assert.ok(Math.abs(results[1].distanceM - 1000) < 15, `about 1 km north, got ${results[1].distanceM} m`);
});

/* ---------------- shape, pins, politeness ---------------- */

test('the provider validates, paces at 1500 ms by default, and records its pins', () => {
  const p = osmProvider({ term: 'dentist', fetchImpl: fakeFetch() });
  assert.deepEqual(validateProvider(p), []);
  assert.equal(p.pacingMs, 1500);
  assert.deepEqual(p.pins, {
    pointRadiusM: 3000,
    radiusMode: 'restriction',
    radiusNote: 'a business further than 3 km from a sample point cannot be returned at that point',
    maxResults: 50,
    ranking: 'distance-asc',
    filter: '["amenity"="dentist"]',
    term: 'dentist',
  });
});

test('the request goes to Overpass as a POST with a descriptive User-Agent', async () => {
  const f = fakeFetch();
  await osmProvider({ term: 'dentist', fetchImpl: f }).query({ ...POINT });
  assert.equal(f.calls[0].url, ENDPOINT);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /^falloff\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/CandyFlex\/falloff\)$/);
  assert.match(decodeURIComponent(f.calls[0].init.body), /^data=\[out:json\]/);
});

test('asking a built provider for a different term is refused', async () => {
  const p = osmProvider({ term: 'dentist', fetchImpl: fakeFetch() });
  await assert.rejects(p.query({ ...POINT, term: 'bbq' }), /built for term/);
});

/* ---------------- through the runner ---------------- */

test('in a scan, Overpass failures become UNREACHED and empty answers become ABSENT, and the pins are in the snapshot', async () => {
  let n = 0;
  const flaky = async () => {
    const i = n++;
    if (i % 20 === 0) return { ok: false, status: 504, text: async () => 'gateway timeout' };
    const elements = i < 12 ? [el('node', 7, 25.8105, -80.2038, 'Target Listing')] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ elements }) };
  };
  const provider = osmProvider({ term: 'dentist', fetchImpl: flaky, pacingMs: 0, retries: 0 });
  const { snapshot, audit: a } = await scan({
    target: { name: 'Target Listing', id: 'osm:node/7', ...POINT },
    query: 'dentist',
    preset: 'tight',
    provider,
    command: 'falloff scan --provider osm --test',
  });
  const t = tally(snapshot.readings);
  assert.equal(t.unreached, 3, 'calls 0, 20 and 40 failed');
  assert.equal(t.found, 11);
  assert.equal(t.absent, 60 - 3 - 11);
  assert.ok(snapshot.readings.filter((r) => r.status === 'unreached').every((r) => /osm 504/.test(r.error)));
  assert.equal(snapshot.provider.id, 'osm-overpass');
  assert.equal(snapshot.provider.pins.ranking, 'distance-asc');
  assert.equal(a.ok, true, JSON.stringify(a.findings));
});
