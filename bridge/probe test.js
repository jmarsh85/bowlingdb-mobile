'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const P = require('./probe.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// robots
const rb = P.parseRobots(`User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /cart\nDisallow: /search?*\nAllow: /cart/public\nSitemap: https://x.com/sm.xml\n\nUser-agent: Bing\nUser-agent: *\nDisallow: /tmp`);
ok(rb.sitemaps[0] === 'https://x.com/sm.xml', 'sitemap line');
ok(rb.disallow.includes('/cart') && rb.disallow.includes('/tmp'), 'star groups collected');
ok(!rb.disallow.includes('/'), 'googlebot-only rule ignored');
ok(!P.allowed(rb, 'https://x.com/cart/abc'), 'disallowed');
ok(P.allowed(rb, 'https://x.com/cart/public/1'), 'longer allow wins');
ok(!P.allowed(rb, 'https://x.com/search?q=1'), 'wildcard');
ok(P.allowed(rb, 'https://x.com/products/phaze-ii'), 'default allow');

// sitemap
const si = P.parseSitemap('<sitemapindex><sitemap><loc>https://x.com/a.xml</loc></sitemap></sitemapindex>');
ok(si.isIndex && si.locs[0] === 'https://x.com/a.xml', 'sitemap index');
const us = P.parseSitemap('<urlset><url><loc> https://x.com/p/phaze-ii-pearl?a=1&amp;b=2 </loc></url></urlset>');
ok(!us.isIndex && us.locs[0] === 'https://x.com/p/phaze-ii-pearl?a=1&b=2', 'urlset + entity');

// discovery
const rows = [{ i: 'storm-phaze-ii', m: 'Storm', n: 'Phaze II', y: '2024' }, { i: 'storm-ion-pro', m: 'Storm', n: 'ION Pro', y: '2024' },
              { i: 'rotogrip-perfect-gem', m: 'Roto Grip', n: 'Perfect Gem', y: '2026' }, { i: 'motiv-x', m: 'Motiv', n: 'Jackal', y: '2025' }];
const d = P.discovery(rows, ['Storm', 'Roto Grip'], ['https://s.com/phaze-ii-bbmphz2', 'https://s.com/perfect-gem-rg1']);
ok(d.total === 3 && d.found === 2 && d.rate === 0.667, 'discovery rate ' + JSON.stringify([d.total, d.found, d.rate]));
ok(d.misses[0].n === 'ION Pro', 'miss listed');

// end-to-end with mock fetch
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify(rows));
  fs.writeFileSync(path.join(tmp, 'src.json'), JSON.stringify({ userAgent: 't', delayMs: 0, samplePages: 2,
    sources: [{ id: 's', kind: 'manufacturer', base: 'https://s.com', brands: ['Storm', 'Roto Grip'] },
              { id: 'agg', kind: 'aggregator', base: 'https://a.com', brands: [] },
              { id: 'down', kind: 'manufacturer', base: 'https://down.com', brands: ['Motiv'] }] }));
  const pages = {
    'https://s.com/robots.txt': 'User-agent: *\nDisallow: /perfect\nSitemap: https://s.com/si.xml',
    'https://s.com/si.xml': '<sitemapindex><sitemap><loc>https://s.com/p.xml</loc></sitemap></sitemapindex>',
    'https://s.com/p.xml': '<urlset><url><loc>https://s.com/phaze-ii-bbmphz2</loc></url><url><loc>https://s.com/perfect-gem-rg1</loc></url></urlset>',
    'https://s.com/phaze-ii-bbmphz2': '<html>RG 2.48</html>',
    'https://a.com/robots.txt': 'User-agent: *\nDisallow:',
  };
  const fetched = [];
  const mock = async (u) => {
    fetched.push(u);
    if (u.startsWith('https://down.com')) throw new Error('ENOTFOUND');
    const t = pages[u];
    return { status: t == null ? 404 : 200, url: u, arrayBuffer: async () => Buffer.from(t || '') };
  };
  const sum = await P.main(['--index', path.join(tmp, 'index.json'), '--out', path.join(tmp, 'out'), '--sources', path.join(tmp, 'src.json'), '--since', '2023'], mock);
  const s = sum.sources.find(x => x.id === 's');
  ok(s.urlCount === 2 && s.discovery.found === 2, 'nested sitemap discovered');
  ok(s.samples.length === 1 && s.samples[0].file, 'robots-disallowed sample skipped, allowed saved');
  ok(!fetched.includes('https://s.com/perfect-gem-rg1'), 'never fetched a disallowed page');
  ok(fs.existsSync(path.join(tmp, 'out', 'pages', s.samples[0].file)), 'fixture written');
  const a = sum.sources.find(x => x.id === 'agg');
  ok(a.samples.length === 0 && !fetched.some(u => u.startsWith('https://a.com/') && !/robots|sitemap/.test(u)), 'aggregator: no page fetches');
  const dn = sum.sources.find(x => x.id === 'down');
  ok(dn.robots.status === 0 && dn.urlCount === 0, 'dead source recorded, run continues');
  ok(/\| s \| 200/.test(fs.readFileSync(path.join(tmp, 'out', 'SUMMARY.md'), 'utf8')), 'summary table');
  console.log('probe_test: ' + n + ' checks passed');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
