/* Fixtures mirror the real page structures seen on 2026-10-06 (values copied from those pages). */
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const X = require('./extract.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const CRAFT = `<html><head><meta property="og:image" content="https://cdn.example/combat_hybrid.png"></head><body>
<h1>Combat Hybrid</h1><p>Brunswick advances the Combat line...</p>
<h2>Core Numbers</h2><table><thead><tr><th></th><th><strong>16 lb</strong></th><th><strong>15 lb</strong></th><th><strong>14 lb</strong></th><th>13 lb</th><th>12 lb</th></tr></thead>
<tbody><tr><td><em>RG</em></td><td>2.515</td><td>2.502</td><td>2.513</td><td>2.597</td><td>2.593</td></tr>
<tr><td><em>DIFF</em></td><td>0.043</td><td>0.051</td><td>0.051</td><td>0.041</td><td>0.041</td></tr>
<tr><td><em>ASY</em></td><td>0.016</td><td>0.019</td><td>0.019</td><td>0.014</td><td>0.014</td></tr></tbody></table>
<table><tr><td>Level</td><td>Pro</td></tr><tr><td>Core</td><td>Rampart</td></tr><tr><td>Coverstock</td><td>Alpha Premier Hybrid</td></tr>
<tr><td>Cover Type</td><td>Hybrid Reactive</td></tr><tr><td>Finish</td><td>500, 2000 Siaair Micro Pad</td></tr>
<tr><td>Release Date</td><td>February 19, 2026</td></tr></table>
<h2>Performance Index:</h2><p><strong>REACTION SHAPE STRENGTH: 94</strong></p><h1>Watch the Combat Hybrid in Action!</h1></body></html>`;
const c = X.parseCraft(CRAFT, 'https://brunswickbowling.com/products/balls/current/combat-hybrid', 'Brunswick')[0];
ok(c.title === 'Combat Hybrid', 'craft title = first h1');
ok(c.specs.weights[15].RG === 2.502 && c.specs.weights[15].Diff === 0.051 && c.specs.weights[15].IntDiff === 0.019, 'craft 15 lb row');
ok(c.specs.weights[12].RG === 2.593, 'craft 12 lb row');
ok(c.specs.core === 'Rampart' && c.specs.coverName === 'Alpha Premier Hybrid' && c.specs.coverType === 'Hybrid Reactive', 'craft spec table');
ok(c.specs.released === '2026-02-19', 'craft release date ' + c.specs.released);
ok(c.mfgScales.brunswickStrength === 94 && c.imageUrl.includes('combat_hybrid'), 'craft scale + private image url');
ok(!JSON.stringify(c).includes('advances the Combat'), 'no marketing copy stored');

const SHOP_BODY = `<h3>Unbeatable Ball Motion!</h3><p>The original Anger introduced...</p><h3><strong>BALL SPECS</strong></h3><ul>
<li><strong>PERFORMANCE</strong> Mid</li><li><strong>CORE</strong> Modified Infamous</li><li><strong>COVERSTOCK</strong> Semtex Solid</li>
<li><strong>COVER TYPE</strong> Solid Reactive</li><li><strong>FINISH</strong> 500, 2000 Siaair Micro Pad&nbsp;</li>
<li><strong>RELEASE DATE</strong> July 10, 2025</li></ul><h3><strong>RG / DIFF</strong></h3><ul>
<li><strong>16 lb -</strong> <strong>RG</strong> (2.572) <strong>DIFF</strong> (0.041)</li>
<li><strong>15 lb -</strong> <strong>RG</strong> (2.567) <strong>DIFF</strong> (0.049)</li>
<li><strong>12 lb -</strong> <strong>RG</strong> (2.608) <strong>DIFF</strong> (0.040)</li></ul>`;
const h = X.parseShopifyBody(SHOP_BODY, 'Anger Solid', 'https://hammerbowling.com/products/anger-solid', 'Hammer', 'img')[0];
ok(h.specs.weights[16].RG === 2.572 && h.specs.weights[15].Diff === 0.049 && h.specs.weights[15].IntDiff === null, 'shopify weights');
ok(h.specs.core === 'Modified Infamous' && h.specs.coverName === 'Semtex Solid' && h.specs.coverType === 'Solid Reactive', 'shopify labels');
ok(h.specs.finish === '500, 2000 Siaair Micro Pad' && h.specs.released === '2025-07-10', 'shopify finish/date');
const asym = X.parseShopifyBody('<li><strong>15 lb -</strong> RG (2.48) DIFF (0.054) INT. DIFF (0.017)</li>', 'X', 'u', 'Hammer', null)[0];
ok(asym.specs.weights[15].IntDiff === 0.017, 'shopify int diff variant');

const MOTIV = `<html><head><meta property="og:image" content="https://m/apex.png"></head><body><h2>Item Number: MTVBJKAPX</h2><h1>Apex Jackal</h1><div>1/7/2026</div>
<p>The Apex Jackal isn't just an upgrade...</p><h2>Specifications</h2><table><tr><td>Length</td><td>73</td></tr><tr><td>Backend</td><td>87</td></tr><tr><td>Hook</td><td>78</td></tr><tr><td>Flare Potential</td><td>7"+</td></tr></table>
<table><tr><td>Weight Block</td><td>Apex Predator&trade;</td></tr><tr><td>Cover Stock</td><td>Propulsion&trade; MXV Pearl Reactive</td></tr><tr><td>Finish</td><td>5000 Grit LSS</td></tr></table>
<ul><li><h3>16</h3>Radius of Gyration 2.53<br>Max Differential .048<br>Int. Differential .017</li>
<li><h3>15</h3>Radius of Gyration 2.52<br>Max Differential .055<br>Int. Differential .020</li>
<li><h3>12</h3>Radius of Gyration 2.64<br>Max Differential .033<br>Int. Differential .014</li></ul></body></html>`;
const mo = X.parseMotiv(MOTIV, 'https://www.motivbowling.com/products/balls/heavy-oil/apex-jackal.html')[0];
ok(mo.title === 'Apex Jackal' && mo.specs.released === '2026-01-07', 'motiv title + date');
ok(mo.specs.weights[15].RG === 2.52 && mo.specs.weights[15].Diff === 0.055 && mo.specs.weights[15].IntDiff === 0.02, 'motiv 15 lb');
ok(mo.specs.weights[16].Diff === 0.048, 'motiv leading-dot numbers');
ok(/Apex Predator/.test(mo.specs.core) && /MXV Pearl/.test(mo.specs.coverName) && mo.specs.finish === '5000 Grit LSS', 'motiv kv');
ok(mo.mfgScales.motivLength === 73 && mo.mfgScales.motivHook === 78, 'motiv scales kept separately');

const STORM = `<ul><li><h2><a href="https://www.stormbowling.com/storm-hy-road-bowling-ball">HY-ROAD</a>SKU: BBMTTY</h2>
<p><strong>Brand:</strong> Storm</p><p><strong>Line:</strong> Thunder</p><p><strong>Weight Block:</strong> S_Inverted Fe2</p><p><strong>Finish:</strong> S_Power Edge</p>
<p><strong>Symmetry:</strong> S_Symmetrical</p><p><strong>Differential:</strong> 0.058</p><p><strong>Radius of Gyration:</strong> 2.52</p>
<p><strong>Weight:</strong> 16</p><p><strong>Coverstock:</strong> S_R2S Hybrid</p><p><strong>Release Date:</strong> 11/18/08</p><p><strong>PSA:</strong></p>
<p><strong>MatchMaker:</strong> 56</p></li>
<li><h2><a href="/storm-monsoon-bowling-ball">MONSOON</a>SKU: BBMVMN</h2><p><strong>Brand:</strong> Storm</p><p><strong>Weight Block:</strong> S_Atmos_AI</p>
<p><strong>Differential:</strong> 0.042</p><p><strong>Radius of Gyration:</strong> 2.53</p><p><strong>Weight:</strong> 16</p><p><strong>Coverstock:</strong> S_Reactor Solid</p>
<p><strong>Release Date:</strong> 05/01/26</p><p><strong>PSA:</strong> 0.2</p></li>
<li><h2><a href="/storm-iq-tour-sapphire-bowling-ball">!Q Tour Sapphire</a>SKU: BBMVQH</h2><p><strong>Brand:</strong> Roto Grip</p>
<p><strong>Differential:</strong> 0.035</p><p><strong>Radius of Gyration:</strong> 2.49</p><p><strong>Weight:</strong> 16</p></li>
<li><h2><a href="/x">TROPICAL SURGE BLACK-BLUE-PINK</a>SKU: BT1VKK</h2><p><strong>Brand:</strong> Storm</p></li></ul>`;
const st = X.parseStormListing(STORM, 'https://www.stormbowling.com');
ok(st.length === 3, 'storm: 3 balls with specs, empty item skipped');
const hy = st[0];
ok(hy.title === 'HY-ROAD' && hy.url.endsWith('storm-hy-road-bowling-ball') && hy.sku === 'BBMTTY', 'storm title/url/sku');
ok(hy.specs.weights[16].RG === 2.52 && hy.specs.weights[16].Diff === 0.058 && hy.specs.weights[16].IntDiff === null, 'storm weight-16 only');
ok(hy.specs.core === 'Inverted Fe2' && hy.specs.coverName === 'R2S Hybrid' && hy.specs.coreType === 'Symmetrical', 'storm S_ prefixes stripped');
ok(hy.specs.released === '2008-11-18' && hy.mfgScales.stormMatchMaker === 56, 'storm 2-digit year + matchmaker');
ok(st[1].url === 'https://www.stormbowling.com/storm-monsoon-bowling-ball', 'relative link resolved');

/* verify / match / decide */
const rows = [{ i: 'storm-hy-road', k: 'storm|hyroad', m: 'Storm', n: 'Hy-Road', y: '2008' },
  { i: 'storm-monsoon', k: 'storm|monsoon', m: 'Storm', n: 'Monsoon', y: '2026' },
  { i: 'roto-grip-iq-tour-sapphire', k: 'x', m: 'Roto Grip', n: 'IQ Tour Sapphire', y: '2026' },
  { i: 'hammer-anger-solid', k: 'x', m: 'Hammer', n: 'Anger Solid', y: '2025' },
  { i: 'hammer-bw3-ruby', k: 'x', m: 'Hammer', n: 'Black Widow 3.0 Ruby', y: '2025' },
  { i: 'hammer-bw3-plat', k: 'x', m: 'Hammer', n: 'Black Widow 3.0 Platinum', y: '2025' },
  { i: 'motiv-apex-jackal', k: 'x', m: 'Motiv', n: '(Apex) Jackal', y: '2026' },
  { i: 'track-inc-x', k: 'x', m: 'Track Inc.', n: 'X', y: '2026' }];
const by = X.indexByBrand(rows);
let m = X.matchRec(hy, by); ok(m.status === 'match' && m.catalogId === 'storm-hy-road', 'HY-ROAD -> Hy-Road');
ok(X.matchRec(st[2], by).catalogId === 'roto-grip-iq-tour-sapphire', '!Q -> IQ');
ok(X.matchRec(mo, by).catalogId === 'motiv-apex-jackal', '(Apex) Jackal -> Apex Jackal');
m = X.matchRec({ title: 'Black Widow 3.0', brand: 'Hammer' }, by);
ok(m.status === 'variant' && m.candidates.length === 2, 'colourway family -> variant, pending');
ok(X.matchRec({ title: 'X', brand: 'Track' }, by).status === 'match', 'site brand Track -> Track Inc.');
const mon = st[1]; const fl = X.verify(mon);
ok(fl.some(f => f.startsWith('out-of-range')) && mon.specs.weights[16].IntDiff === null, 'PSA 0.2 rejected by gate, value nulled');
ok(X.decide(mon, X.matchRec(mon, by), fl).decision === 'pending', 'out-of-range -> pending');
ok(X.decide(hy, X.matchRec(hy, by), X.verify(hy)).decision === 'auto', 'clean exact -> auto');
const bad = { specs: { weights: {}, released: '3024-09-03' } }; X.verify(bad); ok(bad.specs.released === null, 'source typo date dropped');
const dup = [{ decision: 'auto', catalogId: 'a', specs: { weights: { 15: { RG: 2.5 } } } }, { decision: 'auto', catalogId: 'a', specs: { weights: { 15: { RG: 2.6 } } } }];
X.resolveConflicts(dup); ok(dup.every(d => d.decision === 'pending'), 'two sources disagree -> both pending');
const same = [{ decision: 'auto', catalogId: 'a', specs: { weights: { 15: { RG: 2.5 } } } }, { decision: 'auto', catalogId: 'a', specs: { weights: { 15: { RG: 2.5 } } } }];
X.resolveConflicts(same); ok(same[0].decision === 'auto' && same[1].decision === 'duplicate', 'agreeing duplicate collapsed');

/* end-to-end with mocked sites */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
  fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify(rows));
  fs.writeFileSync(path.join(tmp, 'src.json'), JSON.stringify({ userAgent: 't', delayMs: 0, sources: [
    { id: 'storm', kind: 'manufacturer', base: 'https://s.com' }, { id: 'hammer', kind: 'manufacturer', base: 'https://h.com' },
    { id: 'brunswick', kind: 'manufacturer', base: 'https://b.com' }, { id: 'motiv', kind: 'manufacturer', base: 'https://m.com' },
    { id: 'bowwwl', kind: 'aggregator', base: 'https://agg.com' }] }));
  const pages = {
    'https://s.com/robots.txt': 'User-agent: *\nDisallow: /ajax', 'https://s.com/products/equipment/bowling-balls/': STORM,
    'https://h.com/robots.txt': 'Sitemap: https://h.com/sitemap.xml', 'https://h.com/sitemap.xml': '<urlset><url><loc>https://h.com/products/anger-solid</loc></url><url><loc>https://h.com/products/towel</loc></url></urlset>',
    'https://h.com/products/anger-solid.json': JSON.stringify({ product: { title: 'Anger Solid', body_html: SHOP_BODY, image: { src: 'img' } } }),
    'https://h.com/products/towel.json': JSON.stringify({ product: { title: 'Towel', body_html: '<p>Soft towel</p>' } }),
    'https://b.com/robots.txt': 'Sitemap: https://b.com/sm.xml', 'https://b.com/sm.xml': '<urlset><url><loc>https://b.com/products/balls/current/combat-hybrid</loc></url><url><loc>https://b.com/products/bags/x</loc></url></urlset>',
    'https://b.com/products/balls/current/combat-hybrid': CRAFT,
    'https://m.com/robots.txt': '', 'https://m.com/sitemap.xml': '<urlset><url><loc>https://m.com/products/balls/heavy-oil/apex-jackal.html</loc></url></urlset>',
    'https://m.com/products/balls/heavy-oil/apex-jackal.html': MOTIV };
  const seen = [];
  const mock = async u => { seen.push(u); const t = pages[u]; return { status: t == null ? 404 : 200, text: async () => t || '' }; };
  const res = await X.main(['--index', path.join(tmp, 'index.json'), '--out', path.join(tmp, 'st'), '--sources', path.join(tmp, 'src.json')], mock, () => {});
  ok(!seen.some(u => u.includes('agg.com')), 'aggregator never fetched');
  ok(!seen.some(u => u.includes('/bags/')), 'non-ball craft pages skipped');
  const titles = res.staged.map(s => s.title);
  ok(titles.includes('Anger Solid') && titles.includes('Combat Hybrid') && titles.includes('Apex Jackal') && titles.includes('HY-ROAD'), 'all four platforms staged: ' + titles);
  ok(!titles.includes('Towel'), 'non-ball shopify product dropped');
  const auto = res.staged.filter(s => s.decision === 'auto').map(s => s.catalogId).sort();
  ok(auto.includes('hammer-anger-solid') && auto.includes('motiv-apex-jackal') && auto.includes('storm-hy-road'), 'auto set ' + auto);
  ok(res.staged.find(s => s.title === 'Combat Hybrid').reason === 'no-usbc', 'no USBC row -> pending no-usbc');
  ok(res.coverage['Hammer'].auto === 1 && res.coverage['Hammer'].all === 3, 'coverage per brand');
  const md = fs.readFileSync(path.join(tmp, 'st', 'SUMMARY.md'), 'utf8');
  ok(/auto\*\*/.test(md) && /Pending reasons:/.test(md), 'summary written');
  ok(!fs.readFileSync(path.join(tmp, 'st', 'specs_staging.json'), 'utf8').includes('Unbeatable'), 'no marketing text in staging');
  console.log('extract_test: ' + n + ' checks passed');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
