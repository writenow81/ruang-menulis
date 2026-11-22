// Semua panggilan AI (Claude API). Kunci API disimpan di pelayan sahaja:
// pengguna aplikasi tidak memerlukan akaun Claude.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const client = new Anthropic(); // membaca ANTHROPIC_API_KEY daripada persekitaran

const PRINSIP = `Anda pembantu penulisan dalam aplikasi "Ruang Menulis".
Prinsip yang tidak boleh dilanggar:
- Penulis memegang kawalan penuh terhadap naskhah. Anda hanya memberi cadangan; jangan sekali-kali menulis semula keseluruhan teks penulis.
- Kekalkan suara, maksud dan gaya penulis.
- Nada anda lembut, khusus dan membina. Sebut perkara yang sudah baik sebelum kelemahan apabila sesuai.
- Jawab dalam bahasa yang sama dengan teks penulis (Bahasa Melayu atau Inggeris). Jika teks bercampur, gunakan Bahasa Melayu.`;

class AIError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function konteksProjek(project) {
  if (!project) return '';
  const medan = [
    ['Projek penulisan (bayangan karya/sinopsis)', project.reader_project],
    ['Pembaca sasaran', project.reader_target],
    ['Keperluan pembaca', project.reader_needs],
    ['Mesej utama', project.reader_message],
    ['Perubahan yang diharapkan pada pembaca', project.reader_change],
  ].filter(([, v]) => v && v.trim());
  if (!medan.length) return `Judul projek: ${project.title}\n(Zon Kenal Pembaca belum diisi.)`;
  return `Judul projek: ${project.title}\nZON KENAL PEMBACA:\n` +
    medan.map(([k, v]) => `- ${k}: ${v.trim()}`).join('\n');
}

function teksDaripada(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Satu panggilan Messages API. Jika `schema` diberi, jawapan dihadkan kepada JSON yang sah.
async function panggil({ system, user, schema, tools, effort = 'medium', maxTokens = 16000 }) {
  const base = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    ...(tools ? { tools } : {}),
  };

  let messages = base.messages;
  let response;
  for (let pusingan = 0; pusingan < 4; pusingan++) {
    try {
      // Fallback sebelah pelayan: jika model utama menolak, API mencuba model sandaran.
      response = await client.beta.messages.create({
        ...base,
        messages,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new AIError('Perkhidmatan AI sedang sibuk. Cuba lagi sebentar.', 429);
      if (err instanceof Anthropic.AuthenticationError) throw new AIError('Kunci API AI belum ditetapkan dengan betul pada pelayan.', 500);
      if (err instanceof Anthropic.APIConnectionError) throw new AIError('Tidak dapat menghubungi perkhidmatan AI.', 502);
      if (err instanceof Anthropic.APIError) throw new AIError(`Ralat AI: ${err.message}`, 502);
      if (/authentication method/i.test(err?.message || '')) throw new AIError('Kunci API AI (ANTHROPIC_API_KEY) belum ditetapkan pada pelayan.', 503);
      throw err;
    }
    // Carian web yang panjang boleh berhenti sementara (pause_turn); sambung semula.
    if (response.stop_reason === 'pause_turn') {
      messages = [...base.messages, { role: 'assistant', content: response.content }];
      continue;
    }
    break;
  }

  if (response.stop_reason === 'refusal') throw new AIError('AI tidak dapat memproses permintaan ini.', 422);
  if (response.stop_reason === 'max_tokens') throw new AIError('Teks terlalu panjang untuk diproses sekali gus. Pilih bahagian yang lebih pendek.', 413);

  const text = teksDaripada(response.content);
  if (!schema) return { text, content: response.content };
  try {
    return JSON.parse(text);
  } catch {
    throw new AIError('Jawapan AI tidak dapat dibaca. Sila cuba lagi.');
  }
}

const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });

