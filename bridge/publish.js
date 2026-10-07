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
/* decisions (from the approval page, later): [{catalogId, url, action:'approve'|'reject'}] */
function publish(staged, decisions) {
  const dec = {}; (decisions || []).forEach(d => { dec[(d.url || '') + '|' + (d.catalogId || '')] = d; });
  const out = {}, report = { auto: 0, approved: 0, rejected: 0, skippedNoWeights: 0, conflicts: [] };
  for (const r of staged) {
    let id = r.decision === 'auto' ? r.catalogId : null;
    const d = (decisions || []).find(x => x.url === r.url);
    if (d && d.action === 'reject') { report.rejected++; continue; }
    if (d && d.action === 'approve' && d.catalogId) { id = d.catalogId; report.approved++; }
    else if (id) report.auto++;
    if (!id) continue;
    const e = toSpecsEntry(r);
    if (!Object.keys(e.SpecsByWeight).length) { report.skippedNoWeights++; continue; }
    if (out[id] && JSON.stringify(out[id].SpecsByWeight) !== JSON.stringify(e.SpecsByWeight)) {
      report.conflicts.push(id); delete out[id]; out['__conflict__' + id] = true; continue;
    }
    if (out['__conflict__' + id]) continue;
    out[id] = e;
  }
  Object.keys(out).forEach(k => { if (k.startsWith('__conflict__')) delete out[k]; });
  report.published = Object.keys(out).length;
  return { specs: out, report };
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
