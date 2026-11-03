#!/usr/bin/env node
// pdf-send-check: read-only report on the parts of a PDF that travel with it
// when you send it: earlier saves, annotations, form fields, document info,
// attachments, scripts and encryption. MIT license. Node 18+, no dependencies.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ANNOT_TYPES = ['Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight',
  'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound', 'Movie',
  'Widget', 'Screen', 'Redact'];
// Marks a reader can move, edit or delete after you send the file.
const LOOSE_MARKS = ['Ink', 'FreeText', 'Stamp', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Highlight',
  'Underline', 'Squiggly', 'StrikeOut', 'Text', 'Caret'];
const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];

function decodeLiteral(raw) {
  // raw is the text between the outer parentheses of a PDF literal string
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push(raw.charCodeAt(i) & 0xff); continue; }
    const n = raw[++i];
    const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (n in map) out.push(map[n]);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1])) oct += raw[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (n === '\r') { if (raw[i + 1] === '\n') i++; }
    else if (n !== '\n' && n !== undefined) out.push(raw.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function bytesToText(buf) {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < buf.length; i += 2) s += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
    return s;
  }
  return buf.toString('latin1');
}

// Reads one PDF string value (literal or hex) starting at position i of text.
function readString(text, i) {
  if (text[i] === '(') {
    let depth = 0; let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '\\') { j++; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    return bytesToText(decodeLiteral(text.slice(i + 1, j)));
  }
  if (text[i] === '<' && text[i + 1] !== '<') {
    const end = text.indexOf('>', i);
    let hex = text.slice(i + 1, end).replace(/\s+/g, '');
    if (hex.length % 2) hex += '0';
    return bytesToText(Buffer.from(hex, 'hex'));
  }
  return null;
}

function inflate(buf) {
  try { return zlib.inflateSync(buf); } catch (e) {
    try { return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e2) { return null; }
  }
}

// Collects every object body: plain "N G obj ... endobj" and objects packed in object streams.
// A later definition of the same number wins, as it does in a reader.
function collectObjects(buf) {
  const text = buf.toString('latin1');
  const objects = new Map();
  const streams = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) break;
    let body = text.slice(start, end);
    const s = body.indexOf('stream');
    let dict = body;
    if (s >= 0 && /^\s*<</.test(body)) {
      dict = body.slice(0, s);
      let dataStart = start + s + 6;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;
      const dataEnd = text.lastIndexOf('endstream', end);
      streams.push({ num: +m[1], dict, data: buf.subarray(dataStart, dataEnd > dataStart ? dataEnd : dataStart) });
    }
    objects.set(+m[1], dict);
    re.lastIndex = end;
  }
  for (const st of streams) {
    if (!/\/Type\s*\/ObjStm/.test(st.dict)) continue;
    if (!/\/FlateDecode/.test(st.dict)) continue;
    const data = inflate(st.data);
    if (!data) continue;
    const n = +(st.dict.match(/\/N\s+(\d+)/) || [])[1];
    const first = +(st.dict.match(/\/First\s+(\d+)/) || [])[1];
    const s = data.toString('latin1');
    const nums = s.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k++) {
      const num = nums[2 * k];
      const from = first + nums[2 * k + 1];
      const to = k + 1 < n ? first + nums[2 * k + 3] : s.length;
      objects.set(num, s.slice(from, to));
    }
  }
  return { text, objects, streams };
}

function trailerValue(text, streams, key) {
  // classic trailers first, then cross-reference streams; the last one in the file is the newest
  const hits = [];
  const re = /trailer\s*<<([\s\S]*?)>>\s*startxref/g;
  let m;
  while ((m = re.exec(text))) hits.push(m[1]);
  for (const st of streams) if (/\/Type\s*\/XRef/.test(st.dict)) hits.push(st.dict);
  for (let i = hits.length - 1; i >= 0; i--) {
    const v = hits[i].match(new RegExp('/' + key + '\\s+(\\d+)\\s+\\d+\\s+R'));
    if (v) return +v[1];
    if (new RegExp('/' + key + '\\b').test(hits[i])) return true;
  }
  return null;
}