// 1. Rakaman suara: kemaskan transkrip tanpa menambah isi
async function kemaskanTranskrip(transkrip) {
  return panggil({
    effort: 'low',
    system: `${PRINSIP}

Tugas: Anda menerima transkrip suara mentah (Bahasa Melayu atau Inggeris, kadang-kadang bercampur).
Betulkan BENTUK bahasa sahaja: ejaan, tanda baca, huruf besar, pemecahan ayat dan perenggan, kata ulang yang tidak sengaja (contoh "saya saya"), serta pengisi ucapan seperti "err", "emm", "macam", "uh" apabila jelas tidak bermakna.
Larangan: JANGAN menambah isi, fakta, contoh, hujah atau ayat baharu. JANGAN membuang maklumat. JANGAN menukar bahasa. JANGAN meringkaskan.
Pulangkan juga senarai ringkas jenis perubahan yang dibuat.`,
    user: `Transkrip mentah:\n"""\n${transkrip}\n"""`,
    schema: obj({ teks_kemas: str, bahasa: { type: 'string', enum: ['ms', 'en', 'campuran'] }, perubahan: arr(str) }),
  });
}

// 2. Semakan tulisan: ejaan, struktur ayat, tatabahasa, kata seerti
async function semakTulisan(teks, project) {
  return panggil({
    system: `${PRINSIP}

Tugas: semak teks penulis untuk (a) ejaan, (b) tatabahasa, (c) struktur ayat, dan (d) kata seerti yang lebih tepat atau mengelakkan ulangan.
Peraturan cadangan:
- "asal" MESTILAH salinan TEPAT aksara demi aksara daripada teks penulis (termasuk tanda baca dan huruf besar), cukup panjang supaya unik, dan sependek mungkin (biasanya satu frasa atau satu ayat).
- "cadangan" ialah gantian untuk "asal" sahaja, mengekalkan maksud penulis. Jangan tambah isi baharu.
- "sebab" menerangkan dengan ringkas dan lembut mengapa perubahan dicadangkan.
- Jangan cadangkan perubahan untuk ciri gaya yang sah atau dialog yang sengaja tidak formal.
- Bagi kata seerti, beri satu pilihan terbaik dalam "cadangan" dan sebut pilihan lain dalam "sebab" jika ada.
- Maksimum 30 cadangan, yang paling penting dahulu. Jika tiada masalah, pulangkan senarai kosong.
Gunakan Zon Kenal Pembaca sebagai rujukan nada yang sesuai dengan pembaca sasaran.`,
    user: `${konteksProjek(project)}\n\nTEKS UNTUK DISEMAK:\n"""\n${teks}\n"""`,
    schema: obj({
      ringkasan: str,
      cadangan: arr(obj({
        jenis: { type: 'string', enum: ['ejaan', 'tatabahasa', 'struktur ayat', 'kata seerti'] },
        asal: str, cadangan: str, sebab: str,
      })),
    }),
  });
}

// 3. Carian fakta dengan sumber (carian web)
async function cariFakta(soalan, konteksTeks, project) {
  const { text, content } = await panggil({
    effort: 'medium',
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
    system: `${PRINSIP}

Tugas: cari fakta yang berkaitan dan boleh disahkan untuk membantu penulis. Gunakan carian web.
- Utamakan sumber berwibawa (badan kerajaan, institusi akademik, organisasi antarabangsa, media arus perdana, jurnal).
- Setiap fakta mesti ringkas (1-2 ayat), ditulis dalam bahasa teks penulis, dan disertai sumber sebenar yang anda temui (judul dan URL).
- Jangan reka sumber. Jika sesuatu fakta tidak pasti atau sumber bercanggah, nyatakan dalam "catatan".
- Beri 3 hingga 6 fakta.
Pada akhir jawapan, pulangkan HANYA satu blok JSON dalam format ini (tiada teks lain selepasnya):
\`\`\`json
{"fakta":[{"fakta":"...","sumber_judul":"...","sumber_url":"https://...","tarikh_sumber":"jika diketahui, atau kosong","catatan":"..."}]}
\`\`\``,
    user: `${konteksProjek(project)}\n\nPERKARA YANG MAHU DICARI: ${soalan}\n${konteksTeks ? `\nKONTEKS TULISAN:\n"""\n${konteksTeks}\n"""` : ''}`,
  });

  const padanan = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*"fakta"[\s\S]*\})/);
  let fakta = [];
  if (padanan) {
    try { fakta = JSON.parse(padanan[1]).fakta || []; } catch { /* abaikan */ }
  }
  // Senarai sumber yang benar-benar dibuka oleh carian web, untuk semakan silang.
  const sumberCarian = [];
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === 'web_search_result') sumberCarian.push({ judul: r.title, url: r.url });
    }
  }
  const urlSah = new Set(sumberCarian.map((s) => s.url));
  fakta = fakta.map((f) => ({ ...f, sumber_disahkan_carian: urlSah.has(f.sumber_url) }));
  if (!fakta.length) throw new AIError('Tiada fakta yang dapat dipulangkan. Cuba ubah kata kunci carian.');
  return { fakta, sumber_carian: sumberCarian.slice(0, 15) };
}

