/* catalog/normalize.js — BowlingDB ball catalog
 *
 * Shared by the ingest pipeline and (later) the in-app matcher.
 * Keep it dependency-free and side-effect-free so it can be pasted
 * into index.html without change.
 *
 * Design ref: DESIGN_ball_catalog.md §4
 */

'use strict';

/* --------------------------------------------------------------
 * Manufacturer aliases
 * USBC is inconsistent with itself: its brand selector says
 * "Track Inc." and "Columbia" while its PDF body says "Columbia 300".
 * Map everything onto a canonical name. Key = norm() of any spelling.
 * ------------------------------------------------------------ */
const MFG_ALIASES = {
  track:        'Track Inc.',
  trackinc:     'Track Inc.',
  columbia:     'Columbia 300',
  columbia300:  'Columbia 300',
  rotogrip:     'Roto Grip',
  '900global':  '900 Global',
  storm:        'Storm',
  brunswick:    'Brunswick',
  hammer:       'Hammer',
  radical:      'Radical',
  motiv:        'Motiv',
  dv8:          'DV8',
  ebonite:      'Ebonite',
};

/* Ball-name aliases: our spelling -> USBC's spelling.
 * Additive only. Each entry should be traceable to a real miss. */
const NAME_ALIASES = {
  'storm|hyroad':    'Hy-Road',      // preseed BallID 7
  'brunswick|tzone': 'T Zone',       // preseed BallID 17, USBC "T Zone (All Colors)"
};

const WEIGHT_LIMIT_UNDER_13 = 'under 13 lb';

/* Dates outside this range are source errors, not data.
 * The official list contains "September 3, 3024". */
const DATE_MIN = 1960;
const DATE_MAX = new Date().getFullYear() + 2;

/* --------------------------------------------------------------
 * Transliteration. Characters that carry meaning but are not
 * alphanumeric must survive the strip, or distinct balls collide:
 * "X" vs "X\u00b2", "505C" vs "505C\u00b2", "Results" vs "Results+".
 * ------------------------------------------------------------ */
const TRANSLIT = [
  [/\u00b2/g, '2'], [/\u00b3/g, '3'], [/\u00b9/g, '1'],       // superscripts
  [/[\u221e\ua70f]/g, 'eight'],                             // infinity glyphs
  [/\u03a0|\u03c0/g, 'pi'], [/\u03a9/g, 'omega'],              // greek
  [/\+/g, 'plus'],
  [/&/g, 'and'],
  [/\u2192|\u2190/g, 'to'],
];

function translit(s) {
  let out = String(s);
  for (const [re, rep] of TRANSLIT) out = out.replace(re, rep);
  return out;
}

/* --------------------------------------------------------------
 * norm(s) — the core reduction
 * ------------------------------------------------------------ */
function norm(s) {
  if (s == null) return '';
  return translit(s)
    .toLowerCase()
    .replace(/\(all colors?\)/g, '')      // colourway-agnostic marker
    .replace(/[^a-z0-9]/g, '');
}

/* --------------------------------------------------------------
 * cleanBallName(raw) -> { name, weightLimit }
 * Strips USBC's "**" prefix (manufactured only under 13 lb) and
 * keeps it as data rather than discarding it.
 * ------------------------------------------------------------ */
function cleanBallName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const starred = /^\*+\s*/.test(s);
  return {
    name: s.replace(/^\*+\s*/, '').trim(),
    weightLimit: starred ? WEIGHT_LIMIT_UNDER_13 : null,
  };
}

/* --------------------------------------------------------------
 * canonicalMfg(raw) -> canonical display name (or the trimmed input)
 * ------------------------------------------------------------ */
function canonicalMfg(raw) {
  const k = norm(raw);
  return MFG_ALIASES[k] || String(raw == null ? '' : raw).trim();
}

/* --------------------------------------------------------------
 * Keys.
 * MatchKey is identity: mfg | name | colourway.
 * ModelKey is a soft, curated group: mfg | name.
 * Release year is NEVER part of either (see §4).
 * ------------------------------------------------------------ */
function modelKey(mfg, ballName) {
  const m = norm(canonicalMfg(mfg));
  const { name } = cleanBallName(ballName);
  const aliased = NAME_ALIASES[m + '|' + norm(name)];
  return m + '|' + norm(aliased || name);
}

function matchKey(mfg, ballName, colorway) {
  return modelKey(mfg, ballName) + '|' + norm(colorway);
}

/* --------------------------------------------------------------
 * parseApprovalDate(raw) -> { iso, precision, ok, raw }
 * USBC mixes "September 30, 2016", "Oct-13", "Jan-'04", "Jun'00".
 * precision: 'day' | 'month' | null
 * ok=false means out of sanity range — keep raw, do not use.
 * ------------------------------------------------------------ */
const MONTHS = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12,
  january:1, february:2, march:3, april:4, june:6, july:7,
  august:8, september:9, october:10, november:11, december:12,
};

function parseApprovalDate(raw) {
  const out = { iso: null, precision: null, ok: false, raw: raw == null ? null : String(raw).trim() };
  if (!out.raw) return out;
  const s = out.raw;

  let y = null, mo = null, d = null;

  // "September 30, 2016"
  let m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3];
  } else {
    // "Oct-13" | "Jan-'04" | "Jun'00" | "March-'04" | "Nov-'02"
    m = s.match(/^([A-Za-z]+)[-\s]?'?(\d{2,4})$/);
    if (m) {
      mo = MONTHS[m[1].toLowerCase()];
      let yy = +m[2];
      y = yy >= 100 ? yy : (yy <= 30 ? 2000 + yy : 1900 + yy);
    }
  }

  if (!y || !mo) return out;                    // unparseable — keep raw
  if (y < DATE_MIN || y > DATE_MAX) return out; // sanity range — keep raw

  const pad = n => String(n).padStart(2, '0');
  if (d) { out.iso = `${y}-${pad(mo)}-${pad(d)}`; out.precision = 'day'; }
  else   { out.iso = `${y}-${pad(mo)}`;           out.precision = 'month'; }
  out.ok = true;
  return out;
}

/* --------------------------------------------------------------
 * buildIndex(rows) -> Map<matchKey, row[]>
 * Rows with the same key are NOT merged. Ambiguity is surfaced,
 * never resolved silently.
 * ------------------------------------------------------------ */
function buildIndex(rows, keyFn) {
  const fn = keyFn || (r => matchKey(r.mfg, r.ballName, r.colorway));
  const idx = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  }
  return idx;
}

/* --------------------------------------------------------------
 * lookup(idx, mfg, name, colorway) -> { status, candidates }
 * status: 'match' | 'ambiguous' | 'miss'
 * Exact match only — never prefix, never fuzzy. "Hitman" and
 * "Hitman Enforcer" are both live DV8 entries.
 * ------------------------------------------------------------ */
function lookup(idx, mfg, name, colorway) {
  const hits = idx.get(matchKey(mfg, name, colorway)) || [];
  if (hits.length === 1) return { status: 'match',     candidates: hits };
  if (hits.length > 1)   return { status: 'ambiguous', candidates: hits };
  return { status: 'miss', candidates: [] };
}

module.exports = {
  norm, translit, cleanBallName, canonicalMfg,
  modelKey, matchKey, parseApprovalDate,
  buildIndex, lookup,
  MFG_ALIASES, NAME_ALIASES,
  WEIGHT_LIMIT_UNDER_13, DATE_MIN, DATE_MAX,
};
