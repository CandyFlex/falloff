/**
 * node/command-line.mjs: the reproduce command, as it gets recorded.
 *
 * Every snapshot carries the command that made it. Two things can go wrong
 * with that, and both are worth a module and a test:
 *
 *   - A secret in the command. `--key <value>` is dropped, both the flag and
 *     its value, as is `--key=<value>`. A snapshot is meant to be published;
 *     an API key in it would be published too.
 *   - A command that cannot be pasted. Arguments with spaces or shell
 *     characters are quoted, so `--name "Some Business"` comes back the way
 *     it was typed instead of as two words.
 */

const SECRET_FLAGS = new Set(['--key']);

/** Quote one argument for a POSIX shell when it needs it. */
export function shellQuote(a) {
  const s = String(a);
  return /^[A-Za-z0-9_\-+=:.,/@%]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** The command line for a snapshot: `falloff <args>`, minus secrets. */
export function commandLine(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (SECRET_FLAGS.has(a)) {
      i++; // the value goes too
      continue;
    }
    if ([...SECRET_FLAGS].some((f) => a.startsWith(`${f}=`))) continue;
    out.push(shellQuote(a));
  }
  return `falloff ${out.join(' ')}`;
}
