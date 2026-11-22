/* Ruang Menulis: aplikasi pelanggan (tanpa rangka kerja) */
'use strict';

// ---------- Utiliti DOM ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // hanya untuk HTML yang telah dibersihkan pelayan
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// Abaikan null/false apabila menggantikan kandungan (seperti h())
const _ganti = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) { return _ganti.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function tarikh(s) {
  if (!s) return '-';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ms-MY', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function loading(teks = 'Sedang memproses…') { return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), teks); }

// ---------- API ----------
async function api(method, url, body, opts = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Requested-With': 'RuangMenulis', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    keepalive: !!opts.keepalive,
  });
  let data = null;
  try { data = await res.json(); } catch { /* tiada JSON */ }
  if (res.status === 401 && !opts.biar401) { state.me = null; go('#/masuk'); throw new Error(data?.error || 'Sila log masuk.'); }
  if (!res.ok) throw new Error(data?.error || `Ralat (${res.status})`);
  return data;
}

// ---------- Dialog ----------
function dialog({ tajuk, isi = [], butang = [] }) {
  return new Promise((resolve) => {
    const d = $('#dialog');
    const f = $('#dialog-form');
    f.replaceChildren(
      h('h2', {}, tajuk),
      h('div', { class: 'stack' }, isi),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:18px' },
        butang.map((b) => h('button', { value: b.nilai, class: b.kelas || '', type: 'submit' }, b.label))),
    );
    d.onclose = () => resolve(d.returnValue);
    d.returnValue = '';
    d.showModal();
  });
}
async function sahkan(mesej, labelOk = 'Ya', bahaya = false) {
  const r = await dialog({ tajuk: 'Pengesahan', isi: [h('p', {}, mesej)], butang: [{ label: 'Batal', nilai: 'batal' }, { label: labelOk, nilai: 'ok', kelas: bahaya ? 'btn-primary btn-danger' : 'btn-primary' }] });
  return r === 'ok';
}
async function mintaTeks(tajuk, label, nilai = '') {
  const input = h('input', { value: nilai, maxlength: '200' });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  const r = await dialog({ tajuk, isi: [h('label', {}, label), input], butang: [{ label: 'Batal', nilai: 'batal' }, { label: 'Simpan', nilai: 'ok', kelas: 'btn-primary' }] });
  return r === 'ok' ? input.value.trim() : null;
}

// ---------- Keadaan & penghalaan ----------
const state = { me: null, cleanup: null };
function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

async function muatMe() {
  try { state.me = await api('GET', '/api/me', null, { biar401: true }); } catch { state.me = null; }
  const ada = !!state.me;
  $('#topbar').hidden = !ada;
  if (ada) {
    $('#nav-nama').textContent = state.me.full_name;
    $('#nav-admin').hidden = state.me.role !== 'admin';
  }
}

$('#btn-logout').addEventListener('click', async () => {
  // Simpan kerja yang belum disimpan sebelum sesi ditamatkan
  if (state.cleanup) { try { await state.cleanup(); } catch { /* abaikan */ } state.cleanup = null; }
  await api('POST', '/api/logout');
  state.me = null; await muatMe(); go('#/masuk');
});

async function route() {
  if (state.cleanup) { try { await state.cleanup(); } catch { /* abaikan */ } state.cleanup = null; }
  const [laluan, query] = location.hash.replace(/^#/, '').split('?');
  const bahagian = laluan.split('/').filter(Boolean);
  if (!state.me) await muatMe();
  const awam = ['masuk', 'daftar'].includes(bahagian[0]);
  if (!state.me && !awam) return go('#/masuk');
  if (state.me && awam) return go('#/projek');
  const params = new URLSearchParams(query || '');
  window.scrollTo(0, 0);
  try {
    if (bahagian[0] === 'masuk') return paparMasuk();
    if (bahagian[0] === 'daftar') return paparDaftar();
    if (bahagian[0] === 'projek' && bahagian[1]) return paparProjek(Number(bahagian[1]), params.get('tab') || 'bab');
    if (bahagian[0] === 'bab' && bahagian[1]) return paparBab(Number(bahagian[1]));
    if (bahagian[0] === 'admin') return paparAdmin();
    return paparSenaraiProjek(params);
  } catch (e) { app.replaceChildren(h('div', { class: 'card' }, e.message)); }
}
window.addEventListener('hashchange', route);

// ---------- Pendaftaran & log masuk ----------
function borangAuth(tajuk, medan, labelHantar, onSubmit, bawah) {
  const ralat = h('p', { class: 'small', style: 'color:var(--danger)' });
  const btn = h('button', { class: 'btn-primary', type: 'submit', style: 'width:100%;justify-content:center;margin-top:16px' }, labelHantar);
  const form = h('form', { class: 'card auth' },
    h('h1', {}, tajuk),
    medan.map(([nama, label, jenis, extra = {}]) => [h('label', { for: nama }, label, extra.hint ? h('span', { class: 'hint' }, extra.hint) : null), h('input', { id: nama, name: nama, type: jenis, required: true, ...extra.attrs })]),
    ralat, btn, h('p', { class: 'small', style: 'text-align:center' }, bawah));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); ralat.textContent = ''; btn.disabled = true;
    try { await onSubmit(Object.fromEntries(new FormData(form))); await muatMe(); go('#/projek'); } catch (err) { ralat.textContent = err.message; } finally { btn.disabled = false; }
  });
  app.replaceChildren(form);
}

function paparMasuk() {
  borangAuth('Log masuk', [
    ['email', 'E-mel', 'email', { attrs: { autocomplete: 'email' } }],
    ['password', 'Kata laluan', 'password', { attrs: { autocomplete: 'current-password' } }],
  ], 'Log masuk', (d) => api('POST', '/api/login', d), ['Kali pertama di sini? ', h('a', { href: '#/daftar' }, 'Daftar akaun')]);
}

function paparDaftar() {
  borangAuth('Daftar akaun', [
    ['full_name', 'Nama penuh', 'text', { attrs: { autocomplete: 'name', minlength: '3' } }],
    ['email', 'E-mel', 'email', { attrs: { autocomplete: 'email' }, hint: 'Digunakan untuk log masuk.' }],
    ['phone', 'Nombor telefon', 'tel', { attrs: { autocomplete: 'tel', placeholder: '012-345 6789' } }],
    ['password', 'Kata laluan', 'password', { attrs: { autocomplete: 'new-password', minlength: '8' }, hint: 'Sekurang-kurangnya 8 aksara. Anda akan menggunakannya untuk log masuk seterusnya.' }],
  ], 'Daftar dan mula menulis', (d) => api('POST', '/api/register', d), ['Sudah ada akaun? ', h('a', { href: '#/masuk' }, 'Log masuk')]);
}

// ---------- Senarai projek ----------
async function paparSenaraiProjek(params) {
  const g = params?.get('google');
  if (g === 'ok') toast('Google Drive berjaya disambungkan.');
  if (g === 'gagal') toast('Gagal menyambung Google Drive.');
  app.replaceChildren(loading('Memuatkan projek…'));
  const projek = await api('GET', '/api/projects');
  const baru = async () => {
    const title = await mintaTeks('Projek baharu', 'Judul projek (boleh ditukar kemudian)');
    if (title === null) return;
    const r = await api('POST', '/api/projects', { title });
    go(`#/projek/${r.id}?tab=pembaca`);
  };
  app.replaceChildren(
    h('div', { class: 'spread' }, h('h1', {}, 'Projek penulisan saya'), h('button', { class: 'btn-primary', onclick: baru }, '+ Projek baharu')),
    h('p', { class: 'muted' }, 'Aliran: cipta projek → isi Zon Kenal Pembaca → tulis mana-mana bab → susun bab → muat turun.'),
    projek.length
      ? h('div', { class: 'grid-projects' }, projek.map((p) => h('a', { class: 'card project-card', href: `#/projek/${p.id}` },
        h('h3', {}, p.title), h('div', { class: 'muted small' }, `${p.bilangan_bab} bab · dikemas kini ${tarikh(p.updated_at)}`))))
      : h('div', { class: 'card' }, h('p', {}, 'Belum ada projek. Mulakan dengan mencipta projek pertama anda.')),
  );
}

