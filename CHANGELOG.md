# Changelog

## 0.1.0 (unreleased, staged 2026-09-19)

First version.

### Changed before release (2026-09-20)
- The five original studies are replaced by two seeded studies of the query
  "dentist": one business in Miami, FL and one in Elkins, WV, 80 points each.
  The query, both places and the point inside each came from one seed;
  `scripts/draw.mjs` replays the draw. The test fixture and the tampered
  example are now built from the Miami scan.
- `scripts/build-field.mjs` rebuilds a reading for every business a scan
  captured, so one scan gives a reach figure for the whole field.
- The site has three pages. `docs/index.html` is a plain introduction,
  `docs/case-study.html` walks through the two studies, and the technical
  page moved to `docs/method.html`. `scripts/build-site-data.mjs` writes the
  data behind the first two, and `test/site.test.mjs` keeps it current.
- Example coordinates in tests and docs no longer point at a real business.

### Method
- Radial sampler `radial-v2`: geometric ring ladder, points proportional to
  circumference, golden-angle stagger, exact call budget. Four presets.
- Three reading states: found, absent, unreached. Enforced when a reading is
  constructed. Unreached points leave every denominator and are counted beside it.
- Metrics that carry their denominators: visibility, top-3 share, per-ring
  breakdown, reach edge, top-3 edge (with a Wilson 95% interval on the
  qualifying ring and the next one, a censored flag when the edge is the
  outermost ring scanned, and a fragile flag from those intervals rather than
  from a size-blind margin), gone-by ring, and a named shape including
  `absent` for a scan with no sightings and `patchy` for a curve that comes
  back after a zero ring.
- `goneBy` is the first reportable ring with no sightings after which no
  reportable ring has one. When sightings resume there is no gone-by and the
  rings where they resume are named. The old definition printed
  "gone by 2.5 km" for a business seen at 3.9, 6.2 and 9.8 km.
- A ring is not reportable when more than a third of its points are unreached,
  as well as when fewer than four were measured.
- `listDepth` per reading and `method.observation.listDepth`: absent means not
  in the captured list of that depth, and providers do not return a fixed
  depth.
- User-facing wording is "top 3", because the local pack is a Google Search
  feature and this measures position in the Maps results feed. The API keeps
  `pack` and adds `top3Share` and `top3Edge` as aliases.
- The latitude and longitude scale constants are recorded method pins
  (`kmPerDegLat`, `kmPerDegLngEquator`, `lngScale`). The audit replays with
  the recorded values.

### Audit
- Recomputes everything from raw readings. Groups A to F: structure,
  reachability (more than 10% unreached fails), status integrity, geometry
  replay to 1e-6 degrees, field plausibility, fragility.
- The geometry replay uses the pins the snapshot recorded, not this build's
  constants, and refuses a sampler it cannot replay. A recorded pin that is
  not the one its sampler version is defined with fails; `kmPerDegLat` is the
  one that may vary.
- Exactly one reading per planned point, and each is checked on distance,
  bearing, label and coordinates. The target has to sit on the home point.
- A found rank must point at the target's id in the captured list and may not
  run past the end of it; an absence may not contain the target's id; the
  capture depth must match the rows; `packSize` must equal the constant; the
  provider block must agree with the method; a redaction block must match what
  is actually in the file.
- The verdict reads "PASS: internally consistent", not "Safe to publish". The
  module header and the README list what the audit cannot know.
- One `[tamper]` test per doctored snapshot from the 2026-09-19 review,
  including the two that still pass and say so.

### Providers
- `places`: Google Places API (New), your key. NEVER RUN LIVE by the author.
  It posts to `places:searchText` with a `locationBias` circle, because Nearby
  Search (New) has no text query field and would answer 400; it asks for
  `places.id` and `places.displayName` only, which bills as Text Search Pro,
  5,000 free events a month (checked 2026-09-19).
- `osm`: OpenStreetMap through Overpass, no key. Ranks by distance and records
  that rule. Measures listing proximity in the open map, not Google.
  Throttled calls (429, 502, 503, 504, dropped connections) are retried twice
  with backoff, honouring Retry-After, then recorded as unreached. `--pacing`
  slows the scan down. Each query is RESTRICTED to a 3 km circle, so a
  business further than that from a sample point cannot be returned there and
  every ring beyond 3 km is absent by construction. The radius is a pin and
  `report` prints it.
- `manual`: `plan` writes a sheet of Maps links, `ingest` turns the filled
  sheet into a snapshot. Blank rows are unreached. Rows are matched by ring
  and index with a coordinate tolerance of 1e-5 degrees, so a spreadsheet that
  rounds a coordinate on save does not throw the work away.
- Provider pins are written into the snapshot.

### Commands
- `scan`, `plan`, `ingest`, `audit`, `report`, `render`, `compare`, `redact`,
  `convert`.
- `compare` takes two snapshots of the same plan, refuses on a query or pin
  mismatch by name, and prints per-point agreement with the rank movement as a
  distribution. A point unreached in either pass is never agreement and never
  a change.
- Every command that prints a figure prints its reproduce command. Exit 0 ok,
  1 audit failed or input refused, 2 usage. `--key` is never recorded.

### Publishing
- `redact` withholds names, replaces every id with `h:` plus 16 hex of
  SHA-256(salt + id) under a random per-study salt written only to
  `studies/private/<study>.salt`, rounds the centre to 0.01 degrees and
  recomputes every sample point from the rounded centre so the geometry still
  replays, and replaces the whole source file name. It says in the block that
  withheld is not anonymous. The result passes the same audit. Browser-safe: it
  takes a hash function and falls back to a pure SHA-256.
- The published studies previously kept Google feature ids, whose second half
  is the CID, and the centre to seven decimals. `test/fixtures/legacy-grid-scan.json`
  did too. Both are fixed, and `test/leak.test.mjs` checks the shape of every
  tracked snapshot so the guard runs in CI rather than only on one machine.
- `render` writes a standalone HTML report: no scripts, no external requests,
  status encoded by shape and colour.
- `convert` rebuilds legacy grid-scan radial files, replaying their geometry
  and re-deriving rank from the captured lists by place id.
- Five dated studies with names withheld, with a generated index grouped by
  preset. They were observed with an automated browser scan written by the
  author, which is not in this repository; the recorded commands re-render
  those files, and re-observing needs your own provider.

### Showcase page
- `docs/` rebuilt as a generated page: `scripts/build-docs-data.mjs` discovers
  the studies, writes `docs/data.js` (no names, no result lists), copies each
  report to `docs/studies/`, and renders every figure into `docs/index.html`,
  so the page is complete without JavaScript.
- The lab runs the real `scan()` and `audit()` from `docs/lib/` over a
  synthetic provider, labelled as a constructed scenario.
- Fonts are vendored (B612, OFL). The page makes no request to another origin.
- The install section reports what `npm view falloff` returned at build time.
- Removed `docs/study/study-1.json`, `docs/hero.svg` and the first-pass
  `tools/` scripts, which carried or read real business names.
- `test/docs-data.test.mjs` fails when `docs/` is stale, when a name from
  `studies/private/` appears under `docs/`, or when the page would load
  anything from another origin.

### Known limits at 0.1.0

- The Places provider has never been run against Google.
- No study has been run twice, so nothing here measures scan-to-scan variance.
- An overall visible share is a share of the sample points a preset lays down.
  It is not comparable across presets, and the page and the index group by
  preset for that reason.
- An audit pass is internal consistency, not proof. The README names the four
  things it cannot see.
