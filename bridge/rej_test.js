/* v30.185 REJ-1 bridge checks: extract set-aside, publish status, catalog flags, approvals render. */
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const X = require('./extract.js'), P = require('./publish.js'), A = require('./approvals.js');
const B = require('../catalog/build_catalog.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const W = { '15': { RG: 2.5, Diff: 0.05, IntDiff: null } };
const rej = new Set(['storm-gone']);
// 1. extract: own target rejected; family row loses a candidate; family row with only rejected
const staged = [
  { url: 'u1', catalogId: 'storm-gone', candidates: ['storm-gone'], decision: 'auto', specs: { weights: W } },
  { url: 'u2', catalogId: null, candidates: ['storm-gone', 'storm-keep'], decision: 'pending', reason: 'variant', specs: { weights: W } },
  { url: 'u3', catalogId: null, candidates: ['storm-gone'], decision: 'pending', reason: 'ambiguous', specs: { weights: W } },
  { url: 'u4', catalogId: 'storm-keep', candidates: ['storm-keep'], decision: 'auto', specs: { weights: W } }];
ok(X.applyRejections(staged, rej) === 3, 'three rows touched');
ok(staged[0].decision === 'rejected' && staged[0].reason === 'rejected-by-you', 'own target rejected');
ok(staged[1].decision === 'pending' && staged[1].candidates.join() === 'storm-keep', 'family keeps the other candidate');
ok(staged[2].decision === 'rejected', 'family with only rejected candidates set aside');
ok(staged[3].decision === 'auto', 'others untouched');
ok(X.applyRejections(staged, new Set()) === 0, 'empty list is a no-op');
// 2. status file discovery
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rej-'));
fs.mkdirSync(path.join(dir, 'corrections')); fs.mkdirSync(path.join(dir, 'staging'));
fs.writeFileSync(path.join(dir, 'corrections', 'status.json'), JSON.stringify({ 'storm-gone': { status: 'retired', rejected: true, reason: 'not-made' }, 'storm-old': { status: 'retired', reason: 'manual' } }));
const sp = X.statusPathNear(path.join(dir, 'staging'));
ok(sp === path.join(dir, 'corrections', 'status.json'), 'status.json found beside staging');
const st = X.readStatusFile(sp);
ok(X.rejectedSet(st).has('storm-gone') && !X.rejectedSet(st).has('storm-old'), 'rejected set from file');
ok(Object.keys(X.readStatusFile(path.join(dir, 'nope.json'))).length === 0, 'missing file = empty');
// 3. publish
const rows = [{ url: 'u1', catalogId: 'storm-gone', decision: 'auto', specs: { weights: W } },
  { url: 'u4', catalogId: 'storm-keep', decision: 'auto', specs: { weights: W }, status: 'current' },
  { url: 'u5', catalogId: 'storm-old', decision: 'auto', specs: { weights: W }, status: 'current' },
  { url: 'u6', decision: 'pending', specs: { weights: W } }];
const out = P.publish(rows, [{ url: 'u6', catalogId: 'storm-gone', action: 'approve' }], {}, st);
ok(out.report.rejectedByYou === 2, 'auto row and approval for a rejected ball skipped');
ok(out.specs['storm-gone'] && out.specs['storm-gone'].Rejected === true && out.specs['storm-gone'].Status === 'retired', 'rejected ball published as status-only');
ok(Object.keys(out.specs['storm-gone'].SpecsByWeight).length === 0, 'no numbers for a rejected ball');
ok(out.specs['storm-old'].Status === 'retired' && Object.keys(out.specs['storm-old'].SpecsByWeight).length, 'manual discontinue overrides maker current, keeps specs');
ok(out.specs['storm-keep'].Status === 'current' && !out.specs['storm-keep'].Rejected, 'unlisted ball untouched');
ok(out.report.published === 2 && out.report.statusOnly === 1 && out.report.statusRetired === 2, 'report counts real entries apart from status-only');
ok(Object.keys(P.publish(rows, [], {}).specs).length === 3, 'no status file: old behaviour');
// 4. build_catalog flags
const usbc = ['storm-gone', 'storm-keep', 'storm-old'].map(id => ({ mfg: 'Storm', ballName: id.slice(6), approvalISO: '2024-01-01', approvalDateOK: true }));
const built = B.build(usbc, { 'storm-gone': out.specs['storm-gone'], 'storm-keep': out.specs['storm-keep'], 'storm-old': out.specs['storm-old'] }, 'test');
const ix = {}; built.index.forEach(r => { ix[r.i] = r; });
ok(ix['storm-gone'].x === 1 && ix['storm-gone'].r === 1 && !ix['storm-gone'].s, 'index: rejected = x 1, r 1, no specs dot');
ok(!ix['storm-keep'].x && ix['storm-keep'].r === 0, 'index: others carry no x');
ok(ix['storm-old'].r === 1 && ix['storm-old'].s === 1, 'index: manual discontinue r 1 with specs');
ok(built.review.missingSpecs.includes('storm-gone'), 'status-only entry still counts as missing specs');
// 5. approvals render
const body = A.render([{ url: 'u7', title: 'Gone', source: 'storm', decision: 'pending', reason: 'conflicting-sources', catalogId: 'storm-gone', specs: { weights: W } },
  { url: 'u8', title: 'Pair', source: 'storm', decision: 'pending', reason: 'variant', candidates: ['storm-gone', 'storm-keep'], specs: { weights: W } }], '', rej);
ok(!/storm-gone/.test(body), 'approvals issue never lists a rejected ball');
ok(/`storm-keep`/.test(body), 'family row keeps its other box');
console.log('rej_test: ' + n + ' checks passed');