// ---------- Halaman projek ----------
async function paparProjek(id, tab) {
  app.replaceChildren(loading('Memuatkan projek…'));
  const p = await api('GET', `/api/projects/${id}`);
  const tabs = [['bab', 'Senarai Bab'], ['pembaca', 'Zon Kenal Pembaca'], ['sampah', `Tong Sampah (${p.sampah.length})`], ['drive', 'Google Drive']];
  const kandungan = h('div');

  const tukarJudul = async () => {
    const t = await mintaTeks('Tukar judul projek', 'Judul projek', p.title);
    if (!t) return;
    await api('PUT', `/api/projects/${id}`, { title: t }); paparProjek(id, tab);
  };
  const padamProjek = async () => {
    if (!(await sahkan(`Padam projek "${p.title}" beserta SEMUA babnya secara kekal? Tindakan ini tidak boleh dibatalkan.`, 'Padam projek', true))) return;
    await api('DELETE', `/api/projects/${id}`); toast('Projek dipadam.'); go('#/projek');
  };

  app.replaceChildren(
    h('p', { class: 'small' }, h('a', { href: '#/projek' }, '← Semua projek')),
    h('div', { class: 'spread' }, h('h1', {}, p.title),
      h('div', { class: 'row' }, h('button', { class: 'btn-sm', onclick: tukarJudul }, 'Tukar judul'), h('button', { class: 'btn-sm btn-danger', onclick: padamProjek }, 'Padam projek'))),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onclick: () => go(`#/projek/${id}?tab=${k}`) }, l))),
    kandungan,
  );

  if (tab === 'pembaca') return tabPembaca(p, kandungan);
  if (tab === 'sampah') return tabSampah(p, kandungan);
  if (tab === 'drive') return tabDrive(p, kandungan);
  return tabBab(p, kandungan);
}

function muatTurun(url) {
  const a = h('a', { href: url, download: '' }); document.body.append(a); a.click(); a.remove();
}

function tabBab(p, el) {
  const dipilih = new Set();
  const senarai = h('ul', { class: 'list' });
  const btnTerpilih = h('div', { class: 'row' });

  const babBaru = async () => {
    const title = await mintaTeks('Bab baharu', 'Judul sementara bab', `Bab ${p.bab.length + 1}`);
    if (title === null) return;
    const r = await api('POST', `/api/projects/${p.id}/chapters`, { title });
    go(`#/bab/${r.id}`);
  };

  function lukis() {
    senarai.replaceChildren(...(p.bab.length ? p.bab.map((b, i) => h('li', {},
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: dipilih.has(b.id), 'aria-label': `Pilih ${b.title}`, onchange: (e) => { e.target.checked ? dipilih.add(b.id) : dipilih.delete(b.id); lukisTerpilih(); } })),
      h('span', { class: 'num' }, `${i + 1}.`),
      h('a', { class: 'title', href: `#/bab/${b.id}` }, b.title),
      h('span', { class: 'muted small' }, tarikh(b.updated_at)),
      h('div', { class: 'row' },
        h('button', { class: 'btn-sm', title: 'Naik', 'aria-label': 'Naikkan kedudukan', disabled: i === 0, onclick: () => gerak(b.id, 'up') }, '↑'),
        h('button', { class: 'btn-sm', title: 'Turun', 'aria-label': 'Turunkan kedudukan', disabled: i === p.bab.length - 1, onclick: () => gerak(b.id, 'down') }, '↓'),
        h('a', { class: 'btn btn-sm', href: `#/bab/${b.id}` }, 'Buka'),
        h('button', { class: 'btn-sm', onclick: () => namakan(b) }, 'Judul'),
        h('button', { class: 'btn-sm', onclick: () => muatTurun(`/api/chapters/${b.id}/export?format=docx`) }, 'DOCX'),
        h('button', { class: 'btn-sm', onclick: () => muatTurun(`/api/chapters/${b.id}/export?format=txt`) }, 'TXT'),
        h('button', { class: 'btn-sm btn-danger', onclick: () => padam(b) }, 'Padam')),
    )) : [h('li', {}, h('span', { class: 'muted' }, 'Belum ada bab. Anda boleh mula dengan mana-mana bab dan menyusunnya kemudian.'))]));
    lukisTerpilih();
  }
  function lukisTerpilih() {
    const ids = p.bab.filter((b) => dipilih.has(b.id)).map((b) => b.id).join(',');
    btnTerpilih.replaceChildren(
      h('span', { class: 'muted small' }, dipilih.size ? `${dipilih.size} bab dipilih:` : 'Muat turun semua bab mengikut susunan semasa:'),
      h('button', { class: 'btn-sm', disabled: !p.bab.length, onclick: () => muatTurun(`/api/projects/${p.id}/export?format=docx${ids ? `&ids=${ids}` : ''}`) }, 'Word (DOCX)'),
      h('button', { class: 'btn-sm', disabled: !p.bab.length, onclick: () => muatTurun(`/api/projects/${p.id}/export?format=txt${ids ? `&ids=${ids}` : ''}`) }, 'TXT'),
    );
  }
  async function gerak(babId, direction) {
    const r = await api('POST', `/api/chapters/${babId}/move`, { direction });
    p.bab = r.bab; lukis();
  }
  async function namakan(b) {
    const t = await mintaTeks('Tukar judul bab', 'Judul bab', b.title);
    if (!t) return;
    await api('PUT', `/api/chapters/${b.id}`, { title: t }); b.title = t; lukis();
  }
  async function padam(b) {
    if (!(await sahkan(`Padam bab "${b.title}"? Bab akan dipindahkan ke Tong Sampah projek dan boleh dipulihkan.`, 'Padam bab', true))) return;
    await api('DELETE', `/api/chapters/${b.id}`);
    toast('Bab dipindahkan ke Tong Sampah.');
    paparProjek(p.id, 'bab');
  }

  lukis();
  el.replaceChildren(h('div', { class: 'card stack' },
    h('div', { class: 'spread' }, h('h2', {}, 'Senarai Bab'), h('button', { class: 'btn-primary', onclick: babBaru }, '+ Bab baharu')),
    h('p', { class: 'muted small' }, 'Susunan di sini menjadi susunan apabila projek dimuat turun. Fail Word mengekalkan tebal, condong dan senarai berbutir (Arial 11.5, langkau 1.5). TXT hanya menyimpan teks biasa dan pemisah bab.'),
    senarai, btnTerpilih));
}

const MEDAN_PEMBACA = [
  ['reader_project', 'Projek penulisan', 'Bayangan karya, sinopsis atau perkara yang mahu ditulis. Nyatakan juga jenisnya (contoh: kisah hidup, buku panduan, novel).'],
  ['reader_target', 'Pembaca sasaran', 'Siapa yang dijangka membaca.'],
  ['reader_needs', 'Keperluan pembaca', 'Masalah, persoalan atau keperluan yang mahu disentuh.'],
  ['reader_message', 'Mesej utama', 'Perkara terpenting yang mahu disampaikan.'],
  ['reader_change', 'Perubahan yang diharapkan', 'Apa yang anda mahu pembaca fikir, lihat dari sudut baharu atau lakukan selepas membaca.'],
];

