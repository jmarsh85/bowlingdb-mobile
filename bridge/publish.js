#!/usr/bin/env node
/* Spec bridge, stage 7: publish.
   staging/specs_staging.json (auto rows + approved decisions) -> catalog/specs.json,
   the file catalog-refresh already merges into the detail shards (build_catalog.js --specs).
   Facts only: mfgScales and imageUrl never leave staging.

   node bridge/publish.js --staging specs/staging/specs_staging.json [--decisions specs/staging/decisions.json] --out catalog/specs.json
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
  };
}
/* decisions (from the approvals issue): [{url, catalogId, action:'approve'|'reject'}]
   Precedence per CatalogID: your approvals > auto. Within a tier, sources must agree or nothing publishes. */
function publish(staged, decisions) {
  decisions = decisions || [];
  const report = { auto: 0, approved: 0, rejected: 0, skippedNoWeights: 0, conflicts: [] };
  const rejectUrl = new Set(decisions.filter(d => d.action === 'reject').map(d => d.url));
  const byUrl = {}; staged.forEach(r => { if (r.url) (byUrl[r.url] = byUrl[r.url] || []).push(r); });
  const tiers = {};   // id -> {approved:[entry], auto:[entry]}
  const add = (id, tier, r) => {
    const e = toSpecsEntry(r);
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
  }
  report.published = Object.keys(specs).length;
  return { specs, report };
}
function main(argv) {
  const arg = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
  const staged = JSON.parse(fs.readFileSync(arg('staging'), 'utf8'));
  const decPath = arg('decisions');
  const decisions = decPath && fs.existsSync(decPath) ? JSON.parse(fs.readFileSync(decPath, 'utf8')) : [];
  const { specs, report } = publish(staged, decisions);
  if (report.published < 100) { console.error('Refusing to publish: only ' + report.published + ' entries (expected 1000+). Check staging.'); process.exit(1); }
  const sorted = {}; Object.keys(specs).sort().forEach(k => { sorted[k] = specs[k]; });
  fs.writeFileSync(arg('out'), JSON.stringify(sorted, null, 1) + '\n');
  console.log(JSON.stringify(report));
  return report;
}
module.exports = { publish, toSpecsEntry, main };
if (require.main === module) main(process.argv.slice(2));
