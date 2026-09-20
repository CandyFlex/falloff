# falloff

Measures where a local business is visible in map search across a geography,
and where it stops.

```
$ falloff report studies/2026-09-20-dentist-miami-fl/snapshot.json
  name withheld, query "dentist"
  80 points, 2.5-60 km, 8 rings, preset mid
  observed 2026-09-20 via google-maps-web (grid-scan radial-v2 @13z)
  absent means not in the captured list at that point; those lists held 1-10 rows

  visible      24/80 measured  30%   (0 unreached, excluded)
  in the top 3 24/80 measured  30%
  (share of sample points, preset mid; not comparable across presets)
  reach edge   6.2 km  (6/6 on that ring)  [fragile]
               a re-scan could move this edge: the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5
  top-3 edge   6.2 km  (6/6 on that ring)  [fragile]
               a re-scan could move this edge: the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5
  gone by      not reportable: sightings resume at 24.2, 38.1 km
  shape        patchy  (inner 6/6, middle 0/8, outer 0/18)

  by ring
       2.5 km  ████████████████████  6/6
       3.9 km  ████████████████████  6/6
       6.2 km  ████████████████████  6/6
       9.8 km  ███████·············  2/6
      15.4 km  ····················  0/8
      24.2 km  ███·················  2/12
      38.1 km  █···················  1/17
        60 km  ····················  0/18

  Business name withheld. Ids are hashed with a salt that is not published.
  The centre is rounded to 0.01 degrees, about 1 km, and the sample points are
  recomputed from the rounded centre. The scan was observed at the true coordinates.
  Withheld is not anonymous: the town, the query and the date are kept, and they narrow the candidates a long way.

  reproduce: falloff convert withheld.json
```

That is a real scan of a real dental practice in Miami, FL, observed on
2026-09-20. Every figure above is recomputed from the raw readings when you
run the command.

---

## Read the limits first

- **This repository ships no scraper.** Nothing in the package drives a
  browser against anyone's site. You bring readings through a provider.
- **The two studies were not gathered by anything in this repository.** They
  were observed with an automated browser scan written by the author, which is
  not included here. The reproduce command on a study re-renders the recorded
  file; re-observing those points needs your own provider.
- **The Google Places provider has never been run live.** The author has no
  key. The request shape follows Google's published reference and is asserted
  offline; nobody has seen it answer.
- **The OpenStreetMap provider does not measure Google, and its radius caps
  what it can see.** Each point asks for listings within 3 km, so a business
  further than that from a sample point cannot be returned at all. Every ring
  past 3 km is absent by construction, and an OSM scan will read as a falloff
  whatever the business does. It measures listing order in the open map, and
  it is a free way to exercise the whole pipeline.
- **A single-pass scan is one observation on one day.** No study here has been
  run twice, so nothing in this repository measures how far a point moves
  between scans. `falloff compare` is the command that would.
- **An overall share depends on the preset.** Points are allocated by ring
  circumference, so the same business scores differently on `tight` and `mid`.
  The per-ring table and the edges are comparable; the headline share is not.

---

## The distinction the whole thing rests on

At every sampled point, one of three things is true:

| | meaning |
|---|---|
| **found** | the business appeared, at rank *n* |
| **absent** | the point was measured, and the business was not in the list captured there |
| **unreached** | the point was never measured (timeout, block, quota, crash) |

A tool that merges the last two reports the same "37% visible" for a scan that
failed at 30 of 80 points and a scan that completed and found nothing at those
points. One says the business has no reach there. The other says we do not
know.

Falloff keeps them apart, and enforces it in the type instead of trusting
the caller:

```js
reading({ point, status: ABSENT, rank: 4 })
// Error: reading: only FOUND may carry a rank, got status=absent rank=4

reading({ point, status: UNREACHED })
// Error: reading: UNREACHED must record why; an unexplained gap is
//        indistinguishable from a lie
```

Unreached points are excluded from every denominator and reported beside it.
That is why the output says `37/80 measured` and then `(0 unreached, excluded)`.

`test/vacuum.test.mjs` builds both scans: 30 sightings in 80 measured points,
and 30 sightings with 30 points that never answered. A tool that merges the
two states prints 30/80 for both. Falloff prints 30/80 for the first and 30/50
with 30 unreached for the second, and the audit refuses to publish the second.

### What "absent" is absent from

