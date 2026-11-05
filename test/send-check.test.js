'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { check, format, readString } = require('../scripts/pdf-send-check.js');

// Builds a small PDF from object bodies. Offsets are not exact; the checker does not need them.
function pdf(objects, trailer, extra = '') {
  let s = '%PDF-1.7\n';
  objects.forEach((body, i) => { s += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  s += `xref\n0 ${objects.length + 1}\ntrailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n0\n%%EOF\n`;
  return Buffer.from(s + extra, 'latin1');
}

const page = (annots = '') => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${annots} >>`;
const base = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page()];

test('the highlighted flyer from the README is a single save with no annotations', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'examples', 'bake-sale-highlighted.pdf'));
  const r = check(file);
  assert.strictEqual(r.pages, 1);
  assert.strictEqual(r.saves, 1);
  assert.deepStrictEqual(r.notes, []);
});

test('clean one-page file has nothing to flag', () => {
  const r = check(pdf(base, '/Root 1 0 R'));
  assert.strictEqual(r.pages, 1);
  assert.strictEqual(r.saves, 1);
  assert.deepStrictEqual(r.notes, []);
});

test('ink drawing left as an annotation is flagged', () => {
  const objs = [base[0], base[1], page(' /Annots [4 0 R]'),
    '<< /Type /Annot /Subtype /Ink /Rect [100 100 200 150] /InkList [[100 100 150 140 200 120]] >>'];
  const r = check(pdf(objs, '/Root 1 0 R'));
  assert.strictEqual(r.annots.Ink, 1);
  assert.strictEqual(r.loose, 1);
  assert.match(r.notes.join('\n'), /move or delete/);
});

test('links do not count as loose marks', () => {
  const objs = [base[0], base[1], page(' /Annots [4 0 R]'), '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] >>'];
  const r = check(pdf(objs, '/Root 1 0 R'));
  assert.strictEqual(r.annots.Link, 1);
  assert.strictEqual(r.loose, 0);
});

test('incremental save is counted and flagged', () => {
  const update = '4 0 obj\n<< /Producer (edit) >>\nendobj\ntrailer\n<< /Size 5 /Root 1 0 R /Prev 0 >>\nstartxref\n0\n%%EOF\n';
  const r = check(pdf(base, '/Root 1 0 R', update));
  assert.strictEqual(r.saves, 2);
  assert.match(r.notes[0], /saved 2 times/);
});

test('form fields, attachment, script and author are reported', () => {
  const objs = ['<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> /OpenAction 6 0 R >>', base[1],
    page(' /Annots [4 0 R]'),
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [50 50 250 70] >>',
    '<< /Type /Filespec /F (notes.txt) /EF << /F 7 0 R >> >>',
    '<< /S /JavaScript /JS (app.alert\\(1\\)) >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Author (Jane Smith) /Title (Lease \\(draft\\)) >>'];
  const r = check(pdf(objs, '/Root 1 0 R /Info 8 0 R'));
  assert.strictEqual(r.annots.Widget, 1);
  assert.strictEqual(r.attachments, 1);
  assert.strictEqual(r.javascript, true);
  assert.strictEqual(r.info.Author, 'Jane Smith');
  assert.strictEqual(r.info.Title, 'Lease (draft)');
  assert.strictEqual(r.notes.length, 4);
});

test('objects packed in a compressed object stream are read', () => {
  const inner = '<< /Type /Annot /Subtype /FreeText /Rect [10 10 90 30] /Contents (OK) >>';
  const info = '<< /Author <FEFF004A006F> >>';
  const header = `4 0 5 ${inner.length + 1} `;
  const data = zlib.deflateSync(Buffer.from(header + inner + ' ' + info, 'latin1'));
  const objs = [base[0], base[1], page(' /Annots [4 0 R]'), null, null,
    `<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`];
  const buf = pdf(objs.map(o => o || '<< >>'), '/Root 1 0 R /Info 5 0 R');
  const r = check(buf);
  assert.strictEqual(r.annots.FreeText, 1);
  assert.strictEqual(r.info.Author, 'Jo');
});

test('page objects outside the page tree are reported', () => {
  const r = check(pdf([...base, page()], '/Root 1 0 R'));
  assert.strictEqual(r.pages, 1);
  assert.strictEqual(r.unusedPages, 1);
});

test('encrypted file skips document info', () => {
  const r = check(pdf([...base, '<< /Author (x) >>'], '/Root 1 0 R /Info 4 0 R /Encrypt 5 0 R'));
  assert.strictEqual(r.encrypted, true);
  assert.deepStrictEqual(r.info, {});
});

test('string decoding and text report', () => {
  assert.strictEqual(readString('(a\\051b\\\\c)', 0), 'a)b\\c');
  assert.strictEqual(readString('<4869>', 0), 'Hi');
  const text = format('a.pdf', check(pdf(base, '/Root 1 0 R')));
  assert.match(text, /^a\.pdf: PDF 1\.7, 1 page, saved 1 time/);
  assert.match(text, /nothing to flag/);
});

test('rejects a file that is not a PDF', () => {
  assert.throws(() => check(Buffer.from('hello')), /not a PDF/);
});
