/**
 * One test per hole a hostile reviewer drove a truck through.
 *
 * On 2026-09-19 a reviewer doctored 34 copies of a published study and 20 of
 * them came back "PASS ... Safe to publish", including the exact edit this
 * tool exists to prevent. Every row of that table is a test here, named for
 * what the edit claimed, so that closing a hole and then reopening it is a
 * red test rather than a discovery.
 *
 * The rule these tests encode: a snapshot may not state anything the auditor
 * cannot recompute. Where a lie genuinely cannot be caught from one file, the
 * test says so out loud instead of pretending, and the README carries the
 * same list under "what the audit cannot know".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { audit, formatAudit, verdictLine } from '../src/audit.mjs';
import { convertGridScan } from '../src/node/convert-grid-scan.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/legacy-grid-scan.json', import.meta.url));

/** The clean, passing snapshot every test below starts from. */
function base() {
  const legacy = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  return convertGridScan(legacy, { basename: 'legacy-grid-scan.json', convertedAt: '2026-09-19T00:00:00.000Z' });
}

/** Doctor a copy and return its audit. */
function doctored(edit) {
  const snap = structuredClone(base());
  edit(snap);
  return { snap, result: audit(snap) };
}

const critical = (r) => r.findings.filter((f) => f.level === 'CRITICAL').map((f) => f.id);
const has = (r, id) => critical(r).includes(id);

test('the base fixture passes, so every failure below is the edit and not the fixture', () => {
  const r = audit(base());
  assert.equal(r.ok, true, JSON.stringify(r.findings, null, 2));
});

test('[tamper] every absence rewritten as a rank-1 sighting with an empty list', () => {
  // The reviewer's row 1: visible jumps from 37/80 to 80/80 and the old audit
  // said nothing, because it only checked the row at the claimed rank when
  // that row existed.
  const { result } = doctored((s) => {
    for (const r of s.readings) {
      if (r.status !== 'absent') continue;
      r.status = 'found';
      r.rank = 1;
      r.results = [];
    }
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'C6'), 'a rank with no row under it is not an observation');
  assert.ok(has(result, 'C8'), 'and the captured depth no longer matches the rows');
});

test('[tamper] the target prepended to an absent point\'s list', () => {
  // Row 2. The list itself is forged, which one file cannot disprove, but the
  // recorded capture depth no longer matches the rows, and it does.
  const { result } = doctored((s) => {
    const victim = s.readings.find((r) => r.status === 'absent');
    victim.status = 'found';
    victim.rank = 1;
    victim.results = [{ id: s.target.id }, ...victim.results];
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'C8'), 'a row added to a list changes the depth that was recorded with it');
});

test('[tamper] a sighting rewritten as an absence, with the target still in the list', () => {
  // Row 3. Nothing used to check that an absence was absent from its own
  // evidence.
  const { result } = doctored((s) => {
    const victim = s.readings.find((r) => r.status === 'found');
    victim.status = 'absent';
    victim.rank = null;
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'C7'));
});

test('[tamper] target.id deleted so the rank checks are skipped', () => {
  // Row 4. Removing the identity used to disable C6 for the whole file.
  const { result } = doctored((s) => {
    delete s.target.id;
    for (const r of s.readings) {
      if (r.status !== 'absent') continue;
      r.status = 'found';
      r.rank = 1;
    }
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'A8'), 'a file with ids in its lists and none on its target cannot be checked at all');
});

test('[tamper] ids stripped from the result rows so no rank can be checked', () => {
  // Row 5. The lists survive, the ids do not, and every rank becomes a claim.
  const { result } = doctored((s) => {
    for (const r of s.readings) {
      r.rank = r.status === 'found' ? 1 : r.rank;
      for (const b of r.results) delete b.id;
    }
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'C6'));
});

test('[tamper] a rank past the end of the list it was supposedly read from', () => {
  // Row 6. results[49] is undefined, so the old check simply did not run.
  const { result } = doctored((s) => {
    for (const r of s.readings) if (r.status === 'found') r.rank = 50;
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'C6'));
});

test('[tamper] a near sighting and a far absence swapped, keeping the counts', () => {
  // Rows 7 and 8. The near point keeps its own list, so the new rank has no
  // row under it.
  const { result } = doctored((s) => {
    const near = s.readings.find((r) => r.status === 'found' && r.dKm > 0);
    const far = s.readings.find((r) => r.status === 'absent' && r.dKm >= 24);
    const wasRank = near.rank;
    near.status = 'absent';
    near.rank = null;
    far.status = 'found';
    far.rank = wasRank + 40;
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'C6') || has(result, 'C7'));
});

test('[tamper] one reading duplicated over another, so a planned point loses its own', () => {
  // Row 9. The length still matches the plan, which is all the old check
  // compared.
  const { result } = doctored((s) => {
    s.readings[70] = structuredClone(s.readings[5]);
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'D8'), 'a planned point with two readings');
  assert.ok(has(result, 'D9'), 'and a planned point with none');
});

test('[tamper] the whole scan moved east, with the target left where it was', () => {
  // Row 10. The replay took its centre from the ring-0 reading and never
  // compared it with the business the file claims to be about.
  const { result } = doctored((s) => {
    for (const r of s.readings) r.lng += 2;
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'D6'));
});

test('[tamper] the target moved to null island, with the scan left where it was', () => {
  // Row 11, the same hole from the other side.
  const { result } = doctored((s) => {
    s.target.lat = 0;
    s.target.lng = 0;
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'D6'));
});

