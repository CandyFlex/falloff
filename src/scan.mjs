/**
 * scan.mjs: runs a plan against a provider and returns an audited snapshot.
 *
 * The orchestration is deliberately boring. All the judgment happened when
 * the plan was made; all the checking happens after. This part just walks
 * points in order, paces itself, and records what came back, including, and
 * especially, what did not.
 *
 * FAILURE POLICY. A provider that throws produces an UNREACHED reading with
 * the reason attached. It does not abort the scan and it does not become an
 * empty result. A scan with gaps is publishable only if the auditor says so
 * (it fails above 10% unreached); a scan that silently converted its failures
 * into zeroes would pass every check and be wrong.
 */

import { samplePlan } from './sample.mjs';
import { reading, snapshot, listDepthRange, FOUND, ABSENT, UNREACHED } from './schema.mjs';
import { validateProvider, locateTarget } from './providers/index.mjs';
import { audit } from './audit.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {object} opts.target    { name, id?, lat, lng }
 * @param {string} opts.query     the search term, e.g. "dentist"
 * @param {object} opts.provider  see providers/index.mjs
 * @param {string} [opts.preset]  tight | mid | regional | wide
 * @param {number} [opts.rmin] @param {number} [opts.rmax] @param {number} [opts.points]
 * @param {string} opts.command   the command line that produced this scan
 * @param {function} [opts.onPoint] progress callback ({ done, total, reading })
 * @param {AbortSignal} [opts.signal]
 */
export async function scan({
  target,
  query,
  provider,
  preset = 'mid',
  rmin,
  rmax,
  points,
  command,
  onPoint,
  signal,
}) {
  const problems = validateProvider(provider);
  if (problems.length) throw new Error(`invalid provider: ${problems.join('; ')}`);
  if (!target?.name) throw new Error('scan: target.name is required');
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) {
    throw new Error('scan: target.lat and target.lng are required');
  }
  if (!query) throw new Error('scan: query is required');
  if (!command) {
    throw new Error('scan: command is required; a snapshot that cannot say how it was made cannot be audited');
  }

  const plan = samplePlan({ lat: target.lat, lng: target.lng, preset, rmin, rmax, points });
  const pacing = provider.pacingMs ?? 0;
  const startedAt = new Date().toISOString();
  const readings = [];

  for (const point of plan.points) {
    if (signal?.aborted) {
      // An aborted scan records the rest as unreached rather than truncating.
      // A short snapshot would silently change every denominator.
      readings.push(reading({ point, status: UNREACHED, error: 'aborted' }));
      continue;
    }

    let r;
    try {
      const res = await provider.query({ lat: point.lat, lng: point.lng, term: query, signal });
      const results = res?.results ?? [];
      const rank = locateTarget(results, target);
      // How many rows came back is part of the reading: "absent" means absent
      // from a list of this depth, and providers do not return a fixed depth.
      const listDepth = results.length;
      r = rank
        ? reading({ point, status: FOUND, rank, results, listDepth })
        : reading({ point, status: ABSENT, results, listDepth });
    } catch (err) {
      // The one branch that matters: a failure is NOT an absence.
      r = reading({ point, status: UNREACHED, error: String(err?.message || err) });
    }

    readings.push(r);
    onPoint?.({ done: readings.length, total: plan.points.length, reading: r });
    if (pacing && readings.length < plan.points.length) await sleep(pacing);
  }

  const snap = snapshot({
    target,
    query,
    plan,
    readings,
    // The provider's pins travel with the readings. What "rank" meant at a
    // point (search radius, result cap, ranking rule) is part of the method.
    provider: {
      id: provider.id,
      version: provider.version ?? null,
      ...(provider.pins ? { pins: provider.pins } : {}),
    },
    command,
    startedAt,
    finishedAt: new Date().toISOString(),
  });

  // The capture depth range says what ABSENT was absent from.
  snap.method.observation = {
    ...(snap.method.observation ?? {}),
    listDepth: listDepthRange(readings),
  };

  return { snapshot: snap, audit: audit(snap) };
}
