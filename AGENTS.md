# Instructions for coding agents

This repository measures things and publishes the measurements. The rules
below exist so that a change cannot quietly make a number less true.

## Run the tests

```sh
npm test                    # node:test, offline, no install step
npm run check-docs-sync     # docs/lib must equal the browser-safe part of src
npm run check-docs-data     # docs/data.js, docs/method.html blocks and docs/studies must be current (fix: npm run docs-data)
npm run check-site-data     # docs/site-data.js must be current (fix: npm run site-data)
node scripts/studies-index.mjs --check
```

All four must pass before a commit, and CI runs all four. The suite must stay
offline (inject `fetchImpl` for provider tests) and finish in under 30 seconds.

## Where code lives

| path | rule |
|---|---|
| `src/*.mjs`, `src/providers/*.mjs` | pure ESM, runs in a browser unchanged. No `node:` imports, no `process`, no `Buffer`, no bare specifiers. A test enforces this. |
| `src/node/*.mjs` | anything that needs `fs`, `path` or another node builtin |
| `bin/falloff.mjs` | the CLI. Every command that prints a figure prints a `reproduce:` line. |
| `test/*.test.mjs` | `node:test` only. Fixtures in `test/fixtures/`. |
| `scripts/*.mjs` | deterministic generators: `sync-docs`, `studies-index`, `build-study`, `make-tampered` |
| `studies/` | generated. `studies/private/` is ignored and must stay ignored: it holds both the unredacted conversions and the per-study salts. |
| `docs/lib/` | generated copy of `src/` minus `src/node/`. Never edit it; run `node scripts/sync-docs.mjs`. |

After changing anything under `src/`, run `node scripts/sync-docs.mjs`. After
changing `src/render.mjs` or `src/metrics.mjs`, also run
`node scripts/build-study.mjs --refresh <folder>` for each study and
`node scripts/studies-index.mjs`, because the committed reports and index are
tested byte for byte against what the code produces now.

## Rules that do not bend

- **Absent and unreached never merge.** Not in a status, a count, a
  denominator, a colour, a mark or a sentence. A provider must throw on
  failure and return an empty list only for a real empty answer.
- **Numbers in docs come from scripts or pasted command output.** Do not type
  a figure into README, a study, INDEX.md or a page. If a number needs to
  appear, generate it or paste it from a run and keep the command beside it.
- **A model never produces a number.** Nothing in the pipeline may call one to
  compute, estimate or summarise a figure.
- **`audit` recomputes.** It never reads a stated figure and believes it. A new
  field that carries a claim needs a check that can fail, and a `[tamper]`
  test that makes it fail.
- **Do not add dependencies.** Zero `dependencies`, zero `devDependencies`.
- **Do not add a scraping provider.** Nothing in this repository drives a
  browser or fetches a vendor's HTML. Providers are sanctioned APIs, open
  data, or a person with a sheet.
- **Pins are versioned acts.** `GOLDEN_ANGLE`, `RING_GROWTH`, `MIN_RING_POINTS`,
  the earth constants and the presets change what a snapshot means. Do not
  adjust them to make a test or a figure come out differently.
- **Never commit an unredacted run, or a salt.** Real business names do not go
  into fixtures, studies, tests or docs. Use invented names in tests. A
  published id is a salted hash and the salt lives only in
  `studies/private/<study>.salt`; a salt in a tracked file undoes every study
  at once.
- **A published figure says which preset it came from.** Points are allocated
  by ring circumference, so an overall share is a property of the scan design
  as well as the business, and it is not comparable across presets.
- **No dashes as separators** (em or en) in README, CLI output, reports or
  docs. Ranges use a hyphen. No emoji.
- **Do not loosen a tolerance to make something pass.** Find out which pin is
  missing and record it.

## Commit messages

Say why, not what. The diff shows what changed; the message explains the
reason it had to. First line is a full sentence under about 80 characters,
then a body in plain prose.
