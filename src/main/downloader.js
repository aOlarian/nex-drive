/* MAP
 * §1 constante si tipuri Google  L6-L20
 * §2 coada de descarcari  L21-L162
 */

// §1 constante si tipuri Google (Docs/Sheets/Slides nu au continut binar: se exporta)
const fs = require('fs');
const path = require('path');

const FOLDER = 'application/vnd.google-apps.folder';
const OOXML = 'application/vnd.openxmlformats-officedocument';
const EXPORTS = {
  'application/vnd.google-apps.document': [`${OOXML}.wordprocessingml.document`, '.docx'],
  'application/vnd.google-apps.spreadsheet': [`${OOXML}.spreadsheetml.sheet`, '.xlsx'],
  'application/vnd.google-apps.presentation': [`${OOXML}.presentationml.presentation`, '.pptx'],
  'application/vnd.google-apps.drawing': ['image/png', '.png'],
  'application/vnd.google-apps.script': ['application/vnd.google-apps.script+json', '.json'],
};
const safeName = (n) => n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '_';

// §2 coada de descarcari: foldere expandate lent, o eroare pe un fisier NU opreste restul
function createDownloader({ drive, cfg, now = Date.now, sleep, onChange = () => {} }) {
  let tasks = [];
  let nextId = 1;
  let active = 0;
  let samples = []; // [moment, octeti] pentru viteza pe ultimele secunde
  let totalBytes = 0;
  let lastEmit = 0;
  const reserved = new Set();

  function emit(force) {
    if (!force && now() - lastEmit < 300) return;
    lastEmit = now();
    onChange(snapshot());
  }

  // Politica la fisier local existent: skip (null) | replace (suprascrie) | rename (nume-1, nume-2...)
  function resolveDest(dir, name, policy) {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const p = path.join(dir, name);
    const taken = (x) => reserved.has(x) || fs.existsSync(x);
    if (!taken(p)) { reserved.add(p); return p; }
    if (policy === 'skip') return null;
    if (policy === 'replace' && !reserved.has(p)) { reserved.add(p); return p; }
    for (let n = 1; ; n++) {
      const cand = path.join(dir, `${stem}-${n}${ext}`);
      if (!taken(cand)) { reserved.add(cand); return cand; }
    }
  }

  const addTask = (item, destDir, onExists, onDone) => {
    tasks.push({ id: nextId++, driveId: item.id, name: item.name, mimeType: item.mimeType, size: Number(item.size) || 0, destDir, onExists, onDone, state: 'pending', bytes: 0, error: '', rel: '', note: '' });
  };

  // onDone(caleLocala): apelat dupa fiecare fisier ajuns pe disc (sau sarit pentru ca exista deja); folosit de Sync la restaurare
  function add(items, destDir, onExists, onDone) {
    const pol = ['skip', 'replace', 'rename'].includes(onExists) ? onExists : 'rename';
    for (const it of items) addTask(it, destDir, pol, onDone);
    kick();
    emit(true);
    return items.length;
  }

  async function runFolder(t) {
    const dir = path.join(t.destDir, safeName(t.name)); // foldere: se imbina; politica se aplica fisierelor din ele
    fs.mkdirSync(dir, { recursive: true });
    const kids = await drive.listAll(t.driveId);
    for (const k of kids) addTask(k, dir, t.onExists, t.onDone);
    t.state = 'done';
  }

  async function runFile(t) {
    const exp = EXPORTS[t.mimeType];
    if (t.mimeType === 'application/vnd.google-apps.shortcut') throw new Error('Drive shortcut: has no content of its own');
    if (t.mimeType.startsWith('application/vnd.google-apps.') && !exp) throw new Error('Google type without export (Forms/Sites/Maps)');
    const name = exp && !safeName(t.name).toLowerCase().endsWith(exp[1]) ? safeName(t.name) + exp[1] : safeName(t.name);
    const dest = resolveDest(t.destDir, name, t.onExists);
    if (!dest) { t.rel = name; t.note = 'skipped: already exists'; t.state = 'done'; if (t.onDone) t.onDone(path.join(t.destDir, name)); return; }
    const part = `${dest}.part`;
    t.rel = path.basename(dest);
    t.controller = new AbortController();
    try {
      for (let n = 0; ; n++) {
        t.bytes = 0;
        try {
          await drive.download(t.driveId, part, {
            signal: t.controller.signal, exportMime: exp && exp[0],
            onProgress: (len) => { t.bytes += len; totalBytes += len; samples.push([now(), len]); emit(false); },
          });
          break;
        } catch (e) {
          const transient = (e.status >= 500 || e.reason === 'userRateLimitExceeded' || /fetch failed|ECONNRESET|terminated/.test(e.message));
          if (!transient || n >= cfg.NET_RETRIES || t.controller.signal.aborted) throw e;
          await sleep(cfg.RETRY_BASE_MS * 2 ** n);
        }
      }
      fs.renameSync(part, dest);
      t.state = 'done';
      if (t.onDone) t.onDone(dest);
    } catch (e) {
      fs.rmSync(part, { force: true });
      reserved.delete(dest);
      throw e;
    } finally {
      t.controller = null;
    }
  }

  async function worker() {
    active++;
    try {
      for (let t = tasks.find((x) => x.state === 'pending'); t; t = tasks.find((x) => x.state === 'pending')) {
        t.state = 'downloading';
        emit(true);
        try {
          if (t.mimeType === FOLDER) await runFolder(t); else await runFile(t);
        } catch (e) {
          if (t.cancelled) { t.state = 'cancelled'; } else { t.state = 'error'; t.error = e.reason ? `${e.message} (${e.reason})` : e.message; }
        }
        emit(true);
      }
    } finally {
      active--;
      if (active === 0) reserved.clear(); // rezervarile conteaza doar in cursul unui lot
      emit(true);
    }
  }

  function kick() {
    const want = Math.min(cfg.DL_WORKERS - active, tasks.filter((t) => t.state === 'pending').length);
    for (let i = 0; i < want; i++) worker();
  }

  function cancelAll() {
    for (const t of tasks) {
      if (t.state === 'pending') t.state = 'cancelled';
      else if (t.state === 'downloading') { t.cancelled = true; if (t.controller) t.controller.abort(); }
    }
    emit(true);
  }

  function retryErrors() {
    let n = 0;
    for (const t of tasks) if (t.state === 'error' || t.state === 'cancelled') { t.state = 'pending'; t.error = ''; t.cancelled = false; n++; }
    kick();
    emit(true);
    return n;
  }

  function clear(mode) { // done | finished (gata + anulate) ; erorile se pastreaza pana la „Reincearca” sau „Sterge tot”
    tasks = tasks.filter((t) => (mode === 'all' ? t.state === 'downloading' : !(t.state === 'done' || t.state === 'cancelled')));
    emit(true);
  }

  function snapshot() {
    const cut = now() - 5000;
    samples = samples.filter((s) => s[0] >= cut);
    const speed = samples.reduce((a, s) => a + s[1], 0) / 5;
    const counts = { pending: 0, downloading: 0, done: 0, error: 0, cancelled: 0 };
    for (const t of tasks) if (t.mimeType !== FOLDER) counts[t.state]++;
    const pick = (t) => ({ id: t.id, name: t.rel || t.name, state: t.state, bytes: t.bytes, size: t.size, error: t.error, note: t.note });
    const files = tasks.filter((t) => t.mimeType !== FOLDER);
    const order = [...files.filter((t) => t.state === 'downloading'), ...files.filter((t) => t.state === 'error'),
      ...files.filter((t) => t.state === 'pending').slice(0, 100), ...files.filter((t) => t.state === 'done').slice(-30)];
    return { counts, totalBytes, speed, active: active > 0, items: order.map(pick) };
  }

  return { add, cancelAll, retryErrors, clear, snapshot, idle: () => active === 0 };
}

module.exports = { createDownloader };