A provider hands back some number of rows per point, and that number is not
fixed: the Miami study captured lists of one, two, seven, nine and ten rows
within one scan. So absent means **not in the captured list of that depth**, and the
depth is recorded per reading (`listDepth`) with the range in
`method.observation.listDepth`. Without it, a shallower capture looks like a
smaller business.

---

## Every figure carries its denominator

A bare percentage cannot be checked. A count can. These are the real values
for the study above:

```js
visibility(readings)
// {"found":24,"measured":80,"unreached":0,"share":0.3,"reliable":true,"note":null}
```

A ring with too few measured points, or with more than a third of its points
unreached, does not return a confident-looking number. It says so:

```js
byRing(readings)[0]   // the home point is one point, not a ring
// {"ring":0,"dKm":0,"found":1,"absent":0,"unreached":0,"inPack":1,"measured":1,
//  "visibleShare":1,"packShare":1,"reliable":false,
//  "note":"only 1 measured point(s); needs 4 to be reportable"}
```

And a figure that a re-scan would move flags itself, with the arithmetic that
says so. Fragile means a Wilson 95% interval on the qualifying ring or on the
next ring out contains the threshold:

```js
packEdge(readings)
// {"dKm":6.2,"ring":3,"hits":6,"measured":6,"need":3,"margin":3,
//  "interval":{"lo":0.609...,"hi":1},
//  "nextInterval":{"lo":0.096...,"hi":0.700...},"nextRingKm":9.8,
//  "censored":false,"nonMonotonic":false,"fragile":true,"thinMargin":false,
//  "note":"the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5"}
```

Two more things a figure will refuse to say:

- **`gone by` is withheld when sightings resume.** It is the first reportable
  ring with no sightings after which no reportable ring has one. The Miami
  study is 6/6, 6/6, 6/6, 2/6, then 0/8, and then 2/12 and 1/17 further out:
  there is no distance past which that business stops, so nothing is printed
  and the shape is called `patchy`.
- **An edge on the outermost ring scanned is printed as "at least X km"**
  (`censored: true`). The scan cannot say how much further it reaches.

---

## The audit replays the geometry

The scanner is never trusted to grade itself. `falloff audit` recomputes
everything from the raw readings. It is arithmetic only, with no judgment and
no model, and it **regenerates the sampling plan from the method pins recorded
in the snapshot**, then checks the coordinates, the distances, the bearings
and the labels against it. Exactly one reading per planned point, no more
and no fewer.

`snapshots/tampered.json` is the study above with four edits: a rank written
onto a point where the business was not seen, `method.rmax` changed from 60 to
55, the top-3 size widened to 20, and a competitor's id in one captured list
swapped for the target's own.

```
$ falloff audit snapshots/tampered.json
  snapshots/tampered.json
  FAIL  A3b  method.packSize is 20 but this build measures the top 3
  WARN  A5  names withheld (target.name, readings[].results[].name, ids, target.lat, target.lng, readings[].lat, readings[].lng, command, provenance.sourceFile); no name survives in this file and the figures are unaffected
  FAIL  C7  ABSENT at 9.8 km ESE, but the captured list contains the target's own id (h:cf85433690e77284)
  FAIL  C2  absent carries rank 1 at 24.2 km NNW
  FAIL  D4  recorded points drift from the method by 6.71e-2 deg, and 134 point(s) also disagree on distance, bearing or label
  WARN  F1  top-3 edge 6.2 km is fragile, so a re-scan could move it: the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5
  WARN  F1  reach edge 6.2 km is fragile, so a re-scan could move it: the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5
  WARN  F4  sightings resume beyond a ring with none (at 24.2, 38.1 km), so there is no gone-by distance to report

  FAIL: not internally consistent (4 critical, 4 warning(s)). Nothing publishes.

  reproduce: falloff convert withheld.json
```

Exit code 1, so it works as a gate in a pipeline.

| group | checks |
|---|---|
| A | schema, reproduce command, method pins, the top-3 size against the constant, provider agreement between the two places it is written, a redaction block that matches what is actually in the file |
| B | status counts add up; more than 10% unreached fails |
| C | found has a rank, absent and unreached do not; unreached has a reason; the rank points at the target's id in the captured list; an absence is not contradicted by its own list; the capture depth matches the rows |
| D | the sampler is one this build can replay; the recorded pins are the ones that sampler is defined with; the plan replayed from those pins lands on the recorded points within 1e-6 degrees, with the same distance, bearing and label, exactly one reading per planned point, and the target at the home point |
| E | ratings and review counts in range; no duplicate id at a point |
| F | fragile edges, censored edges, non-monotonic decay and thin rings are flagged |

