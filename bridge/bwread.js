#!/usr/bin/env node
/* v30.213 BW-1: read ONE bowwwl ball page when James taps "Read bowwwl" in the app.
   Not a crawler: the workflow takes one address per run, from the app, and only a
   bowwwl ball-database page. What it read is encrypted with the public key the app
   sent (RSA-OAEP 2048 + AES-256-GCM), so the copy that passes through this public
   repo (branch `inbox`) is unreadable; only James's phone holds the private key.
   Nothing here is published to dist or written to the specs branch.

   node bwread.js --url <page> --key <spki base64> --nonce <id> --out <file>
   node bwread.js --test        (fixtures only, no network) */
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const URL_OK = /^https:\/\/www\.bowwwl\.com\/bowling-ball-database\/[a-z0-9-]+\/[a-z0-9-]+$/;

/* ---------- pure: page HTML -> text lines (one block per line) ---------- */
function decode(t) {
  return t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, '\u2019').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));
}
function htmlToLines(html) {
  let h = String(html || '');
  h = h.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ');
  /* keep picture addresses as their own lines so the parser can take them */
  h = h.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi, (m, s) => '\n@img ' + s + '\n');
  h = h.replace(/<h([1-6])\b[^>]*>/gi, (m, n) => '\n' + '#'.repeat(+n) + ' ').replace(/<\/h[1-6]>/gi, '\n');
  h = h.replace(/<(br|\/p|\/div|\/li|\/tr|\/td|\/th|\/dt|\/dd|\/section|\/article|p|div|li|tr|dt|dd)\b[^>]*>/gi, '\n');
  h = h.replace(/<[^>]+>/g, ' ');
  return decode(h).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
/* the og:image (the ball picture) from the head, before the head is dropped */
function ogImage(html) { const m = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html || '') || /<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i.exec(html || ''); return m ? decode(m[1]) : null; }

/* ---------- pure: text lines -> what the page says ---------- */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function monthYear(t) {
  const m = /^([a-z]{3,9})\.?\s+(\d{4})$/i.exec(String(t || '').trim()); if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase() === 'sept' ? 4 : 3)]; return mo ? m[2] + '-' + String(mo).padStart(2, '0') : null;
}
function num(t) { const m = /^(\d?\.\d{2,4}|\d\.\d{1,4})$/.exec(String(t || '').trim()); return m ? +m[1] : null; }
/* v30.215: the same page as text can come as "Label: value" on one line, "Label:" then the value,
   or a heading wrapped before its last word ("Centrex Symmetrical Mass Bias" / "Core"). Put it in one shape. */
