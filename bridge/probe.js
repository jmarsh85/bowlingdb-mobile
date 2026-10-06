#!/usr/bin/env node
/* Spec bridge, stage 0: source survey (probe).
   For each source: robots.txt -> sitemap(s) -> product-URL discovery rate
   against the published USBC index -> a few raw sample pages saved as
   parser fixtures. Read-only, throttled, robots-respecting. Never throws
   for one source failing; every outcome lands in probe/summary.json.

   node catalog/bridge/probe.js --index published/index.json --out probe [--since 2023]
*/
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
/* Same normalizer as the USBC ingest (catalog/normalize.js); inline fallback
   is the verbatim copy used by catalog.js so the probe also runs standalone. */
let norm = null;
try { norm = require('../normalize.js').norm; } catch (e) {}
if (typeof norm !== 'function') {
  const TR = [[/\u00b2/g,'2'],[/\u00b3/g,'3'],[/\u00b9/g,'1'],[/[\u221e\ua70f]/g,'eight'],[/\u03a0|\u03c0/g,'pi'],
              [/\u03a9/g,'omega'],[/\+/g,'plus'],[/&/g,'and'],[/\u2192|\u2190/g,'to']];
  norm = s => { if (s == null) return ''; let o = String(s); for (const [a, b] of TR) o = o.replace(a, b);
                return o.toLowerCase().replace(/\(all colors?\)/g, '').replace(/[^a-z0-9]/g, ''); };
}

