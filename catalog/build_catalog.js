/* catalog/build_catalog.js — rows -> published catalog artifacts
 *
 *   node build_catalog.js rows.json [--specs specs.json] [--out ../dist]
 *
 * Writes:
 *   <out>/manifest.json          build no., hash per file, USBC list version
 *   <out>/index.json             search-level record per ball
 *   <out>/detail/<slug>.json     one shard per manufacturer
 *   <out>/usbc.json              eligibility, versioned separately
 *   <out>/review.json            everything a human needs to look at
 *
 * Exit 0 with "changed: false" means nothing to commit (§7).
 *
 * Design ref: DESIGN_ball_catalog.md §6, §7
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const N = require('./normalize');

/* -------------------------------------------------------------- *
 * Stable serialisation. Unstable key order produces phantom diffs
 * and defeats change detection (§7).
 * -------------------------------------------------------------- */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}
const stable = v => JSON.stringify(sortDeep(v), null, 1) + '\n';
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const slug = s => N.norm(s) || 'unknown';

/* -------------------------------------------------------------- *
 * CatalogID — stable, human-readable, derived from identity only.
 * Never from the release year (§4).
 * -------------------------------------------------------------- */
function catalogID(row) {
  const parts = [row.mfg, row.ballName, row.colorway].filter(Boolean);
  let id = N.translit(parts.join(' '))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')        // (All Colors) is KEPT here — it
    .replace(/^-|-$/g, '');             // distinguishes a real USBC row
  /* The ** marker is part of identity: USBC lists "**Wolf" (under 13 lb)
   * and "Wolf" as separate approvals. Strip it from the name and they
   * collide, and one real ball gets dropped. */
  if (row.weightLimit) id += '-u13';
  return id || 'unknown';
}

/* Deterministic disambiguation. Some USBC rows are genuinely
 * indistinguishable after normalization — "(Danger) Zone" and
 * "Danger Zone" are different balls with the same reduction. Suffix
 * rather than drop: a duplicate ID is recoverable, a missing ball is not. */
function uniqueID(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const cand = `${base}-${n}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${taken.size}`;
}

