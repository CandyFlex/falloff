/**
 * csv.mjs: a small RFC 4180 reader and writer, because the manual sheet is
 * a CSV and this package has no dependencies.
 *
 * Handles quoted fields, doubled quotes inside them, embedded newlines,
 * CRLF and LF, and a trailing newline. It does not guess delimiters or
 * encodings: the sheet is comma-separated UTF-8 because Falloff wrote it.
 *
 * Every record carries the physical line it started on, so an error in
 * the sheet can be reported by line number rather than by record index.
 */

/** Parse CSV text into records. @returns {{ fields: string[], line: number }[]} */
export function parseCsv(text) {
  const src = String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) return parseCsv(src.slice(1)); // BOM from a spreadsheet export
  const records = [];
  let fields = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endField = () => {
    fields.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push({ fields, line: recordLine });
    fields = [];
    recordLine = line;
  };

  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      line++;
      endRecord();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (quoted) throw new Error(`csv: unterminated quoted field starting near line ${recordLine}`);
  if (field.length || fields.length) endRecord();
  // Drop records that are entirely empty (a blank trailing line).
  return records.filter((r) => !(r.fields.length === 1 && r.fields[0] === ''));
}

/** Quote one value when it needs it. */
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise rows (arrays) to CSV text with LF line endings. */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}
