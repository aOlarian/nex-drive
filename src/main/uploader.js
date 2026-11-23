/* MAP
 * §1 imports, retry  L9-L64
 * §2 upload un fisier (multipart <=2MiB | resumabil >2MiB)  L65-L152
 * §3 procesare element + pauza + workeri  L153-L222
 * §4 pornire, ceas, API public  L223-L265
 */

// §1 imports, retry
const fs = require('fs');
const path = require('path');
const { DriveError } = require('./drive');
const { createQueue } = require('./queue');
const { PauseSignal, classify, createTelemetry, createRateGuard, createFolderCache, createInteractiveGate } = require('./upload-telemetry');

function createUploader({ drive, dataDir, cfg, now = Date.now, sleep, onChange = () => {}, onSyncDone = () => {}, activity = null, jobName = () => '', getSettings = null, getJobPolicy = null }) {
  const q = createQueue({ dataDir, cfg, now });
  const st = q.st;
  const gate = createInteractiveGate({ maxWaitMs: cfg.INTERACTIVE_YIELD_MS || 3000 });
  let active = 0;
  let timer = null;

  const limit = () => Math.min(Math.max(Number(st.workers) || cfg.WORKERS, 1), cfg.MAX_WORKERS || 8);
  const rg = createRateGuard({ cfg, now, getSettings });
  const cap = () => rg.effectiveWorkers(limit());
  const paused = () => st.manualPaused || (st.pausedUntil > 0 && now() < st.pausedUntil);
  const policy = () => (getJobPolicy ? getJobPolicy() : null);
  const jobBlocked = (id) => { if (!id) return false; const p = policy(); return !!(p && p.isBlocked && p.isBlocked(id)); };
  const log = (level, scope, text) => { if (activity) activity.log(level, scope, text); };
  const tel = createTelemetry({ now, cfg, jobName, onEmit: () => onChange(snapshot()) });

  function snapshot() {
    return { ...q.snapshot(), activeWorkers: active, speed: tel.speed(active), activeItems: tel.activeItems(), retryInfo: tel.getRetry() };
  }

  async function withRetry(fn, it) {
    for (let n = 0; ; n++) {
      try {
        const r = await fn();
        if (rg.onSuccess()) kick();
        const ri = tel.getRetry();
        if (ri && (!it || ri.itemId === it.id)) tel.setRetry(null);
        return r;
      } catch (e) {
        const kind = classify(e);
        if (kind === 'transient' && n < cfg.NET_RETRIES) {
          const waitMs = cfg.RETRY_BASE_MS * 2 ** n;
          tel.setRetry({ kind: 'network', itemId: it ? it.id : 0, attempt: n + 1, max: cfg.NET_RETRIES, waitMs, until: now() + waitMs, reason: e.message });
          if (it) tel.setPhase(it.id, `retrying network (${n + 1}/${cfg.NET_RETRIES})`);
          if (n === 0) log('warn', 'Upload', `Temporary network error on ${it ? it.name : 'request'}: ${e.message}. Retrying…`);
          tel.emit(); await sleep(waitMs);
          if (it && (it.cancel || jobBlocked(it.syncJob))) { const a = new Error('aborted'); a.aborted = true; throw a; }
          continue;
        }
        if (kind === 'quota') {
          const d = rg.onRateError(e);
          if (d.pause) { tel.setRetry(null); throw new PauseSignal(d.reason, d.waitMs); }
          const detail = `HTTP ${e.status || 429} ${e.reason || 'rateLimit'}`;
          tel.setRetry({ kind: 'rate', itemId: it ? it.id : 0, attempt: d.wave, max: d.max, waitMs: d.waitMs, until: now() + d.waitMs, reason: detail });
          if (it) tel.setPhase(it.id, `Drive rate limit (${d.wave}/${d.max})`);
          if (!d.sameWave) log('warn', 'Drive limit', `${detail} (wave ${d.wave}/${d.max}). Backing off ${Math.max(1, Math.round(d.waitMs / 1000))}s (connections: ${cap()}/${limit()})…`);
          tel.emit(); await sleep(d.waitMs);
          if (it && (it.cancel || jobBlocked(it.syncJob))) { const a = new Error('aborted'); a.aborted = true; throw a; }
          continue;
        }
        throw e;
      }
    }
  }

  const cache = createFolderCache({ drive, cfg, now, withRetry });

  // §2 upload un fisier (multipart <=2MiB | resumabil >2MiB)
  const splitName = (name) => { const ext = path.extname(name); return [ext ? name.slice(0, -ext.length) : name, ext]; };

  function freeName(children, name) {
    const [stem, ext] = splitName(name);
    for (let n = 1; ; n++) {
      const cand = `${stem}-${n}${ext}`;
      if (!children.has(cand)) return cand;
    }
  }

  async function prepare(it, parentId) {
    tel.setPhase(it.id, 'checking Drive');
    if (it.updateId) return 'go';
    const children = await cache.getChildren(parentId, it);
    const same = children.get(it.uploadName || it.name);
    if (!same) { it.uploadName = it.uploadName || it.name; return 'go'; }
    if (it.onExists === 'adopt') {
      if (same.size === it.size) { it.driveId = same.id; it.note = 'already in Drive'; return 'skip'; }
      it.updateId = same.id;
      return 'go';
    }
    if (it.uploadName && same.size === it.size) { it.driveId = same.id; return 'done'; }
    const policy = it.onExists || 'skip';
    if (policy === 'skip') { it.note = 'skipped: already exists'; return 'skip'; }
    if (policy === 'replace') {
      await withRetry(() => drive.trash(same.id), it);
      children.delete(it.name);
      it.uploadName = it.name;
      it.note = 'replaced';
      return 'go';
    }
    it.uploadName = freeName(children, it.name);
    it.note = `renamed: ${it.uploadName}`;
    return 'go';
  }

  async function uploadFile(it, parentId) {
    if (!it.session) {
      const r = await prepare(it, parentId);
      if (r !== 'go') { q.setProgress(it, it.size); return; }
      if (it.size === 0) {
        if (it.updateId) await withRetry(() => drive.trash(it.updateId), it);
        it.driveId = (await withRetry(() => drive.createEmptyFile(parentId, it.uploadName || it.name), it)).id;
        cache.remember(parentId, it.uploadName || it.name, it.driveId, 0);
        return;
      }
      if (drive.uploadMultipart && it.size <= (cfg.MULTIPART_MAX_BYTES || 0)) {
        await gate.wait();
        if (it.cancel || paused() || jobBlocked(it.syncJob)) return;
        tel.setPhase(it.id, 'uploading');
        const buf = await fs.promises.readFile(it.path);
        let res;
        try {
          res = await withRetry(() => drive.uploadMultipart({ name: it.uploadName || it.name, parentId, buf, updateId: it.updateId, keepForever: it.keepForever }), it);
        } catch (e) {
          if (!(it.updateId && e instanceof DriveError && e.status === 404)) throw e;
          it.updateId = '';
          it.uploadName = it.name;
          res = await withRetry(() => drive.uploadMultipart({ name: it.uploadName, parentId, buf }), it);
        }
        tel.recordBytes(buf.length);
        rg.addUploaded(buf.length);
        it.driveId = res.id;
        q.setProgress(it, it.size);
        cache.remember(parentId, it.uploadName || it.name, it.driveId, it.size);
        return;
      }
      tel.setPhase(it.id, 'starting upload');
      try {
        it.session = await withRetry(() => drive.initUpload({ name: it.uploadName, parentId, size: it.size, updateId: it.updateId, keepForever: it.keepForever }), it);
      } catch (e) {
        if (!(it.updateId && e instanceof DriveError && e.status === 404)) throw e;
        it.updateId = '';
        it.uploadName = it.name;
        it.session = await withRetry(() => drive.initUpload({ name: it.uploadName, parentId, size: it.size }), it);
      }
      q.setProgress(it, 0);
      q.save(false);
    } else {
      tel.setPhase(it.id, 'resuming session');
      const r = await withRetry(() => drive.queryOffset(it.session, it.size), it);
      if (r.done) { it.driveId = r.file.id; q.setProgress(it, it.size); return; }
      q.setProgress(it, r.next);
    }
    tel.setPhase(it.id, 'uploading');
    const fh = await fs.promises.open(it.path, 'r');
    try {
      while (it.offset < it.size) {
        await gate.wait();
        if (it.cancel || paused() || jobBlocked(it.syncJob)) return;
        const len = Math.min(cfg.CHUNK_BYTES, it.size - it.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, it.offset);
        if (bytesRead !== len) throw new Error(`File changed while reading: ${it.path}`);
        const r = await withRetry(() => drive.putChunk(it.session, buf, it.offset, it.size), it);
        tel.recordBytes(len);
        rg.addUploaded(len);
        if (r.done) { it.driveId = r.file.id; q.setProgress(it, it.size); cache.remember(parentId, it.uploadName || it.name, it.driveId, it.size); break; }
        q.setProgress(it, r.next);
        q.save(false);
        tel.emit();
      }
    } finally { await fh.close(); }
  }

  // §3 procesare element + pauza + workeri
  function startPause(reason, waitMs) {
    if (st.pausedUntil > now()) return;
    const dur = waitMs || rg.pauseDuration();
    st.pausedUntil = now() + dur;
    st.pauseReason = reason;
    rg.reset();
    tel.setRetry(null);
    const mins = Math.max(1, Math.round(dur / 60000));
    log('warn', 'Upload', `${reason}. Retrying automatically in ${mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`}.`);
    q.save(true); arm(); tel.emit(true);
  }

  async function processItem(it) {
    q.setState(it, 'uploading');
    it.error = '';
    tel.activeMap.set(it.id, { id: it.id, name: it.name, syncJob: it.syncJob || 0, phase: 'preparing' });
    tel.emit();
    try {
      let stat;
      try { stat = await fs.promises.stat(it.path); } catch (e) { throw new Error(`File no longer exists: ${it.path}`); }
      if (stat.size !== it.size) { it.session = ''; q.setProgress(it, 0, stat.size); }
      tel.setPhase(it.id, 'resolving folders');
      const parentId = await withRetry(() => cache.resolveParent(it), it);
      if (it.cancel) return;
      if (jobBlocked(it.syncJob)) { q.setState(it, 'pending'); return; }
      await uploadFile(it, parentId);
      if (it.cancel) return;
      const finished = it.offset >= it.size;
      q.setState(it, finished ? 'done' : 'pending');
      if (finished && it.syncJob) { q.remove(it.id); onSyncDone(it); }
    } catch (e) {
      if (it.cancel) return;
      if (e.aborted || jobBlocked(it.syncJob)) { q.setState(it, 'pending'); return; }
      const kind = classify(e);
      if (kind === 'pause') { q.setState(it, 'pending'); startPause(e.reason, e.waitMs); }
      else if (kind === 'session') { q.setState(it, 'pending'); it.session = ''; q.setProgress(it, 0); }
      else if (kind === 'auth') {
        q.setState(it, 'pending'); st.manualPaused = true; st.pauseReason = 'Sign-in expired: connect again';
        log('error', 'Auth', 'Google sign-in expired. Uploads paused until you sign in again.'); q.save(true);
      } else {
        it.error = e.message; q.setState(it, 'error');
        log('error', it.syncJob ? (jobName(it.syncJob) || 'Sync') : 'Upload', `Failed "${it.name}": ${e.message}`);
      }
    } finally {
      tel.activeMap.delete(it.id);
      const ri = tel.getRetry();
      if (ri && ri.itemId === it.id) tel.setRetry(null);
      q.save(false); tel.emit();
    }
  }

  async function workerLoop() {
    active++;
    try {
      while (!paused() && active <= cap()) {
        const it = q.nextPending(policy());
        if (!it) break;
        await processItem(it);
      }
    } finally {
      active--;
      if (active === 0) tel.setRetry(null);
      tel.emit(active === 0);
    }
  }

  function kick() {
    if (paused()) return;
    const elig = q.eligiblePendingCount ? q.eligiblePendingCount(policy()) : q.counts.pending;
    const want = Math.min(cap() - active, elig);
    for (let i = 0; i < want; i++) workerLoop();
  }

  // §4 pornire, ceas, API public
  function arm() {
    clearTimeout(timer);
    if (!st.pausedUntil) return;
    const wait = Math.min(Math.max(st.pausedUntil - now(), 1000), cfg.TICK_MS);
    timer = setTimeout(tick, wait);
    if (timer.unref) timer.unref();
  }

  function tick() {
    if (st.pausedUntil && now() >= st.pausedUntil) {
      st.pausedUntil = 0; st.pauseReason = ''; rg.reset();
      log('ok', 'Upload', 'Limit wait ended. Retrying uploads automatically.'); q.save(true);
    }
    kick(); arm(); tel.emit(true);
  }

  function jobStatus(jobId) {
    const info = q.jobInfo(jobId);
    return {
      ...info, open: info.pending + info.uploading + info.error,
      activeWorkers: active, maxWorkers: limit(), busyWith: tel.busyOwners(jobId), speed: tel.speed(active),
      paused: paused(), manualPaused: st.manualPaused, pausedUntil: st.pausedUntil, pauseReason: st.pauseReason, retryInfo: tel.getRetry(),
    };
  }

  return {
    queue: q, start: tick, tick, kick, snapshot, jobStatus, beginInteractive: gate.begin,
    async add(paths, rootParent, onExists) { const n = await q.add(paths, rootParent, onExists); if (n) log('info', 'Files', `Queued ${n} file(s) for upload.`); kick(); tel.emit(true); return n; },
    remove(id) { const ok = q.remove(id); tel.emit(true); return ok; },
    clear(mode) { const n = q.clear(mode); tel.emit(true); return n; },
    retryErrors() { const n = q.retryErrors(); if (n) log('info', 'Upload', `Retrying ${n} failed upload(s).`); kick(); tel.emit(true); return n; },
    pause() { st.manualPaused = true; st.pauseReason = 'Paused by you'; log('info', 'Upload', 'Uploads paused manually.'); q.save(true); tel.emit(true); },
    resume() { st.manualPaused = false; st.pausedUntil = 0; st.pauseReason = ''; rg.reset(); log('info', 'Upload', 'Uploads resumed.'); q.save(true); kick(); arm(); tel.emit(true); },
    setWorkers(n) { st.workers = Math.min(Math.max(Math.round(Number(n)) || cfg.WORKERS, 1), cfg.MAX_WORKERS || 8); q.save(true); kick(); tel.emit(true); return st.workers; },
    addItems(list) { const n = q.addItems(list); kick(); tel.emit(true); return n; },
    removeWhere(pred) { const n = q.removeWhere(pred); tel.emit(true); return n; },
    idle: () => active === 0,
  };
}

module.exports = { createUploader, classify, PauseSignal };
