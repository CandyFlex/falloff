---
name: falloff
description: Measure where a local business is visible in map search around its location and where that visibility stops, with every figure carrying its denominator, its unreached count and the command that reproduces it.
---

# falloff

## When to use it

Use it when someone asks how far a business's map visibility reaches for a
search term, where it drops out of the top results, or whether a visibility
number they were given can be trusted. Use `audit` when handed a snapshot
someone else produced.

Do not use it to claim anything about Google's ranking from the `osm`
provider. OpenStreetMap has no ranking, and that provider restricts each query
to a 3 km circle around the sample point, so every ring beyond 3 km is absent
by construction. It measures whether and how near a business is listed in the
open map.

## Setup

Node 20 or later, no dependencies. Falloff is not on npm; clone the
repository. From the repository root:

```sh
falloff() { node bin/falloff.mjs "$@"; }
```

That is a POSIX shell function. Anywhere else, including PowerShell, run every
command below as `node bin/falloff.mjs <args>`.

## Commands

| command | what it does | exit |
|---|---|---|
| `falloff scan --name N --lat A --lng B --query Q [--provider places\|osm] [--id ID] [--preset tight\|mid\|regional\|wide] --out S.json` | runs a scan through a provider | 0 pass, 1 audit fail |
| `falloff plan --lat A --lng B --query Q --out P.json --sheet P.csv` | writes the sample points and a sheet of Google Maps links for a person to read | 0 |
| `falloff ingest --plan P.json --sheet filled.csv --name N --out S.json` | turns the filled sheet into a snapshot | 0 pass, 1 fail or refused |
| `falloff audit S.json` | recomputes everything from raw readings | 0 pass, 1 fail |
| `falloff report S.json` | figures with denominators | 0 pass, 1 fail |
| `falloff render S.json --out R.html` | standalone HTML report | 0 pass, 1 fail |
| `falloff compare A.json B.json` | two passes of the same plan, point by point | 0, 1 if refused |
| `falloff redact S.json --out PUBLIC.json` | withholds names, hashes ids with an unpublished salt, rounds the centre | 0 pass, 1 fail |
| `falloff convert LEGACY.json --out S.json` | legacy grid-scan radial file to a snapshot | 0 pass, 1 fail or refused |

Exit 2 always means a usage mistake. `places` needs `--key` or
`FALLOFF_PLACES_KEY`, and has never been run live by the author. `osm` and the
manual sheet need no key.

## How to read the output

```
  visible      37/80 measured  46%   (0 unreached, excluded)
  in the top 3 20/80 measured  25%
  (share of sample points, preset mid; not comparable across presets)
  reach edge   15.4 km  (8/8 on that ring)  [fragile]
  top-3 edge   9.8 km  (3/6 on that ring)  [fragile]
  gone by      38.1 km  (0/17 on that ring, and nothing beyond it)
  shape        falloff  (inner 6/6, middle 8/8, outer 0/18)
```

- `37/80 measured`: found at 37 of the 80 points that were measured. The
  denominator is measured points only.
- `(0 unreached, excluded)`: points that were never measured. They are not
  absences. They are outside the denominator.
- The share line under the counts: the overall percentage depends on the
  preset, because points are allocated by ring circumference. Quote it with
  the preset or not at all, and never put two presets in one table.
- `reach edge`: the furthest ring, counting out from the centre without a
  break, where the business was seen at half or more of that ring's measured
  points. It has ring resolution, not metre resolution.
- `top-3 edge`: the same for the top 3 of the Maps results feed. This is not
  the Google Search local pack, which is a different surface.
- `[fragile]`: a Wilson 95% interval on that ring or on the next ring out
  contains the threshold, so a re-scan could move the edge. The line printed
  under the edge gives the arithmetic.
- `at least X km`: the edge is on the outermost ring scanned, so the scan
  cannot say how much further it reaches. Never drop the "at least".
- `gone by`: the first reportable ring with no sightings after which no
  reportable ring has one. When sightings resume further out there is no
  gone-by, and the output says where they resume.
- `absent`: not in the list captured at that point. The report prints the
  range of captured list depths. A shallower capture is not a smaller
  business.
- `not reportable: <reason>`: the figure cannot be supported. Report that, not
  a zero.
- The audit line is last: `PASS: internally consistent (n warning(s), 0
  critical).` or `FAIL: not internally consistent (...). Nothing publishes.`
  A pass means the file agrees with itself, not that the readings are true.
  The README lists what the audit cannot know.

## Three rules you must obey

1. **Never turn an unreached count into an absence.** "Not visible at 30
   points" and "30 points could not be measured" are different facts. If the
   output says `(12 unreached, excluded)`, say that 12 points were not
   measured. Do not add them to the absent count, do not fold them into a
   percentage, and do not describe them as places the business does not
   appear.
2. **Never quote a fragile edge as the headline.** If either edge is marked
   `[fragile]`, lead with the visibility count or with a figure that is not
   fragile, and mention the fragile one with the word fragile and the reason
   the tool printed. When both edges are fragile, say that.
3. **Always include the reproduce command when reporting a figure.** Every
   command prints a `reproduce:` line. Any figure you pass on goes with that
   line and with the observation date. Say "observed 2026-09-17", never
   "currently". A converted study's `reproduce:` line names a private file
   that nobody else has, so cite `falloff report <snapshot>` instead, which
   anyone with the repository can run, and say that re-observing those points
   needs their own provider.

Also: never state a figure the tool did not print. Do not compute your own
percentages from its counts, do not average across studies, do not compare
overall shares across presets, and do not estimate a radius between rings. If
the audit fails, report that it failed and which findings fired. Do not report
the figures as results.

## Worked example

Task: "How far does the Elkins study's visibility reach, and can I trust it?"

```sh
falloff audit studies/2026-09-20-dentist-elkins-wv/snapshot.json
falloff report studies/2026-09-20-dentist-elkins-wv/snapshot.json
```

The audit prints:

```
  WARN  A5  names withheld (target.name, readings[].results[].name, ids, target.lat, target.lng, readings[].lat, readings[].lng, command, provenance.sourceFile); no name survives in this file and the figures are unaffected
  WARN  F1  reach edge 15.4 km is fragile, so a re-scan could move it: this ring is 4/8, 95% interval 0.22-0.78, which contains 0.5

  PASS: internally consistent (2 warning(s), 0 critical).
```

A correct answer:

> Observed 2026-09-20, query "dentist", Elkins, WV, business name withheld.
> The business was visible at 26 of 80 measured points; 0 points were
> unreached. That is 33% of the sample points on preset mid, which is not
> comparable with a scan on another preset. It was in the top 3 at 2 of those
> 80 points. Its reach edge is the 15.4 km ring, where it was seen at 4 of 8
> measured points, and it is gone by the 24.2 km ring (0 of 12, with nothing
> beyond it). The reach edge is marked fragile because that ring is 4 of 8,
> whose 95% interval contains the half threshold, so I am leading with the
> count and not the edge. There is no top-3 edge to report: no ring has the
> business in the top 3 at half or more of its measured points. These ranks
> are the order of the Google Maps results feed for a logged-out desktop
> browser at zoom 13, from a single pass, where absent means not in a captured
> list of 10 rows.
>
> Reproduce: `falloff report studies/2026-09-20-dentist-elkins-wv/snapshot.json`.
> The study was observed with an automated browser scan that is not in the
> repository, so that command re-renders the recorded file; re-observing these
> points needs your own provider.
>
> Audit: `PASS: internally consistent (2 warning(s), 0 critical).`

The answer ends with the audit line, pasted as printed.