function tabPembaca(p, el) {
  const inputs = {};
  const status = h('span', { class: 'save-state' });
  const hasil = h('div');
  const simpan = async () => {
    const body = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
    await api('PUT', `/api/projects/${p.id}`, body);
    Object.assign(p, body);
    status.textContent = 'Disimpan';
  };
  const btnAnalisis = h('button', { class: 'btn-primary' }, 'Analisis Projek');
  btnAnalisis.addEventListener('click', async () => {
    btnAnalisis.disabled = true;
    hasil.replaceChildren(loading('AI sedang menganalisis projek dan bab-bab anda…'));
    try { await simpan(); lukisAnalisis(await api('POST', `/api/projects/${p.id}/analyze`)); } catch (e) { hasil.replaceChildren(h('p', { class: 'card' }, e.message)); } finally { btnAnalisis.disabled = false; }
  });
  function lukisAnalisis(a) {
    if (!a) return hasil.replaceChildren();
    const bahagian = [['sudah_jelas', 'Yang sudah jelas', 'good'], ['masih_kabur', 'Yang masih kabur', 'warn'], ['kelemahan', 'Kelemahan yang mungkin menjejaskan pembaca', 'danger'], ['cadangan', 'Cadangan penambahbaikan', '']];
    hasil.replaceChildren(h('div', { class: 'card stack' },
      h('div', { class: 'spread' }, h('h2', {}, 'Analisis Projek'), h('span', { class: 'muted small' }, a.dijana_pada ? tarikh(a.dijana_pada) : '')),
      h('p', {}, h('span', { class: 'badge' }, a.jenis_projek), ' ', h('span', { class: 'muted small' }, a.ukuran_penilaian)),
      h('div', { class: 'analysis-grid' }, bahagian.map(([k, l, c]) => h('div', { class: 'sugg' }, h('h3', {}, h('span', { class: `badge ${c}` }, l)), h('ul', {}, (a[k] || []).map((t) => h('li', {}, t)))))),
      h('p', { class: 'muted small' }, 'Maklum balas ini cadangan. Anda yang menentukan sama ada mahu mengubah sinopsis, susunan bab atau teks.')));
  }
  let t;
  el.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'spread' }, h('h2', {}, 'Zon Kenal Pembaca'), status),
    h('p', { class: 'muted small' }, 'Isi zon ini supaya AI memahami tujuan karya anda. Ia menjadi rujukan bagi Ulas Perenggan, Semakan Tulisan dan Analisis Projek. Anda boleh kembali mengemas kininya bila-bila masa.'),
    MEDAN_PEMBACA.map(([k, l, hint]) => {
      const ta = h('textarea', { id: k, rows: '3', oninput: () => { status.textContent = 'Belum disimpan…'; clearTimeout(t); t = setTimeout(simpan, 1200); } });
      ta.value = p[k] || '';
      inputs[k] = ta;
      return [h('label', { for: k }, l, h('span', { class: 'hint' }, hint)), ta];
    }),
    h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { onclick: simpan }, 'Simpan'), btnAnalisis),
  ), h('div', { style: 'margin-top:16px' }, hasil));
  lukisAnalisis(p.last_analysis);
  state.cleanup = async () => { clearTimeout(t); if (status.textContent.startsWith('Belum')) await simpan(); };
}

function tabSampah(p, el) {
  el.replaceChildren(h('div', { class: 'card stack' },
    h('h2', {}, 'Tong Sampah'),
    h('p', { class: 'muted small' }, 'Bab yang dipadam disimpan di sini. Pulihkan untuk meletakkannya semula di hujung Senarai Bab.'),
    h('ul', { class: 'list' }, p.sampah.length ? p.sampah.map((b) => h('li', {},
      h('span', { class: 'title' }, b.title), h('span', { class: 'muted small' }, `Dipadam ${tarikh(b.deleted_at)}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn-sm', onclick: async () => { await api('POST', `/api/chapters/${b.id}/restore`); toast('Bab dipulihkan.'); paparProjek(p.id, 'sampah'); } }, 'Pulihkan'),
        h('button', { class: 'btn-sm btn-danger', onclick: async () => {
          if (!(await sahkan(`Padam "${b.title}" secara kekal? Ia tidak boleh dipulihkan lagi.`, 'Padam kekal', true))) return;
          await api('DELETE', `/api/chapters/${b.id}?permanent=1`); paparProjek(p.id, 'sampah');
        } }, 'Padam kekal')))) : [h('li', {}, h('span', { class: 'muted' }, 'Tong sampah kosong.'))])));
}

async function tabDrive(p, el) {
  const g = state.me.google;
  if (!g.dikonfigurasi) {
    return el.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Google Drive'), h('p', {}, 'Integrasi Google Drive belum diaktifkan oleh pentadbir aplikasi.')));
  }
  if (!g.bersambung) {
    return el.replaceChildren(h('div', { class: 'card stack' }, h('h2', {}, 'Google Drive'),
      h('p', {}, 'Sambungkan akaun Google anda untuk menyimpan dan membuka tulisan melalui Google Drive. Kebenaran ini berasingan daripada log masuk Ruang Menulis.'),
      h('p', { class: 'muted small' }, 'Aplikasi hanya dapat mengakses fail yang ia cipta atau anda buka melaluinya (folder "Ruang Menulis"), bukan keseluruhan Drive anda.'),
      h('a', { class: 'btn btn-primary', href: '/api/google/connect' }, 'Sambungkan Google Drive')));
  }
  const fail = h('div', {}, loading('Memuatkan fail Drive…'));
  const simpan = async (format, btn) => {
    btn.disabled = true;
    try { const r = await api('POST', '/api/google/save', { project_id: p.id, format }); toast(`Disimpan ke Drive: ${r.name}`); muatFail(); } catch (e) { toast(e.message); } finally { btn.disabled = false; }
  };
  async function muatFail() {
    try {
      const senarai = await api('GET', '/api/google/files');
      fail.replaceChildren(h('ul', { class: 'list' }, senarai.length ? senarai.map((f) => h('li', {},
        h('span', { class: 'title' }, f.name), h('span', { class: 'muted small' }, tarikh(f.modifiedTime)),
        h('button', { class: 'btn-sm', onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await api('POST', '/api/google/import', { project_id: p.id, file_id: f.id }); toast('Fail dibuka sebagai bab baharu.'); go(`#/bab/${r.id}`); } catch (err) { toast(err.message); e.target.disabled = false; }
        } }, 'Buka sebagai bab baharu'))) : [h('li', {}, h('span', { class: 'muted' }, 'Belum ada fail daripada Ruang Menulis dalam Drive anda.'))]));
    } catch (e) { fail.replaceChildren(h('p', {}, e.message)); }
  }
  const b1 = h('button', { class: 'btn-primary' }, 'Simpan projek ke Drive (DOCX)');
  const b2 = h('button', {}, 'Simpan projek ke Drive (TXT)');
  b1.onclick = () => simpan('docx', b1); b2.onclick = () => simpan('txt', b2);
  el.replaceChildren(h('div', { class: 'card stack' },
    h('div', { class: 'spread' }, h('h2', {}, 'Google Drive'), h('button', { class: 'btn-sm', onclick: async () => {
      if (!(await sahkan('Putuskan sambungan Google Drive? Fail dalam Drive anda tidak akan dipadam.', 'Putuskan'))) return;
      await api('POST', '/api/google/disconnect'); state.me.google.bersambung = false; tabDrive(p, el);
    } }, 'Putuskan sambungan')),
    h('div', { class: 'row' }, b1, b2),
    h('h3', {}, 'Fail dalam folder "Ruang Menulis"'), fail));
  muatFail();
}