### What the audit cannot know

A pass says the file is internally consistent. It does not say the readings
are true, and the verdict reads `PASS: internally consistent` for that reason.
Some facts are not in the file at all:

- **A fabricated results list.** Rows can be invented and the target's id put
  among them. Recording the capture depth narrows this, because a row added or
  removed no longer matches the depth recorded with it and a depth outside the
  scan's own range fails, but a list forged whole at the right depth is
  consistent with everything else.
- **An unreached point rewritten as absent.** The reason is deleted with it,
  so the file simply says a point was measured and nothing was there. There is
  no trace of the difference. `test/tamper.test.mjs` contains this case and
  asserts that it passes, so that nobody discovers it by surprise.
- **Two readings swapped between points whose captured lists are the same
  depth.** Nothing ties a captured list to a coordinate.
- **The query, the timestamps and the reproduce command.** They are recorded,
  not authenticated.

Every other row of the hostile review that produced this list is a test in
`test/tamper.test.mjs`, named for what the edit claimed.

---

## The sampling is allocated by circumference

A uniform grid spends most of its budget far from the business, where nothing
changes, and under-samples the near ring, where everything does. Fixed spokes
are worse. At 8 spokes the 4 km ring has a point every 3 km and the 120 km
ring has one every 94 km.

Falloff allocates by **circumference**:

1. Ring radii follow a geometric ladder from `rmin` to `rmax`, so rings
   cluster where the decay happens.
2. Points per ring are proportional to that ring's radius, floored at 6, so
   angular spacing stays roughly even at every distance.
3. Each ring is rotated by the golden angle (2.39996 rad) from the last, so
   points never line up into radial lanes that leave wedges unsampled.
4. The total is reconciled to an exact call budget, so cost is known before
   the scan starts.

The growth ratio (1.55), the golden angle, the ring floor and the two earth
constants (110.574 km per degree of latitude, 111.32 x cos(lat) per degree of
longitude) are **pinned constants**, not tuning knobs. Changing one changes
what a snapshot means, so every snapshot carries them and the audit replays
with what it recorded. A snapshot whose pins are not the ones its sampler
version is defined with fails; the latitude constant is the one exception,
because an older scanner used 110.57 and those files are honest measurements
of a slightly different earth.

### Presets

| preset | reach | budget | for |
|---|---|---|---|
| `tight` | 1.5 to 20 km | 60 | walk-in trade: coffee, barbers, nail salons |
| `mid` | 2.5 to 60 km | 80 | everyday drive: restaurants, dentists |
| `regional` | 3 to 90 km | 90 | specialists, venues |
| `wide` | 4 to 120 km | 100 | destination: people plan a trip |

---

## Install

Not on npm yet. Clone it:

```sh
git clone https://github.com/CandyFlex/falloff
cd falloff
```

Node 20 or later. No dependencies, no build step, no install step.

Every command in this README runs as written from the repository root if you
define the command for your shell session:

```sh
falloff() { node bin/falloff.mjs "$@"; }
```

That is a POSIX shell function. In PowerShell, cmd, or anywhere else, run the
same commands as:

```
node bin/falloff.mjs <args>
```

---

## Three ways to get readings

### 1. Google Places API, with your key. Untested.

**The author has never run this provider.** There is no key on this machine
and no response from Google has ever passed through it. What is here is a
request shape written against Google's published reference, with an offline
test that asserts the shape. Check the first response yourself.

```sh
export FALLOFF_PLACES_KEY=...
falloff scan --name "Some Business" --id <place-id> --lat 25.81 --lng -80.2 \
             --query dentist --preset tight --out out/scan.json
```

It POSTs to `places:searchText`, because Nearby Search (New) has no text
query field: its body takes `includedTypes`, `excludedTypes`,
`includedPrimaryTypes`, `excludedPrimaryTypes`, `locationRestriction`,
`maxResultCount`, `rankPreference`, `languageCode`, `regionCode` and
`includeFutureOpeningBusinesses`, and Google rejects unknown fields with a
400. Each point uses a `locationBias` circle of 3 km rather than a
restriction, so a sighting from further away is still possible; a hard
restriction would make the outer rings absent by construction.