/* -------------------------------------------------------------- */
/* v30.171: same classes as the app's coverClass(); name only for Pearl/Hybrid/Solid (v30.167 rule). */
function coverCode(cv) {
  const t = ((cv && cv.Type) || '').toLowerCase(), n = ((cv && cv.Name) || '').toLowerCase();
  const pick = s => /polyester|plastic|spare/.test(s) ? null : (/urethane/.test(s) && !/reactive/.test(s)) ? 'U'
    : /hybrid/.test(s) ? 'H' : /pearl/.test(s) ? 'P' : /solid/.test(s) ? 'S' : null;
  if (t) return pick(t);
  const hits = ['pearl', 'hybrid', 'solid'].filter(w => new RegExp('\\b' + w).test(n));
  return hits.length === 1 ? pick(hits[0]) : (/urethane/.test(n) && !/reactive/.test(n) ? 'U' : null);
}
function coreCode(co) { const t = (co && co.Type) || ''; return /asym/i.test(t) ? 'a' : /sym/i.test(t) ? 's' : null; }
function build(rows, specsByKey, listVersion) {
  const review = {
    listVersion,
    generated: new Date().toISOString().slice(0, 10),
    badDates: [],
    idCollisions: [],
    modelGroups: [],
    missingSpecs: [],
    weightLimited: [],
  };

  const byID = new Map();
  const models = new Map();

  for (const r of rows) {
    let id = catalogID(r);
    const mk = r.modelKey || N.modelKey(r.mfg, r.ballName);

    const baseID = id;
    if (byID.has(id)) {
      id = uniqueID(baseID, byID);
      review.idCollisions.push({
        base: baseID, assigned: id,
        a: byID.get(baseID).BallName, b: r.ballName,
        identical: byID.get(baseID).BallName === r.ballName,
      });
    }
    if (!r.approvalDateOK) {
      review.badDates.push({ id, raw: r.approvalDate, line: r.raw });
    }
    if (r.weightLimit) review.weightLimited.push(id);

    const specs = specsByKey[id] || specsByKey[mk] || null;
    if (!specs) review.missingSpecs.push(id);

    const entry = {
      CatalogID: id,
      MatchKey: N.matchKey(r.mfg, r.ballName, r.colorway),
      ModelKey: mk,
      MFG: r.mfg,
      BallName: r.ballName,                       // verbatim from USBC (§4)
      Colorway: r.colorway || null,
      Aliases: (specs && specs.Aliases) || [],
      DateReleased: (specs && specs.DateReleased) || null,
      WeightLimit: r.weightLimit || null,
      Core: (specs && specs.Core) || { Name: null, Type: null },
      Cover: (specs && specs.Cover) || { Name: null, Type: null, Finish: null },
      SpecsByWeight: (specs && specs.SpecsByWeight) || {},
      Source: (specs && specs.Source) || null,     // v30.159: manufacturer page the specs came from
      Checked: (specs && specs.Checked) || null,   // date the bridge fetched it
      Status: (specs && specs.Status) || null,     // v30.171: 'current' | 'retired' from the maker's site
      USBC: {
        Approved: true,
        ApprovedDate: r.approvalISO,
        ApprovedDateRaw: r.approvalDateOK ? null : r.approvalDate,
        NonConforming: false,
        Ineligible: { NoSlowOil: false, SlowOil78D: false },
        ListVersion: listVersion,
      },
      Images: { Thumb: null, Cover: null, Core: null },
      Ratings: { PerfectScaleVal: null, HookRating: null },
      FieldSources: Object.assign(
        { BallName: 'usbc', USBC: 'usbc' },
        specs ? { RG: 'mfg', Core: 'mfg', Cover: 'mfg' } : {}
      ),
    };

    byID.set(id, entry);
    if (!models.has(mk)) models.set(mk, []);
    models.get(mk).push(id);
  }

  for (const [mk, ids] of models) {
    if (ids.length > 1) review.modelGroups.push({ modelKey: mk, count: ids.length, ids });
  }

  const entries = [...byID.values()].sort((a, b) => a.CatalogID.localeCompare(b.CatalogID));

  /* index: search-level only, ~110 B per record (§6) */
  const index = entries.map(e => ({
    i: e.CatalogID,
    m: e.MFG,
    n: e.BallName,
    c: e.Colorway,
    y: e.USBC.ApprovedDate ? e.USBC.ApprovedDate.slice(0, 4) : null,
    k: e.ModelKey,
    t: !!e.Images.Thumb,
    /* v30.159: published specs flag for the search-row dot; absent when none (keeps index small) */
    ...(Object.keys(e.SpecsByWeight || {}).length ? { s: 1 } : {}),
    /* v30.171 Add a Ball bubbles: r 1 retired / 0 current (absent = unknown), cv cover class, co core */
    ...(e.Status === 'retired' ? { r: 1 } : e.Status === 'current' ? { r: 0 } : {}),
    ...(coverCode(e.Cover) ? { cv: coverCode(e.Cover) } : {}),
    ...(coreCode(e.Core) ? { co: coreCode(e.Core) } : {}),
  }));

  /* detail sharded by manufacturer — Storm is one request, not 400 */
  const shards = {};
  for (const e of entries) {
    const s = slug(e.MFG);
    (shards[s] = shards[s] || []).push(e);
  }

  /* eligibility versioned separately so a stale flag is visibly stale */
  const usbc = {
    ListVersion: listVersion,
    Counts: { approved: entries.length },
    Eligibility: entries.reduce((acc, e) => {
      acc[e.CatalogID] = e.USBC.Ineligible;
      return acc;
    }, {}),
  };

  return { entries, index, shards, usbc, review };
}