// ---------- Zon Menulis ----------
async function paparBab(id) {
  app.replaceChildren(loading('Membuka bab…'));
  const bab = await api('GET', `/api/chapters/${id}`);
  const kunciDraf = `draf:${id}`;

  const status = h('span', { class: 'save-state' }, 'Disimpan');
  const judul = h('input', { class: 'title-input', value: bab.title, 'aria-label': 'Judul bab', maxlength: '200' });
  const editor = h('div', { class: 'editor', contenteditable: 'true', spellcheck: 'true', 'data-placeholder': 'Mula menulis di sini…', html: bab.content_html || '' });

  // Pulihkan draf tempatan jika lebih baharu daripada versi pelayan (contoh: talian terputus)
  try {
    const d = JSON.parse(localStorage.getItem(kunciDraf) || 'null');
    if (d && d.html !== bab.content_html && d.masa > new Date(bab.updated_at.replace(' ', 'T') + 'Z').getTime()) {
      setTimeout(async () => {
        if (await sahkan('Terdapat draf yang belum sempat disimpan ke pelayan pada peranti ini. Pulihkan draf tersebut?', 'Pulihkan draf')) { editor.innerHTML = d.html; tandaUbah(); } else localStorage.removeItem(kunciDraf);
      }, 50);
    }
  } catch { /* abaikan */ }

  // --- Simpan automatik ---
  let pemasa = null; let berubah = false; let sedangSimpan = null;
  function htmlBersih() {
    const c = editor.cloneNode(true);
    c.querySelectorAll('.para-focus').forEach((e) => e.classList.remove('para-focus'));
    c.querySelectorAll('[class=""]').forEach((e) => e.removeAttribute('class'));
    return c.innerHTML;
  }
  function tandaUbah() {
    berubah = true; status.textContent = 'Belum disimpan…';
    try { localStorage.setItem(kunciDraf, JSON.stringify({ html: htmlBersih(), masa: Date.now() })); } catch { /* abaikan */ }
    clearTimeout(pemasa); pemasa = setTimeout(simpan, 1500);
  }
  async function simpan(keepalive = false) {
    clearTimeout(pemasa);
    if (!berubah) return;
    berubah = false; status.textContent = 'Menyimpan…';
    const p = api('PUT', `/api/chapters/${id}`, { title: judul.value, content_html: htmlBersih() }, { keepalive })
      .then(() => { status.textContent = `Disimpan ${new Date().toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' })}`; try { localStorage.removeItem(kunciDraf); } catch { /* abaikan */ } })
      .catch((e) => { berubah = true; status.textContent = 'Gagal disimpan, draf disimpan pada peranti ini'; toast(e.message); });
    sedangSimpan = p; await p;
  }
  editor.addEventListener('input', tandaUbah);
  judul.addEventListener('input', tandaUbah);
  const sebelumTutup = () => { if (berubah) simpan(true); };
  window.addEventListener('beforeunload', sebelumTutup);
  const kekunci = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); berubah = true; simpan(); } };
  document.addEventListener('keydown', kekunci);

  // Tampal sebagai teks biasa untuk mengelakkan gaya asing
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const teks = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, teks);
  });

  // --- Pemilihan & kursor ---
  let julatAkhir = null;
  const ikutPilihan = () => {
    const s = document.getSelection();
    if (s.rangeCount && editor.contains(s.getRangeAt(0).commonAncestorContainer)) julatAkhir = s.getRangeAt(0).cloneRange();
    kemasToolbar();
  };
  document.addEventListener('selectionchange', ikutPilihan);
  const teksDipilih = () => (julatAkhir && !julatAkhir.collapsed ? julatAkhir.toString().trim() : '');
  function blokSemasa() {
    let n = julatAkhir?.startContainer;
    if (!n || !editor.contains(n)) return null;
    while (n && n.parentNode !== editor) {
      if (n.nodeType === 1 && n.tagName === 'LI') return n;
      n = n.parentNode;
    }
    if (n && n.nodeType === 3) { // teks terus dalam editor: balut dalam <p>
      const p = document.createElement('p'); n.replaceWith(p); p.append(n); return p;
    }
    return n && n.nodeType === 1 && n.tagName !== 'UL' ? n : (n?.tagName === 'UL' ? n.querySelector('li') : null);
  }
  const teksBlok = (el) => (el ? el.innerText.trim() : '');
  function konteksSekitar(el) {
    if (!el) return '';
    const sebelum = el.previousElementSibling ? teksBlok(el.previousElementSibling) : '';
    const selepas = el.nextElementSibling ? teksBlok(el.nextElementSibling) : '';
    return [sebelum && `[Sebelum] ${sebelum}`, selepas && `[Selepas] ${selepas}`].filter(Boolean).join('\n').slice(0, 4000);
  }
  function pulihkanKursor() {
    editor.focus();
    if (julatAkhir) { const s = document.getSelection(); s.removeAllRanges(); s.addRange(julatAkhir); }
  }

  // --- Bar alat ---
  const arahan = (cmd) => () => { pulihkanKursor(); document.execCommand(cmd); tandaUbah(); kemasToolbar(); };
  const bB = h('button', { title: 'Tebal (Ctrl+B)', 'aria-label': 'Tebal', onmousedown: (e) => e.preventDefault(), onclick: arahan('bold') }, h('b', {}, 'B'));
  const bI = h('button', { title: 'Condong (Ctrl+I)', 'aria-label': 'Condong', onmousedown: (e) => e.preventDefault(), onclick: arahan('italic') }, h('i', {}, 'I'));
  const bU = h('button', { title: 'Senarai berbutir', 'aria-label': 'Senarai berbutir', onmousedown: (e) => e.preventDefault(), onclick: arahan('insertUnorderedList') }, '• Senarai');
  function kemasToolbar() {
    try {
      bB.classList.toggle('on', document.queryCommandState('bold'));
      bI.classList.toggle('on', document.queryCommandState('italic'));
      bU.classList.toggle('on', document.queryCommandState('insertUnorderedList'));
    } catch { /* abaikan */ }
  }
  const btnUlas = h('button', { class: 'btn-primary', onmousedown: (e) => e.preventDefault(), onclick: () => { bukaPanel('ulas'); ulasPerenggan(false); } }, 'Ulas Perenggan');
  const menuMuatTurun = h('select', { 'aria-label': 'Muat turun atau simpan', class: 'btn-sm', style: 'width:auto' },
    h('option', { value: '' }, 'Muat turun…'),
    h('option', { value: 'docx' }, 'Bab ini: Word (DOCX)'),
    h('option', { value: 'txt' }, 'Bab ini: TXT'),
    state.me.google.dikonfigurasi ? h('option', { value: 'drive' }, 'Simpan ke Google Drive') : null);
  menuMuatTurun.addEventListener('change', async () => {
    const v = menuMuatTurun.value; menuMuatTurun.value = '';
    berubah = true; await simpan();
    if (v === 'docx' || v === 'txt') muatTurun(`/api/chapters/${id}/export?format=${v}`);
    if (v === 'drive') {
      if (!state.me.google.bersambung) { if (await sahkan('Google Drive belum disambungkan. Sambungkan sekarang?', 'Sambungkan')) location.href = '/api/google/connect'; return; }
      try { const r = await api('POST', '/api/google/save', { chapter_id: id, format: 'docx' }); toast(`Disimpan ke Drive: ${r.name}`); } catch (e) { toast(e.message); }
    }
  });

  // --- Panel bantuan ---
  const panelIsi = h('div', { class: 'card' });
  const PANEL = [['ulas', 'Ulas Perenggan'], ['semak', 'Semakan'], ['fakta', 'Carian Fakta'], ['sambung', 'Sambung Menulis'], ['rakam', 'Rakam Suara']];
  let panelAktif = 'ulas';
  const panelTabs = h('div', { class: 'panel-tabs' });
  const keadaanPanel = {}; // simpan kandungan setiap tab
  function bukaPanel(k) {
    panelAktif = k;
    panelTabs.replaceChildren(...PANEL.map(([kk, l]) => h('button', { class: kk === k ? 'active' : '', onmousedown: (e) => e.preventDefault(), onclick: () => bukaPanel(kk) }, l)));
    if (!keadaanPanel[k]) keadaanPanel[k] = binaPanel[k]();
    panelIsi.replaceChildren(keadaanPanel[k]);
    if (window.matchMedia('(max-width: 900px)').matches && k === 'ulas') panelIsi.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 1. Ulas Perenggan
  let perengganDiulas = null; let ulasanSebelum = null;
  const ulasKotak = h('div');
  function tandaPerenggan(el) {
    editor.querySelectorAll('.para-focus').forEach((e) => e.classList.remove('para-focus'));
    if (el) el.classList.add('para-focus');
  }
  async function ulasPerenggan(semula) {
    let el = semula && perengganDiulas?.isConnected ? perengganDiulas : blokSemasa();
    if (!el || !teksBlok(el)) {
      ulasKotak.replaceChildren(h('p', { class: 'muted' }, 'Klik di dalam satu perenggan dahulu, kemudian tekan Ulas Perenggan.'));
      return;
    }
    if (!semula) ulasanSebelum = null;
    perengganDiulas = el; tandaPerenggan(el);
    ulasKotak.replaceChildren(h('p', { class: 'quote small' }, `"${teksBlok(el).slice(0, 160)}${teksBlok(el).length > 160 ? '…' : ''}"`), loading(semula ? 'Mengulas semula…' : 'Mengulas perenggan…'));
    try {
      const r = await api('POST', '/api/ai/paragraph', { chapter_id: id, paragraph: teksBlok(el), context: konteksSekitar(el), previous: ulasanSebelum });
      ulasanSebelum = r;
      lukisUlasan(r, el);
    } catch (e) { ulasKotak.replaceChildren(h('p', {}, e.message)); }
  }
  function lukisUlasan(r, el) {
    const kelas = { baik: 'baik', 'boleh diperkukuh': 'boleh', 'perlu perhatian': 'perlu' };
    const lencana = { baik: 'good', 'boleh diperkukuh': 'warn', 'perlu perhatian': 'danger' };
    const aspek = (nama, a) => h('div', { class: `aspect ${kelas[a.status] || ''}` }, h('div', { class: 'spread' }, h('strong', {}, nama), h('span', { class: `badge ${lencana[a.status]}` }, a.status)), h('p', { style: 'margin:.3em 0 0' }, a.ulasan));
    const jenisLencana = { 'fakta boleh disahkan': 'warn', pendapat: '', 'pengalaman peribadi': 'good' };
    ulasKotak.replaceChildren(
      h('p', { class: 'quote small' }, `"${teksBlok(el).slice(0, 160)}${teksBlok(el).length > 160 ? '…' : ''}"`),
      r.perkembangan ? h('div', { class: 'sugg', style: 'background:var(--accent-soft)' }, h('strong', {}, 'Perkembangan sejak ulasan lalu'), h('p', { style: 'margin:.3em 0 0' }, r.perkembangan)) : null,
      aspek('Hujah', r.hujah), aspek('Fakta', r.fakta), aspek('Penyampaian', r.penyampaian),
      r.dakwaan?.length ? h('details', {}, h('summary', {}, `Dakwaan dalam perenggan (${r.dakwaan.length})`),
        r.dakwaan.map((d) => h('div', { class: 'sugg small' },
          h('div', { class: 'row' }, h('span', { class: `badge ${jenisLencana[d.jenis] ?? ''}` }, d.jenis), d.perlu_sumber ? h('span', { class: 'badge danger' }, 'perlu sumber') : null),
          h('p', { class: 'quote', style: 'margin:.4em 0' }, `"${d.petikan}"`), d.catatan ? h('p', { style: 'margin:0' }, d.catatan) : null))) : null,
      r.cadangan_pembuka ? h('div', { class: 'sugg' }, h('strong', {}, 'Cadangan pembuka (mengekalkan maksud anda)'), h('p', { style: 'margin:.3em 0 0' }, r.cadangan_pembuka)) : null,
      h('p', { class: 'muted small' }, 'Ulasan ini tidak mengubah teks anda. Sunting perenggan sendiri, kemudian tekan Ulas semula.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn-primary btn-sm', onmousedown: (e) => e.preventDefault(), onclick: () => ulasPerenggan(true) }, 'Ulas semula'),
        h('button', { class: 'btn-sm', onclick: () => { tandaPerenggan(null); perengganDiulas = null; ulasanSebelum = null; ulasKotak.replaceChildren(h('p', { class: 'muted' }, 'Klik dalam perenggan dan tekan Ulas Perenggan.')); } }, 'Tutup ulasan')),
    );
  }

  // 2. Semakan tulisan
  function gantiDalamEditor(asal, baru) {
    // Cari "asal" merentasi nod teks (mungkin melangkau sempadan tebal/condong)
    const nod = []; let teks = '';
    const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { nod.push({ n: w.currentNode, mula: teks.length }); teks += w.currentNode.data; }
    const norm = (s) => s.replace(/ /g, ' ');
    const i = norm(teks).indexOf(norm(asal));
    if (i < 0) return false;
    const cari = (pos, akhir) => { for (let k = nod.length - 1; k >= 0; k--) if (akhir ? nod[k].mula < pos : nod[k].mula <= pos) return { node: nod[k].n, off: pos - nod[k].mula }; return null; };
    const a = cari(i, false); const b = cari(i + asal.length, true);
    const r = document.createRange();
    r.setStart(a.node, a.off); r.setEnd(b.node, b.off);
    r.deleteContents();
    r.insertNode(document.createTextNode(baru));
    editor.normalize();
    tandaUbah();
    return true;
  }
  function binaSemak() {
    const kotak = h('div');
    const btn = h('button', { class: 'btn-primary', onmousedown: (e) => e.preventDefault() }, 'Semak tulisan');
    btn.addEventListener('click', async () => {
      const dipilih = teksDipilih();
      const teks = dipilih || editor.innerText.trim();
      if (!teks) return kotak.replaceChildren(h('p', { class: 'muted' }, 'Tiada teks untuk disemak.'));
      btn.disabled = true;
      kotak.replaceChildren(loading(dipilih ? 'Menyemak teks dipilih…' : 'Menyemak keseluruhan bab…'));
      try { lukis(await api('POST', '/api/ai/review', { chapter_id: id, text: teks })); } catch (e) { kotak.replaceChildren(h('p', {}, e.message)); } finally { btn.disabled = false; }
    });
    function lukis(r) {
      const item = r.cadangan.map((c) => ({ ...c, keadaan: 'menunggu' }));
      const senarai = h('div');
      const btnSemua = h('button', { class: 'btn-sm btn-primary' }, 'Terapkan semua');
      btnSemua.addEventListener('click', async () => {
        const menunggu = item.filter((c) => c.keadaan === 'menunggu');
        if (!menunggu.length) return;
        const ok = await dialog({
          tajuk: `Terapkan ${menunggu.length} perubahan?`,
          isi: [h('p', { class: 'muted small' }, 'Semak senarai perubahan sebelum diterapkan:'),
            h('div', { style: 'max-height:50vh;overflow:auto' }, menunggu.map((c) => h('p', { class: 'small' }, h('span', { class: 'diff-old' }, c.asal), ' → ', h('span', { class: 'diff-new' }, c.cadangan))))],
          butang: [{ label: 'Batal', nilai: 'batal' }, { label: 'Terapkan semua', nilai: 'ok', kelas: 'btn-primary' }],
        });
        if (ok !== 'ok') return;
        let gagal = 0;
        menunggu.forEach((c) => { if (gantiDalamEditor(c.asal, c.cadangan)) c.keadaan = 'diterima'; else { c.keadaan = 'tidak dijumpai'; gagal++; } });
        lukisSenarai();
        toast(gagal ? `${menunggu.length - gagal} diterapkan; ${gagal} tidak dijumpai kerana teks telah berubah.` : 'Semua perubahan diterapkan.');
      });
      function lukisSenarai() {
        senarai.replaceChildren(...(item.length ? item.map((c) => h('div', { class: `sugg ${c.keadaan !== 'menunggu' ? 'done' : ''}` },
          h('div', { class: 'spread' }, h('span', { class: 'tag' }, c.jenis), c.keadaan !== 'menunggu' ? h('span', { class: 'badge' }, c.keadaan) : null),
          h('div', { class: 'small', style: 'margin:.4em 0' }, h('div', {}, 'Asal: ', h('span', { class: 'diff-old' }, c.asal)), h('div', {}, 'Cadangan: ', h('span', { class: 'diff-new' }, c.cadangan))),
          h('p', { class: 'small muted', style: 'margin:0 0 .4em' }, c.sebab),
          c.keadaan === 'menunggu' ? h('div', { class: 'row' },
            h('button', { class: 'btn-sm', onmousedown: (e) => e.preventDefault(), onclick: () => { c.keadaan = gantiDalamEditor(c.asal, c.cadangan) ? 'diterima' : 'tidak dijumpai'; lukisSenarai(); } }, 'Terima'),
            h('button', { class: 'btn-sm', onclick: () => { c.keadaan = 'diabaikan'; lukisSenarai(); } }, 'Abaikan')) : null))
          : [h('p', {}, 'Tiada cadangan. Tulisan anda kelihatan baik.')]));
        btnSemua.disabled = !item.some((c) => c.keadaan === 'menunggu');
      }
      lukisSenarai();
      kotak.replaceChildren(h('p', { class: 'small' }, r.ringkasan), item.length ? h('div', { class: 'spread' }, h('span', { class: 'muted small' }, `${item.length} cadangan`), btnSemua) : null, senarai);
    }
    return h('div', { class: 'stack' }, h('h3', {}, 'Semakan tulisan'), h('p', { class: 'muted small' }, 'Semak ejaan, tatabahasa, struktur ayat dan kata seerti. Pilih teks untuk menyemak bahagian tertentu; jika tiada pilihan, seluruh bab disemak.'), btn, kotak);
  }

  // 3. Carian fakta
  function binaFakta() {
    const input = h('input', { placeholder: 'Contoh: kadar celik huruf di Malaysia', 'aria-label': 'Perkara untuk dicari' });
    const kotak = h('div');
    const btn = h('button', { class: 'btn-primary', type: 'submit' }, 'Cari fakta');
    const ambilPilihan = h('button', { class: 'btn-sm', type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => { input.value = teksDipilih() || teksBlok(blokSemasa()); } }, 'Guna teks dipilih');
    const form = h('form', { class: 'stack' }, input, h('div', { class: 'row' }, btn, ambilPilihan));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      btn.disabled = true;
      kotak.replaceChildren(loading('Mencari fakta dan sumber di web… (boleh mengambil masa)'));
      try {
        const r = await api('POST', '/api/ai/facts', { chapter_id: id, query: input.value.trim().slice(0, 500), context: teksBlok(blokSemasa()) });
        kotak.replaceChildren(...r.fakta.map((f) => h('div', { class: 'sugg' },
          h('p', { style: 'margin:0 0 .4em' }, f.fakta),
          h('div', { class: 'small' }, 'Sumber: ', /^https?:\/\//.test(f.sumber_url) ? h('a', { href: f.sumber_url, target: '_blank', rel: 'noopener noreferrer' }, f.sumber_judul || f.sumber_url) : (f.sumber_judul || '-'), f.tarikh_sumber ? ` (${f.tarikh_sumber})` : ''),
          h('div', { class: 'row', style: 'margin:.4em 0' }, f.sumber_disahkan_carian ? h('span', { class: 'badge good' }, 'sumber daripada carian') : h('span', { class: 'badge warn' }, 'sila sahkan sumber')),
          f.catatan ? h('p', { class: 'small muted', style: 'margin:0 0 .4em' }, f.catatan) : null,
          h('button', { class: 'btn-sm', onmousedown: (e2) => e2.preventDefault(), onclick: (e2) => { sisipTeksSebaris(`${f.fakta} (Sumber: ${f.sumber_judul || ''}${f.sumber_url ? `, ${f.sumber_url}` : ''})`); e2.target.textContent = 'Dimasukkan'; e2.target.disabled = true; } }, 'Masukkan ke tulisan'))),
        h('p', { class: 'muted small' }, 'Periksa setiap sumber sebelum menggunakannya. Fakta hanya dimasukkan apabila anda memilihnya.'));
      } catch (err) { kotak.replaceChildren(h('p', {}, err.message)); } finally { btn.disabled = false; }
    });
    return h('div', { class: 'stack' }, h('h3', {}, 'Carian fakta'), h('p', { class: 'muted small' }, 'AI mencadangkan fakta berkaitan bersama sumber untuk anda periksa. Fakta disisip di kedudukan kursor.'), form, kotak);
  }
  function sisipTeksSebaris(teks) {
    pulihkanKursor();
    if (!julatAkhir) { editor.append(h('p', {}, teks)); tandaUbah(); return; }
    const r = julatAkhir.cloneRange(); r.collapse(false);
    const n = document.createTextNode(' ' + teks + ' ');
    r.insertNode(n);
    r.setStartAfter(n); r.collapse(true);
    const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); julatAkhir = r.cloneRange();
    tandaUbah();
  }
  function sisipPerenggan(teks) {
    const blok = blokSemasa();
    const para = teks.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t) => h('p', {}, t));
    if (!para.length) return;
    let akhir = blok && blok.tagName === 'LI' ? blok.closest('ul') : blok;
    if (akhir && akhir.parentNode === editor) akhir.after(...para); else editor.append(...para);
    const r = document.createRange(); r.selectNodeContents(para[para.length - 1]); r.collapse(false);
    editor.focus(); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); julatAkhir = r.cloneRange();
    tandaUbah();
  }

  // 4. Sambung menulis
  function binaSambung() {
    const kotak = h('div');
    const btn = h('button', { class: 'btn-primary', onmousedown: (e) => e.preventDefault() }, 'Dapatkan soalan pendorong');
    btn.addEventListener('click', async () => {
      const blok = blokSemasa();
      const pilihan = teksDipilih() || teksBlok(blok);
      if (!pilihan) return kotak.replaceChildren(h('p', { class: 'muted' }, 'Pilih ayat atau klik dalam perenggan dahulu.'));
      btn.disabled = true;
      kotak.replaceChildren(loading('Menyediakan soalan…'));
      try {
        const r = await api('POST', '/api/ai/prompts', { chapter_id: id, selection: pilihan, context: konteksSekitar(blok) });
        kotak.replaceChildren(...r.soalan.map((s) => h('div', { class: 'sugg' }, h('p', { style: 'margin:0 0 .3em;font-weight:600' }, s.soalan), h('p', { class: 'small muted', style: 'margin:0 0 .4em' }, s.tujuan),
          h('button', { class: 'btn-sm', onmousedown: (e) => e.preventDefault(), onclick: () => mulaJawab(blok) }, 'Jawab dalam Zon Menulis'))),
        h('p', { class: 'muted small' }, 'Soalan ini hanya pendorong. Anda yang menulis jawapannya.'));
      } catch (e) { kotak.replaceChildren(h('p', {}, e.message)); } finally { btn.disabled = false; }
    });
    function mulaJawab(blok) {
      const p = h('p', {}, h('br'));
      let sasaran = blok && blok.tagName === 'LI' ? blok.closest('ul') : blok;
      if (sasaran && sasaran.isConnected && sasaran.parentNode === editor) sasaran.after(p); else editor.append(p);
      const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
      editor.focus(); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
      p.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return h('div', { class: 'stack' }, h('h3', {}, 'Bantuan sambung menulis'), h('p', { class: 'muted small' }, 'Pilih ayat atau perenggan. AI akan mengemukakan soalan untuk membantu anda menyambung tulisan sendiri.'), btn, kotak);
  }

  // 5. Rakaman suara
  let pengecam = null;
  function binaRakam() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const bahasa = h('select', { 'aria-label': 'Bahasa rakaman' }, h('option', { value: 'ms-MY' }, 'Bahasa Melayu'), h('option', { value: 'en-US' }, 'English'));
    const asal = h('textarea', { placeholder: 'Transkrip asal akan dipaparkan di sini. Anda juga boleh menaip atau membetulkannya.', 'aria-label': 'Transkrip asal' });
    const kemas = h('textarea', { placeholder: 'Versi ayat yang dikemaskan.', 'aria-label': 'Versi dikemaskan' });
    const perubahan = h('div', { class: 'small muted' });
    const sementara = h('p', { class: 'small muted quote' });
    const btnRakam = h('button', { class: 'btn-primary' }, 'Mula rakam');
    const btnKemas = h('button', {}, 'Kemaskan ayat');
    const kotakKemas = h('div', { class: 'stack', hidden: true });
    let merakam = false;

    btnRakam.addEventListener('click', () => {
      if (!SR) return;
      if (merakam) { pengecam?.stop(); return; }
      pengecam = new SR();
      pengecam.lang = bahasa.value; pengecam.continuous = true; pengecam.interimResults = true;
      pengecam.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) asal.value = (asal.value + ' ' + t).replace(/\s+/g, ' ').trimStart(); else interim += t;
        }
        sementara.textContent = interim;
      };
      pengecam.onerror = (e) => { toast(e.error === 'not-allowed' ? 'Kebenaran mikrofon ditolak.' : `Ralat rakaman: ${e.error}`); };
      pengecam.onend = () => { merakam = false; btnRakam.replaceChildren('Mula rakam'); sementara.textContent = ''; };
      pengecam.start(); merakam = true;
      btnRakam.replaceChildren(h('span', { class: 'rec-dot' }), ' Henti rakam');
    });
    btnKemas.addEventListener('click', async () => {
      if (!asal.value.trim()) return toast('Tiada transkrip untuk dikemaskan.');
      btnKemas.disabled = true; kotakKemas.hidden = false; perubahan.replaceChildren(loading('Mengemaskan bentuk bahasa…'));
      try {
        const r = await api('POST', '/api/ai/transcript', { text: asal.value });
        kemas.value = r.teks_kemas;
        perubahan.replaceChildren('Perubahan: ', r.perubahan.length ? r.perubahan.join('; ') : 'tiada');
      } catch (e) { perubahan.textContent = e.message; } finally { btnKemas.disabled = false; }
    });
    kotakKemas.append(h('label', {}, 'Versi dikemaskan (boleh disunting)'), kemas, perubahan,
      h('button', { class: 'btn-primary btn-sm', onmousedown: (e) => e.preventDefault(), onclick: () => { if (kemas.value.trim()) { sisipPerenggan(kemas.value); toast('Dimasukkan ke dalam tulisan.'); } } }, 'Masukkan versi dikemaskan'));
    return h('div', { class: 'stack' },
      h('h3', {}, 'Rakaman suara'),
      SR ? h('p', { class: 'muted small' }, 'Rakam dalam Bahasa Melayu atau Inggeris. Versi dikemaskan hanya membetulkan bentuk bahasa tanpa menambah isi. Semak sebelum memasukkannya ke dalam tulisan.')
        : h('p', { class: 'small', style: 'color:var(--warn)' }, 'Pelayar ini tidak menyokong pengecaman suara. Gunakan Chrome, Edge atau Safari terkini. Anda masih boleh menaip atau menampal transkrip di bawah.'),
      h('div', { class: 'row' }, bahasa, SR ? btnRakam : null),
      sementara,
      h('label', {}, 'Transkrip asal'), asal,
      h('div', { class: 'row' }, btnKemas, h('button', { class: 'btn-sm', onmousedown: (e) => e.preventDefault(), onclick: () => { if (asal.value.trim()) sisipPerenggan(asal.value); } }, 'Masukkan versi asal')),
      kotakKemas,
    );
  }

  const binaPanel = {
    ulas: () => h('div', { class: 'stack' }, h('h3', {}, 'Ulas Perenggan'),
      h('p', { class: 'muted small' }, 'Klik dalam satu perenggan, kemudian tekan Ulas Perenggan. AI memberi maklum balas tentang hujah, fakta dan penyampaian berdasarkan Zon Kenal Pembaca. Teks anda tidak diubah.'),
      ulasKotak),
    semak: binaSemak, fakta: binaFakta, sambung: binaSambung, rakam: binaRakam,
  };

  app.replaceChildren(
    h('p', { class: 'small' }, h('a', { href: `#/projek/${bab.project.id}` }, `← ${bab.project.title}: Senarai Bab`)),
    h('div', { class: 'writer' },
      h('div', { class: 'writer-main' },
        h('div', { class: 'spread' }, judul, status),
        h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Format teks' },
          bB, bI, bU, h('span', { class: 'sep' }), btnUlas, h('span', { class: 'sep' }), menuMuatTurun),
        editor),
      h('aside', { class: 'panel', 'aria-label': 'Bantuan AI' }, panelTabs, panelIsi)),
  );
  document.execCommand('defaultParagraphSeparator', false, 'p');
  if (!editor.innerHTML.trim()) editor.innerHTML = '<p><br></p>';
  ulasKotak.append(h('p', { class: 'muted' }, 'Belum ada ulasan.'));
  bukaPanel(panelAktif);

  state.cleanup = async () => {
    document.removeEventListener('selectionchange', ikutPilihan);
    document.removeEventListener('keydown', kekunci);
    window.removeEventListener('beforeunload', sebelumTutup);
    try { pengecam?.stop(); } catch { /* abaikan */ }
    if (berubah) await simpan(); else if (sedangSimpan) await sedangSimpan;
  };
}

