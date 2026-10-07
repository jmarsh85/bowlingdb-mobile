#!/usr/bin/env node
/* Spec bridge, stages 1-5 (discover -> extract -> match -> verify -> decide).
   STAGING ONLY: writes staging/ to the `specs` branch. Nothing here touches
   dist; publishing waits for the approval page (D8 b).

   Four site platforms, found by the probe (2026-10-06):
     storm   commercebuild listing pages carry full spec blocks (Storm, Roto Grip, 900 Global)
     craft   Brunswick, DV8, Radical: /products/balls/{current,retired}/<slug>, per-weight table
     shopify Hammer, Track, Ebonite, Columbia 300: /products/<slug>.json body_html
     motiv   /products/balls/<category>/<slug>.html, per-weight blocks
   Facts only. Marketing copy is never stored. Manufacturer performance scales
   (Brunswick strength, Motiv length/backend/hook, Storm MatchMaker) are kept in
   `mfgScales` for MET calibration only and are never published. Image URLs
   are kept private (`imageUrl`) and never published without permission.

   node bridge/extract.js --index published/index.json --out staging [--only storm] [--limit 20]
*/
'use strict';
const fs = require('fs'), path = require('path');
const { parseRobots, allowed, parseSitemap } = require('./probe.js');

/* ---------- normalizer (same as catalog/normalize.js modelKey path) ---------- */
const TR = [[/\u00b2/g,'2'],[/\u00b3/g,'3'],[/\u00b9/g,'1'],[/[\u221e\ua70f]/g,'eight'],[/\u03a0|\u03c0/g,'pi'],
            [/\u03a9/g,'omega'],[/\+/g,'plus'],[/&/g,'and'],[/\u2192|\u2190/g,'to']];
function norm(s) { if (s == null) return ''; let o = String(s); for (const [a, b] of TR) o = o.replace(a, b);
  return o.toLowerCase().replace(/\(all colors?\)/g, '').replace(/[^a-z0-9]/g, ''); }
const BRAND_KEYS = { storm: 'Storm', rotogrip: 'Roto Grip', '900global': '900 Global', brunswick: 'Brunswick', hammer: 'Hammer',
  dv8: 'DV8', radical: 'Radical', track: 'Track Inc.', trackinc: 'Track Inc.', ebonite: 'Ebonite', columbia: 'Columbia 300',
  columbia300: 'Columbia 300', motiv: 'Motiv' };
const canonBrand = b => BRAND_KEYS[norm(b)] || String(b || '').trim();
/* site titles -> USBC spelling quirks */
function titleKey(t) {
  let s = String(t || '').trim().replace(/\s*[\u2013|-]\s*(hammer ?bowling|brunswick bowling|motiv bowling).*$/i, '');
  s = s.replace(/^!/, 'i').replace(/\bbowling ball\b/i, '');
  return norm(s);
}

/* ---------- html -> text (tables become "a | b | c" lines) ---------- */
function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&[a-z]+;/gi, ' ');
}
function htmlToText(html) {
  let s = String(html || '').replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\s*(td|th)[^>]*>/gi, ' | ').replace(/<\s*br\s*\/?>/gi, '\n')
       .replace(/<\/\s*(p|div|li|h[1-6]|tr|table|ul|ol|section|article|dd|dt)\s*>/gi, '\n').replace(/<\s*(li|h[1-6]|tr|p)[^>]*>/gi, '\n');
  s = decode(s.replace(/<[^>]+>/g, ' '));
  return s.split('\n').map(l => l.replace(/\s+/g, ' ').trim().replace(/^\|\s*/, '').replace(/\s*\|$/, '')).filter(Boolean).join('\n');
}
function firstH1(html) { const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html || ''); return m ? decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null; }
function metaContent(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop.replace(/[:.]/g, '\\$&') + '["\'][^>]*content=["\']([^"\']+)', 'i');
  const m = re.exec(html || ''); return m ? decode(m[1]) : null;
}
const num = v => { if (v == null) return null; const n = parseFloat(String(v).replace(/^\./, '0.')); return isFinite(n) ? n : null; };

