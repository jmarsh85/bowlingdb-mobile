#!/usr/bin/env node
/* Spec bridge, stage 6: approvals as a GitHub issue checklist (D8, revised 2026-10-07).
   render: staged pending rows -> issue body (tick boxes), keeping ticks from the current body.
   parse:  issue body -> decisions [{url, catalogId, action:'approve'}] for publish.js.
   Each box carries a hidden token <!--a:URL|CatalogID--> so re-renders keep your ticks.

   node bridge/approvals.js render --staging staging/specs_staging.json [--current body.md] --out body.md
   node bridge/approvals.js parse  --body body.md --out decisions.json
*/
'use strict';
const fs = require('fs');
const MAX = 60000;   // GitHub issue body limit is 65,536 characters

function fmtSpecs(s) {
  const w = s && s.weights || {};
  const k = w['15'] ? '15' : Object.keys(w).sort().reverse()[0];
  if (!k) return 'no numbers';
  const v = w[k]; const f = x => x == null ? '–' : String(x);
  return 'RG ' + f(v.RG) + ' / Diff ' + f(v.Diff) + (v.IntDiff != null ? ' / Int ' + v.IntDiff : '') + ' @' + k + ' lb';
}
const LABEL = { variant: 'Colourway family: tick the USBC ball(s) this page covers',
  ambiguous: 'Two USBC entries share this name: tick the right one',
  'conflicting-sources': 'Sources disagree: tick the one to trust',
  'out-of-range': 'A value failed the range check (that value is dropped): tick to publish the rest',
  'no-usbc': 'No USBC match' };
/* Only rows that could publish something get boxes; the rest are counted. */
function actionable(r) {
  const ws = r.specs && r.specs.weights || {};
  const hasNums = Object.keys(ws).some(w => ws[w] && ws[w].RG != null && ws[w].Diff != null);   // publish needs both
  if (!hasNums) return [];
  const reason = String(r.reason || '').replace(/:.*/, '');
  if (reason === 'variant' || reason === 'ambiguous') return (r.candidates || []).map(id => ({ id, reason }));
  if ((reason === 'conflicting-sources' || reason === 'out-of-range') && r.catalogId) return [{ id: r.catalogId, reason }];
  return [];
}
function readTicks(body) {
  const t = new Set();
  for (const m of String(body || '').matchAll(/^\s*-\s*\[[xX]\][^\n]*<!--a:([^>]*?)-->/gm)) t.add(m[1]);
  return t;
}
function render(staged, currentBody) {
  const ticked = readTicks(currentBody);
  const pend = staged.filter(r => r.decision === 'pending');
  const groups = {}, counts = {};
  let boxes = 0;
  for (const r of pend) {
    const items = actionable(r);
    const reason = String(r.reason || '').replace(/:.*/, '');
    if (!items.length) { counts[reason] = (counts[reason] || 0) + 1; continue; }
    for (const it of items) {
      const tok = (r.url || '') + '|' + it.id;
      const key = it.reason + '||' + r.source;
      (groups[key] = groups[key] || []).push('- [' + (ticked.has(tok) ? 'x' : ' ') + '] **' + String(r.title || '?').replace(/[*\[\]]/g, '') + '** → `' + it.id + '` · ' +
        fmtSpecs(r.specs) + (r.url ? ' · [source](' + r.url + ')' : '') + ' <!--a:' + tok + '-->');
      boxes++;
    }
  }
  const head = ['# Spec approvals', '',
    'Tick a box to publish that page\'s specs for that USBC ball. Then run **specs-publish**. Unticking removes it next publish.',
    'Updated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC · ' + boxes + ' boxes · ' + ticked.size + ' ticked before this update.', ''];
  const body = [];
  for (const key of Object.keys(groups).sort()) {
    const [reason, src] = key.split('||');
    body.push('### ' + src + ' — ' + (LABEL[reason] || reason) + ' (' + groups[key].length + ')', '', ...groups[key], '');
  }
  const ruled = {}; staged.filter(r => r.decision === 'auto' && r.rule).forEach(r => { ruled[r.rule] = (ruled[r.rule] || 0) + 1; });
  const outvoted = staged.filter(r => r.decision === 'minority').length;
  const tail = ['---', 'Handled automatically (no box needed): ' + (Object.entries(ruled).map(([k, v]) => k + ' ' + v).join(', ') || 'none') +
    (outvoted ? '; ' + outvoted + ' outvoted by majority' : '') + '.',
    'Not shown (nothing publishable to approve): ' +
    (Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', ') || 'none') + '.'];
  let out = head.concat(body, tail).join('\n');
  if (out.length > MAX) {
    const keep = []; let len = head.join('\n').length + 200;
    for (const l of body) { if (len + l.length + 1 > MAX) break; keep.push(l); len += l.length + 1; }
    out = head.concat(keep, ['', '_List truncated at GitHub\'s size limit; work through these and the rest appear next run._'], tail).join('\n');
  }
  return out;
}
function parse(body) {
  return [...readTicks(body)].map(tok => { const i = tok.lastIndexOf('|');
    return { url: tok.slice(0, i), catalogId: tok.slice(i + 1), action: 'approve' }; });
}
function main(argv) {
  const arg = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
  const cmd = argv[0];
  if (cmd === 'render') {
    const staged = JSON.parse(fs.readFileSync(arg('staging'), 'utf8'));
    const cur = arg('current') && fs.existsSync(arg('current')) ? fs.readFileSync(arg('current'), 'utf8') : '';
    fs.writeFileSync(arg('out'), render(staged, cur));
  } else if (cmd === 'parse') {
    const b = arg('body') && fs.existsSync(arg('body')) ? fs.readFileSync(arg('body'), 'utf8') : '';
    const d = parse(b); fs.writeFileSync(arg('out'), JSON.stringify(d, null, 1)); console.log(d.length + ' approvals');
  } else { console.error('usage: approvals.js render|parse'); process.exit(2); }
}
module.exports = { render, parse, actionable, readTicks };
if (require.main === module) main(process.argv.slice(2));