// ---------- Panel admin ----------
async function paparAdmin() {
  if (state.me.role !== 'admin') return go('#/projek');
  app.replaceChildren(loading('Memuatkan pengguna…'));
  let pengguna = await api('GET', '/api/admin/users');
  let tapisTidakAktif = false; let cari = '';
  const badan = h('tbody');
  const ringkasan = h('p', { class: 'muted small' });

  function lukis() {
    const senarai = pengguna.filter((u) => (!tapisTidakAktif || u.tidak_aktif_5_hari) && (!cari || `${u.full_name} ${u.email} ${u.phone}`.toLowerCase().includes(cari)));
    ringkasan.textContent = `${pengguna.length} pengguna · ${pengguna.filter((u) => u.tidak_aktif_5_hari).length} tidak aktif ≥ 5 hari · ${senarai.length} dipaparkan`;
    badan.replaceChildren(...senarai.map((u) => h('tr', { class: u.tidak_aktif_5_hari ? 'inactive' : '' },
      h('td', {}, h('strong', {}, u.full_name), h('div', { class: 'small muted' }, u.email), u.role === 'admin' ? h('span', { class: 'badge' }, 'admin') : null, u.disabled ? h('span', { class: 'badge danger' }, 'dinyahaktif') : null, u.admin_note ? h('div', { class: 'small muted' }, `Nota: ${u.admin_note}`) : null),
      h('td', {}, u.phone, u.whatsapp ? h('div', {}, h('a', { href: u.whatsapp, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'WhatsApp')) : null),
      h('td', { class: 'small' }, tarikh(u.created_at)),
      h('td', { class: 'small' }, u.last_active_at ? tarikh(u.last_active_at) : 'Belum pernah', u.tidak_aktif_5_hari ? h('div', {}, h('span', { class: 'badge warn' }, `Tidak aktif ${Math.floor(u.hari_tidak_aktif)} hari`)) : null),
      h('td', { class: 'small' }, `${u.bilangan_projek} projek, ${u.bilangan_bab} bab`),
      h('td', {}, h('div', { class: 'row' },
        h('button', { class: 'btn-sm', onclick: () => sunting(u) }, 'Sunting'),
        u.role !== 'admin' ? h('button', { class: 'btn-sm', onclick: () => togolAktif(u) }, u.disabled ? 'Aktifkan' : 'Nyahaktif') : null,
        h('button', { class: 'btn-sm', onclick: () => setKataLaluan(u) }, 'Kata laluan'),
        u.role !== 'admin' ? h('button', { class: 'btn-sm btn-danger', onclick: () => padam(u) }, 'Padam') : null)),
    )));
  }
  async function muatSemula() { pengguna = await api('GET', '/api/admin/users'); lukis(); }
  async function sunting(u) {
    const f = { full_name: h('input', { value: u.full_name }), email: h('input', { value: u.email, type: 'email' }), phone: h('input', { value: u.phone }), admin_note: h('textarea', {}) };
    f.admin_note.value = u.admin_note || '';
    const r = await dialog({ tajuk: 'Sunting rekod pengguna', isi: [h('label', {}, 'Nama penuh'), f.full_name, h('label', {}, 'E-mel'), f.email, h('label', {}, 'Telefon'), f.phone, h('label', {}, 'Nota admin'), f.admin_note], butang: [{ label: 'Batal', nilai: 'batal' }, { label: 'Simpan', nilai: 'ok', kelas: 'btn-primary' }] });
    if (r !== 'ok') return;
    try { await api('PUT', `/api/admin/users/${u.id}`, Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value]))); toast('Rekod dikemas kini.'); muatSemula(); } catch (e) { toast(e.message); }
  }
  async function togolAktif(u) {
    if (!(await sahkan(u.disabled ? `Aktifkan semula akaun ${u.full_name}?` : `Nyahaktifkan akaun ${u.full_name}? Pengguna tidak dapat log masuk sehingga diaktifkan semula. Tulisan mereka tidak dipadam.`, u.disabled ? 'Aktifkan' : 'Nyahaktif'))) return;
    await api('PUT', `/api/admin/users/${u.id}`, { disabled: !u.disabled }); muatSemula();
  }
  async function setKataLaluan(u) {
    const t = await mintaTeks(`Tetapkan kata laluan baharu: ${u.full_name}`, 'Kata laluan baharu (sekurang-kurangnya 8 aksara)');
    if (!t) return;
    try { await api('POST', `/api/admin/users/${u.id}/password`, { password: t }); toast('Kata laluan dikemas kini.'); } catch (e) { toast(e.message); }
  }
  async function padam(u) {
    if (!(await sahkan(`Padam akaun ${u.full_name} (${u.email}) beserta SEMUA projek dan babnya secara kekal?`, 'Padam akaun', true))) return;
    try { await api('DELETE', `/api/admin/users/${u.id}`); toast('Akaun dipadam.'); muatSemula(); } catch (e) { toast(e.message); }
  }
  async function tukarKataLaluanSaya() {
    const semasa = h('input', { type: 'password', autocomplete: 'current-password' });
    const baru = h('input', { type: 'password', autocomplete: 'new-password', minlength: '8' });
    const r = await dialog({ tajuk: 'Tukar kata laluan saya', isi: [h('label', {}, 'Kata laluan semasa'), semasa, h('label', {}, 'Kata laluan baharu'), baru], butang: [{ label: 'Batal', nilai: 'batal' }, { label: 'Tukar', nilai: 'ok', kelas: 'btn-primary' }] });
    if (r !== 'ok') return;
    try { await api('POST', '/api/me/password', { current: semasa.value, password: baru.value }); toast('Kata laluan ditukar.'); } catch (e) { toast(e.message); }
  }

  app.replaceChildren(
    h('div', { class: 'spread' }, h('h1', {}, 'Panel admin'), h('button', { class: 'btn-sm', onclick: tukarKataLaluanSaya }, 'Tukar kata laluan saya')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' },
        h('input', { placeholder: 'Cari nama, e-mel atau telefon', style: 'max-width:320px', oninput: (e) => { cari = e.target.value.toLowerCase(); lukis(); } }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { tapisTidakAktif = e.target.checked; lukis(); } }), 'Tunjuk yang tidak aktif ≥ 5 hari sahaja'),
        h('button', { class: 'btn-sm', onclick: muatSemula }, 'Muat semula')),
      ringkasan,
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Pengguna', 'Telefon', 'Didaftar', 'Penggunaan terakhir', 'Kandungan', 'Tindakan'].map((t) => h('th', {}, t)))),
        badan))),
    binaIsuBahasa());
  lukis();
}