The field mask asks for `places.id` and `places.displayName` and nothing
else. `places.id` bills under Text Search Essentials ID Only and
`places.displayName` under Text Search Pro, so a call billing both bills as
**Text Search Pro: 5,000 free events a month**
(developers.google.com/maps/billing-and-pricing/pricing, checked 2026-09-19).
An 80-point scan is 80 events. `places.rating` and `places.userRatingCount`
are Enterprise SKU fields and are not requested.

The key is never written to the snapshot. The recorded reproduce command
drops `--key` and its value.

### 2. OpenStreetMap, no key

```sh
falloff scan --provider osm --name "Some Business" --id osm:node/123456 \
             --lat 25.81 --lng -80.2 --query dentist --preset tight --out out/osm.json
```

Two limits, both first. **OpenStreetMap has no ranking:** this provider sorts
the listings Overpass returns by distance from each sample point (ties by id)
and records that rule in the snapshot as `ranking: 'distance-asc'`. And **each
point is restricted to a 3 km circle,** so a business further than 3 km from a
sample point cannot be returned there at all. The presets put five to seven
rings beyond 3 km, so an OSM scan reads as a falloff by construction past that
radius. Raise it with `osmProvider({ pointRadiusM })` if you want the outer
rings to mean anything. The radius is in `provider.pins` and `falloff report`
prints it.

Terms map to OSM tags through a small table (`dentist`, `restaurant`, `bbq`,
`brewery`, `bar`, `coffee`, `cafe`, `mechanic`, `plumber`, `hvac` and a few
more), or pass a raw tag such as `shop=bakery`. An unknown term is refused
before any call is made, and the message lists every term the table knows.

The public Overpass server is shared and it throttles. The first live run of
this provider, on 2026-09-19, was a 60-point `tight` scan in the shape shown
above. It got an answer at 6 of 60 points; the other 54 came back 429, 504 or
a dropped connection. Falloff
reported exactly that: `0/6 measured (54 unreached, excluded)`, and the audit
failed with `B4  54/60 points unreached (90%); too many gaps to publish`. It
did not report "0% visible". Since then a throttled call is retried twice,
waiting for the server's `Retry-After` when it sends one, before the point is
recorded as unreached. That change has been tested offline only; it has not
yet been run against the live server. Requests are paced at 1500 ms by
default; pass `--pacing 5000` to go slower, or point `osmProvider({ endpoint })`
at an Overpass instance of your own.

### 3. The manual sheet, no key, about twenty minutes

```sh
falloff plan --lat 25.81 --lng -80.2 --query dentist --preset tight \
             --out out/plan.json --sheet out/plan.csv
```

```
  60 points: the home point plus 7 rings at 1.5, 2.3, 3.6, 5.5, 8.4, 13, 20 km
  plan:   out/plan.json
  sheet:  out/plan.csv

  Open each mapsUrl in a logged-out browser window. In the status column write
  found (and the rank), or absent. Leave a row blank if you did not get to it:
  a blank row is recorded as unreached, never as absent.

  reproduce: falloff plan --lat 25.81 --lng -80.2 --query dentist --preset tight --out out/plan.json --sheet out/plan.csv
```

The protocol:

1. Open `out/plan.csv` in a spreadsheet. Each row has a `mapsUrl` pinned at
   zoom 13.
2. Open each link in a logged-out (private) browser window and read the
   results list.
3. If the business is in the list, write `found` and its position in `rank`.
   If it is not, write `absent`. If the page would not load or you skipped
   it, leave the row blank or write `unreached` and say why in `note`.
4. Save as CSV and ingest:

```sh
falloff ingest --plan out/plan.json --sheet out/plan.csv \
               --name "Some Business" --observer JO --out out/manual.json
```

Rows are matched by ring and index, and the coordinate columns are a
cross-check with a tolerance of 1e-5 degrees, about a metre. A spreadsheet
that rewrites a coordinate to ten significant digits on save is fine; a row
pasted from another point is refused by its row number. A `found` without an
integer rank is refused with its line number. A blank row becomes `unreached`
with the reason `not recorded`.

Run the ingest command above on the sheet exactly as `plan` wrote it, with
nothing filled in, and this is what you get (exit code 1):

```
  visible      not reportable: no point was measured   (60 unreached, excluded)
  in the top 3 not reportable: no point was measured
  ...
  FAIL  B4  60/60 points unreached (100%); too many gaps to publish
  ...
  FAIL: not internally consistent (1 critical, 7 warning(s)). Nothing publishes.
```

An unfilled sheet is not "0% visible". It is not a measurement at all.