/* -------------------------------------------------------------- */
function writeIfChanged(file, body, manifest, key) {
  const h = sha(body);
  let prev = null;
  try { prev = sha(fs.readFileSync(file, 'utf8')); } catch (e) {}
  manifest.files[key] = { path: key, hash: h, bytes: Buffer.byteLength(body) };
  if (prev === h) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return true;
}

/* v30.173 CAT-NEW-7: every value already published for the reusable spec
   fields, with how often and which makers use it, for the app's pick lists. */
function vocabOf(entries) {
  const F = { core: e => e.Core && e.Core.Name, coreType: e => e.Core && e.Core.Type, coverName: e => e.Cover && e.Cover.Name,
              coverType: e => e.Cover && e.Cover.Type, finish: e => e.Cover && e.Cover.Finish };
  const out = {};
  for (const k in F) {
    const m = new Map();
    for (const e of entries) {
      const v = F[k](e); if (v == null || String(v).trim() === '') continue;
      const t = String(v).trim(), key = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const o = m.get(key) || { v: t, n: 0, b: [] }; o.n++; if (e.MFG && !o.b.includes(e.MFG)) o.b.push(e.MFG); m.set(key, o);
    }
    out[k] = [...m.values()].map(o => ({ v: o.v, n: o.n, b: o.b.sort() })).sort((a, b) => b.n - a.n || a.v.localeCompare(b.v));
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const rowsPath = args.find(a => !a.startsWith('--') &&
    args[args.indexOf(a) - 1] !== '--specs' && args[args.indexOf(a) - 1] !== '--out');
  const specsPath = args[args.indexOf('--specs') + 1];
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'dist';
  if (!rowsPath) {
    console.error('usage: node build_catalog.js rows.json [--specs specs.json] [--out dist]');
    process.exit(2);
  }

  const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8'));
  const specs = (args.includes('--specs'))
    ? JSON.parse(fs.readFileSync(specsPath, 'utf8'))
    : {};
  const listVersion = process.env.USBC_LIST_VERSION ||
    new Date().toISOString().slice(0, 10);

  const { entries, index, shards, usbc, review } = build(rows, specs, listVersion);

  const manifest = { build: null, listVersion, generated: review.generated, files: {} };
  let changed = false;

  changed = writeIfChanged(path.join(outDir, 'index.json'), stable(index), manifest, 'index.json') || changed;
  changed = writeIfChanged(path.join(outDir, 'usbc.json'),  stable(usbc),  manifest, 'usbc.json')  || changed;
  changed = writeIfChanged(path.join(outDir, 'vocab.json'), stable(vocabOf(entries)), manifest, 'vocab.json') || changed;
  for (const [s, list] of Object.entries(shards)) {
    const key = `detail/${s}.json`;
    changed = writeIfChanged(path.join(outDir, key), stable(list), manifest, key) || changed;
  }

  /* build no. is the hash of the file hashes — deterministic, and it
   * only moves when content moves. */
  manifest.build = sha(Object.values(manifest.files).map(f => f.hash).join(''));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), stable(manifest));
  fs.writeFileSync(path.join(outDir, 'review.json'), stable(review));

  console.error(`entries        ${entries.length}`);
  console.error(`shards         ${Object.keys(shards).length}`);
  console.error(`index bytes    ${manifest.files['index.json'].bytes}`);
  console.error(`build          ${manifest.build}`);
  console.error(`changed        ${changed}`);
  console.error(`-- review --`);
  console.error(`bad dates      ${review.badDates.length}`);
  console.error(`id collisions  ${review.idCollisions.length}`);
  console.error(`model groups   ${review.modelGroups.length}`);
  console.error(`missing specs  ${review.missingSpecs.length}`);
  console.error(`weight-limited ${review.weightLimited.length}`);

  console.log(changed ? 'changed: true' : 'changed: false');
}

if (require.main === module) main();
module.exports = { build, catalogID, stable, sha, coverCode, coreCode, vocabOf };