// Panel admin: analisis isu tatabahasa dan ejaan yang kerap dilakukan pengguna
function binaIsuBahasa() {
  const statistikEl = h('div', {}, loading('Memuatkan statistik…'));
  const hasilEl = h('div');
  const pilihHari = h('select', { 'aria-label': 'Tempoh', style: 'width:auto' },
    [[7, '7 hari'], [30, '30 hari'], [90, '90 hari'], [365, '1 tahun']].map(([v, l]) => h('option', { value: v, selected: v === 30 }, l)));
  const btn = h('button', { class: 'btn-primary' }, 'Analisis isu tatabahasa & ejaan');

  function lukisStatistik(s) {
    statistikEl.replaceChildren(
      h('p', {}, h('strong', {}, `${s.jumlah_isu} isu`), ` daripada ${s.bilangan_pengguna} pengguna dalam ${s.hari} hari terakhir.`),
      s.ikut_jenis.length ? h('div', { class: 'row' }, s.ikut_jenis.map((j) => h('span', { class: 'badge' }, `${j.jenis}: ${j.n}`))) : null,
      s.pengguna_paling_banyak_isu.length ? h('p', { class: 'small muted' }, 'Paling banyak isu: ', s.pengguna_paling_banyak_isu.slice(0, 5).map((p) => `${p.nama} (${p.n})`).join(', ')) : null,
    );
  }
  function lukisAnalisis(a) {
    if (!a) return hasilEl.replaceChildren(h('p', { class: 'muted small' }, 'Belum ada analisis. Tekan butang di atas untuk menjana.'));
    const jenisLencana = { ejaan: 'warn', tatabahasa: 'danger', 'struktur ayat': '' };
    hasilEl.replaceChildren(h('div', { class: 'stack' },
      h('div', { class: 'spread' }, h('h3', {}, 'Hasil analisis'), h('span', { class: 'muted small' }, `${tarikh(a.dijana_pada)} · ${a.statistik?.hari ?? '-'} hari · ${a.statistik?.jumlah_isu ?? '-'} isu`)),
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, 'Muat turun analisis:'),
        h('button', { class: 'btn-sm', onclick: () => muatTurun('/api/admin/language/report?format=docx') }, 'Word (DOCX)'),
        h('button', { class: 'btn-sm', onclick: () => muatTurun('/api/admin/language/report?format=pdf') }, 'PDF')),
      h('p', {}, a.ringkasan),
      a.isu_kerap.map((k, i) => h('div', { class: 'sugg' },
        h('div', { class: 'spread' }, h('strong', {}, `${i + 1}. ${k.kategori}`),
          h('div', { class: 'row' }, h('span', { class: `badge ${jenisLencana[k.jenis] ?? ''}` }, k.jenis), h('span', { class: 'badge' }, `±${k.anggaran_kejadian} kali · ${k.anggaran_pengguna} pengguna`))),
        h('p', { style: 'margin:.4em 0' }, k.penerangan),
        h('div', { class: 'small' }, k.contoh.map((c) => h('div', {}, h('span', { class: 'diff-old' }, c.asal), ' → ', h('span', { class: 'diff-new' }, c.betul)))),
        h('p', { class: 'small', style: 'margin:.5em 0 0' }, h('strong', {}, 'Cadangan pengajaran: '), k.cadangan_pengajaran))),
      a.pengguna_perlu_bimbingan.length ? h('div', {}, h('h3', {}, 'Pengguna yang mungkin memerlukan bimbingan'),
        h('ul', {}, a.pengguna_perlu_bimbingan.map((p) => h('li', {}, h('strong', {}, p.nama), `: ${p.isu_utama}`)))) : null,
      a.catatan_data ? h('p', { class: 'muted small' }, `Catatan data: ${a.catatan_data}`) : null,
    ));
  }
  async function muat() {
    try {
      const r = await api('GET', `/api/admin/language?hari=${pilihHari.value}`);
      lukisStatistik(r.statistik);
      if (!hasilEl.hasChildNodes()) lukisAnalisis(r.analisis);
    } catch (e) { statistikEl.replaceChildren(h('p', {}, e.message)); }
  }
  pilihHari.addEventListener('change', muat);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    hasilEl.replaceChildren(loading('AI sedang menganalisis corak kesilapan pengguna…'));
    try { lukisAnalisis(await api('POST', '/api/admin/language/analyze', { hari: Number(pilihHari.value) })); muat(); } catch (e) { hasilEl.replaceChildren(h('p', {}, e.message)); } finally { btn.disabled = false; }
  });
  muat();
  return h('div', { class: 'card stack', style: 'margin-top:16px' },
    h('h2', {}, 'Isu tatabahasa & ejaan pengguna'),
    h('p', { class: 'muted small' }, 'Isu direkod setiap kali pengguna menggunakan Semakan Tulisan (ejaan, tatabahasa, struktur ayat; cadangan kata seerti tidak dikira). AI mengenal pasti corak kesilapan yang kerap berulang dan mencadangkan topik pengajaran.'),
    h('div', { class: 'row' }, pilihHari, btn),
    statistikEl, hasilEl);
}

route();