// 4. Bantuan sambung menulis: soalan pendorong
async function soalanPendorong(teksDipilih, teksSekitar, project) {
  return panggil({
    effort: 'low',
    system: `${PRINSIP}

Tugas: penulis memilih ayat atau perenggan dan mahu menyambung tulisan. JANGAN tulis sambungan untuk mereka.
Kemukakan 4 hingga 6 soalan pendorong yang terbuka dan khusus kepada teks dipilih, yang membantu penulis menggali idea, butiran, contoh, perasaan, sebab, akibat atau langkah seterusnya.
Setiap soalan disertai "tujuan" ringkas (contoh: "menambah contoh konkrit", "menjelaskan sebab").
Pertimbangkan keperluan pembaca sasaran dalam Zon Kenal Pembaca.`,
    user: `${konteksProjek(project)}\n\nTEKS DIPILIH:\n"""\n${teksDipilih}\n"""${teksSekitar ? `\n\nTEKS SEKITAR (konteks):\n"""\n${teksSekitar}\n"""` : ''}`,
    schema: obj({ soalan: arr(obj({ soalan: str, tujuan: str })) }),
  });
}

// 5. Ulas Perenggan: hujah, fakta, penyampaian. Tidak mengubah teks.
async function ulasPerenggan(perenggan, teksSekitar, project, ulasanSebelum) {
  const aspek = obj({
    status: { type: 'string', enum: ['baik', 'boleh diperkukuh', 'perlu perhatian'] },
    ulasan: str,
  });
  return panggil({
    system: `${PRINSIP}

Tugas: beri maklum balas RINGKAS tentang satu perenggan. Anda TIDAK mengubah teks; penulis sendiri yang akan menyunting.
Nilai tiga aspek:
1. Hujah: Adakah isi utama jelas dan disokong dengan alasan yang cukup?
2. Fakta: Adakah dakwaan memerlukan sumber atau semakan lanjut?
3. Penyampaian: Adakah susunan ayat mudah diikuti dan menarik untuk dibaca?

Pembezaan dakwaan (penting):
- Kelaskan setiap dakwaan penting kepada "fakta boleh disahkan" (angka, tarikh, statistik, kenyataan saintifik/sejarah, petikan, dakwaan umum tentang dunia), "pendapat" (penilaian, saranan, kepercayaan penulis) atau "pengalaman peribadi" (kisah, perasaan, pemerhatian penulis sendiri).
- Hanya "fakta boleh disahkan" boleh ditanda perlu_sumber = true. JANGAN minta sumber untuk pendapat atau pengalaman peribadi; bagi pendapat, anda boleh mencadangkan alasan atau contoh untuk menyokongnya.

Nada: lembut, khusus dan membina, rujuk ayat tertentu. Contoh gaya: "Isi perenggan ini jelas, tetapi pembaca mungkin tertanya-tanya dari mana angka ini diperoleh. Pertimbangkan untuk menambah sumber selepas ayat kedua."
Setiap ulasan aspek 1-3 ayat sahaja.
Nilai juga kesesuaian hujah dan gaya dengan pembaca sasaran dan tujuan projek (Zon Kenal Pembaca), serta jenis projek (contoh: kisah hidup tidak dinilai dengan ukuran buku panduan praktikal).
"cadangan_pembuka": hanya jika ayat pembuka boleh dibuat lebih menarik; ia MESTI mengekalkan maksud penulis. Jika tidak perlu, kosongkan.
${ulasanSebelum ? `Ini ULAS SEMULA. Bandingkan dengan ulasan sebelum ini dan isi "perkembangan": nyatakan kelemahan mana yang sudah ditangani dan mana yang masih ada. Hargai usaha penulis.` : 'Ini ulasan pertama; kosongkan "perkembangan".'}`,
    user: `${konteksProjek(project)}\n\nPERENGGAN DIPILIH:\n"""\n${perenggan}\n"""${teksSekitar ? `\n\nPERENGGAN SEBELUM/SELEPAS (konteks sahaja, jangan diulas):\n"""\n${teksSekitar}\n"""` : ''}${ulasanSebelum ? `\n\nULASAN SEBELUM INI:\n${JSON.stringify(ulasanSebelum)}` : ''}`,
    schema: obj({
      hujah: aspek,
      fakta: aspek,
      penyampaian: aspek,
      dakwaan: arr(obj({
        petikan: str,
        jenis: { type: 'string', enum: ['fakta boleh disahkan', 'pendapat', 'pengalaman peribadi'] },
        perlu_sumber: { type: 'boolean' },
        catatan: str,
      })),
      cadangan_pembuka: str,
      perkembangan: str,
    }),
  });
}