test('[tamper] every distance doubled, so the printed edges double with them', () => {
  // Row 12. The coordinates are untouched, so this is not a drift; it is a
  // claim about what those coordinates mean, and it has to be checked
  // separately.
  const { snap, result } = doctored((s) => {
    for (const r of s.readings) {
      if (r.ring === 0) continue;
      r.dKm = +(r.dKm * 2).toFixed(1);
      r.label = r.label.replace(/^[\d.]+ km/, `${r.dKm} km`);
    }
    s.method.rmax *= 2;
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'D4') || has(result, 'D10'));
  assert.ok(snap.readings.some((r) => r.dKm > 60), 'the edit really did double the distances');
});

test('[tamper] an outer ring relabelled as an inner one', () => {
  // Row 13. A reading with no planned counterpart used to be skipped rather
  // than failed.
  const { result } = doctored((s) => {
    for (const r of s.readings) {
      if (r.ring !== 8) continue;
      r.ring = 1;
      r.dKm = 2.5;
      r.index += 100;
    }
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'D7'), 'a reading the plan never asked for');
  assert.ok(has(result, 'D9'), 'and the planned points it abandoned');
});

test('[tamper] the top-3 size widened so every sighting counts as a top-3 sighting', () => {
  // Row 14. The old A3 checked that the pin existed, not what it said.
  const { result } = doctored((s) => {
    s.method.packSize = 20;
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'A3b'));
});

test('[tamper] the geometry pins rewritten, which the replay used to ignore', () => {
  // Row 15. growth, goldenAngle and minRingPoints were recorded and then
  // never read back, so they were decoration.
  for (const [pin, value] of [['growth', 9.99], ['goldenAngle', 0], ['minRingPoints', 1]]) {
    const { result } = doctored((s) => {
      s.method[pin] = value;
    });
    assert.equal(result.ok, false, pin);
    assert.ok(has(result, 'D5'), `${pin} is part of what radial-v2 means`);
  }
});

test('the latitude constant may vary, because an older scanner used another one', () => {
  // The other half of the same rule: a pin the sampler version allows to vary
  // is replayed, not refused. These files were measured on 110.57.
  const r = audit(base());
  assert.equal(r.ok, true);
  assert.equal(base().method.kmPerDegLat, 110.57);
});

test('[tamper] an unknown sampler name, which used to skip every geometry check', () => {
  // Row 16. `auditGeometry` returned early for any string it did not know, so
  // renaming the sampler let every coordinate go to zero unchallenged.
  const { result } = doctored((s) => {
    s.method.sampler = 'radial-v3';
    for (const r of s.readings) {
      r.lat = 0;
      r.lng = 0;
    }
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'D0'));
});

test('[tamper] the provider block swapped for a different instrument', () => {
  // Row 17. Who answered is part of the method, and the two places it is
  // written have to agree.
  const { result } = doctored((s) => {
    s.provider = { id: 'google-places-text', version: 'v1', pins: { pointRadiusM: 50000 } };
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'A7'));
});

test('[tamper] a failed scan laundered into absences with empty lists', () => {
  // Row 18. Thirty points that never answered, rewritten as thirty points
  // that answered with nothing. The reasons are gone with them, so this
  // cannot be proved from one file; what can be caught is that the capture
  // depth stopped matching the scan's own recorded range.
  const { result } = doctored((s) => {
    for (const r of s.readings.slice(0, 30)) {
      r.status = 'absent';
      r.rank = null;
      r.results = [];
      r.listDepth = 0;
      r.error = null;
    }
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'C8'), 'a depth of 0 is outside the 6-10 rows this scan recorded');
});

test('an unreached point rewritten as absent with a plausible list cannot be caught, and the audit does not claim it can', () => {
  // The honest residue. Nothing in one file distinguishes "measured and not
  // there" from "never measured, and the reason deleted". The verdict wording
  // and the README both say so rather than implying otherwise.
  const { result } = doctored((s) => {
    const victim = s.readings.find((r) => r.status === 'absent');
    const donor = structuredClone(victim.results);
    const target = s.readings[3];
    target.status = 'absent';
    target.rank = null;
    target.error = null;
    target.results = donor;
    target.listDepth = donor.length;
  });
  assert.equal(result.ok, true, 'this really does pass, which is why the wording matters');
  assert.match(
    readFileSync(new URL('../src/audit.mjs', import.meta.url), 'utf8'),
    /An unreached point rewritten as absent/,
    'the module header has to name this limit',
  );
});

test('[tamper] names put back under a redaction block that says they are gone', () => {
  // Row 20. A5 used to print "names withheld ... figures are unaffected"
  // whatever the file actually contained.
  const { result } = doctored((s) => {
    s.redaction = { schema: 'falloff/redaction@2', fields: ['target.name'] };
    s.target.name = 'A Real Business Name';
  });
  assert.equal(result.ok, false);
  assert.ok(has(result, 'A5'));
});

test('the verdict says internally consistent, not safe to publish', () => {
  const clean = audit(base());
  assert.equal(clean.ok, true);
  assert.match(verdictLine(clean), /^PASS: internally consistent \(\d+ warning\(s\), 0 critical\)\.$/);
  assert.ok(!/safe to publish/i.test(formatAudit(clean)));

  const { result } = doctored((s) => {
    s.method.packSize = 20;
  });
  assert.match(verdictLine(result), /^FAIL: not internally consistent \(/);
  assert.ok(!/safe to publish/i.test(formatAudit(result)));
});
