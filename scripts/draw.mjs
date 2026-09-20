#!/usr/bin/env node
/**
 * draw.mjs: the seeded draw behind the two demo studies.
 *
 * Nothing about the demo studies was chosen by hand. One seed string drives a
 * small PRNG, which picks the query, a metro and a point inside it, a quiet
 * town and a point inside it, and a pick fraction for each. The author's
 * private scanner then read the map list at each point once and took the
 * business at floor(pickFraction * listLength). The fraction is drawn before
 * that list is seen, so the list cannot steer the pick.
 *
 * This file is the public half: it is pure, it touches no network, and it
 * prints the same draw every time. The probe and the scan are not in this
 * repository (it ships no scraper), and the picked business is withheld.
 *
 * Usage: node scripts/draw.mjs [--seed "<string>"]
 */
import { createHash } from 'node:crypto';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const seed = arg('seed', 'falloff-demo-2026-09-20');

// mulberry32 seeded from the first 4 bytes of sha256(seed)
let state = createHash('sha256').update(seed).digest().readUInt32BE(0);
const rnd = () => { state |= 0; state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// Everyday categories a person searches on a map. Drawn, not chosen.
const QUERIES = ['coffee', 'hardware store', 'pharmacy', 'auto repair', 'pizza', 'dentist', 'barber', 'veterinarian'];

// The 25 largest US metro areas by population, North Carolina excluded. City-centre coordinates.
const METROS = [
  ['New York, NY', 40.7128, -74.0060], ['Los Angeles, CA', 34.0522, -118.2437], ['Chicago, IL', 41.8781, -87.6298],
  ['Dallas, TX', 32.7767, -96.7970], ['Houston, TX', 29.7604, -95.3698], ['Washington, DC', 38.9072, -77.0369],
  ['Philadelphia, PA', 39.9526, -75.1652], ['Atlanta, GA', 33.7490, -84.3880], ['Miami, FL', 25.7617, -80.1918],
  ['Phoenix, AZ', 33.4484, -112.0740], ['Boston, MA', 42.3601, -71.0589], ['Riverside, CA', 33.9806, -117.3755],
  ['San Francisco, CA', 37.7749, -122.4194], ['Detroit, MI', 42.3314, -83.0458], ['Seattle, WA', 47.6062, -122.3321],
  ['Minneapolis, MN', 44.9778, -93.2650], ['Tampa, FL', 27.9506, -82.4572], ['San Diego, CA', 32.7157, -117.1611],
  ['Denver, CO', 39.7392, -104.9903], ['Baltimore, MD', 39.2904, -76.6122], ['St. Louis, MO', 38.6270, -90.1994],
  ['Orlando, FL', 28.5383, -81.3792], ['San Antonio, TX', 29.4241, -98.4936], ['Portland, OR', 45.5152, -122.6784],
  ['Austin, TX', 30.2672, -97.7431],
];

// Small county seats a long drive from any large city, spread across regions. North Carolina excluded.
const QUIET = [
  ['Valentine, NE', 42.8728, -100.5510], ['Lewistown, MT', 47.0625, -109.4282], ['Alpine, TX', 30.3585, -103.6610],
  ['Ely, NV', 39.2533, -114.8742], ['Winner, SD', 43.3767, -99.8590], ['Houlton, ME', 46.1262, -67.8403],
  ['Colby, KS', 39.3958, -101.0524], ['Burns, OR', 43.5863, -119.0541], ['Worland, WY', 44.0169, -107.9554],
  ['Marianna, AR', 34.7737, -90.7576], ['Salmon, ID', 45.1758, -113.8957], ['Lamar, CO', 38.0872, -102.6207],
  ['Bottineau, ND', 48.8272, -100.4457], ['Greenville, MS', 33.4101, -91.0618], ['Moab, UT', 38.5733, -109.5498],
  ['Ironwood, MI', 46.4547, -90.1710], ['Socorro, NM', 34.0584, -106.8914], ['Elkins, WV', 38.9259, -79.8467],
  ['Crescent City, CA', 41.7558, -124.2026], ['Thomaston, GA', 32.8882, -84.3266],
];

const pointInDisc = (lat, lng, rKm) => {
  const r = rKm * Math.sqrt(rnd()), a = rnd() * 2 * Math.PI;
  return { lat: +(lat + (Math.cos(a) * r) / 110.57).toFixed(5), lng: +(lng + (Math.sin(a) * r) / (111.32 * Math.cos(lat * Math.PI / 180))).toFixed(5), offsetKm: +r.toFixed(2) };
};

const query = pick(QUERIES);
const metro = pick(METROS), quiet = pick(QUIET);
const areas = [
  { kind: 'metro', place: metro[0], discKm: 10, point: pointInDisc(metro[1], metro[2], 10) },
  { kind: 'quiet', place: quiet[0], discKm: 3, point: pointInDisc(quiet[1], quiet[2], 3) },
];
// The pick index for each area is drawn NOW, before the probe, so what the probe returns cannot steer it.
for (const a of areas) a.pickFraction = rnd();

const out = { seed, prng: 'mulberry32 seeded from the first 4 bytes of sha256(seed)', query, queries: QUERIES, metroPool: METROS.map((m) => m[0]), quietPool: QUIET.map((m) => m[0]), areas };
console.log(JSON.stringify(out, null, 2));