/* ---------- pure helpers (unit-tested) ---------- */
function parseRobots(txt) {
  const out = { disallow: [], allow: [], sitemaps: [] };
  let applies = false, inAgents = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'sitemap') { out.sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!inAgents) applies = false;          // a new group starts
      inAgents = true;
      if (val === '*') applies = true;
      continue;
    }
    inAgents = false;
    if (!applies) continue;
    if (key === 'disallow' && val) out.disallow.push(val);
    if (key === 'allow' && val) out.allow.push(val);
  }
  return out;
}
function ruleMatch(rule, p) {
  const re = new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(p);
}
function allowed(robots, url) {
  const p = new URL(url).pathname + (new URL(url).search || '');
  let best = null;
  for (const r of robots.disallow) if (ruleMatch(r, p) && (!best || r.length > best.len)) best = { len: r.length, ok: false };
  for (const r of robots.allow)    if (ruleMatch(r, p) && (!best || r.length >= best.len)) best = { len: r.length, ok: true };
  return best ? best.ok : true;
}
function parseSitemap(xml) {
  const locs = [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  return { isIndex: /<sitemapindex/i.test(xml), locs };
}
function slugOf(url) {
  try { return norm(decodeURIComponent(new URL(url).pathname)); } catch (e) { return ''; }
}
/* Discovery rate: of the USBC names for these brands, how many appear in some URL slug. */
function discovery(rows, brands, urls) {
  const want = new Set(brands.map(b => norm(b)));
  const names = rows.filter(r => want.has(norm(r.m))).map(r => ({ i: r.i, n: r.n, key: norm(String(r.n).replace(/^\*+\s*/, '')) }))
                    .filter(x => x.key.length >= 3);
  const slugs = urls.map(u => ({ u, s: slugOf(u) }));
  const hits = [], misses = [];
  for (const x of names) {
    const h = slugs.find(o => o.s.includes(x.key));
    (h ? hits : misses).push(h ? { i: x.i, n: x.n, url: h.u } : { i: x.i, n: x.n });
  }
  return { total: names.length, found: hits.length, rate: names.length ? +(hits.length / names.length).toFixed(3) : null, hits, misses };
}

/* ---------- I/O ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function makeGetter(cfg, fetchImpl) {
  let last = 0;
  return async function get(url) {
    const wait = last + cfg.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const r = await fetchImpl(url, { headers: { 'User-Agent': cfg.userAgent }, redirect: 'follow' });
      let buf = Buffer.from(await r.arrayBuffer());
      if (/\.gz($|\?)/.test(url) && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      return { status: r.status, url: r.url || url, text: buf.toString('utf8') };
    } catch (e) { return { status: 0, url, text: '', error: String(e && e.message || e) }; }
  };
}

async function probeSource(src, cfg, rows, outDir, fetchImpl) {
  const get = makeGetter(cfg, fetchImpl);
  const res = { id: src.id, kind: src.kind, base: src.base, robots: null, sitemaps: [], urlCount: 0, discovery: null, samples: [], errors: [] };
  const rb = await get(src.base + '/robots.txt');
  const robots = rb.status === 200 ? parseRobots(rb.text) : { disallow: [], allow: [], sitemaps: [] };
  res.robots = { status: rb.status, disallow: robots.disallow, sitemaps: robots.sitemaps };
  const queue = robots.sitemaps.length ? robots.sitemaps.slice() : [src.base + '/sitemap.xml'];
  const urls = []; let fetched = 0;
  while (queue.length && fetched < 25) {
    const sm = queue.shift(); fetched++;
    if (!allowed(robots, sm)) { res.sitemaps.push({ url: sm, skipped: 'robots' }); continue; }
    const r = await get(sm);
    if (r.status !== 200) { res.sitemaps.push({ url: sm, status: r.status }); continue; }
    const p = parseSitemap(r.text);
    res.sitemaps.push({ url: sm, status: 200, index: p.isIndex, locs: p.locs.length });
    if (p.isIndex) queue.push(...p.locs); else urls.push(...p.locs);
  }
  const uniq = [...new Set(urls)];
  res.urlCount = uniq.length;
  fs.writeFileSync(path.join(outDir, src.id + '_urls.txt'), uniq.join('\n'));
  if (src.brands.length) {
    const d = discovery(rows, src.brands, uniq);
    res.discovery = { total: d.total, found: d.found, rate: d.rate, missesSample: d.misses.slice(0, 40).map(x => x.n) };
    if (src.kind === 'manufacturer') {
      const picks = d.hits.filter(h => allowed(robots, h.url)).slice(0, cfg.samplePages);
      for (const h of picks) {
        const r = await get(h.url);
        const file = src.id + '_' + h.i.replace(/[^a-z0-9-]/gi, '_').slice(0, 60) + '.html';
        if (r.status === 200) fs.writeFileSync(path.join(outDir, 'pages', file), r.text);
        res.samples.push({ catalogId: h.i, name: h.n, url: h.url, status: r.status, file: r.status === 200 ? file : null });
      }
    }
  }
  return res;
}

async function main(argv, fetchImpl) {
  const arg = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
  const cfg = JSON.parse(fs.readFileSync(arg('sources') || path.join(__dirname, 'sources.json'), 'utf8'));
  const since = +(arg('since') || 2023);
  const outDir = arg('out') || 'probe';
  fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });
  const all = JSON.parse(fs.readFileSync(arg('index'), 'utf8'));
  const recent = all.filter(r => +(r.y || 0) >= since);
  const only = arg('only');
  const summary = { generated: new Date().toISOString(), since, indexRows: all.length, recentRows: recent.length, sources: [] };
  for (const src of cfg.sources) {
    if (only && src.id !== only) continue;
    try { summary.sources.push(await probeSource(src, cfg, recent, outDir, fetchImpl)); }
    catch (e) { summary.sources.push({ id: src.id, fatal: String(e && e.message || e) }); }
    process.stdout.write(src.id + ': done\n');
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const lines = ['| source | robots | sitemap URLs | USBC ' + since + '+ found | rate | samples |', '|---|---|---|---|---|---|'];
  for (const s of summary.sources) {
    if (s.fatal) { lines.push(`| ${s.id} | FATAL ${s.fatal} | | | | |`); continue; }
    const d = s.discovery || {};
    lines.push(`| ${s.id} | ${s.robots.status} (${s.robots.disallow.length} rules) | ${s.urlCount} | ${d.found ?? '-'} / ${d.total ?? '-'} | ${d.rate ?? '-'} | ${s.samples.filter(x => x.file).length}/${s.samples.length} |`);
  }
  fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), '# Spec bridge probe\n\n' + lines.join('\n') + '\n');
  return summary;
}

module.exports = { parseRobots, allowed, parseSitemap, slugOf, discovery, main, probeSource };
if (require.main === module) main(process.argv.slice(2), globalThis.fetch).catch(e => { console.error(e); process.exit(1); });
