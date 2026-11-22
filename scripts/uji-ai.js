// Ujian langsung semua fungsi AI dengan kunci sebenar.
// Jalankan: node scripts/uji-ai.js   (memerlukan RM_ANTHROPIC_API_KEY atau ANTHROPIC_API_KEY)
const ai = require('../src/ai');

const projek = {
  title: 'Kisah Kampung Saya',
  reader_project: 'Memoir zaman kanak-kanak di sebuah kampung nelayan di Terengganu pada tahun 1980-an.',
  reader_target: 'Generasi muda bandar berumur 18-35 tahun.',
  reader_needs: 'Mereka jarang mendengar kisah hidup sederhana dan nilai kejiranan.',
  reader_message: 'Kebahagiaan tidak bergantung pada kemewahan.',
  reader_change: 'Pembaca lebih menghargai keluarga dan komuniti mereka.',
};
const perenggan = 'Pada tahun 1985, hampir 80 peratus penduduk kampung kami bekerja sebagai nelayan. Saya masih ingat bau ikan masin yang dijemur di halaman rumah setiap pagi. Pada pendapat saya, zaman itu lebih bahagia daripada sekarang kerana semua orang saling membantu.';

const ujian = [
  ['Kemaskan transkrip', () => ai.kemaskanTranskrip('err saya saya nak cerita pasal kampung saya emm dulu kami tinggal tepi laut dan ayah saya pergi laut setiap pagi')],
  ['Semakan tulisan', () => ai.semakTulisan('Saya telah pergi ke pasar semalam untuk membeli ikan ikan segar. Disana ramai orang yang beratur dan mereka semua sangat sangat gembira.', projek)],
  ['Soalan pendorong', () => ai.soalanPendorong('Saya masih ingat bau ikan masin yang dijemur di halaman rumah setiap pagi.', '', projek)],
  ['Ulas Perenggan', () => ai.ulasPerenggan(perenggan, '', projek, null)],
  ['Ulas semula', async () => {
    const pertama = await ai.ulasPerenggan(perenggan, '', projek, null);
    const disunting = perenggan.replace('Pada tahun 1985, hampir 80 peratus', 'Menurut catatan penghulu kampung pada tahun 1985, hampir 80 peratus');
    return ai.ulasPerenggan(disunting, '', projek, pertama);
  }],
  ['Carian fakta', () => ai.cariFakta('bilangan nelayan di Terengganu', '', projek)],
  ['Analisis Projek', () => ai.analisisProjek(projek, [{ title: 'Bab 1: Pagi di Pantai', teks: perenggan }])],
];

(async () => {
  let gagal = 0;
  for (const [nama, fn] of ujian) {
    const mula = Date.now();
    try {
      const hasil = await fn();
      console.log(`\n=== ${nama} ✓ (${((Date.now() - mula) / 1000).toFixed(1)}s) ===`);
      console.log(JSON.stringify(hasil, null, 2).slice(0, 2500));
    } catch (e) {
      gagal++;
      console.log(`\n=== ${nama} ✗ ===\n${e.status || ''} ${e.message}`);
    }
  }
  console.log(`\n${ujian.length - gagal}/${ujian.length} lulus`);
  process.exit(gagal ? 1 : 0);
})();
