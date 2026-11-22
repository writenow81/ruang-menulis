// Ruang Menulis: pelayan utama
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const mammoth = require('mammoth');

const db = require('./src/db');
const ai = require('./src/ai');
const drive = require('./src/drive');
const laporan = require('./src/laporan');
const { bersihkanHtml, htmlKeTeks, binaDocx, binaTxt, teksKeHtml } = require('./src/exporter');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'kreatifkursus@gmail.com').toLowerCase();
const PROD = process.env.NODE_ENV === 'production';
const SESI_HARI = 30;
const HAD_AI_SEJAM = Number(process.env.AI_LIMIT_PER_HOUR || 60);

// ---------- Akaun admin ----------
(function sediakanAdmin() {
  const ada = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL);
  if (ada) { db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ada.id); return; }
  let kataLaluan = process.env.ADMIN_PASSWORD;
  if (!kataLaluan) {
    kataLaluan = crypto.randomBytes(9).toString('base64url');
    console.log(`\n[Ruang Menulis] ADMIN_PASSWORD tidak ditetapkan. Kata laluan admin sementara untuk ${ADMIN_EMAIL}: ${kataLaluan}\nTukar selepas log masuk pertama (Panel admin > Tukar kata laluan saya).\n`);
  }
  db.prepare("INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'admin')")
    .run('Admin Ruang Menulis', ADMIN_EMAIL, '-', bcrypt.hashSync(kataLaluan, 12));
})();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});

// Perlindungan CSRF ringkas: permintaan yang mengubah data mesti datang daripada fetch aplikasi.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'RuangMenulis') return res.status(403).json({ error: 'Permintaan ditolak.' });
  next();
});

// ---------- Utiliti ----------
const salah = (res, status, error) => res.status(status).json({ error });
const bacaKuki = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
const emelSah = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const telefonSah = (t) => /^\+?[0-9\s-]{8,18}$/.test(t);
const tapis = (s, max = 20000) => String(s ?? '').slice(0, max);

function noWhatsApp(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '6' + d; // nombor Malaysia 01x... -> 601x...
  return d.length >= 8 ? d : null;
}

function setSesi(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))").run(token, userId, `+${SESI_HARI} days`);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESI_HARI * 86400}${PROD ? '; Secure' : ''}`);
}

function pengguna(req) {
  const { sid } = bacaKuki(req);
  if (!sid) return null;
  return db.prepare(`SELECT u.id, u.full_name, u.email, u.phone, u.role, u.disabled, u.last_active_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`).get(sid) || null;
}

function perluLogMasuk(req, res, next) {
  const u = pengguna(req);
  if (!u) return salah(res, 401, 'Sila log masuk.');
  if (u.disabled) return salah(res, 403, 'Akaun anda telah dinyahaktifkan. Hubungi admin.');
  // Rekod masa penggunaan terakhir (paling kerap sekali seminit)
  db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ? AND (last_active_at IS NULL OR last_active_at < datetime('now', '-1 minute'))").run(u.id);
  req.user = u;
  next();
}

function perluAdmin(req, res, next) {
  if (req.user.role !== 'admin') return salah(res, 403, 'Hanya admin.');
  next();
}

// Had kadar ringkas dalam ingatan
const kiraan = new Map();
function hadKadar(kunci, had, tetingkapMs) {
  const kini = Date.now();
  const senarai = (kiraan.get(kunci) || []).filter((t) => kini - t < tetingkapMs);
  if (senarai.length >= had) { kiraan.set(kunci, senarai); return false; }
  senarai.push(kini); kiraan.set(kunci, senarai);
  return true;
}

function projekMilik(req, id) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
}
function babMilik(req, id) {
  return db.prepare(`SELECT c.*, p.user_id FROM chapters c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.user_id = ?`).get(Number(id), req.user.id);
}
function senaraiBab(projectId) {
  return db.prepare('SELECT id, title, position, updated_at, length(content_html) AS saiz FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, id').all(projectId);
}
const sentuhProjek = (id) => db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id);
const namaFail = (s) => (s || 'tulisan').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'tulisan';

