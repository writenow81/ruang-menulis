// Integrasi Google Drive (OAuth 2.0, skop drive.file).
// Skop drive.file hanya memberi akses kepada fail yang dicipta atau dibuka oleh aplikasi ini,
// bukan keseluruhan Drive pengguna. Kebenaran ini berasingan daripada log masuk aplikasi.
const crypto = require('node:crypto');
const db = require('./db');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:3000'}/api/google/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Ruang Menulis';

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

function dikonfigurasi() { return !!(CLIENT_ID && CLIENT_SECRET); }

function urlKebenaran(userId) {
  const state = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO oauth_states (state, user_id) VALUES (?, ?)').run(state, userId);
  const p = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tukarKod(code, state) {
  const row = db.prepare("SELECT user_id FROM oauth_states WHERE state = ? AND created_at > datetime('now', '-15 minutes')").get(state);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  if (!row) throw new Error('Sesi kebenaran Google tidak sah atau tamat tempoh.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }),
  });
  const t = await res.json();
  if (!res.ok) throw new Error(t.error_description || 'Gagal menyambung Google Drive.');
  const lama = db.prepare('SELECT refresh_token FROM google_tokens WHERE user_id = ?').get(row.user_id);
  db.prepare(`INSERT INTO google_tokens (user_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`)
    .run(row.user_id, t.access_token, t.refresh_token || lama?.refresh_token || null, Date.now() + (t.expires_in - 60) * 1000);
  return row.user_id;
}

function bersambung(userId) {
  return !!db.prepare('SELECT 1 FROM google_tokens WHERE user_id = ? AND refresh_token IS NOT NULL').get(userId);
}

function putuskan(userId) {
  const row = db.prepare('SELECT refresh_token FROM google_tokens WHERE user_id = ?').get(userId);
  db.prepare('DELETE FROM google_tokens WHERE user_id = ?').run(userId);
  if (row?.refresh_token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.refresh_token)}`, { method: 'POST' }).catch(() => {});
  }
}

async function tokenAkses(userId) {
  const row = db.prepare('SELECT * FROM google_tokens WHERE user_id = ?').get(userId);
  if (!row) { const e = new Error('Google Drive belum disambungkan.'); e.status = 400; throw e; }
  if (row.access_token && row.expires_at > Date.now()) return row.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: row.refresh_token, grant_type: 'refresh_token' }),
  });
  const t = await res.json();
  if (!res.ok) {
    db.prepare('DELETE FROM google_tokens WHERE user_id = ?').run(userId);
    const e = new Error('Kebenaran Google Drive telah tamat. Sila sambung semula.'); e.status = 401; throw e;
  }
  db.prepare('UPDATE google_tokens SET access_token = ?, expires_at = ? WHERE user_id = ?').run(t.access_token, Date.now() + (t.expires_in - 60) * 1000, userId);
  return t.access_token;
}

async function api(userId, url, opts = {}) {
  const token = await tokenAkses(userId);
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let msg = `Ralat Google Drive (${res.status})`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch { /* abaikan */ }
    const e = new Error(msg); e.status = res.status === 404 ? 404 : 502; throw e;
  }
  return res;
}

async function folderId(userId) {
  const q = encodeURIComponent(`name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const r = await (await api(userId, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`)).json();
  if (r.files?.length) return r.files[0].id;
  const c = await (await api(userId, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })).json();
  return c.id;
}

function multipart(metadata, buffer, mime) {
  const boundary = 'rm' + crypto.randomBytes(12).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

// Simpan fail. Jika fileId diberi, kemas kini fail sedia ada; jika tidak, cipta fail baharu.
async function simpan(userId, { nama, buffer, format, fileId }) {
  const mime = MIME[format];
  if (fileId) {
    try {
      const { body, contentType } = multipart({ name: nama }, buffer, mime);
      return await (await api(userId, `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,name,webViewLink`, {
        method: 'PATCH', headers: { 'Content-Type': contentType }, body,
      })).json();
    } catch (e) { if (e.status !== 404) throw e; } // fail telah dipadam di Drive: cipta yang baharu
  }
  const parent = await folderId(userId);
  const { body, contentType } = multipart({ name: nama, parents: [parent] }, buffer, mime);
  return (await api(userId, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST', headers: { 'Content-Type': contentType }, body,
  })).json();
}

async function senarai(userId) {
  const q = encodeURIComponent(`trashed = false and (mimeType = '${MIME.docx}' or mimeType = '${MIME.txt}')`);
  const r = await (await api(userId, `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=50&fields=files(id,name,mimeType,modifiedTime)`)).json();
  return r.files || [];
}

async function muatTurun(userId, fileId) {
  const meta = await (await api(userId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`)).json();
  const res = await api(userId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
  return { meta, buffer: Buffer.from(await res.arrayBuffer()) };
}

module.exports = { dikonfigurasi, urlKebenaran, tukarKod, bersambung, putuskan, simpan, senarai, muatTurun, MIME };