The sheet records a rank or an absence, never the list it was read from, so a
manual snapshot has no capture depth. Absent there means the person looked and
did not see it, at whatever depth they scrolled.

### Bring your own provider

Falloff ships the **method**. The sampling geometry, the absent/unreached
distinction, the metrics and the auditor do not depend on where readings come
from. How you query a point is your business and your terms of service.

A provider is any object with this shape:

```js
{
  id: 'my-provider',
  version: '1',
  pacingMs: 250,
  pins: { /* anything that changes what "rank" means; recorded in the snapshot */ },
  async query({ lat, lng, term, signal }) {
    return { results: [{ id, name, rating?, reviews? }] };  // ranked, best first
  }
}
```

**One rule, and it carries everything above:** `query` must **throw** on
failure. It must never return an empty list to mean "something went wrong."
An empty list means the provider answered and there was nothing there.

---

## Studies

[studies/INDEX.md](studies/INDEX.md) lists two real, dated scans with names
withheld. They were observed with an automated browser scan written by the
author, which is not in this repository; the commands below re-render the
recorded files. The index and each study's README are generated by script from
the snapshots; no figure in them is typed.

```sh
falloff audit  studies/2026-09-20-dentist-miami-fl/snapshot.json
falloff report studies/2026-09-20-dentist-elkins-wv/snapshot.json
```

Both are the query "dentist" on preset `mid`, and they are different shapes.
The Miami scan is `patchy`: 24 of 80 measured points, sightings that stop at
9.8 km and then resume at 24.2 and 38.1 km, so there is no gone-by distance.
The Elkins scan is a `falloff`: 26 of 80 measured points, 2 of 80 in the top
3, and nothing at all past 24.2 km.

The studies are grouped by preset in the index, because an overall share is
not comparable across presets.

The same two studies are drawn on the site in `docs/` (served by GitHub Pages
once the repository is public). It has three pages: `index.html` is the plain
introduction, `case-study.html` walks through the two studies, and
`method.html` is the technical page. Open them locally with any static server
pointed at `docs/`. No figure on any of them is typed:

```sh
npm run page              # asks npm whether the package exists, then writes docs/data.js and the method page
npm run site-data         # writes docs/site-data.js, the data behind the introduction and the case study
npm run check-docs-data   # exits 1 if the method page or its data is stale
npm run check-site-data   # exits 1 if docs/site-data.js is stale
```

The two studies were not picked by hand. `node scripts/draw.mjs` replays the
seeded draw that chose the query, the two places and the point inside each.

`studies/`, `snapshots/` and `test/fixtures/` are in the repository but not in
the npm tarball, which ships `src`, `bin`, `README.md`, `LICENSE` and
`package.json` only.

---

## Convert an old scan

`convert` rebuilds a legacy `grid-scan` radial file as a `falloff/snapshot@1`.
It replays the geometry with the constant that scanner used (110.57 km per
degree of latitude) and refuses the file if any point is off by more than
1e-9 degrees. Failed rows stay unreached, with their reason. Rank is re-derived
from each point's captured list by place id, and the number of rows where the
file's own rank column disagreed is recorded in `provenance`. The end of the
scan is recorded as unknown, because the source file carries one timestamp for
the whole run.

```sh
falloff convert test/fixtures/legacy-grid-scan.json --out out/converted.json
```

```
  WARN  F1  top-3 edge 6.2 km is fragile, so a re-scan could move it: the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5
  WARN  F1  reach edge 6.2 km is fragile, so a re-scan could move it: the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5
  WARN  F4  sightings resume beyond a ring with none (at 24.2, 38.1 km), so there is no gone-by distance to report

  PASS: internally consistent (3 warning(s), 0 critical).

  reproduce: falloff convert legacy-grid-scan.json
  snapshot:  out/converted.json
```

---

## Redact before you publish

```sh
falloff redact out/converted.json --out out/public.json
```

```
  out/public.json
  withheld: target.name, readings[].results[].name, ids, target.lat, target.lng, readings[].lat, readings[].lng, command, provenance.sourceFile
  salt:     out/converted.salt (new). Keep it out of the repository; it is not recoverable from the output.
  Withheld is not anonymous: the town, the query and the date are kept, and they narrow the candidates a long way.
  WARN  A5  names withheld (target.name, readings[].results[].name, ids, target.lat, target.lng, readings[].lat, readings[].lng, command, provenance.sourceFile); no name survives in this file and the figures are unaffected
  WARN  F1  top-3 edge 6.2 km is fragile, so a re-scan could move it: the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5
  WARN  F1  reach edge 6.2 km is fragile, so a re-scan could move it: the next ring out (9.8 km) is 2/6, 95% interval 0.10-0.70, which contains 0.5
  WARN  F4  sightings resume beyond a ring with none (at 24.2, 38.1 km), so there is no gone-by distance to report

  PASS: internally consistent (4 warning(s), 0 critical).

  reproduce: falloff convert withheld.json
```

