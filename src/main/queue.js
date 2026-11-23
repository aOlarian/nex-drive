/* MAP
 * §1 imports, stare si structuri O(1)  L8-L125
 * §2 adaugare, mutare stare, stergere, selectie paralela  L126-L273
 * §3 instantaneu UI (O(UI_LIST))  L274-L296
 */

// §1 imports, stare si structuri O(1): Map-uri indexate ca sa mearga instant si la 500k fisiere (fara splice / filter pe tot vectorul)
const fs = require('fs');
const path = require('path');
const { createQueueIO, shouldPersist } = require('./queue-io');

function createQueue({ dataDir, cfg, now = Date.now }) {
  const file = path.join(dataDir, 'queue.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const allMap = new Map();       // id -> item (ordinea de inserare)
  const persistMap = new Map();   // id -> item persistat in queue.json (O(1) la salvare)
  const pendingMap = new Map();   // id -> item cu state === 'pending'
  const pendingByJob = new Map(); // owner (jobId || 0) -> Map<id, item> (selectie paralela O(K))
  const uploadingByJob = new Map(); // owner (jobId || 0) -> numar fisiere in curs de upload
  const openMap = new Map();      // id -> item cu state !== 'done' (pending | uploading | error)
  const doneMap = new Map();      // id -> item cu state === 'done'
  const syncKeys = new Map();     // "jobId|path" -> id (dedup O(1) la addItems)
  const jobStats = new Map();     // jobId -> { pending, uploading, error, bytesTotal, bytesDone }
  const counts = { pending: 0, uploading: 0, done: 0, error: 0 };
  let bytesTotal = 0;
  let bytesDone = 0;

  const st = { nextId: 1, pausedUntil: 0, pauseReason: '', manualPaused: false, workers: 0 };
  Object.defineProperty(st, 'items', { get: () => [...allMap.values()], enumerable: true });
  const io = createQueueIO({ file, st, persistMap, cfg });

  const syncPersist = (it) => { if (shouldPersist(it)) persistMap.set(it.id, it); else persistMap.delete(it.id); };
  const ownerOf = (it) => it.syncJob || 0;
  const addPending = (it) => { const o = ownerOf(it); let m = pendingByJob.get(o); if (!m) { m = new Map(); pendingByJob.set(o, m); } m.set(it.id, it); };
  const delPending = (it) => { const o = ownerOf(it); const m = pendingByJob.get(o); if (m) { m.delete(it.id); if (m.size === 0) pendingByJob.delete(o); } };
  const bumpUp = (o, d) => { const n = Math.max(0, (uploadingByJob.get(o) || 0) + d); if (n === 0) uploadingByJob.delete(o); else uploadingByJob.set(o, n); };
  const jobBucket = (id) => { if (!id) return null; if (!jobStats.has(id)) jobStats.set(id, { pending: 0, uploading: 0, error: 0, bytesTotal: 0, bytesDone: 0 }); return jobStats.get(id); };

  function indexItem(it) {
    allMap.set(it.id, it);
    syncPersist(it);
    counts[it.state]++;
    bytesTotal += it.size;
    bytesDone += it.state === 'done' ? it.size : it.offset;
    if (it.state === 'pending') { pendingMap.set(it.id, it); addPending(it); }
    if (it.state === 'uploading') bumpUp(ownerOf(it), 1);
    if (it.state === 'done') doneMap.set(it.id, it); else openMap.set(it.id, it);
    if (it.syncJob) {
      syncKeys.set(`${it.syncJob}|${it.path}`, it.id);
      const jb = jobBucket(it.syncJob);
      if (it.state !== 'done') jb[it.state]++;
      jb.bytesTotal += it.size;
      jb.bytesDone += it.state === 'done' ? it.size : it.offset;
    }
  }

  function unindexItem(it) {
    if (!allMap.delete(it.id)) return false;
    persistMap.delete(it.id);
    counts[it.state]--;
    bytesTotal -= it.size;
    bytesDone -= it.state === 'done' ? it.size : it.offset;
    if (it.state === 'pending') delPending(it);
    if (it.state === 'uploading') bumpUp(ownerOf(it), -1);
    pendingMap.delete(it.id);
    openMap.delete(it.id);
    doneMap.delete(it.id);
    if (it.syncJob) {
      const k = `${it.syncJob}|${it.path}`;
      if (syncKeys.get(k) === it.id) syncKeys.delete(k);
      const jb = jobStats.get(it.syncJob);
      if (jb) {
        if (it.state !== 'done') jb[it.state] = Math.max(0, jb[it.state] - 1);
        jb.bytesTotal = Math.max(0, jb.bytesTotal - it.size);
        jb.bytesDone = Math.max(0, jb.bytesDone - (it.state === 'done' ? it.size : it.offset));
        if (jb.pending + jb.uploading + jb.error === 0) jobStats.delete(it.syncJob);
      }
    }
    return true;
  }

  function load() {
    try {
      const stat = fs.statSync(file);
      const maxLegacy = cfg.QUEUE_LEGACY_MAX_BYTES || 20 * 1024 * 1024;
      if (stat.size > maxLegacy) {
        // Coada uriasa din v0.4 (sute de mii de iteme sync): pastram metadatele, arhivam fisierul si lasam sync-ul sa reia curat din indexuri
        const fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(4096);
        const read = fs.readSync(fd, head, 0, head.length, 0);
        const tailLen = Math.min(4096, stat.size);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
        fs.closeSync(fd);
        const txt = head.toString('utf8', 0, read) + tail.toString('utf8');
        const num = (k) => { const m = new RegExp(`"${k}":(\\d+)`).exec(txt); return m ? Number(m[1]) : 0; };
        const str = (k) => { const m = new RegExp(`"${k}":"([^"]*)"`).exec(txt); return m ? m[1] : ''; };
        st.nextId = num('nextId') || 1;
        st.pausedUntil = num('pausedUntil');
        st.pauseReason = str('pauseReason');
        st.manualPaused = /"manualPaused":true/.test(txt);
        st.workers = num('workers');
        st.legacyMigrated = true;
        fs.renameSync(file, `${file}.v04-legacy-${now()}`);
        io.writeSync();
        return;
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      st.nextId = raw.nextId || 1;
      st.pausedUntil = raw.pausedUntil || 0;
      st.pauseReason = raw.pauseReason || '';
      st.manualPaused = !!raw.manualPaused;
      st.workers = raw.workers || 0;
      for (const it of raw.items || []) {
        if (it.state === 'uploading') it.state = 'pending';
        indexItem(it);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') fs.copyFileSync(file, `${file}.corupt-${now()}`);
    }
  }
  load();

  // §2 adaugare, mutare stare, stergere, selectie paralela
  function setState(it, next) {
    if (it.state === next) return;
    const prev = it.state;
    const prevDone = prev === 'done' ? it.size : it.offset;
    const nextDone = next === 'done' ? it.size : it.offset;
    counts[prev]--;
    counts[next]++;
    bytesDone += nextDone - prevDone;
    if (prev === 'pending') { pendingMap.delete(it.id); delPending(it); }
    if (next === 'pending') { pendingMap.set(it.id, it); addPending(it); }
    if (prev === 'uploading') bumpUp(ownerOf(it), -1);
    if (next === 'uploading') bumpUp(ownerOf(it), 1);
    if (prev === 'done') { doneMap.delete(it.id); openMap.set(it.id, it); }
    if (next === 'done') { openMap.delete(it.id); doneMap.set(it.id, it); }
    if (it.syncJob) {
      const jb = jobBucket(it.syncJob);
      if (prev !== 'done') jb[prev] = Math.max(0, jb[prev] - 1);
      if (next !== 'done') jb[next]++;
      jb.bytesDone = Math.max(0, jb.bytesDone + (nextDone - prevDone));
      if (jb.pending + jb.uploading + jb.error === 0) jobStats.delete(it.syncJob);
    }
    it.state = next;
  }

  function setProgress(it, nextOffset, nextSize) {
    const oldSize = it.size;
    const oldDone = it.state === 'done' ? it.size : it.offset;
    if (nextSize !== undefined && nextSize !== oldSize) {
      it.size = nextSize;
      bytesTotal += nextSize - oldSize;
      if (it.syncJob) { const jb = jobBucket(it.syncJob); jb.bytesTotal = Math.max(0, jb.bytesTotal + (nextSize - oldSize)); }
    }
    it.offset = nextOffset;
    syncPersist(it);
    const newDone = it.state === 'done' ? it.size : it.offset;
    bytesDone += newDone - oldDone;
    if (it.syncJob) { const jb = jobBucket(it.syncJob); jb.bytesDone = Math.max(0, jb.bytesDone + (newDone - oldDone)); }
  }

  async function* walk(dir, rel) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(full, [...rel, e.name]);
      else if (e.isFile()) yield { full, rel };
    }
  }

  async function add(paths, rootParent, onExists) {
    const seen = new Set();
    for (const i of openMap.values()) seen.add(`${i.rootParent}|${i.rel.join('/')}|${i.path}`);
    let added = 0;
    const push = async (full, rel) => {
      const key = `${rootParent}|${rel.join('/')}|${full}`;
      if (seen.has(key)) return;
      seen.add(key);
      const stat = await fs.promises.stat(full);
      indexItem({
        id: st.nextId++, path: full, name: path.basename(full), rel, rootParent,
        size: stat.size, onExists: ['skip', 'replace', 'rename'].includes(onExists) ? onExists : 'skip', uploadName: '', note: '', state: 'pending', session: '', offset: 0, error: '', driveId: '', addedAt: now(),
      });
      added++;
    };
    for (const p of paths) {
      const stat = await fs.promises.stat(p);
      if (stat.isDirectory()) { for await (const f of walk(p, [path.basename(p)])) await push(f.full, f.rel); }
      else await push(p, []);
    }
    if (added) io.save(false);
    return added;
  }

  function addItems(list) {
    let added = 0;
    for (const e of list) {
      const key = `${e.syncJob || ''}|${e.path}`;
      if (syncKeys.has(key)) continue;
      indexItem({
        id: st.nextId++, path: e.path, name: path.basename(e.path), rel: e.rel, rootParent: e.rootParent, size: e.size, mtimeMs: e.mtimeMs,
        syncJob: e.syncJob, updateId: e.updateId || '', keepForever: !!e.keepForever, onExists: 'adopt', uploadName: '', note: '', state: 'pending', session: '', offset: 0, error: '', driveId: '', addedAt: now(),
      });
      added++;
    }
    if (added) io.save(false);
    return added;
  }

  function removeWhere(pred) {
    let n = 0;
    for (const it of [...allMap.values()]) { if (pred(it)) { it.cancel = true; unindexItem(it); n++; } }
    if (n) io.save(false);
    return n;
  }

  function remove(id) {
    const it = allMap.get(id);
    if (!it) return false;
    it.cancel = true;
    unindexItem(it);
    io.save(false);
    return true;
  }

  function clear(mode) {
    let removed = 0;
    const src = mode === 'done' ? [...doneMap.values()] : mode === 'errors' ? [...openMap.values()].filter((i) => i.state === 'error') : [...allMap.values()];
    for (const it of src) { it.cancel = true; if (unindexItem(it)) removed++; }
    if (removed) io.save(true);
    return removed;
  }

  function retryErrors() {
    let n = 0;
    for (const it of [...openMap.values()]) { if (it.state === 'error') { it.error = ''; setState(it, 'pending'); n++; } }
    if (n) io.save(false);
    return n;
  }

  // Selectie O(K) pe proiecte in paralel: cele mai prioritare proiecte iau cate 1 conexiune, apoi se distribuie pe cel cu cele mai putine active
  function nextPending(policy) {
    if (!policy) return pendingMap.values().next().value || null;
    const isBlocked = policy.isBlocked || (() => false);
    const seen = new Set();
    const order = [];
    for (const o of policy.order || []) { if (!seen.has(o) && pendingByJob.has(o) && !isBlocked(o)) { seen.add(o); order.push(o); } }
    for (const o of pendingByJob.keys()) { if (!seen.has(o) && !isBlocked(o)) { seen.add(o); order.push(o); } }
    let bestOwner = null;
    let bestActive = Infinity;
    for (const o of order) {
      const act = uploadingByJob.get(o) || 0;
      if (act < bestActive) { bestActive = act; bestOwner = o; if (act === 0) break; }
    }
    if (bestOwner === null) return null;
    const bucket = pendingByJob.get(bestOwner);
    return bucket ? bucket.values().next().value || null : null;
  }

  function eligiblePendingCount(policy) {
    if (!policy) return counts.pending;
    const isBlocked = policy.isBlocked || (() => false);
    let total = 0;
    for (const [o, m] of pendingByJob) if (!isBlocked(o)) total += m.size;
    return total;
  }

  const openCountForJob = (jobId) => { const j = jobStats.get(jobId); return j ? j.pending + j.uploading + j.error : 0; };
  const jobInfo = (jobId) => jobStats.get(jobId) || { pending: 0, uploading: 0, error: 0, bytesTotal: 0, bytesDone: 0 };

  // §3 instantaneu UI (O(UI_LIST), fara a parcurge sute de mii de intrari)
  function snapshot() {
    const pick = (i) => ({ id: i.id, name: i.name, rel: i.rel, size: i.size, offset: i.offset, state: i.state, error: i.error, note: i.note, syncJob: i.syncJob || 0 });
    const items = [];
    let take = cfg.UI_LIST_ACTIVE;
    for (const it of openMap.values()) { if (take-- <= 0) break; items.push(pick(it)); }
    let skipDone = Math.max(0, doneMap.size - cfg.UI_LIST_DONE);
    for (const it of doneMap.values()) { if (skipDone-- > 0) continue; items.push(pick(it)); }
    const perJob = {};
    for (const [id, v] of jobStats) perJob[id] = { ...v };
    return {
      now: now(), pausedUntil: st.pausedUntil, pauseReason: st.pauseReason, manualPaused: st.manualPaused,
      counts: { ...counts }, bytesTotal, bytesDone, perJob,
      workers: Math.min(Math.max(Number(st.workers) || cfg.WORKERS, 1), cfg.MAX_WORKERS || 8),
      items,
    };
  }

  return { st, counts, save: io.save, setState, setProgress, add, addItems, removeWhere, remove, clear, retryErrors, nextPending, eligiblePendingCount, openCountForJob, jobInfo, snapshot };
}

module.exports = { createQueue };
