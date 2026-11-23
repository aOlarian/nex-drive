/* MAP
 * §1 citire/scriere atomica + streaming  L8-L54
 * §2 store joburi si indexuri pe disc  L55-L120
 */

// §1 citire/scriere atomica + streaming: indexurile mari se scriu pe bucati ca sa nu blocheze firul principal
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const yieldTick = () => new Promise((r) => setImmediate(r));

function readJson(file, fallback, now) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') fs.copyFileSync(file, `${file}.corupt-${now()}`); // nu pierdem tacut un fisier ilizibil
    return fallback();
  }
}

function writeAtomicSync(file, data, tag = '') {
  const tmp = `${file}.${tag || 's'}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// Scriere JSON valida {"files":{...}} in bucati de SAVE_CHUNK_ENTRIES, cu yield intre bucati (zero blocaj la 300k+ intrari)
async function writeIndexStream(file, map, isCurrent, tag, chunkEntries = cfg.SAVE_CHUNK_ENTRIES) {
  const tmp = `${file}.${tag}.tmp`;
  const ws = fs.createWriteStream(tmp, { encoding: 'utf8' });
  const push = (str) => new Promise((res, rej) => {
    ws.once('error', rej);
    if (ws.write(str)) { ws.removeListener('error', rej); res(); }
    else ws.once('drain', () => { ws.removeListener('error', rej); res(); });
  });
  let buf = '{"files":{';
  let first = true;
  let n = 0;
  try {
    for (const [k, v] of map) {
      if (!isCurrent()) break;
      buf += `${first ? '' : ','}${JSON.stringify(k)}:${JSON.stringify(v)}`;
      first = false;
      if (++n >= chunkEntries) {
        await push(buf);
        buf = '';
        n = 0;
        await yieldTick();
      }
    }
    await push(`${buf}}}`);
    await new Promise((res, rej) => { ws.once('error', rej); ws.end(res); });
    if (isCurrent()) await fs.promises.rename(tmp, file);
    else await fs.promises.rm(tmp, { force: true }).catch(() => {});
  } catch (e) {
    ws.destroy();
    fs.promises.rm(tmp, { force: true }).catch(() => { /* curatare tmp optionala */ });
    throw e;
  }
}

// §2 store joburi si indexuri pe disc
function createSyncStore({ dataDir, now = Date.now, debounceMs = cfg.INDEX_SAVE_DEBOUNCE_MS }) {
  const dir = path.join(dataDir, 'sync');
  fs.mkdirSync(dir, { recursive: true });
  const jobsFile = path.join(dir, 'jobs.json');
  const data = readJson(jobsFile, () => ({ nextId: 1, jobs: [] }), now);
  const saveJobs = () => writeAtomicSync(jobsFile, data, 'jobs');

  const indexes = new Map();
  const timers = new Map();
  const writing = new Set();
  const dirty = new Set();
  const seqs = new Map(); // id -> numar secventa scriere (evita coliziunea sync vs async pe acelasi tmp)
  const nextSeq = (id) => { const n = (seqs.get(id) || 0) + 1; seqs.set(id, n); return n; };
  const indexFile = (id) => path.join(dir, `job-${id}.index.json`);

  function index(id) {
    if (!indexes.has(id)) {
      const raw = readJson(indexFile(id), () => ({ files: {} }), now);
      indexes.set(id, new Map(Object.entries(raw.files || {})));
    }
    return indexes.get(id);
  }

  async function flushIndexAsync(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (!indexes.has(id)) return;
    if (writing.has(id)) { dirty.add(id); return; }
    writing.add(id);
    dirty.delete(id);
    const seq = nextSeq(id);
    try {
      await writeIndexStream(indexFile(id), indexes.get(id), () => seqs.get(id) === seq && indexes.has(id), `a${seq}`);
    } catch (e) {
      if (seqs.get(id) === seq) dirty.add(id);
    } finally {
      writing.delete(id);
      if (dirty.has(id) && indexes.has(id)) saveIndex(id, false);
    }
  }

  function flushIndexSync(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    dirty.delete(id);
    if (!indexes.has(id)) return;
    const seq = nextSeq(id);
    writeAtomicSync(indexFile(id), { files: Object.fromEntries(indexes.get(id)) }, `s${seq}`);
  }

  function saveIndex(id, force) {
    if (force) return flushIndexAsync(id);
    dirty.add(id);
    if (!timers.has(id)) {
      const t = setTimeout(() => { flushIndexAsync(id); }, debounceMs);
      if (t.unref) t.unref();
      timers.set(id, t);
    }
  }

  function dropIndex(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    dirty.delete(id);
    indexes.delete(id);
    fs.rmSync(indexFile(id), { force: true });
  }

  // Sincron la inchiderea aplicatiei (before-quit) si la flush explicit in teste
  const flushAll = () => { saveJobs(); for (const id of indexes.keys()) flushIndexSync(id); };

  return { data, saveJobs, index, saveIndex, dropIndex, flushAll };
}

module.exports = { createSyncStore };