// 6. Analisis Projek: empat bahagian
async function analisisProjek(project, bab) {
  const ringkasanBab = bab.map((b, i) => `--- Bab ${i + 1}: ${b.title} ---\n${b.teks.slice(0, 6000)}${b.teks.length > 6000 ? '\n[...dipendekkan...]' : ''}`).join('\n\n');
  return panggil({
    effort: 'high',
    system: `${PRINSIP}

Tugas: analisis keseluruhan projek penulisan berdasarkan Zon Kenal Pembaca dan (jika ada) bab-bab yang telah ditulis.
Beri maklum balas dalam empat bahagian:
1. "sudah_jelas": perkara yang sudah jelas dan kukuh.
2. "masih_kabur": perkara yang masih kabur atau belum ditakrifkan.
3. "kelemahan": kelemahan yang mungkin menjejaskan pengalaman atau pemahaman pembaca.
4. "cadangan": cadangan penambahbaikan yang khusus dan boleh dilaksanakan (contoh: tentang sinopsis, fokus pembaca, susunan bab, jurang isi).
Kenal pasti jenis projek daripada apa yang penulis nyatakan (contoh: kisah hidup/memoir, buku panduan praktikal, novel, esei, buku motivasi, akademik) dan nilai mengikut ukuran yang sesuai dengan jenis itu. Nyatakan jenis tersebut dalam "jenis_projek" dan jelaskan secara ringkas ukuran yang anda gunakan dalam "ukuran_penilaian".
Setiap bahagian 2-5 butiran, setiap butiran 1-2 ayat. Ingat: ini cadangan; penulis yang menentukan.`,
    user: `${konteksProjek(project)}\n\nBAB YANG TELAH DITULIS (${bab.length}):\n${ringkasanBab || '(Belum ada bab.)'}`,
    schema: obj({
      jenis_projek: str,
      ukuran_penilaian: str,
      sudah_jelas: arr(str),
      masih_kabur: arr(str),
      kelemahan: arr(str),
      cadangan: arr(str),
    }),
  });
}

module.exports = { AIError, kemaskanTranskrip, semakTulisan, cariFakta, soalanPendorong, ulasPerenggan, analisisProjek, MODEL };
