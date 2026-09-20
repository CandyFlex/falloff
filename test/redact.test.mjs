/**
 * Tests for redaction.
 *
 * The claim: a redacted snapshot contains none of the names it started with,
 * carries no id that can be walked back to a listing, does not publish the
 * business's exact location, still passes audit, and says in the audit that
 * names are withheld. The names in these tests are invented. No real business
 * is named here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { scan } from '../src/scan.mjs';
import { audit } from '../src/audit.mjs';
import { summarise } from '../src/metrics.mjs';
import { redact, collectNames, nameVariants, slugOf, REDACTION_SCHEMA, CENTRE_DECIMALS } from '../src/redact.mjs';
import { sha256Hex } from '../src/sha256.mjs';
import { VERSION } from '../src/version.mjs';

const TARGET = { name: "Example Smile & Bite Co.", id: 'p-target', lat: 25.8104, lng: -80.2037 };
const COMPETITORS = ['Invented Dental Parlour', 'Made-Up Tooth Care', 'Nonexistent Studio LLC'];
const AT = '2026-09-19T12:00:00.000Z';
const SALT = 'a'.repeat(64);

async function sourceSnapshot(command = `falloff scan --name "${TARGET.name}" --id p-target --lat 25.8104 --lng -80.2037 --query dentist --preset tight`) {
  let calls = 0;
  const provider = {
    id: 'fake',
    version: '1',
    pacingMs: 0,
    async query() {
      const i = calls++;
      const others = COMPETITORS.map((name, k) => ({ id: `p-${k}`, name, rating: 4.5, reviews: 10 + k }));
      return { results: i < 30 ? [others[0], { id: 'p-target', name: TARGET.name, rating: 4.9, reviews: 80 }, ...others.slice(1)] : others };
    },
  };
  const { snapshot } = await scan({ target: TARGET, query: 'dentist', preset: 'tight', provider, command });
  return snapshot;
}

test('sha256 in plain JavaScript matches the published test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  // Long enough to need a second block and a multi-byte character.
  assert.equal(sha256Hex('a'.repeat(1000)).length, 64);
  assert.equal(sha256Hex('café'), sha256Hex('café'));
});

test('a redacted snapshot contains none of the original names, in any form', async () => {
  const snap = await sourceSnapshot();
  const names = collectNames(snap);
  assert.ok(names.includes(TARGET.name) && names.length === 4, 'the source must actually contain names to remove');

  const pub = redact(snap, { salt: SALT, at: AT });
  const text = JSON.stringify(pub).toLowerCase();
  for (const n of names) {
    assert.ok(!text.includes(n.toLowerCase()), `name leaked: ${n}`);
  }
  for (const v of nameVariants(TARGET.name)) {
    assert.ok(!text.includes(v.toLowerCase()), `target name variant leaked: ${v}`);
  }
  assert.equal(pub.target.name, 'withheld');
  assert.ok(pub.readings.every((r) => r.results.every((b) => !('name' in b))), 'the name key is deleted, not blanked');
});

test('every id is replaced by a salted hash, and no original id survives', async () => {
  const snap = await sourceSnapshot();
  const pub = redact(snap, { salt: SALT, at: AT });
  const text = JSON.stringify(pub);

  assert.match(pub.target.id, /^h:[0-9a-f]{16}$/);
  for (const id of ['p-target', 'p-0', 'p-1', 'p-2']) {
    assert.ok(!text.includes(`"${id}"`), `original id leaked: ${id}`);
  }
  for (const r of pub.readings) for (const b of r.results) assert.match(b.id, /^h:[0-9a-f]{16}$/);

  // Equality is preserved, which is what the rank checks in audit need.
  const found = pub.readings.find((r) => r.status === 'found');
  assert.equal(found.results[found.rank - 1].id, pub.target.id);
});

test('the salt is required, and a different salt gives different hashes', async () => {
  const snap = await sourceSnapshot();
  assert.throws(() => redact(snap, { at: AT }), /salt of at least 16 characters/);
  assert.throws(() => redact(snap, { salt: 'short', at: AT }), /salt of at least 16 characters/);
  const a = redact(snap, { salt: SALT, at: AT });
  const b = redact(snap, { salt: 'b'.repeat(64), at: AT });
  assert.notEqual(a.target.id, b.target.id, 'the salt has to change the digest, or it is not a salt');
});

test('the centre is rounded and every point is recomputed from the rounded centre', async () => {
  const snap = await sourceSnapshot();
  const pub = redact(snap, { salt: SALT, at: AT });

  assert.equal(pub.target.lat, 25.81);
  assert.equal(pub.target.lng, -80.2);
  const decimals = (x) => (String(x).split('.')[1] ?? '').length;
  assert.ok(decimals(pub.target.lat) <= CENTRE_DECIMALS);
  assert.ok(decimals(pub.target.lng) <= CENTRE_DECIMALS);

  const home = pub.readings.find((r) => r.ring === 0);
  assert.equal(home.lat, pub.target.lat);
  assert.equal(home.lng, pub.target.lng);
  // Every point moved with the centre, or the geometry replay would fail.
  const moved = pub.readings.filter((r, i) => r.lat !== snap.readings[i].lat);
  assert.equal(moved.length, pub.readings.length);
  const original = JSON.stringify(snap.target.lat);
  assert.ok(!JSON.stringify(pub).includes(original), 'the true centre must not survive anywhere in the file');
});

test('ranks, statuses, ratings and dates survive redaction', async () => {
  const snap = await sourceSnapshot();
  const pub = redact(snap, { salt: SALT, at: AT });
  assert.equal(pub.startedAt, snap.startedAt);
  assert.deepEqual(pub.method, snap.method);
  pub.readings.forEach((r, i) => {
    assert.equal(r.status, snap.readings[i].status);
    assert.equal(r.rank, snap.readings[i].rank);
    assert.equal(r.listDepth, snap.readings[i].listDepth);
    r.results.forEach((b, k) => {
      assert.equal(b.rating, snap.readings[i].results[k].rating);
      assert.equal(b.reviews, snap.readings[i].results[k].reviews);
    });
  });
});

test('the figures are identical before and after redaction', async () => {
  const snap = await sourceSnapshot();
  const pub = redact(snap, { salt: SALT, at: AT });
  assert.deepEqual(summarise(pub.readings), summarise(snap.readings));
});

test('a redacted snapshot still passes audit, and the audit says names are withheld (A5, not critical)', async () => {
  const snap = await sourceSnapshot();
  assert.ok(!audit(snap).findings.some((f) => f.id === 'A5'), 'an unredacted snapshot has no A5');
  const r = audit(redact(snap, { salt: SALT, at: AT }));
  assert.equal(r.ok, true, JSON.stringify(r.findings, null, 2));
  const a5 = r.findings.find((f) => f.id === 'A5');
  assert.ok(a5, 'A5 must be present');
  assert.equal(a5.level, 'WARN');
  assert.match(a5.message, /names withheld/);
});

test('[tamper] a redaction block on a file that still has names is CRITICAL', async () => {
  const snap = await sourceSnapshot();
  const pub = redact(snap, { salt: SALT, at: AT });

  const nameBack = structuredClone(pub);
  nameBack.target.name = 'Example Smile & Bite Co.';
  const a1 = audit(nameBack).findings.find((f) => f.id === 'A5');
  assert.equal(a1.level, 'CRITICAL');
  assert.equal(audit(nameBack).ok, false);

  const rowsBack = structuredClone(pub);
  rowsBack.readings[0].results[0].name = 'Invented Dental Parlour';
  const a2 = audit(rowsBack).findings.find((f) => f.id === 'A5');
  assert.equal(a2.level, 'CRITICAL');
  assert.match(a2.message, /still carry a name key/);
});

test('the redaction block records the fields, the hashing, the rounding and the warning', async () => {
  const snap = await sourceSnapshot();
  const pub = redact(snap, { reason: 'public study', at: AT, salt: SALT });
  assert.equal(pub.redaction.schema, REDACTION_SCHEMA);
  assert.ok(pub.redaction.fields.includes('target.name'));
  assert.ok(pub.redaction.fields.includes('readings[].results[].name'));
  assert.ok(pub.redaction.fields.includes('ids'));
  assert.match(pub.redaction.ids, /salt/);
  assert.match(pub.redaction.centre, /rounded to 2 decimal places/);
  assert.match(pub.redaction.points, /recomputed from the rounded centre/);
  assert.match(pub.redaction.observedAt, /observed at the true coordinates/);
  assert.match(pub.redaction.warning, /Withheld is not anonymous/);
  assert.equal(pub.redaction.reason, 'public study');
  assert.equal(pub.redaction.at, AT);
});

test('a name inside the reproduce command is replaced, and the field list says so', async () => {
  const snap = await sourceSnapshot();
  const pub = redact(snap, { salt: SALT, at: AT });
  assert.ok(pub.redaction.fields.includes('command'));
  assert.match(pub.command, /--name "withheld" --id p-target/);
  assert.match(pub.command, /--lat 25\.81 --lng -80\.2 --query dentist/, 'the centre is rounded inside the command as well');
});

test('a descriptor left in a file name is scrubbed with the whole file name', async () => {
  const slug = slugOf(TARGET.name);
  assert.equal(slug, 'example-smile-bite-co');
  // An early study leaked exactly this shape: the name matched, the
  // descriptor did not, and "withheld-family-practice" went to the page.
  const snap = await sourceSnapshot(`falloff convert grid-${slug}-family-practice__dentist__tight-2026-09-19-00-00.json`);
  snap.provenance = { sourceFile: `grid-${slug}-family-practice__dentist__tight-2026-09-19-00-00.json` };
  const pub = redact(snap, { salt: SALT, at: AT });
  assert.equal(pub.command, 'falloff convert withheld.json');
  assert.equal(pub.provenance.sourceFile, 'withheld.json');
  assert.ok(!JSON.stringify(pub).includes('family-practice'));
  assert.ok(pub.redaction.fields.includes('provenance.sourceFile'));
});

test('a command with no name and no file in it is left exactly as it was', async () => {
  const snap = await sourceSnapshot('falloff ingest --plan plan --sheet filled');
  const pub = redact(snap, { salt: SALT, at: AT });
  assert.equal(pub.command, snap.command);
  assert.ok(!pub.redaction.fields.includes('command'));
});

test('redact is idempotent and does not modify its input', async () => {
  const snap = await sourceSnapshot();
  const before = JSON.stringify(snap);
  const once = redact(snap, { salt: SALT, at: AT });
  assert.equal(JSON.stringify(snap), before, 'input must not be mutated');
  const twice = redact(once, { salt: SALT, at: '2030-01-01T00:00:00.000Z' });
  assert.deepEqual(twice, once, 'a second pass changes nothing, including the original timestamp');
});

test('the browser-safe version constant matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
