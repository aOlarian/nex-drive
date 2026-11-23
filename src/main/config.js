/* MAP
 * §1 constante configurabile  L5-L36
 */

// §1 constante configurabile (valoare implicita + interval valid)
const MiB = 1024 * 1024;

module.exports = {
  CHUNK_BYTES: 16 * MiB,            // marime bucata upload; multiplu de 256 KiB (cerinta Drive). 256 KiB..64 MiB
  MULTIPART_MAX_BYTES: 2 * MiB,     // fisierele <= 2 MiB se urca dintr-o singura cerere multipart (3x mai rapid la sute de mii de fisiere mici). 0..5 MiB
  CHILD_CACHE_MAX: 500,             // cate foldere tinem in cache-ul de copii pentru a evita mii de cereri findChild. 50..5000
  QUEUE_LEGACY_MAX_BYTES: 20 * MiB, // coada > 20 MB din versiuni vechi (v0.4) se arhiveaza si se reia curat din indexurile sync. 5..200 MiB
  WORKERS: 3,                       // fisiere urcate in paralel (implicit; se schimba din UI). 1..8
  MAX_WORKERS: 8,                   // plafon pentru selectorul din UI; Drive nu impune o limita fixa, dar peste ~8 apar mai multe erori de rata
  DL_WORKERS: 3,                    // fisiere descarcate in paralel. 1..8
  PAUSE_MS: 24 * 3600 * 1000,       // pauza maxima 24 h cand reluarea automata periodica este dezactivata
  LIMIT_RETRY_MINUTES: 60,          // la cate minute reincercam automat dupa o pauza de limita Google Drive. 5..1440 (0 = asteapta 24 h)
  TICK_MS: 3600 * 1000,             // verificare ceas la cel mult o ora; plus la trezirea PC-ului si la pornire
  RATE_RETRIES: 4,                  // pastrat pentru compatibilitate; pauza de rata foloseste acum valuri distincte (RATE_PAUSE_WAVES)
  RATE_PAUSE_WAVES: 6,              // valuri distincte de backoff (2+4+8+16+32+64s ≈ 2 min) pana la pauza periodica. 2..20
  RATE_BACKOFF_MAX_MS: 64 * 1000,   // plafon backoff exponential per val de rate-limit (recomandat de Google: 32..64 s). 4000..300000
  RATE_RECOVER_OK: 5,               // cate operatiuni reusite consecutive refac paralelismul complet dupa rate-limit. 1..50
  DAILY_QUOTA_BYTES: 700 * 1024 ** 3, // volum urcat local in ultimele 24 h peste care o limita persistenta se eticheteaza 750 GB/zi
  ERROR_LOG_MAX_BYTES: 5 * MiB,     // marime maxima google-errors.jsonl inainte de rotatie. 1..50 MiB
  NET_RETRIES: 6,                   // reincercari pe erori de retea / 5xx per cerere. 0..10
  RETRY_BASE_MS: 2000,              // baza backoff exponential. 100..60000
  META_TIMEOUT_MS: 60000,           // timeout per cerere metadate background (list/mkdir/init); suporta latenta Google sub upload masiv. 15000..180000
  INTERACTIVE_TIMEOUT_MS: 20000,    // timeout per navigare interactiva in commanderul Drive; previne agatarea UI. 5000..60000
  UPLOAD_TIMEOUT_MS: 180000,        // timeout per bucata upload; previne socket blocat indefinit. 30000..600000
  INTERACTIVE_YIELD_MS: 3000,       // cat timp maxim cedeaza workerii pornirea de bucati noi cat ruleaza o navigare interactiva in Drive. 500..10000
  UI_LIST_ACTIVE: 300,              // cate elemente nefinalizate arata coada in UI
  UI_LIST_DONE: 50,                 // cate elemente terminate arata coada in UI
  UI_PUSH_MS: 400,                  // interval minim intre actualizari catre UI (leading + trailing). 100..2000
  SAVE_DEBOUNCE_MS: 2000,           // scriere asincrona coada pe disc (offsetul se reverifica oricum la reluare). 200..15000
  INDEX_SAVE_DEBOUNCE_MS: 15000,    // scriere asincrona index sync pe disc (flush sincron la inchidere). 200..60000
  SAVE_CHUNK_ENTRIES: 2000,         // cate intrari scriem per tick la serializare JSON pe disc (evita blocarea UI). 200..10000
  SCAN_PROGRESS_MS: 250,            // interval rapoarte progres din thread-ul de scanare. 100..2000
  SCAN_STAT_BATCH: 64,              // cate apeluri stat ruleaza in paralel la scanare. 8..256
  DIFF_YIELD_EVERY: 5000,           // cedam event loop-ul la fiecare N fisiere in compararea cu indexul. 500..20000
  TRASH_CONCURRENCY: 4,             // cate fisiere mutam in paralel in Cosul Drive la modul Mirror. 1..8
  ACTIVITY_MAX: 80,                 // cate evenimente pastram in jurnalul de activitate din memorie. 20..500
  DRIVE_BASE: process.env.NEXDRIVE_API || 'https://www.googleapis.com',
  AUTH_URL: process.env.NEXDRIVE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  TOKEN_URL: process.env.NEXDRIVE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  SCOPE: 'https://www.googleapis.com/auth/drive',
};