/* "Key | Value" two-cell lines -> map (lower-case keys) */
function kvLines(text) {
  const m = {};
  for (const l of text.split('\n')) { const c = l.split(' | ').map(x => x.trim()); if (c.length === 2 && c[0] && c[1] && c[0].length < 30) m[c[0].toLowerCase()] = c[1]; }
  return m;
}
/* Per-weight table: header "16 lb | 15 lb | ..." then "RG | ..", "DIFF | ..", "ASY|INT|MB | .." */
function weightTable(text) {
  const lines = text.split('\n'), out = {};
  for (let i = 0; i < lines.length; i++) {
    const ws = [...lines[i].matchAll(/\b(1[0-6])\s*(?:lb|lbs|#|pounds?)\b/gi)].map(m => +m[1]);
    if (ws.length < 2) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const c = lines[j].split(' | ').map(x => x.trim()); const key = (c[0] || '').toLowerCase().replace(/[^a-z]/g, '');
      const field = key === 'rg' ? 'RG' : /^(diff|totaldiff|differential)$/.test(key) ? 'Diff' : /^(asy|asym|int|intdiff|mb|mbdiff|massbias|psa)$/.test(key) ? 'IntDiff' : null;
      if (!field) continue;
      const vals = c.slice(1);
      ws.forEach((w, k) => { const v = num(vals[k]); if (v != null) (out[w] = out[w] || {})[field] = v; });
    }
    if (Object.keys(out).length) return out;
  }
  return out;
}
function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return m[0];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) { let y = +m[3]; if (y < 100) y += y <= (new Date().getFullYear() % 100) + 1 ? 2000 : 1900; return y + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0'); }
  const d = new Date(t + ' UTC'); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

/* ---------- platform parsers: html -> [{title, brand, url, specs, mfgScales, imageUrl}] ---------- */
function parseCraft(html, url, brand) {
  const text = htmlToText(html), kv = kvLines(text);
  const title = firstH1(html);
  const scales = {};
  const rs = /reaction shape strength:?\s*(\d{1,3})/i.exec(text); if (rs) scales.brunswickStrength = +rs[1];
  const lvl = /^level \| (.+)$/im.exec(text); if (lvl) scales.level = lvl[1];
  return [{ title, brand, url, imageUrl: metaContent(html, 'og:image'), mfgScales: scales,
    specs: { core: kv['core'] || null, coverName: kv['coverstock'] || null, coverType: kv['cover type'] || null,
             finish: kv['finish'] || null, released: parseDate(kv['release date']), weights: weightTable(text) } }];
}
function parseShopifyBody(bodyHtml, title, url, brand, imageUrl) {
  const text = htmlToText(bodyHtml);
  const lab = re => { const m = re.exec(text); return m ? m[1].trim() : null; };
  const weights = {};
  const re = /\b(1[0-6])\s*lbs?\s*[-\u2013:]?\s*RG\s*\(?\s*([\d.]+)\s*\)?\s*(?:TOTAL\s*)?DIFF\.?\s*\(?\s*([\d.]+)\s*\)?(?:\s*(?:INT\.?\s*DIFF\.?|MB\s*DIFF|MASS BIAS(?:\s*DIFF)?|ASYM?|PSA)\s*\(?\s*([\d.]+)\s*\)?)?/gi;
  let m; while ((m = re.exec(text))) weights[+m[1]] = { RG: num(m[2]), Diff: num(m[3]), IntDiff: num(m[4]) };
  if (!Object.keys(weights).length) Object.assign(weights, weightTable(text));
  return [{ title, brand, url, imageUrl, mfgScales: {},
    specs: { core: lab(/^CORE:?\s+(.+)$/im), coverName: lab(/^COVERSTOCK:?\s+(.+)$/im), coverType: lab(/^COVER TYPE:?\s+(.+)$/im),
             finish: lab(/^FINISH:?\s+(.+)$/im), released: parseDate(lab(/^RELEASE DATE:?\s+(.+)$/im)), weights } }];
}
function parseMotiv(html, url) {
  const text = htmlToText(html), kv = kvLines(text), flat = text.replace(/\n/g, ' ');
  const title = firstH1(html);
  const weights = {};
  const re = /\b(1[0-6])\s*Radius of Gyration\s*([\d.]+)\s*Max(?:imum)?\.?\s*Differential\s*([\d.]+)(?:\s*Int(?:ermediate)?\.?\s*Differential\s*([\d.]+))?/gi;
  let m; while ((m = re.exec(flat))) weights[+m[1]] = { RG: num(m[2]), Diff: num(m[3]), IntDiff: num(m[4]) };
  let released = null;
  if (title) { const i = text.indexOf(title); const after = i >= 0 ? text.slice(i + title.length, i + title.length + 60) : '';
    const d = /^\s*(\d{1,2}\/\d{1,2}\/\d{4})/.exec(after); if (d) released = parseDate(d[1]); }
  const scales = {}; ['length', 'backend', 'hook'].forEach(k => { if (kv[k] && /^\d+$/.test(kv[k])) scales['motiv' + k[0].toUpperCase() + k.slice(1)] = +kv[k]; });
  return [{ title, brand: 'Motiv', url, imageUrl: metaContent(html, 'og:image'), mfgScales: scales,
    specs: { core: kv['weight block'] || null, coverName: kv['cover stock'] || kv['coverstock'] || null, coverType: null,
             finish: kv['finish'] || null, released, weights } }];
}
/* Storm listing page: many balls per page, one weight each */
function parseStormListing(html, base) {
  const links = [...String(html).matchAll(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ url: m[1].startsWith('http') ? m[1] : base + m[1], title: decode(m[2].replace(/<[^>]+>/g, '')).trim() }));
  const text = htmlToText(html), items = []; let cur = null;
  const clean = v => v == null ? null : String(v).replace(/^S_/, '').replace(/_/g, ' ').trim() || null;
  for (const l of text.split('\n')) {
    const h = /^(.+?)\s*SKU:\s*(\S+)$/.exec(l);
    if (h) { cur = { title: h[1].trim(), sku: h[2], f: {} }; items.push(cur); continue; }
    const kv = /^([A-Za-z.' ]{2,30}):\s*(.*)$/.exec(l);
    if (cur && kv) cur.f[kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  return items.filter(it => it.f['radius of gyration'] || it.f['differential']).map(it => {
    const f = it.f, w = num(f['weight']), link = links.find(x => x.title === it.title);
    const weights = {}; if (w) weights[w] = { RG: num(f['radius of gyration']), Diff: num(f['differential']), IntDiff: num(f['psa']) };
    const scales = {}; if (f['matchmaker'] && /^\d+$/.test(f['matchmaker'])) scales.stormMatchMaker = +f['matchmaker'];
    return { title: it.title, brand: f['brand'] || 'Storm', url: link ? link.url : null, sku: it.sku, imageUrl: null, mfgScales: scales,
      specs: { core: clean(f['weight block']), coverName: clean(f['coverstock']), coverType: null, finish: clean(f['finish']),
               coreType: clean(f['symmetry']), released: parseDate(f['release date']), weights } };
  });
}

/* ---------- match + verify + decide (pure) ---------- */
const GATES = { RG: [2.40, 2.85], Diff: [0, 0.080], IntDiff: [0, 0.040] };
function verify(rec) {
  const flags = [];
  const ws = rec.specs.weights || {};
  if (!Object.keys(ws).length) flags.push('no-weight-specs');
  for (const w in ws) for (const k in GATES) {
    const v = ws[w][k]; if (v == null) continue;
    if (v < GATES[k][0] || v > GATES[k][1]) { flags.push('out-of-range:' + w + ':' + k + '=' + v); ws[w][k] = null; }
  }
  const r = rec.specs.released;
  if (r && (r < '1990-01-01' || r > (new Date().getFullYear() + 1) + '-12-31')) { flags.push('bad-date:' + r); rec.specs.released = null; }
  return flags;
}
function indexByBrand(rows) {
  const by = {};
  for (const r of rows) { const b = canonBrand(r.m); (by[b] = by[b] || []).push(Object.assign({}, r, { _t: titleKey(String(r.n).replace(/^\*+\s*/, '')) })); }
  return by;
}
function matchRec(rec, byBrand) {
  const pool = byBrand[canonBrand(rec.brand)] || [], t = titleKey(rec.title);
  if (!t) return { status: 'no-title', candidates: [] };
  const exact = pool.filter(r => r._t === t);
  if (exact.length === 1) return { status: 'match', catalogId: exact[0].i, candidates: [exact[0].i] };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.map(r => r.i) };
  const variants = pool.filter(r => r._t.startsWith(t) && r._t.length > t.length).slice(0, 12);
  return { status: variants.length ? 'variant' : 'no-usbc', candidates: variants.map(r => r.i) };
}
function decide(rec, match, flags) {
  if (match.status !== 'match') return { decision: 'pending', reason: match.status };
  if (flags.some(f => f === 'no-weight-specs' || f.startsWith('out-of-range'))) return { decision: 'pending', reason: flags[0] };
  return { decision: 'auto', reason: 'exact-match+gates' };
}
/* multiple pages can claim one CatalogID (e.g. a slug shared by two names): keep auto only if they agree */
function resolveConflicts(staged) {
  const by = {};
  staged.filter(s => s.decision === 'auto').forEach(s => (by[s.catalogId] = by[s.catalogId] || []).push(s));
  for (const id in by) if (by[id].length > 1) {
    const sig = s => JSON.stringify(s.specs.weights);
    if (new Set(by[id].map(sig)).size > 1) by[id].forEach(s => { s.decision = 'pending'; s.reason = 'conflicting-sources'; });
    else by[id].slice(1).forEach(s => { s.decision = 'duplicate'; s.reason = 'same-values-as-other-source'; });
  }
}
function coverage(rows, staged, since) {
  const got = {}; staged.forEach(s => { if (s.decision === 'auto') got[s.catalogId] = 'auto'; else (s.candidates || []).forEach(id => { if (!got[id]) got[id] = 'pending'; }); });
  const out = {};
  for (const r of rows) {
    const b = canonBrand(r.m); if (!['Storm','Roto Grip','900 Global','Brunswick','Hammer','DV8','Radical','Track Inc.','Ebonite','Columbia 300','Motiv'].includes(b)) continue;
    const o = out[b] = out[b] || { all: 0, auto: 0, pending: 0, recent: 0, recentAuto: 0 };
    o.all++; if (got[r.i] === 'auto') o.auto++; else if (got[r.i] === 'pending') o.pending++;
    if (+(r.y || 0) >= since) { o.recent++; if (got[r.i] === 'auto') o.recentAuto++; }
  }
  return out;
}

/* ---------- I/O ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getter(cfg, fetchImpl) {
  let last = 0;
  return async url => {
    const wait = last + cfg.delayMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
    try { const r = await fetchImpl(url, { headers: { 'User-Agent': cfg.userAgent }, redirect: 'follow' });
          return { status: r.status, text: await r.text() }; }
    catch (e) { return { status: 0, text: '', error: String(e && e.message || e) }; }
  };
}
async function sitemapUrls(get, robots, start) {
  const q = start.slice(), urls = []; let n = 0;
  while (q.length && n < 40) { const sm = q.shift(); n++; if (!allowed(robots, sm)) continue;
    const r = await get(sm); if (r.status !== 200) continue; const p = parseSitemap(r.text);
    if (p.isIndex) q.push(...p.locs.filter(u => !/blog|center|gallery|apparel|bowlers-1|pages_|collections_/i.test(u))); else urls.push(...p.locs); }
  return [...new Set(urls)];
}
const PLATFORM = { storm: 'storm', brunswick: 'craft', dv8: 'craft', radical: 'craft', hammer: 'shopify', track: 'shopify', ebonite: 'shopify', columbia: 'shopify', motiv: 'motiv' };
const SITE_BRAND = { brunswick: 'Brunswick', dv8: 'DV8', radical: 'Radical', hammer: 'Hammer', track: 'Track Inc.', ebonite: 'Ebonite', columbia: 'Columbia 300', motiv: 'Motiv' };

async function extractSource(src, cfg, fetchImpl, limit, log) {
  const get = getter(cfg, fetchImpl), plat = PLATFORM[src.id], recs = [], errors = [];
  const rb = await get(src.base + '/robots.txt'); const robots = rb.status === 200 ? parseRobots(rb.text) : parseRobots('');
  const host = new URL(src.base).host.replace(/^www\./, '');
  if (plat === 'storm') {
    for (let p = 1; p <= 30; p++) {
      const u = src.base + '/products/equipment/bowling-balls/' + (p === 1 ? '' : '24/1/' + p + '/');
      if (!allowed(robots, u)) break;
      const r = await get(u); if (r.status !== 200) { errors.push(u + ' ' + r.status); break; }
      const items = parseStormListing(r.text, src.base); if (!items.length) break;
      recs.push(...items); if (limit && recs.length >= limit) break;
    }
    return { recs, errors, pages: recs.length };
  }
  const smStart = robots.sitemaps.length ? robots.sitemaps : [src.base + '/sitemap.xml'];
  let urls = await sitemapUrls(get, robots, smStart);
  if (plat === 'craft') urls = urls.filter(u => /\/products\/balls\/(current|retired)\/[^/]+$/.test(u));
  if (plat === 'motiv') urls = urls.filter(u => /\/products\/balls\/[^/]+\/[^/]+\.html$/.test(u));
  if (plat === 'shopify') urls = urls.filter(u => new URL(u).host.replace(/^www\./, '') === host && /\/products\/[^/]+$/.test(u));
  if (limit) urls = urls.slice(0, limit);
  let pages = 0;
  for (const u of urls) {
    if (!allowed(robots, u)) continue;
    try {
      if (plat === 'shopify') {
        const r = await get(u + '.json'); pages++;
        if (r.status !== 200) { errors.push(u + '.json ' + r.status); continue; }
        const p = JSON.parse(r.text).product || {};
        const img = (p.image && p.image.src) || null;
        recs.push(...parseShopifyBody(p.body_html || '', p.title, u, SITE_BRAND[src.id], img));
      } else {
        const r = await get(u); pages++;
        if (r.status !== 200) { errors.push(u + ' ' + r.status); continue; }
        recs.push(...(plat === 'craft' ? parseCraft(r.text, u, SITE_BRAND[src.id]) : parseMotiv(r.text, u)));
      }
    } catch (e) { errors.push(u + ' ' + (e.message || e)); }
  }
  log(src.id + ': ' + urls.length + ' candidate urls, ' + pages + ' fetched');
  return { recs, errors, pages };
}

async function main(argv, fetchImpl, log = s => process.stdout.write(s + '\n')) {
  const arg = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
  const cfg = JSON.parse(fs.readFileSync(arg('sources') || path.join(__dirname, 'sources.json'), 'utf8'));
  const rows = JSON.parse(fs.readFileSync(arg('index'), 'utf8'));
  const out = arg('out') || 'staging', only = arg('only'), limit = +(arg('limit') || 0), since = +(arg('since') || 2023);
  fs.mkdirSync(out, { recursive: true });
  const byBrand = indexByBrand(rows);
  const sources = cfg.sources.filter(s => s.kind === 'manufacturer' && PLATFORM[s.id] && (!only || s.id === only));
  const runs = await Promise.all(sources.map(s => extractSource(s, cfg, fetchImpl, limit, log).catch(e => ({ recs: [], errors: [String(e)], pages: 0 }))));
  const fetched = new Date().toISOString().slice(0, 10), staged = [], perSource = {};
  sources.forEach((s, i) => {
    const r = runs[i]; let parsed = 0;
    for (const rec of r.recs) {
      const hasSpecs = rec.specs && (Object.keys(rec.specs.weights || {}).length || rec.specs.core || rec.specs.coverName);
      if (!hasSpecs) continue;             // not a ball page (bags, shoes, accessories)
      parsed++;
      const flags = verify(rec), m = matchRec(rec, byBrand), d = decide(rec, m, flags);
      staged.push({ source: s.id, platform: PLATFORM[s.id], brand: canonBrand(rec.brand), title: rec.title, url: rec.url, sku: rec.sku || null,
        catalogId: m.catalogId || null, match: m.status, candidates: m.candidates, decision: d.decision, reason: d.reason, flags,
        specs: rec.specs, mfgScales: rec.mfgScales, imageUrl: rec.imageUrl, fetched, method: 'parser' });
    }
    perSource[s.id] = { pages: r.pages, parsed, errors: r.errors.length, errorSample: r.errors.slice(0, 10) };
  });
  resolveConflicts(staged);
  staged.sort((a, b) => (a.brand + a.title).localeCompare(b.brand + b.title));
  const cov = coverage(rows, staged, since);
  fs.writeFileSync(path.join(out, 'specs_staging.json'), JSON.stringify(staged, null, 1));
  fs.writeFileSync(path.join(out, 'coverage.json'), JSON.stringify({ generated: new Date().toISOString(), since, perSource, coverage: cov }, null, 2));
  const count = k => staged.filter(s => s.decision === k).length;
  const L = ['# Spec bridge extract', '', 'Staged ' + staged.length + ' ball pages: **' + count('auto') + ' auto**, ' + count('pending') + ' pending, ' + count('duplicate') + ' duplicate.', '',
    '| source | pages | ball pages | auto | pending | errors |', '|---|---|---|---|---|---|'];
  for (const s of sources) { const p = perSource[s.id]; const st = staged.filter(x => x.source === s.id);
    L.push(`| ${s.id} | ${p.pages} | ${p.parsed} | ${st.filter(x => x.decision === 'auto').length} | ${st.filter(x => x.decision === 'pending').length} | ${p.errors} |`); }
  L.push('', '| brand | USBC rows | specs (auto) | pending | ' + since + '+ rows | ' + since + '+ auto |', '|---|---|---|---|---|---|');
  for (const b in cov) { const c = cov[b]; L.push(`| ${b} | ${c.all} | ${c.auto} | ${c.pending} | ${c.recent} | ${c.recentAuto} |`); }
  const reasons = {}; staged.filter(s => s.decision === 'pending').forEach(s => { reasons[s.reason] = (reasons[s.reason] || 0) + 1; });
  L.push('', 'Pending reasons: ' + (Object.entries(reasons).map(([k, v]) => k + ' ' + v).join(', ') || 'none'));
  fs.writeFileSync(path.join(out, 'SUMMARY.md'), L.join('\n') + '\n');
  return { staged, coverage: cov, perSource };
}

module.exports = { htmlToText, weightTable, kvLines, parseDate, parseCraft, parseShopifyBody, parseMotiv, parseStormListing,
  verify, matchRec, decide, resolveConflicts, coverage, indexByBrand, titleKey, norm, main };
if (require.main === module) main(process.argv.slice(2), globalThis.fetch).catch(e => { console.error(e); process.exit(1); });
