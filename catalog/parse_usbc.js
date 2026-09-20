/* catalog/parse_usbc.js — USBC approved ball list -> rows
 *
 *   node parse_usbc.js list.txt  > rows.json     # PDF text layout
 *   node parse_usbc.js brand.html > rows.json    # per-brand web view
 *
 * Emits: [{ mfg, ballName, colorway, weightLimit, approvalDate,
 *           approvalISO, approvalPrecision, modelKey, raw }]
 *
 * Does NOT fetch. Feed it a file; the Action handles retrieval so the
 * parser stays testable offline.
 *
 * Design ref: DESIGN_ball_catalog.md §5
 */

'use strict';
const fs = require('fs');
const path = require('path');
const N = require('./normalize');

const BRANDS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'usbc_brands.json'), 'utf8')
).brands;

/* Longest first, so "Columbia 300" wins over "Columbia" and
 * "Track Inc." over "Track". This is the whole trick: brand and ball
 * name are both multi-word with no delimiter between them. */
const BRANDS_BY_LENGTH = BRANDS.slice().sort((a, b) => b.length - a.length);

/* Trailing date. Covers every shape seen in the real list:
 *   "September 30, 2016" | "Oct-13" | "Jan-'04" | "Jun'00"
 *   "March-'04" | "Nov-'02" | "Sept-'05" | "Apr'00"
 */
const DATE_TAIL = /\s+([A-Za-z]+\s+\d{1,2},\s*\d{4}|[A-Za-z]+[-\s]?'?\d{2,4})\s*$/;

/* Lines that are chrome, not data. */
const NOISE = [
  /^Page \d+ of \d+$/i,
  /^Brand\s+Ball Name\s+Date Approved$/i,
  /^\*\* Denotes/i,
  /^USBC Approved Bowling Balls$/i,
  /^Since all bowling balls/i,
  /^previously approved/i,
  /^discretion of the tournament/i,
  /^House Balls may be used/i,
  /^USBC Equipment Specifications Manual/i,
  /^\d{1,2}\/\d{1,2}\/\d{4}$/,          // the list's own date stamp
];

function isNoise(line) {
  return !line || NOISE.some(re => re.test(line));
}

function splitBrand(line) {
  for (const b of BRANDS_BY_LENGTH) {
    if (line.length > b.length &&
        line.slice(0, b.length) === b &&
        /\s/.test(line[b.length])) {
      return { mfg: b, rest: line.slice(b.length).trim() };
    }
  }
  return null;
}

/* -------------------------------------------------------------- */
function parseLine(line, out, unmatched) {
  const s = line.replace(/\s+/g, ' ').trim();
  if (isNoise(s)) return;

  const dm = s.match(DATE_TAIL);
  if (!dm) { unmatched.push({ reason: 'no trailing date', line: s }); return; }

  const approvalDate = dm[1].trim();
  const head = s.slice(0, dm.index).trim();

  const split = splitBrand(head);
  if (!split) { unmatched.push({ reason: 'brand not recognised', line: s }); return; }

  const { name, weightLimit } = N.cleanBallName(split.rest);
  if (!name) { unmatched.push({ reason: 'empty ball name', line: s }); return; }

  const d = N.parseApprovalDate(approvalDate);
  out.push({
    mfg: N.canonicalMfg(split.mfg),
    ballName: name,                 // verbatim, colourway included (§4)
    colorway: null,                 // never parsed out of the name
    weightLimit,
    approvalDate: d.raw,
    approvalISO: d.iso,
    approvalPrecision: d.precision,
    approvalDateOK: d.ok,
    modelKey: N.modelKey(split.mfg, name),
    raw: s,
  });
}

/* -------------------------------------------------------------- *
 * Per-brand web view: a two-column table, so the brand comes from
 * context rather than from the row. Pass it with --mfg.
 * -------------------------------------------------------------- */
function parseHTMLTable(html, mfg) {
  const out = [], unmatched = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of rows) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [])
      .map(c => c.replace(/<[^>]*>/g, '')
                 .replace(/&amp;/g, '&').replace(/&#x27;|&apos;/g, "'")
                 .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 2 || /^ball name$/i.test(cells[0])) continue;
    parseLine(`${mfg} ${cells[0]} ${cells[1]}`, out, unmatched);
  }
  return { out, unmatched };
}

/* -------------------------------------------------------------- */
function main() {
  const args = process.argv.slice(2);
  const mfgFlag = args.indexOf('--mfg');
  const mfg = mfgFlag >= 0 ? args[mfgFlag + 1] : null;
  const file = args.find(a => !a.startsWith('--') && a !== mfg);
  if (!file) {
    console.error('usage: node parse_usbc.js <list.txt|brand.html> [--mfg "Storm"]');
    process.exit(2);
  }

  const text = fs.readFileSync(file, 'utf8');
  let out, unmatched;

  if (/<\s*t[rd]\b/i.test(text)) {
    if (!mfg) {
      console.error('HTML table input needs --mfg "<Brand>" (the page filters by brand).');
      process.exit(2);
    }
    ({ out, unmatched } = parseHTMLTable(text, mfg));
  } else {
    out = []; unmatched = [];
    for (const line of text.split(/\r?\n/)) parseLine(line, out, unmatched);
  }

  /* Report to stderr so stdout stays pipeable JSON. */
  const badDates = out.filter(r => !r.approvalDateOK);
  const dupes = [];
  const seen = new Map();
  for (const r of out) {
    const k = r.modelKey;
    if (seen.has(k)) dupes.push(`${r.mfg} — ${seen.get(k)} / ${r.ballName}`);
    else seen.set(k, r.ballName);
  }

  console.error(`parsed   ${out.length} rows`);
  console.error(`brands   ${new Set(out.map(r => r.mfg)).size}`);
  console.error(`bad date ${badDates.length}${badDates.length ? ' -> ' + badDates.slice(0,5).map(r=>r.raw).join(' ; ') : ''}`);
  console.error(`modelKey collisions ${dupes.length}${dupes.length ? ' (expected — colourways share a ModelKey)' : ''}`);
  console.error(`unmatched ${unmatched.length}`);
  for (const u of unmatched.slice(0, 20)) console.error(`  [${u.reason}] ${u.line}`);
  if (unmatched.length > 20) console.error(`  ...and ${unmatched.length - 20} more`);

  process.stdout.write(JSON.stringify(out, null, 1));
}

if (require.main === module) main();
module.exports = { parseLine, parseHTMLTable, splitBrand, DATE_TAIL, isNoise };

