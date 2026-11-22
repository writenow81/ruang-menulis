// Penukaran tulisan (HTML terhad) kepada DOCX dan TXT, serta pembersihan HTML.
const sanitizeHtml = require('sanitize-html');
const { parseDocument } = require('htmlparser2');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

// Hanya gaya yang disokong Zon Menulis: perenggan, tebal, condong, senarai berbutir.
function bersihkanHtml(html) {
  return sanitizeHtml(html || '', {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'ul', 'li'],
    allowedAttributes: {},
    transformTags: { div: 'p', h1: 'p', h2: 'p', h3: 'p', h4: 'p', ol: 'ul' },
  });
}

// Tukar HTML kepada senarai blok: { jenis: 'p' | 'li', runs: [{ teks, tebal, condong }] }
function keBlok(html) {
  const doc = parseDocument(bersihkanHtml(html));
  const blok = [];
  let semasa = null;

  const mula = (jenis) => { semasa = { jenis, runs: [] }; blok.push(semasa); };
  const tamat = () => { semasa = null; };

  function jalan(node, gaya) {
    if (node.type === 'text') {
      const teks = node.data.replace(/&nbsp;/g, ' ');
      if (!semasa) { if (!teks.trim()) return; mula('p'); }
      semasa.runs.push({ teks, ...gaya });
      return;
    }
    if (node.type !== 'tag') { (node.children || []).forEach((c) => jalan(c, gaya)); return; }
    const t = node.name;
    if (t === 'p' || t === 'li') {
      mula(t);
      node.children.forEach((c) => jalan(c, gaya));
      tamat();
      return;
    }
    if (t === 'br') { if (semasa) semasa.runs.push({ teks: '\n', ...gaya }); return; }
    const gayaBaru = { ...gaya };
    if (t === 'strong' || t === 'b') gayaBaru.tebal = true;
    if (t === 'em' || t === 'i') gayaBaru.condong = true;
    node.children.forEach((c) => jalan(c, gayaBaru));
    if (t === 'ul') tamat();
  }
  doc.children.forEach((c) => jalan(c, {}));
  return blok;
}

function blokKeTeks(blok) {
  return blok.map((b) => ({ b, t: b.runs.map((r) => r.teks).join('').trim() })).filter((x) => x.t)
    .map(({ b, t }) => (b.jenis === 'li' ? '• ' : '') + t).join('\n\n');
}

function htmlKeTeks(html) { return blokKeTeks(keBlok(html)); }

const FON = 'Arial';
const SAIZ = 23; // separuh mata: 23 = 11.5 pt
const LANGKAU = 360; // 240 = 1.0, 360 = 1.5

function binaPerenggan(blok) {
  return blok.map((b) => {
    const children = [];
    b.runs.forEach((r) => {
      const bahagian = r.teks.split('\n');
      bahagian.forEach((teks, i) => {
        children.push(new TextRun({ text: teks, bold: !!r.tebal, italics: !!r.condong, font: FON, size: SAIZ, break: i > 0 ? 1 : undefined }));
      });
    });
    return new Paragraph({
      children,
      spacing: { line: LANGKAU, after: 160 },
      ...(b.jenis === 'li' ? { bullet: { level: 0 } } : {}),
    });
  });
}

// bab: [{ title, content_html }]
async function binaDocx(judulDokumen, bab) {
  const children = [];
  bab.forEach((b, i) => {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: i > 0,
      alignment: AlignmentType.LEFT,
      spacing: { line: LANGKAU, after: 240 },
      children: [new TextRun({ text: b.title, bold: true, font: FON, size: 32 })],
    }));
    children.push(...binaPerenggan(keBlok(b.content_html)));
  });
  const doc = new Document({
    title: judulDokumen,
    creator: 'Ruang Menulis',
    styles: {
      default: {
        document: { run: { font: FON, size: SAIZ }, paragraph: { spacing: { line: LANGKAU } } },
        heading1: { run: { font: FON, size: 32, bold: true, color: '000000' } },
      },
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

function binaTxt(judulDokumen, bab) {
  const pemisah = '\n\n' + '='.repeat(40) + '\n\n';
  const isi = bab.map((b) => `${b.title.toUpperCase()}\n${'-'.repeat(Math.min(40, b.title.length))}\n\n${htmlKeTeks(b.content_html)}`).join(pemisah);
  return (bab.length > 1 ? `${judulDokumen}\n\n` : '') + isi + '\n';
}


module.exports = { bersihkanHtml, htmlKeTeks, binaDocx, binaTxt };
