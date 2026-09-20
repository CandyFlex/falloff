/**
 * providers/index.mjs: where readings come from.
 *
 * Falloff ships the METHOD, not a scraper. The sampling geometry, the
 * absent/unreached distinction, the metrics and the auditor are all provider-
 * agnostic and are the part worth having. How you actually query a point is
 * your business and your terms of service.
 *
 * A provider is any object with this shape:
 *
 *   {
 *     id: 'places',              // recorded in the snapshot's method block
 *     version: '1',              // bump when behaviour changes
 *     pacingMs: 2800,            // minimum gap between calls, self-imposed
 *     async query({ lat, lng, term, signal }) -> {
 *       results: [{ id, name, rating?, reviews? }],   // ranked, best first
 *     }
 *   }
 *
 * `query` returns the ranked list seen from that coordinate. It must THROW on
 * failure rather than returning an empty list. An empty list means "measured,
 * nothing there" (ABSENT) and a throw means "not measured" (UNREACHED). That
 * one line is the whole reason the numbers can be defended, so it is the
 * provider's job to get it right.
 */

/** Sanity-check a provider before a scan spends real calls on it. */
export function validateProvider(p) {
  const problems = [];
  if (!p) return ['provider is missing'];
  if (!p.id) problems.push('provider.id is required; it is recorded in the method block');
  if (typeof p.query !== 'function') problems.push('provider.query must be a function');
  if (p.pacingMs != null && !(p.pacingMs >= 0)) problems.push('provider.pacingMs must be >= 0');
  return problems;
}

/**
 * Find the target in a ranked result list.
 *
 * Identity is by stable id wherever the provider supplies one. Name matching
 * is a fallback and is deliberately strict: a loose match silently converts
 * a competitor's rank into yours, which is the worst failure this tool could
 * have.
 */
export function locateTarget(results, target) {
  if (target.id) {
    const i = results.findIndex((r) => r.id && r.id === target.id);
    if (i >= 0) return i + 1;
    // A target WITH an id that is not in the list is genuinely absent.
    // Do not fall through to name matching; that is how false ranks happen.
    return null;
  }
  const want = normaliseName(target.name);
  const i = results.findIndex((r) => normaliseName(r.name) === want);
  return i >= 0 ? i + 1 : null;
}

function normaliseName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(the|llc|inc|co|ltd)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export { normaliseName };