What it does, and why each part:

- **Names.** The target becomes `withheld` and every competitor name is
  removed.
- **Ids.** Every id becomes `h:` plus the first 16 hex characters of
  SHA-256(salt + id). A Google feature id is not an opaque token: its second
  half is the CID, and `google.com/maps?cid=<decimal>` opens the listing.
  Hashing preserves equality, so the rank checks in `audit` still work. The
  salt is random per study and is written only to `studies/private/<study>.salt`,
  which is git-ignored and never published. An unsalted hash would not survive
  a bulk export of place ids.
- **Coordinates.** The centre is rounded to 0.01 degrees, about 1 km, and
  every sample point is recomputed from the rounded centre with the
  snapshot's own pins, so the geometry still replays and the file still
  passes the same audit. The coordinates in the reproduce command are rounded
  with it.
- **The source file name.** Replaced wholesale with `withheld.json`. Scrubbing
  only the part that matches the name leaves the description: one study went
  out with a file name that still said what kind of business it was.

**Withheld is not anonymous.** The town, the query and the date are kept on
purpose, because without them the study measures nothing, and together they
narrow the candidates a long way. The redaction block says so in those words.

---

## Compare two passes

```sh
falloff compare out/pass-1.json out/pass-2.json
```

It refuses when the query or any comparable pin differs, naming each one, then
prints how many points were found in both, absent in both, changed, or
unreached in either, with the rank movement as a distribution. A point
unreached in either pass is never counted as agreement and never as a change.

No study here has been run twice, so this repository still contains no
measurement of scan-to-scan variance. The command is the missing half of that
sentence, not a substitute for it.

---

## Render a report

```sh
falloff render out/public.json --out out/report.html
```

One standalone HTML file: no scripts, no external requests, light and dark.
The map encodes status by shape as well as colour (filled circle, hollow
circle, x, hatched diamond), so an unmeasured point never looks like a pale
absence. The map is linear in kilometres, stated in its caption. Every figure
prints with its denominator.

---

## API

```js
import { samplePlan, scan, audit, summarise, redact, renderReport } from 'falloff';
import { osmProvider } from 'falloff/providers/osm';
import { placesProvider } from 'falloff/providers/places';

const plan = samplePlan({ lat, lng, preset: 'mid' });    // pure geometry
const { snapshot, audit: result } = await scan({ target, query, provider, command });
const figures = summarise(snapshot.readings);             // with denominators
const html = renderReport(redact(snapshot, { salt }), result);
```

Exports: `samplePlan` `ringLadder` `allocatePoints` `windName` `PRESETS`
`SAMPLERS`, `reading` `snapshot` `tally` `listDepthRange`, `visibility`
`packShare` `top3Share` `byRing` `packEdge` `top3Edge` `reachEdge` `goneBy`
`decayShape` `archetype` `summarise` `wilson`, `audit` `formatAudit`
`verdictLine`, `compare` `formatCompare`, `scan`, `redact`, `renderReport`,
`makePlan` `planSheet` `ingestSheet`, `parseCsv` `toCsv`, `validateProvider`
`locateTarget`.

The API keeps the name `pack` where it always had it, so existing callers do
not break. Everything a reader sees says "top 3", because the local pack is a
Google Search feature and this measures position in the Maps results feed,
which is a different surface. `top3Share` and `top3Edge` are aliases.

Everything outside `src/node/` runs in a browser unchanged, including
`redact`: it takes a hash function and falls back to a pure SHA-256.

---

## Tests

```sh
npm test
```

All offline, no install step. A large share of them tamper with data (forge a
rank on an absent point, move a coordinate, doctor a method pin, rename the
sampler, widen the top-3 size, put a name back under a redaction block) and
assert that the auditor, the converter or the ingest catches it. Count them
yourself:

```sh
cat test/*.test.mjs | grep -c "^test('\[tamper\]"
```

`test/tamper.test.mjs` is the one written against a hostile review: one test
per doctored snapshot that used to pass, including two that still do, which
say so.

---

MIT. Jarred O'Brien.
