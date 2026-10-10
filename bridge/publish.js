#!/usr/bin/env node
/* Spec bridge, stage 7: publish.
   staging/specs_staging.json (auto rows + approved decisions) -> catalog/specs.json,
   the file catalog-refresh already merges into the detail shards (build_catalog.js --specs).
   Facts only: mfgScales and imageUrl never leave staging.

   node bridge/publish.js --staging specs/staging/specs_staging.json [--decisions specs/staging/decisions.json]
                          [--overrides specs/corrections/overrides.json] --out catalog/specs.json

   v30.170 corrections: overrides.json is written by the app's "Correct / fill gaps"
   ({ catalogId: { coverType, finish, core, coreType, released, weights:{lb:{RG,Diff,IntDiff}},
   source, note, at } }). It lives in corrections/ on the specs branch, because
   specs-extract replaces staging/ on every run. A correction is applied to a ball
   only when that ball publishes (auto or approved); it fills or replaces just the
   fields it names. source "bowwwl" is NEVER published (personal-use data; the app
   keeps those on the device), even if one reaches this file.
*/
'use strict';
const fs = require('fs');

function toSpecsEntry(r) {
  const s = r.specs || {}, sbw = {};
  for (const w of Object.keys(s.weights || {}).sort()) {
    const v = s.weights[w];
    if (v && v.RG != null && v.Diff != null) sbw[w] = { RG: v.RG, Diff: v.Diff, IntDiff: v.IntDiff == null ? null : v.IntDiff };
  }
  const coreType = s.coreType ? (/asym/i.test(s.coreType) ? 'Asymmetrical' : /sym/i.test(s.coreType) ? 'Symmetrical' : null) : null;
  return {
    DateReleased: s.released || null,
    Core: { Name: s.core || null, Type: coreType },
    Cover: { Name: s.coverName || null, Type: s.coverType || null, Finish: s.finish || null },
    SpecsByWeight: sbw,
    Source: r.url || null,
    Checked: r.fetched || null,
    /* v30.171 CAT-NEW-1: maker's current/retired; unknown is left out */
    ...(r.status === 'current' || r.status === 'retired' ? { Status: r.status } : {}),
  };
}
/* Pure: a staged row with a correction merged in (new object; the row is untouched). */
function applyOverride(r, o) {
  if (!o) return r;
  const s = JSON.parse(JSON.stringify(r.specs || {}));
  for (const k of ['coverType', 'finish', 'core', 'coreType', 'released', 'coverName']) if (o[k] != null && o[k] !== '') s[k] = o[k];
  s.weights = s.weights || {};
  for (const w of Object.keys(o.weights || {})) s.weights[w] = Object.assign({}, s.weights[w] || {}, o.weights[w]);
  return Object.assign({}, r, { specs: s });
}
/* decisions (from the approvals issue): [{url, catalogId, action:'approve'|'reject'}]
   Precedence per CatalogID: your approvals > auto. Within a tier, sources must agree or nothing publishes. */
function publish(staged, decisions, overrides) {
  decisions = decisions || []; overrides = overrides || {};
  const report = { auto: 0, approved: 0, rejected: 0, skippedNoWeights: 0, conflicts: [], corrected: 0, correctionsNotPublished: [] };
  const ovFor = id => {
    const o = overrides[id];
    if (!o) return null;
    if (o.source === 'bowwwl') { if (report.correctionsNotPublished.indexOf(id) < 0) report.correctionsNotPublished.push(id); return null; }
    return o;
  };
  const rejectUrl = new Set(decisions.filter(d => d.action === 'reject').map(d => d.url));
  const byUrl = {}; staged.forEach(r => { if (r.url) (byUrl[r.url] = byUrl[r.url] || []).push(r); });
  const tiers = {};   // id -> {approved:[entry], auto:[entry]}
  const add = (id, tier, r) => {
    const o = ovFor(id);
    const e = toSpecsEntry(applyOverride(r, o));
    if (o) e.Corrected = { source: o.source || 'maker', at: o.at || null };
    if (!Object.keys(e.SpecsByWeight).length) { report.skippedNoWeights++; return; }
    ((tiers[id] = tiers[id] || { approved: [], auto: [] })[tier]).push(e);
  };
  for (const d of decisions) {
    if (d.action !== 'approve' || !d.catalogId) continue;
    const rows = byUrl[d.url] || [];
    if (!rows.length) continue;            // page no longer staged: approval waits
    report.approved++; add(d.catalogId, 'approved', rows[0]);
  }
  for (const r of staged) {
    if (r.decision !== 'auto' || !r.catalogId) continue;
    if (rejectUrl.has(r.url)) { report.rejected++; continue; }
    report.auto++; add(r.catalogId, 'auto', r);
  }
  const specs = {};
  for (const id in tiers) {
    const list = tiers[id].approved.length ? tiers[id].approved : tiers[id].auto;
    if (!list.length) continue;
    const sig = e => JSON.stringify(e.SpecsByWeight);
    if (new Set(list.map(sig)).size > 1) { report.conflicts.push(id); continue; }
    specs[id] = list[0];
    if (list[0].Corrected) report.corrected++;
  }
  report.published = Object.keys(specs).length;
  return { specs, report };
}
function main(argv) {
  const arg = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
  const staged = JSON.parse(fs.readFileSync(arg('staging'), 'utf8'));
  const decPath = arg('decisions');
  const decisions = decPath && fs.existsSync(decPath) ? JSON.parse(fs.readFileSync(decPath, 'utf8')) : [];
  const ovPath = arg('overrides');
  const overrides = ovPath && fs.existsSync(ovPath) ? JSON.parse(fs.readFileSync(ovPath, 'utf8')) : {};
  const { specs, report } = publish(staged, decisions, overrides);
  if (report.published < 100) { console.error('Refusing to publish: only ' + report.published + ' entries (expected 1000+). Check staging.'); process.exit(1); }
  const sorted = {}; Object.keys(specs).sort().forEach(k => { sorted[k] = specs[k]; });
  fs.writeFileSync(arg('out'), JSON.stringify(sorted, null, 1) + '\n');
  console.log(JSON.stringify(report));
  return report;
}
module.exports = { publish, toSpecsEntry, applyOverride, main };
if (require.main === module) main(process.argv.slice(2));
