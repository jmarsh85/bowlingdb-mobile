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
  let id = parts.join(' ')
    .toLowerCase()
    .replace(/\(all colors?\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return id || 'unknown';
}

/* -------------------------------------------------------------- */
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
    const id = catalogID(r);
    const mk = r.modelKey || N.modelKey(r.mfg, r.ballName);

    if (byID.has(id)) {
      review.idCollisions.push({ id, a: byID.get(id).BallName, b: r.ballName });
      continue;                                   // never merge silently (§4)
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
module.exports = { build, catalogID, stable, sha };