function check(buf) {
  if (buf.subarray(0, 1024).toString('latin1').indexOf('%PDF-') < 0) throw new Error('not a PDF file');
  const { text, objects, streams } = collectObjects(buf);
  const version = (text.match(/%PDF-(\d\.\d)/) || [])[1] || '?';
  const linearized = /\/Linearized\b/.test(text.slice(0, 2048));
  const eofCount = (text.match(/%%EOF/g) || []).length;
  const saves = Math.max(1, eofCount - (linearized ? 1 : 0));

  let pageObjects = 0;
  let rootCount = null;
  const annots = {};
  let acroForm = false;
  let javascript = false;
  let attachments = 0;
  let xmp = false;
  for (const dict of objects.values()) {
    if (/\/Type\s*\/Page(?![s\w])/.test(dict)) pageObjects++;
    if (/\/Type\s*\/Pages\b/.test(dict) && !/\/Parent\s+\d+/.test(dict)) {
      const c = dict.match(/\/Count\s+(\d+)/);
      if (c) rootCount = Math.max(rootCount || 0, +c[1]);
    }
    const sub = dict.match(/\/Subtype\s*\/(\w+)/);
    if (sub && ANNOT_TYPES.includes(sub[1]) && /\/Rect\s*\[/.test(dict)) annots[sub[1]] = (annots[sub[1]] || 0) + 1;
    if (/\/AcroForm\b/.test(dict) && /\/Type\s*\/Catalog/.test(dict)) acroForm = true;
    if (/\/(JS|JavaScript)\b/.test(dict)) javascript = true;
    if (/\/Type\s*\/Filespec/.test(dict) && /\/EF\s*<</.test(dict)) attachments++;
    if (/\/Type\s*\/Metadata/.test(dict) && /\/Subtype\s*\/XML/.test(dict)) xmp = true;
  }

  const pages = rootCount === null ? pageObjects : rootCount;
  const unusedPages = Math.max(0, pageObjects - pages);
  const encrypted = trailerValue(text, streams, 'Encrypt') !== null;
  const info = {};
  const infoRef = trailerValue(text, streams, 'Info');
  if (typeof infoRef === 'number' && objects.has(infoRef) && !encrypted) {
    const dict = objects.get(infoRef);
    for (const key of INFO_KEYS) {
      const k = dict.search(new RegExp('/' + key + '\\s*[(<]'));
      if (k < 0) continue;
      const at = dict.indexOf(dict.slice(k).match(/[(<]/)[0], k);
      const value = readString(dict, at);
      if (value !== null && value.trim() !== '') info[key] = value.replace(/\u0000/g, '').trim();
    }
  }

  const loose = Object.keys(annots).filter(t => LOOSE_MARKS.includes(t)).reduce((a, t) => a + annots[t], 0);
  const notes = [];
  if (saves > 1) notes.push(`saved ${saves} times: the earlier version is still inside the file and can be recovered`);
  if (loose) notes.push(`${loose} mark(s) are annotations: the reader can move or delete them`);
  if (annots.Widget) notes.push(`${annots.Widget} form field(s): values can still be changed`);
  if (unusedPages) notes.push(`${unusedPages} page object(s) are not in the page list: a reader will not show them, but they are in the file`);
  if (info.Author) notes.push('document info has an Author name');
  if (attachments) notes.push(`${attachments} attached file(s) travel with the PDF`);
  if (javascript) notes.push('contains script actions');
  if (encrypted) notes.push('encrypted: document info was not read');

  return { version, pages, unusedPages, saves, linearized, annots, loose, acroForm, javascript, attachments, xmp, encrypted, info, notes };
}

function format(name, r) {
  const lines = [];
  lines.push(`${name}: PDF ${r.version}, ${r.pages} page${r.pages === 1 ? '' : 's'}, saved ${r.saves} time${r.saves === 1 ? '' : 's'}`);
  const kinds = Object.keys(r.annots).sort().map(k => `${k} ${r.annots[k]}`);
  lines.push(`  annotations: ${kinds.length ? kinds.join(', ') : 'none'}`);
  lines.push(`  form fields: ${r.annots.Widget || 0}${r.acroForm && !r.annots.Widget ? ' (empty form dictionary)' : ''}`);
  const infoKeys = Object.keys(r.info);
  lines.push(`  document info: ${infoKeys.length ? infoKeys.join(', ') : 'none'}${r.xmp ? ' + XMP packet' : ''}`);
  for (const k of infoKeys) if (k === 'Title' || k === 'Author' || k === 'Subject' || k === 'Keywords') lines.push(`    ${k}: ${r.info[k]}`);
  lines.push(`  attachments: ${r.attachments}, scripts: ${r.javascript ? 'yes' : 'no'}, encrypted: ${r.encrypted ? 'yes' : 'no'}`);
  lines.push(r.notes.length ? '  check before sending:' : '  nothing to flag');
  for (const n of r.notes) lines.push(`    - ${n}`);
  return lines.join('\n');
}

function main(argv) {
  const args = argv.filter(a => !a.startsWith('--'));
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  if (!args.length) {
    console.error('usage: node scripts/pdf-send-check.js <file.pdf> [more.pdf] [--json] [--strict]');
    return 2;
  }
  let flagged = 0;
  const results = [];
  for (const file of args) {
    let r;
    try { r = check(fs.readFileSync(file)); } catch (e) {
      console.error(`${file}: ${e.message}`);
      return 2;
    }
    if (r.notes.length) flagged++;
    if (json) results.push({ file: path.basename(file), ...r });
    else console.log(format(path.basename(file), r) + (args.length > 1 ? '\n' : ''));
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  return strict && flagged ? 1 : 0;
}

module.exports = { check, format, readString };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