const INLINE = /^(release date|factory finish|box finish|type|core type|rg|diff|mb diff|int\.? diff)\s*:\s*(.+)$/i;
function normLines(lines) {
  const out = [];
  lines.forEach(raw => {
    const s = String(raw).trim(); if (!s) return;
    const hm = /^(#+)\s/.exec(s), body = s.replace(/^#+\s*/, '');
    const m = !hm && INLINE.exec(body);
    if (m) { out.push(m[1]); out.push(m[2].trim()); return; }
    if (!hm && /^(core|coverstock)$/i.test(body) && out.length && !/^#/.test(out[out.length - 1]) && /^[A-Z0-9]/.test(out[out.length - 1]) && out[out.length - 1].length <= 45 && !INLINE.test(out[out.length - 1])) {
      out.push('##### ' + out.pop() + ' ' + body); return;   // the wrapped heading, made whole
    }
    if (!hm && /^[A-Z0-9].{1,60}\s(core|coverstock)$/i.test(body) && !/^core type/i.test(body)) { out.push('##### ' + body); return; }   // a heading line without its # (text or PDF)
    out.push(hm ? s : body.replace(/:\s*$/, ''));
  });
  return out;
}
function parseLines(lines) {
  lines = normLines(lines);
  const out = { name: null, released: null, international: false, country: null, discontinued: false, finish: null, coverName: null, coverType: null, core: null, coreType: null, coreImg: null, weights: {} };
  const L = lines.map(s => s.replace(/^#+\s*/, '').trim());
  const head = lines.map(s => (/^(#+)\s/.exec(s) || [])[1] || '');
  let w = null, sect = null;
  const after = i => L[i + 1] || '';
  for (let i = 0; i < L.length; i++) {
    const s = L[i], low = s.toLowerCase();
    if (head[i] === '#' && !out.name) { out.name = s; continue; }
    if (/^overseas\s*\/?\s*international release$/i.test(s) || /^international release$/i.test(s)) out.international = true;
    const tf = /^translated from (korean|japanese|chinese|thai|german|french|spanish|italian|swedish)\b/i.exec(s);   // v30.220: where it was released
    if (tf && !out.country) out.country = { korean: 'Korea', japanese: 'Japan', chinese: 'Asia', thai: 'Asia' }[tf[1].toLowerCase()] || 'Europe';
    if (/^discontinued$/i.test(s) || /^discontinued\b.*\bball\b/i.test(s)) out.discontinued = true;
    if (low === 'release date') { out.released = monthYear(after(i)) || out.released; continue; }
    if (low === 'factory finish' || low === 'box finish') { if (after(i)) out.finish = after(i); continue; }
    if (head[i] && /\bcoverstock$/i.test(s)) { out.coverName = s.replace(/\s*coverstock$/i, '').trim() || null; sect = 'cover'; w = null; continue; }
    if (head[i] && /\bcore$/i.test(s) && !/pounds?$/i.test(s)) { out.core = s.replace(/\s*core$/i, '').trim() || null; sect = 'core'; w = null; continue; }
    if (low === 'type' && sect === 'cover') { out.coverType = after(i) || null; continue; }
    if (low === 'core type') { const t = after(i); out.coreType = /^asym/i.test(t) ? 'Asymmetrical' : /^sym/i.test(t) ? 'Symmetrical' : (t || null); continue; }
    if (/^@img /.test(s) && sect === 'core' && !out.coreImg && /\/cores\//.test(s)) { out.coreImg = s.slice(5); continue; }
    const wm = /^(\d{1,2})\s*(?:pounds?|lbs?\.?)$/i.exec(s);
    if (wm) { w = wm[1]; out.weights[w] = out.weights[w] || {}; continue; }
    if (w && (low === 'rg' || low === 'diff' || low === 'mb diff' || low === 'int diff' || low === 'int. diff')) {
      const v = num(after(i)); if (v == null) continue;
      out.weights[w][low === 'rg' ? 'RG' : low === 'diff' ? 'Diff' : 'IntDiff'] = v; continue;
    }
    if (head[i] && w && !/pounds?$/i.test(s)) w = null;   // a later section ends the weights
  }
  Object.keys(out.weights).forEach(k => { if (!Object.keys(out.weights[k]).length) delete out.weights[k]; });
  return out;
}

/* ---------- encryption for the phone ---------- */
function seal(obj, spkiB64) {
  const pub = crypto.createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final(), c.getAuthTag()]);   // WebCrypto wants ciphertext||tag
  const k = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { v: 1, k: k.toString('base64'), iv: iv.toString('base64'), d: body.toString('base64') };
}

async function main() {
  const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : null; };
  const url = arg('url'), key = arg('key'), nonce = arg('nonce'), outFile = arg('out');
  if (!/^[a-z0-9-]{8,64}$/i.test(nonce || '')) throw new Error('nonce: letters, digits, dashes');
  const write = o => fs.writeFileSync(outFile, JSON.stringify(Object.assign({ nonce, at: new Date().toISOString() }, o)) + '\n');
  if (!URL_OK.test(url || '')) { write({ err: 'not a bowwwl ball page' }); return; }
  if (!key || !/^[A-Za-z0-9+/=]{200,1200}$/.test(key)) { write({ err: 'no key' }); return; }
  const r = await fetch(url, { headers: { 'User-Agent': 'BowlingDB personal-use reader (one page, on request)' }, redirect: 'follow' });
  if (!r.ok) { write({ err: 'HTTP ' + r.status }); return; }
  const html = await r.text(), lines = htmlToLines(html), page = parseLines(lines);
  page.ballImg = ogImage(html);
  write({ sealed: seal({ url, page, lines: lines.slice(0, 400) }, key) });
}

module.exports = { htmlToLines, parseLines, normLines, ogImage, monthYear, seal, URL_OK };
if (require.main === module && !process.argv.includes('--test')) main().catch(e => { console.error(e); process.exit(1); });
