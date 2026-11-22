// Laporan analisis isu tatabahasa & ejaan: DOCX dan PDF
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

const FON = 'Arial';
const tarikhMs = (iso) => new Date(iso).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function maklumat(a) {
  const s = a.statistik || {};
  return [
    `Dijana: ${tarikhMs(a.dijana_pada)}`,
    `Tempoh: ${s.hari ?? '-'} hari terakhir`,
    `Jumlah isu: ${s.jumlah_isu ?? '-'} daripada ${s.bilangan_pengguna ?? '-'} pengguna`,
    s.ikut_jenis?.length ? `Ikut jenis: ${s.ikut_jenis.map((j) => `${j.jenis} ${j.n}`).join(', ')}` : null,
  ].filter(Boolean);
}

// ---------- DOCX ----------
async function binaDocxLaporan(a) {
  const run = (text, o = {}) => new TextRun({ text, font: FON, size: 23, ...o });
  const para = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { line: 360, after: 120 }, ...o });
  const tajuk = (text, level) => new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: [new TextRun({ text, font: FON, bold: true, size: level === HeadingLevel.HEADING_1 ? 32 : 26 })] });

  const c = [
    tajuk('Analisis Isu Tatabahasa & Ejaan Pengguna', HeadingLevel.HEADING_1),
    ...maklumat(a).map((t) => para(run(t, { color: '555555', size: 20 }), { spacing: { after: 40 } })),
    tajuk('Ringkasan', HeadingLevel.HEADING_2),
    para(run(a.ringkasan)),
    tajuk('Isu yang kerap berulang', HeadingLevel.HEADING_2),
  ];
  a.isu_kerap.forEach((k, i) => {
    c.push(tajuk(`${i + 1}. ${k.kategori}`, HeadingLevel.HEADING_3));
    c.push(para(run(`Jenis: ${k.jenis} · anggaran ${k.anggaran_kejadian} kali · ${k.anggaran_pengguna} pengguna`, { italics: true, color: '555555' })));
    c.push(para(run(k.penerangan)));
    k.contoh.forEach((x) => c.push(para([run(x.asal, { strike: true, color: 'A3302A' }), run('  →  '), run(x.betul, { bold: true, color: '2C6E3F' })], { bullet: { level: 0 } })));
    c.push(para([run('Cadangan pengajaran: ', { bold: true }), run(k.cadangan_pengajaran)]));
  });
  if (a.pengguna_perlu_bimbingan?.length) {
    c.push(tajuk('Pengguna yang mungkin memerlukan bimbingan', HeadingLevel.HEADING_2));
    a.pengguna_perlu_bimbingan.forEach((p) => c.push(para([run(p.nama, { bold: true }), run(`: ${p.isu_utama}`)], { bullet: { level: 0 } })));
  }
  if (a.catatan_data) c.push(para(run(`Catatan data: ${a.catatan_data}`, { italics: true, color: '555555' })));
  c.push(para(run('Laporan ini dijana oleh AI daripada isu yang dikesan oleh Semakan Tulisan. Ia ialah panduan untuk pengajar, bukan penilaian muktamad.', { italics: true, color: '777777', size: 18 })));

  const doc = new Document({
    title: 'Analisis Isu Tatabahasa & Ejaan', creator: 'Ruang Menulis',
    styles: { default: { document: { run: { font: FON, size: 23 } } } },
    sections: [{ children: c }],
  });
  return Packer.toBuffer(doc);
}

// ---------- PDF ----------
// Fon terbina dalam PDF (Helvetica) hanya menyokong aksara Latin asas; tukar simbol lain.
const selamat = (s) => String(s ?? '')
  .replace(/[→⇒]/g, '->').replace(/±/g, '+/-').replace(/[≥]/g, '>=').replace(/[≤]/g, '<=')
  .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...').replace(/·/g, '|')
  .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '');

function binaPdfLaporan(a) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 60, right: 60 }, info: { Title: 'Analisis Isu Tatabahasa & Ejaan', Author: 'Ruang Menulis' } });
    const bahagian = [];
    doc.on('data', (b) => bahagian.push(b));
    doc.on('end', () => resolve(Buffer.concat(bahagian)));
    doc.on('error', reject);

    const W = doc.page.width - 120;
    const teks = (t, o = {}) => doc.font(o.font || 'Helvetica').fontSize(o.size || 11).fillColor(o.color || '#1f2328').text(selamat(t), { width: W, lineGap: 4, ...o.opts });
    const tajuk = (t, size) => { doc.moveDown(0.6); teks(t, { font: 'Helvetica-Bold', size }); doc.moveDown(0.3); };

    teks('Analisis Isu Tatabahasa & Ejaan Pengguna', { font: 'Helvetica-Bold', size: 18 });
    doc.moveDown(0.4);
    maklumat(a).forEach((m) => teks(m, { size: 9.5, color: '#555555' }));
    tajuk('Ringkasan', 13);
    teks(a.ringkasan);
    tajuk('Isu yang kerap berulang', 13);
    a.isu_kerap.forEach((k, i) => {
      tajuk(`${i + 1}. ${k.kategori}`, 11.5);
      teks(`Jenis: ${k.jenis} | anggaran ${k.anggaran_kejadian} kali | ${k.anggaran_pengguna} pengguna`, { font: 'Helvetica-Oblique', size: 9.5, color: '#555555' });
      doc.moveDown(0.2);
      teks(k.penerangan);
      k.contoh.forEach((x) => {
        doc.font('Helvetica').fontSize(11).fillColor('#a3302a').text(`  •  ${selamat(x.asal)}`, { continued: true, width: W, lineGap: 4 })
          .fillColor('#1f2328').text('  ->  ', { continued: true }).font('Helvetica-Bold').fillColor('#2c6e3f').text(selamat(x.betul));
      });
      doc.moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#1f2328').text('Cadangan pengajaran: ', { continued: true, width: W, lineGap: 4 }).font('Helvetica').text(selamat(k.cadangan_pengajaran));
    });
    if (a.pengguna_perlu_bimbingan?.length) {
      tajuk('Pengguna yang mungkin memerlukan bimbingan', 13);
      a.pengguna_perlu_bimbingan.forEach((p) => doc.font('Helvetica-Bold').fontSize(11).fillColor('#1f2328').text(`  •  ${selamat(p.nama)}`, { continued: true, width: W, lineGap: 4 }).font('Helvetica').text(`: ${selamat(p.isu_utama)}`));
    }
    if (a.catatan_data) { doc.moveDown(0.6); teks(`Catatan data: ${a.catatan_data}`, { font: 'Helvetica-Oblique', size: 9.5, color: '#555555' }); }
    doc.moveDown(1);
    teks('Laporan ini dijana oleh AI daripada isu yang dikesan oleh Semakan Tulisan. Ia ialah panduan untuk pengajar, bukan penilaian muktamad.', { font: 'Helvetica-Oblique', size: 8.5, color: '#777777' });
    doc.end();
  });
}

module.exports = { binaDocxLaporan, binaPdfLaporan };
