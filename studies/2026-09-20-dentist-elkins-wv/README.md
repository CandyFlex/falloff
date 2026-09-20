# "dentist", Elkins, WV, observed 2026-09-20

This study was observed with an automated browser scan written by this
project's author. That scanner is not in this repository, and this repository
ships no scraper. The commands at the bottom of this page re-render the
recorded file; re-observing these points needs your own provider.

Business name withheld. Ids are hashed with a salt that is not published. The
centre is rounded to 0.01 degrees, about 1 km, and the sample points are
recomputed from the rounded centre, so the geometry still replays. The scan
itself was observed at the true coordinates. Withheld is not anonymous: the
town, the query and the date are kept.

Why this study is in the set: a small town a long drive from any city: the target and the point were drawn from the same seed.

| figure | value |
|---|---|
| visible | 26/80 measured (33%), 0 unreached and excluded |
| in the top 3 | 2/80 measured (3%) |
| reach edge | 15.4 km (4/8 measured on that ring, needs 4). [fragile] a re-scan could move this edge: this ring is 4/8, 95% interval 0.22-0.78, which contains 0.5 |
| top-3 edge | not reportable: no reportable ring has the business in the top 3 at half or more of its measured points, counting out from the centre |
| gone by | 24.2 km (0/12 measured on that ring, and no reportable ring beyond it has a sighting) |
| shape | falloff (inner 6/6 at 2.5 km, middle 4/8 at 15.4 km, outer 0/18 at 60 km). A descriptive label for the curve, not a diagnosis |

The two share figures above are shares of the sample points on preset
`mid`. Points are allocated by ring circumference, so the same
business scores differently on a different preset and these percentages are
not comparable across presets. The per-ring table and the edges are.

| ring | found / measured | in top 3 / measured | unreached | note |
|---|---|---|---|---|
| home | 1/1 | 0/1 | 0 | only 1 measured point(s); needs 4 to be reportable |
| 2.5 km | 6/6 | 0/6 | 0 |  |
| 3.9 km | 6/6 | 0/6 | 0 |  |
| 6.2 km | 5/6 | 1/6 | 0 |  |
| 9.8 km | 4/6 | 1/6 | 0 |  |
| 15.4 km | 4/8 | 0/8 | 0 |  |
| 24.2 km | 0/12 | 0/12 | 0 |  |
| 38.1 km | 0/17 | 0/17 | 0 |  |
| 60 km | 0/18 | 0/18 | 0 |  |

## What was measured

- Provider: `google-maps-web` (grid-scan radial-v2 @13z).
- Surface: ranks are the order of the Google Maps results feed as seen by a logged-out desktop browser at zoom 13; a Places API re-scan measures a different surface and may differ.
- Absent means the business was not in the list captured at that point. Those lists held between 10 and 10 rows.
- Observed: 2026-09-20T05:00:03.991Z. This is a dated observation, not a live claim. The observation window is unknown: the source file records one timestamp for the whole scan, and an 80-point scan is not instantaneous.
- Geometry: preset `mid`, 80 points, 2.5-60 km, 8 rings, 110.57 km per degree of latitude.
- Published centre: 38.92, -79.84, rounded to 2 decimal places. 
- Rank source: position of the target place id in each point's captured list. The source file's own rank column disagreed with its captured lists at 0 of 80 points; the lists were used.
- Passes: 1. This is a single pass. Nothing in this repository measures how far individual points move between scans; `falloff compare` is the command that would, and no study has been run twice.

## Audit

```
  WARN  A5  names withheld (target.name, readings[].results[].name, ids, target.lat, target.lng, readings[].lat, readings[].lng, command, provenance.sourceFile); no name survives in this file and the figures are unaffected
  WARN  F1  reach edge 15.4 km is fragile, so a re-scan could move it: this ring is 4/8, 95% interval 0.22-0.78, which contains 0.5

  PASS: internally consistent (2 warning(s), 0 critical).
```

A pass means the file is internally consistent, not that the readings are
true. The README lists what the audit cannot know.

## Reproduce

```sh
falloff audit  studies/2026-09-20-dentist-elkins-wv/snapshot.json
falloff report studies/2026-09-20-dentist-elkins-wv/snapshot.json
falloff render studies/2026-09-20-dentist-elkins-wv/snapshot.json --out report.html
```

The snapshot itself was produced by:

```
falloff convert withheld.json
```

The source file is a private, unredacted scan and is not in this repository,
so that last command documents provenance rather than something a reader can
run. The three commands above recompute every figure on this page from
`snapshot.json`. The rendered report is [report.html](report.html).
