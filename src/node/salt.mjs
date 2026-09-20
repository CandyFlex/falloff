/**
 * node/salt.mjs: the per-study salt, and where it is allowed to live.
 *
 * A hashed id is only as private as its salt. An unsalted hash of a Google
 * feature id is reversible by anyone with a bulk export: hash the export,
 * match the digests, read off the business. So each study gets its own random
 * salt, and the salt is written to `studies/private/<study>.salt`, which is
 * git-ignored. It is never in a snapshot, a report, the page, or the pack.
 *
 * Losing a salt loses nothing that matters: the ids in the published study
 * stay internally consistent, so every rank check still works. What is lost
 * is the ability to re-derive the same hashes from the private file, which is
 * why the salt is kept rather than thrown away after use.
 *
 * This module is under src/node/ because it touches the filesystem and
 * node:crypto. `redact` itself stays browser-safe and takes the hash function
 * as an argument.
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** SHA-256 hex, from node. Passed into `redact` as its `hash`. */
export const hasher = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Read the salt at `file`, or make one and write it there.
 *
 * @param {string} file  a path under studies/private/, which is git-ignored
 * @returns {{salt: string, created: boolean}}
 */
export function saltFor(file) {
  if (existsSync(file)) {
    const salt = readFileSync(file, 'utf8').trim();
    if (salt.length < 16) throw new Error(`salt file ${file} is too short to be a salt`);
    return { salt, created: false };
  }
  const salt = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${salt}\n`);
  return { salt, created: true };
}