// ---------- Pendaftaran & log masuk ----------
app.post('/api/register', async (req, res) => {
  if (!hadKadar(`reg:${req.ip}`, 10, 3600e3)) return salah(res, 429, 'Terlalu banyak cubaan. Cuba lagi kemudian.');
  const full_name = tapis(req.body.full_name, 120).trim();
  const email = tapis(req.body.email, 200).trim().toLowerCase();
  const phone = tapis(req.body.phone, 30).trim();
  const password = String(req.body.password || '');
  if (full_name.length < 3) return salah(res, 400, 'Sila isi nama penuh.');
  if (!emelSah(email)) return salah(res, 400, 'Alamat e-mel tidak sah.');
  if (!telefonSah(phone)) return salah(res, 400, 'Nombor telefon tidak sah. Contoh: 012-345 6789');
  if (password.length < 8) return salah(res, 400, 'Kata laluan mesti sekurang-kurangnya 8 aksara.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return salah(res, 409, 'E-mel ini sudah didaftarkan. Sila log masuk.');
  const hash = await bcrypt.hash(password, 12);
  const r = db.prepare('INSERT INTO users (full_name, email, phone, password_hash, last_active_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(full_name, email, phone, hash);
  setSesi(res, r.lastInsertRowid);
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const email = tapis(req.body.email, 200).trim().toLowerCase();
  if (!hadKadar(`login:${req.ip}:${email}`, 8, 15 * 60e3)) return salah(res, 429, 'Terlalu banyak cubaan log masuk. Cuba lagi dalam 15 minit.');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) return salah(res, 401, 'E-mel atau kata laluan salah.');
  if (u.disabled) return salah(res, 403, 'Akaun anda telah dinyahaktifkan. Hubungi admin.');
  db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(u.id);
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  setSesi(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const { sid } = bacaKuki(req);
  if (sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', perluLogMasuk, (req, res) => {
  const { id, full_name, email, phone, role } = req.user;
  res.json({ id, full_name, email, phone, role, google: { dikonfigurasi: drive.dikonfigurasi(), bersambung: drive.bersambung(id) } });
});

app.post('/api/me/password', perluLogMasuk, async (req, res) => {
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash))) return salah(res, 400, 'Kata laluan semasa salah.');
  const baru = String(req.body.password || '');
  if (baru.length < 8) return salah(res, 400, 'Kata laluan baharu mesti sekurang-kurangnya 8 aksara.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(baru, 12), req.user.id);
  res.json({ ok: true });
});

// ---------- Projek ----------
app.get('/api/projects', perluLogMasuk, (req, res) => {
  res.json(db.prepare(`SELECT p.id, p.title, p.updated_at, (SELECT count(*) FROM chapters c WHERE c.project_id = p.id AND c.deleted_at IS NULL) AS bilangan_bab
    FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC`).all(req.user.id));
});

app.post('/api/projects', perluLogMasuk, (req, res) => {
  const title = tapis(req.body.title, 200).trim() || 'Projek tanpa judul';
  const r = db.prepare('INSERT INTO projects (user_id, title) VALUES (?, ?)').run(req.user.id, title);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.get('/api/projects/:id', perluLogMasuk, (req, res) => {
  const p = projekMilik(req, req.params.id);
  if (!p) return salah(res, 404, 'Projek tidak dijumpai.');
  const sampah = db.prepare('SELECT id, title, deleted_at FROM chapters WHERE project_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(p.id);
  res.json({ ...p, last_analysis: p.last_analysis ? JSON.parse(p.last_analysis) : null, bab: senaraiBab(p.id), sampah });
});

const MEDAN_PEMBACA = ['reader_project', 'reader_target', 'reader_needs', 'reader_message', 'reader_change'];
app.put('/api/projects/:id', perluLogMasuk, (req, res) => {
  const p = projekMilik(req, req.params.id);
  if (!p) return salah(res, 404, 'Projek tidak dijumpai.');
  const title = req.body.title !== undefined ? (tapis(req.body.title, 200).trim() || p.title) : p.title;
  const nilai = MEDAN_PEMBACA.map((k) => (req.body[k] !== undefined ? tapis(req.body[k], 5000) : p[k]));
  db.prepare(`UPDATE projects SET title = ?, ${MEDAN_PEMBACA.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(title, ...nilai, p.id);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', perluLogMasuk, (req, res) => {
  const p = projekMilik(req, req.params.id);
  if (!p) return salah(res, 404, 'Projek tidak dijumpai.');
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// ---------- Bab ----------
app.post('/api/projects/:id/chapters', perluLogMasuk, (req, res) => {
  const p = projekMilik(req, req.params.id);
  if (!p) return salah(res, 404, 'Projek tidak dijumpai.');
  const { m } = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM chapters WHERE project_id = ?').get(p.id);
  const title = tapis(req.body.title, 200).trim() || `Bab ${senaraiBab(p.id).length + 1} (judul sementara)`;
  const r = db.prepare('INSERT INTO chapters (project_id, title, position, content_html) VALUES (?, ?, ?, ?)').run(p.id, title, m + 1, bersihkanHtml(req.body.content_html || ''));
  sentuhProjek(p.id);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.get('/api/chapters/:id', perluLogMasuk, (req, res) => {
  const c = babMilik(req, req.params.id);
  if (!c || c.deleted_at) return salah(res, 404, 'Bab tidak dijumpai.');
  const p = projekMilik(req, c.project_id);
  res.json({ id: c.id, title: c.title, content_html: c.content_html, updated_at: c.updated_at, project: { id: p.id, title: p.title } });
});

app.put('/api/chapters/:id', perluLogMasuk, (req, res) => {
  const c = babMilik(req, req.params.id);
  if (!c || c.deleted_at) return salah(res, 404, 'Bab tidak dijumpai.');
  const title = req.body.title !== undefined ? (tapis(req.body.title, 200).trim() || c.title) : c.title;
  const html = req.body.content_html !== undefined ? bersihkanHtml(tapis(req.body.content_html, 2_000_000)) : c.content_html;
  db.prepare("UPDATE chapters SET title = ?, content_html = ?, updated_at = datetime('now') WHERE id = ?").run(title, html, c.id);
  sentuhProjek(c.project_id);
  res.json({ ok: true, updated_at: db.prepare('SELECT updated_at FROM chapters WHERE id = ?').get(c.id).updated_at });
});

app.post('/api/chapters/:id/move', perluLogMasuk, (req, res) => {
  const c = babMilik(req, req.params.id);
  if (!c || c.deleted_at) return salah(res, 404, 'Bab tidak dijumpai.');
  const senarai = senaraiBab(c.project_id);
  const i = senarai.findIndex((b) => b.id === c.id);
  const j = req.body.direction === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < senarai.length) {
    [senarai[i], senarai[j]] = [senarai[j], senarai[i]];
    const kemas = db.prepare('UPDATE chapters SET position = ? WHERE id = ?');
    senarai.forEach((b, k) => kemas.run(k + 1, b.id));
    sentuhProjek(c.project_id);
  }
  res.json({ bab: senaraiBab(c.project_id) });
});

app.delete('/api/chapters/:id', perluLogMasuk, (req, res) => {
  const c = babMilik(req, req.params.id);
  if (!c) return salah(res, 404, 'Bab tidak dijumpai.');
  if (req.query.permanent === '1') {
    if (!c.deleted_at) return salah(res, 400, 'Bab mesti berada dalam tong sampah dahulu.');
    db.prepare('DELETE FROM chapters WHERE id = ?').run(c.id);
  } else {
    db.prepare("UPDATE chapters SET deleted_at = datetime('now') WHERE id = ?").run(c.id);
  }
  sentuhProjek(c.project_id);
  res.json({ ok: true });
});

app.post('/api/chapters/:id/restore', perluLogMasuk, (req, res) => {
  const c = babMilik(req, req.params.id);
  if (!c || !c.deleted_at) return salah(res, 404, 'Bab tidak dijumpai dalam tong sampah.');
  const { m } = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM chapters WHERE project_id = ? AND deleted_at IS NULL').get(c.project_id);
  db.prepare('UPDATE chapters SET deleted_at = NULL, position = ? WHERE id = ?').run(m + 1, c.id);
  sentuhProjek(c.project_id);
  res.json({ ok: true });
});

// ---------- Muat turun ----------
async function hantarFail(res, { judul, bab, format }) {
  if (format === 'txt') {
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(namaFail(judul))}.txt` });
    return res.send('﻿' + binaTxt(judul, bab));
  }
  const buf = await binaDocx(judul, bab);
  res.set({ 'Content-Type': drive.MIME.docx, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(namaFail(judul))}.docx` });
  res.send(buf);
}

function babUntukEksport(req, { chapterId, projectId, ids }) {
  if (chapterId) {
    const c = babMilik(req, chapterId);
    if (!c || c.deleted_at) return null;
    return { judul: c.title, bab: [c], projectId: c.project_id };
  }
  const p = projekMilik(req, projectId);
  if (!p) return null;
  let bab = db.prepare('SELECT * FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, id').all(p.id);
  if (ids?.length) bab = bab.filter((b) => ids.includes(b.id)); // susunan semasa dikekalkan
  return { judul: p.title, bab, projectId: p.id };
}

app.get('/api/chapters/:id/export', perluLogMasuk, async (req, res, next) => {
  try {
    const d = babUntukEksport(req, { chapterId: req.params.id });
    if (!d) return salah(res, 404, 'Bab tidak dijumpai.');
    await hantarFail(res, { ...d, format: req.query.format });
  } catch (e) { next(e); }
});

app.get('/api/projects/:id/export', perluLogMasuk, async (req, res, next) => {
  try {
    const ids = req.query.ids ? String(req.query.ids).split(',').map(Number).filter(Boolean) : null;
    const d = babUntukEksport(req, { projectId: req.params.id, ids });
    if (!d) return salah(res, 404, 'Projek tidak dijumpai.');
    if (!d.bab.length) return salah(res, 400, 'Tiada bab untuk dimuat turun.');
    await hantarFail(res, { ...d, format: req.query.format });
  } catch (e) { next(e); }
});

// ---------- AI ----------
function perluHadAI(req, res, next) {
  if (!hadKadar(`ai:${req.user.id}`, HAD_AI_SEJAM, 3600e3)) return salah(res, 429, 'Had penggunaan AI sejam telah dicapai. Cuba lagi kemudian.');
  next();
}
const projekBagiBab = (req, chapterId) => {
  const c = chapterId ? babMilik(req, chapterId) : null;
  return c ? projekMilik(req, c.project_id) : null;
};
const ai_route = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    if (e.status && e.message) return salah(res, e.status, e.message);
    console.error(e);
    salah(res, 500, 'Ralat semasa memproses permintaan AI.');
  }
};
function wajib(teks, nama, max = 40000) {
  const t = tapis(teks, max + 1).trim();
  if (!t) { const e = new Error(`Tiada ${nama} untuk diproses.`); e.status = 400; throw e; }
  if (t.length > max) { const e = new Error(`${nama[0].toUpperCase() + nama.slice(1)} terlalu panjang. Pilih bahagian yang lebih pendek.`); e.status = 413; throw e; }
  return t;
}

app.post('/api/ai/transcript', perluLogMasuk, perluHadAI, ai_route((req) => ai.kemaskanTranskrip(wajib(req.body.text, 'transkrip', 20000))));
app.post('/api/ai/review', perluLogMasuk, perluHadAI, ai_route(async (req) => {
  const hasil = await ai.semakTulisan(wajib(req.body.text, 'teks', 15000), projekBagiBab(req, req.body.chapter_id));
  // Rekod isu untuk analisis admin (kata seerti bukan kesilapan, jadi tidak direkod)
  const simpan = db.prepare('INSERT INTO language_issues (user_id, jenis, asal, cadangan, sebab) VALUES (?, ?, ?, ?, ?)');
  for (const c of hasil.cadangan || []) {
    if (c.jenis === 'kata seerti') continue;
    simpan.run(req.user.id, c.jenis, tapis(c.asal, 300), tapis(c.cadangan, 300), tapis(c.sebab, 300));
  }
  return hasil;
}));
app.post('/api/ai/facts', perluLogMasuk, perluHadAI, ai_route((req) => ai.cariFakta(wajib(req.body.query, 'kata kunci carian', 500), tapis(req.body.context, 3000), projekBagiBab(req, req.body.chapter_id))));
app.post('/api/ai/prompts', perluLogMasuk, perluHadAI, ai_route((req) => ai.soalanPendorong(wajib(req.body.selection, 'teks dipilih', 6000), tapis(req.body.context, 4000), projekBagiBab(req, req.body.chapter_id))));
app.post('/api/ai/paragraph', perluLogMasuk, perluHadAI, ai_route((req) => ai.ulasPerenggan(wajib(req.body.paragraph, 'perenggan', 6000), tapis(req.body.context, 4000), projekBagiBab(req, req.body.chapter_id), req.body.previous || null)));
app.post('/api/projects/:id/analyze', perluLogMasuk, perluHadAI, ai_route(async (req) => {
  const p = projekMilik(req, req.params.id);
  if (!p) { const e = new Error('Projek tidak dijumpai.'); e.status = 404; throw e; }
  const bab = db.prepare('SELECT title, content_html FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, id').all(p.id)
    .map((b) => ({ title: b.title, teks: htmlKeTeks(b.content_html) }));
  const hasil = await ai.analisisProjek(p, bab);
  hasil.dijana_pada = new Date().toISOString();
  db.prepare('UPDATE projects SET last_analysis = ? WHERE id = ?').run(JSON.stringify(hasil), p.id);
  return hasil;
}));

// ---------- Google Drive ----------
app.get('/api/google/connect', perluLogMasuk, (req, res) => {
  if (!drive.dikonfigurasi()) return salah(res, 501, 'Google Drive belum dikonfigurasi oleh pentadbir.');
  res.redirect(drive.urlKebenaran(req.user.id));
});
app.get('/api/google/callback', async (req, res) => {
  if (req.query.error) return res.redirect('/#/projek?google=batal');
  try { await drive.tukarKod(String(req.query.code || ''), String(req.query.state || '')); res.redirect('/#/projek?google=ok'); } catch (e) {
    console.error(e); res.redirect('/#/projek?google=gagal');
  }
});
app.post('/api/google/disconnect', perluLogMasuk, (req, res) => { drive.putuskan(req.user.id); res.json({ ok: true }); });

const drive_route = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) { console.error(e); salah(res, e.status || 500, e.message || 'Ralat Google Drive.'); }
};
app.post('/api/google/save', perluLogMasuk, drive_route(async (req) => {
  const format = req.body.format === 'txt' ? 'txt' : 'docx';
  const d = babUntukEksport(req, { chapterId: req.body.chapter_id, projectId: req.body.project_id });
  if (!d || !d.bab.length) { const e = new Error('Tiada kandungan untuk disimpan.'); e.status = 404; throw e; }
  const buffer = format === 'txt' ? Buffer.from('﻿' + binaTxt(d.judul, d.bab), 'utf8') : await binaDocx(d.judul, d.bab);
  const satuBab = !!req.body.chapter_id;
  const fileId = satuBab && format === 'docx' ? d.bab[0].drive_file_id : null;
  const fail = await drive.simpan(req.user.id, { nama: `${namaFail(d.judul)}.${format}`, buffer, format, fileId });
  if (satuBab && format === 'docx') db.prepare('UPDATE chapters SET drive_file_id = ? WHERE id = ?').run(fail.id, d.bab[0].id);
  return fail;
}));
app.get('/api/google/files', perluLogMasuk, drive_route((req) => drive.senarai(req.user.id)));
app.post('/api/google/import', perluLogMasuk, drive_route(async (req) => {
  const p = projekMilik(req, req.body.project_id);
  if (!p) { const e = new Error('Projek tidak dijumpai.'); e.status = 404; throw e; }
  const { meta, buffer } = await drive.muatTurun(req.user.id, String(req.body.file_id || ''));
  let html;
  if (meta.mimeType === drive.MIME.docx) html = (await mammoth.convertToHtml({ buffer })).value;
  else if (meta.mimeType === drive.MIME.txt) html = teksKeHtml(buffer.toString('utf8').replace(/^﻿/, ''));
  else { const e = new Error('Hanya fail DOCX atau TXT boleh dibuka.'); e.status = 400; throw e; }
  const { m } = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM chapters WHERE project_id = ?').get(p.id);
  const title = meta.name.replace(/\.(docx|txt)$/i, '').replace(/_/g, ' ');
  const r = db.prepare('INSERT INTO chapters (project_id, title, position, content_html, drive_file_id) VALUES (?, ?, ?, ?, ?)')
    .run(p.id, title, m + 1, bersihkanHtml(html), meta.mimeType === drive.MIME.docx ? meta.id : null);
  sentuhProjek(p.id);
  return { id: Number(r.lastInsertRowid) };
}));

// ---------- Panel admin ----------
app.get('/api/admin/users', perluLogMasuk, perluAdmin, (req, res) => {
  const rows = db.prepare(`SELECT u.id, u.full_name, u.email, u.phone, u.role, u.disabled, u.admin_note, u.created_at, u.last_active_at,
      (SELECT count(*) FROM projects p WHERE p.user_id = u.id) AS bilangan_projek,
      (SELECT count(*) FROM chapters c JOIN projects p ON p.id = c.project_id WHERE p.user_id = u.id AND c.deleted_at IS NULL) AS bilangan_bab,
      CAST(julianday('now') - julianday(COALESCE(u.last_active_at, u.created_at)) AS REAL) AS hari_tidak_aktif
    FROM users u ORDER BY COALESCE(u.last_active_at, u.created_at) DESC`).all();
  res.json(rows.map((r) => ({ ...r, tidak_aktif_5_hari: r.hari_tidak_aktif >= 5, whatsapp: noWhatsApp(r.phone) ? `https://wa.me/${noWhatsApp(r.phone)}` : null })));
});

// Statistik isu bahasa dan analisis terakhir
function statistikIsu(hari) {
  const julat = `-${hari} days`;
  const jumlah = db.prepare("SELECT count(*) AS n, count(DISTINCT user_id) AS pengguna FROM language_issues WHERE created_at >= datetime('now', ?)").get(julat);
  const ikutJenis = db.prepare("SELECT jenis, count(*) AS n FROM language_issues WHERE created_at >= datetime('now', ?) GROUP BY jenis ORDER BY n DESC").all(julat);
  const ikutPengguna = db.prepare(`SELECT u.full_name AS nama, count(*) AS n FROM language_issues i JOIN users u ON u.id = i.user_id
    WHERE i.created_at >= datetime('now', ?) GROUP BY i.user_id ORDER BY n DESC LIMIT 10`).all(julat);
  return { hari, jumlah_isu: jumlah.n, bilangan_pengguna: jumlah.pengguna, ikut_jenis: ikutJenis, pengguna_paling_banyak_isu: ikutPengguna };
}
const hariSah = (h) => ([7, 30, 90, 365].includes(Number(h)) ? Number(h) : 30);

app.get('/api/admin/language', perluLogMasuk, perluAdmin, (req, res) => {
  const lapor = db.prepare("SELECT value FROM admin_reports WHERE key = 'isu_bahasa'").get();
  res.json({ statistik: statistikIsu(hariSah(req.query.hari)), analisis: lapor ? JSON.parse(lapor.value) : null });
});

app.post('/api/admin/language/analyze', perluLogMasuk, perluAdmin, perluHadAI, ai_route(async (req) => {
  const hari = hariSah(req.body.hari);
  const statistik = statistikIsu(hari);
  if (statistik.jumlah_isu < 5) {
    const e = new Error(`Belum cukup data: hanya ${statistik.jumlah_isu} isu direkod dalam ${hari} hari terakhir. Isu direkod setiap kali pengguna menggunakan Semakan Tulisan.`);
    e.status = 400; throw e;
  }
  const isu = db.prepare(`SELECT u.full_name AS pengguna, i.jenis, i.asal, i.cadangan, i.sebab FROM language_issues i JOIN users u ON u.id = i.user_id
    WHERE i.created_at >= datetime('now', ?) ORDER BY i.created_at DESC LIMIT 600`).all(`-${hari} days`);
  const hasil = await ai.analisisIsuBahasa(isu, statistik);
  hasil.dijana_pada = new Date().toISOString();
  hasil.statistik = statistik;
  db.prepare(`INSERT INTO admin_reports (key, value) VALUES ('isu_bahasa', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = datetime('now')`).run(JSON.stringify(hasil));
  return hasil;
}));

app.get('/api/admin/language/report', perluLogMasuk, perluAdmin, async (req, res, next) => {
  try {
    const lapor = db.prepare("SELECT value FROM admin_reports WHERE key = 'isu_bahasa'").get();
    if (!lapor) return salah(res, 404, 'Belum ada analisis untuk dimuat turun.');
    const a = JSON.parse(lapor.value);
    const nama = `Analisis_Isu_Bahasa_${a.dijana_pada.slice(0, 10)}`;
    if (req.query.format === 'pdf') {
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${nama}.pdf"` });
      return res.send(await laporan.binaPdfLaporan(a));
    }
    res.set({ 'Content-Type': drive.MIME.docx, 'Content-Disposition': `attachment; filename="${nama}.docx"` });
    res.send(await laporan.binaDocxLaporan(a));
  } catch (e) { next(e); }
});

app.put('/api/admin/users/:id', perluLogMasuk, perluAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return salah(res, 404, 'Pengguna tidak dijumpai.');
  const full_name = req.body.full_name !== undefined ? tapis(req.body.full_name, 120).trim() : u.full_name;
  const email = req.body.email !== undefined ? tapis(req.body.email, 200).trim().toLowerCase() : u.email;
  const phone = req.body.phone !== undefined ? tapis(req.body.phone, 30).trim() : u.phone;
  const admin_note = req.body.admin_note !== undefined ? tapis(req.body.admin_note, 2000) : u.admin_note;
  let disabled = req.body.disabled !== undefined ? (req.body.disabled ? 1 : 0) : u.disabled;
  if (u.email === ADMIN_EMAIL) disabled = 0; // akaun admin utama tidak boleh dinyahaktifkan
  if (!full_name || !emelSah(email)) return salah(res, 400, 'Nama atau e-mel tidak sah.');
  if (u.email === ADMIN_EMAIL && email !== ADMIN_EMAIL) return salah(res, 400, 'E-mel akaun admin utama tidak boleh ditukar di sini.');
  if (email !== u.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return salah(res, 409, 'E-mel sudah digunakan.');
  db.prepare('UPDATE users SET full_name = ?, email = ?, phone = ?, admin_note = ?, disabled = ? WHERE id = ?').run(full_name, email, phone, admin_note, disabled, u.id);
  if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/password', perluLogMasuk, perluAdmin, async (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return salah(res, 404, 'Pengguna tidak dijumpai.');
  const baru = String(req.body.password || '');
  if (baru.length < 8) return salah(res, 400, 'Kata laluan mesti sekurang-kurangnya 8 aksara.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(baru, 12), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', perluLogMasuk, perluAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return salah(res, 404, 'Pengguna tidak dijumpai.');
  if (u.email === ADMIN_EMAIL || u.id === req.user.id) return salah(res, 400, 'Akaun admin tidak boleh dipadam.');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  res.json({ ok: true });
});

// ---------- Semakan kesihatan (untuk hos) ----------
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- Fail statik ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/api', (req, res) => salah(res, 404, 'Tidak dijumpai.'));
app.use((err, req, res, _next) => { console.error(err); salah(res, 500, 'Ralat pelayan.'); });

app.listen(PORT, () => console.log(`Ruang Menulis berjalan di http://localhost:${PORT} (model AI: ${ai.MODEL})`));
