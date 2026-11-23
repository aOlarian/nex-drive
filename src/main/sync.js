/* MAP
 * §1 stare joburi, view si politica de prioritate  L8-L57
 * §2 rulare sync + Mirror (cu anulare la Stop)  L58-L120
 * §3 CRUD joburi, Start/Stop, Pause/Resume, Reorder, tick paralel  L121-L270
 */

// §1 stare joburi, view si politica de prioritate
const { nextRun, normalize, describe } = require('./schedule');
const { scanSources, covered, resolveDeleteMode, describeLive, trashMirrorBatch, diffScan } = require('./sync-scan');
const { createDeletedOps } = require('./sync-deleted');

const MTIME_TOLERANCE_MS = 2;

function createSync({ store, uploader, drive, downloader, now = Date.now, onChange = () => {}, activity = null }) {
  const running = new Set();
  const scanCancels = new Map();
  const scanProg = new Map();
  const cleanProg = new Map();
  const counts = new Map();
  const data = store.data;
  const find = (id) => data.jobs.find((j) => j.id === id);
  const mustFind = (id) => { const j = find(id); if (!j) throw new Error('Unknown sync job'); return j; };
  const openOf = (id) => (uploader.queue.openCountForJob ? uploader.queue.openCountForJob(id) : 0);
  const log = (level, scope, text) => { if (activity) activity.log(level, scope, text); };
  const emit = () => onChange(listJobs());
  const kickUploader = () => { if (uploader.kick) uploader.kick(); };
  const launch = (j) => run(j.id).catch((e) => { j.lastError = e.message; log('error', j.name, e.message); emit(); });

  function recount(id) {
    let deleted = 0;
    const idx = store.index(id);
    for (const e of idx.values()) if (e.x) deleted++;
    counts.set(id, { files: idx.size, deleted });
  }

  function view(j) {
    if (!counts.has(j.id)) recount(j.id);
    const c = counts.get(j.id);
    const st = uploader.jobStatus ? uploader.jobStatus(j.id) : { open: openOf(j.id), uploading: 0, pending: 0, error: 0, bytesDone: 0, bytesTotal: 0 };
    const live = describeLive(j, st, { isRunning: running.has(j.id), scanProg: scanProg.get(j.id), cleanProg: cleanProg.get(j.id), now });
    return {
      ...j, paused: !!j.paused, deleteMode: resolveDeleteMode(j), running: running.has(j.id),
      openUploads: st.open, uploadingNow: st.uploading, pendingUploads: st.pending, uploadErrors: st.error,
      bytesDone: st.bytesDone, bytesTotal: st.bytesTotal, phase: live.phase, detail: live.detail,
      scanProgress: scanProg.get(j.id) || null, cleanProgress: cleanProg.get(j.id) || null,
      files: c.files, deleted: c.deleted, scheduleText: describe(j.schedule),
    };
  }

  const listJobs = () => data.jobs.map(view);
  const nameOf = (id) => { const j = find(id); return j ? j.name : ''; };

  // Ordinea de prioritate pentru uploader: upload manual (0) apoi joburile sync de sus in jos; blocate = oprite sau in pauza
  const getPriorityPolicy = () => ({
    order: [0, ...data.jobs.map((j) => j.id)],
    isBlocked: (id) => { if (!id) return false; const j = find(id); return !j || !j.enabled || !!j.paused; },
  });

  // §2 rulare sync + Mirror (cu anulare la Stop)
  async function run(id, { force = false } = {}) {
    const job = mustFind(id);
    if (!job.enabled) return 'stopped';
    if (running.has(id) || (!force && openOf(id) > 0)) return 'busy';
    running.add(id);
    scanProg.set(id, { files: 0, dirs: 0, currentDir: '' });
    emit();
    const idx = store.index(id);
    const mode = resolveDeleteMode(job);
    try {
      uploader.removeWhere((it) => it.syncJob === id && it.state === 'error');
      const t0 = now();
      const { files, unreadable, errors } = await scanSources(job.sources, {
        onProgress: (p) => { scanProg.set(id, p); emit(); },
        onWorker: (cancel) => scanCancels.set(id, cancel),
      });
      scanCancels.delete(id); scanProg.delete(id);
      if (!job.enabled) return 'stopped';

      const plan = await diffScan({ files, unreadable, idx, job, mode, now, toleranceMs: MTIME_TOLERANCE_MS });
      if (!plan || !job.enabled) return 'stopped';
      const { queued, fresh, changed, markedDeleted, toTrash } = plan;

      let trashedFromDrive = 0;
      if (toTrash.length && job.enabled) {
        const r = await trashMirrorBatch({ drive, idx, list: toTrash, now, onProgress: (p) => { cleanProg.set(id, p); emit(); } });
        cleanProg.delete(id); trashedFromDrive = r.done;
        if (r.done) log('info', job.name, `Mirror moved ${r.done} removed file(s) to Drive Trash.`);
        if (r.failed.length) errors.push(`Drive cleanup failed for ${r.failed.length} file(s): ${r.failed.slice(0, 2).join('; ')}`);
      }
      if (!job.enabled) return 'stopped';

      job.lastRunAt = t0;
      job.nextRunAt = nextRun(job.schedule, t0, now());
      job.lastError = errors.join('; ');
      job.incomplete = openOf(id) + queued.length > 0;
      job.lastScan = { at: t0, total: files.size, fresh, changed, markedDeleted, trashedFromDrive, ms: now() - t0 };
      store.saveIndex(id, false); store.saveJobs(); recount(id);
      uploader.addItems(queued);
      if (errors.length) log('error', job.name, job.lastError);
      else if (fresh || changed || markedDeleted || trashedFromDrive) {
        const parts = [fresh && `${fresh} new`, changed && `${changed} changed`, markedDeleted && `${markedDeleted} marked deleted`, trashedFromDrive && `${trashedFromDrive} trashed in Drive`].filter(Boolean);
        log('info', job.name, `Scan finished (${files.size.toLocaleString('en-US')} files): ${parts.join(', ')}.`);
      }
      return 'started';
    } catch (e) {
      if (e && e.cancelled) return 'stopped';
      throw e;
    } finally {
      scanCancels.delete(id); scanProg.delete(id); cleanProg.delete(id); running.delete(id); emit();
    }
  }

  function onUploaded(it) {
    const job = find(it.syncJob);
    if (!job) return;
    const idx = store.index(job.id);
    const had = idx.has(it.path);
    idx.set(it.path, { s: it.size, m: it.mtimeMs, d: it.driveId || it.updateId });
    if (!had && counts.has(job.id)) counts.get(job.id).files++;
    if (job.incomplete && openOf(job.id) === 0) { job.incomplete = false; store.saveJobs(); }
    store.saveIndex(job.id, false); emit();
  }

  // §3 CRUD joburi, Start/Stop, Pause/Resume, Reorder, tick paralel
  function sanitize(p) {
    const sources = (p.sources || []).map((s) => (typeof s === 'string' ? { path: s, mode: 'item', exclude: [] } : { path: s.path, mode: s.mode === 'children' ? 'children' : 'item', exclude: s.exclude || [] }));
    if (!sources.length) throw new Error('Select at least one file or folder to sync');
    return { sources, schedule: normalize(p.schedule || { type: 'interval', every: 1, unit: 'hours' }) };
  }

  function create(p) {
    if (!p.driveParentId) throw new Error('Choose a Drive destination folder');
    const { sources, schedule } = sanitize(p);
    const deleteMode = resolveDeleteMode(p);
    const job = {
      id: data.nextId++, name: p.name || 'Sync job', driveParentId: p.driveParentId, driveParentName: p.driveParentName || '',
      sources, schedule, deleteMode, trackDeletes: deleteMode === 'mark', keepVersions: p.keepVersions !== false, enabled: true, paused: false,
      lastRunAt: 0, nextRunAt: 0, lastError: '', lastScan: null,
    };
    data.jobs.push(job); store.saveJobs();
    log('info', job.name, `Sync job created (${deleteMode} mode). Starting first scan…`);
    launch(job); emit();
    return view(job);
  }

  function stopInternal(job) {
    job.enabled = false; job.paused = false;
    const cancel = scanCancels.get(job.id);
    if (cancel) cancel();
    uploader.removeWhere((it) => it.syncJob === job.id);
  }

  function start(id) {
    const job = mustFind(id);
    job.enabled = true; job.paused = false; job.lastError = '';
    store.saveJobs(); log('info', job.name, 'Sync job activated.'); kickUploader();
    if (!running.has(id) && openOf(id) === 0) launch(job);
    emit(); return view(job);
  }

  function stop(id) {
    const job = mustFind(id);
    stopInternal(job); store.saveJobs(); log('info', job.name, 'Sync job stopped.');
    emit(); kickUploader(); return view(job);
  }

  function setPaused(id, flag) {
    const job = mustFind(id);
    if (!job.enabled) return view(job);
    job.paused = !!flag; store.saveJobs();
    log('info', job.name, job.paused ? 'Sync job paused (connections freed for other jobs).' : 'Sync job resumed.');
    emit(); kickUploader();
    if (!job.paused && !running.has(id) && openOf(id) === 0) {
      const due = !job.lastRunAt || !!job.incomplete || (job.nextRunAt && now() >= job.nextRunAt);
      if (due) launch(job);
    }
    return view(job);
  }

  function reorder(ids) {
    if (!Array.isArray(ids) || !ids.length) return listJobs();
    const byId = new Map(data.jobs.map((j) => [j.id, j]));
    const next = [];
    for (const rawId of ids) { const j = byId.get(Number(rawId)); if (j) { next.push(j); byId.delete(j.id); } }
    for (const j of byId.values()) next.push(j);
    data.jobs.length = 0; data.jobs.push(...next);
    store.saveJobs(); emit(); kickUploader();
    return listJobs();
  }

  function update(id, p) {
    const job = mustFind(id);
    if (p.name !== undefined) job.name = String(p.name).trim() || job.name;
    if (p.sources !== undefined || p.schedule !== undefined) {
      const s = sanitize({ sources: p.sources || job.sources, schedule: p.schedule || job.schedule });
      job.sources = s.sources; job.schedule = s.schedule;
      job.nextRunAt = nextRun(job.schedule, job.lastRunAt, now());
      if (p.sources !== undefined) uploader.removeWhere((it) => it.syncJob === id && !covered(job, it.path));
    }
    if (p.deleteMode !== undefined) { job.deleteMode = resolveDeleteMode(p); job.trackDeletes = job.deleteMode === 'mark'; }
    else if (p.trackDeletes !== undefined) { job.trackDeletes = !!p.trackDeletes; job.deleteMode = job.trackDeletes ? 'mark' : 'keep'; }
    if (p.keepVersions !== undefined) job.keepVersions = !!p.keepVersions;
    if (p.enabled !== undefined) { if (!p.enabled) stopInternal(job); else job.enabled = true; }
    if (p.paused !== undefined && job.enabled) job.paused = !!p.paused;
    store.saveJobs(); emit(); kickUploader();
    return view(job);
  }

  function remove(id) {
    const i = data.jobs.findIndex((j) => j.id === id);
    if (i < 0) return false;
    const job = data.jobs[i];
    stopInternal(job);
    data.jobs.splice(i, 1); store.dropIndex(id); counts.delete(id); store.saveJobs();
    log('info', job.name, 'Sync job removed (files in Drive and on PC untouched).');
    emit(); kickUploader(); return true;
  }

  async function tick() {
    const migrated = !!(uploader.queue.st && uploader.queue.st.legacyMigrated);
    if (migrated) uploader.queue.st.legacyMigrated = false;
    const toRun = data.jobs.filter((j) => {
      const due = j.nextRunAt && now() >= j.nextRunAt;
      const resume = (!!j.incomplete || migrated) && openOf(j.id) === 0;
      return j.enabled && !j.paused && (due || resume);
    });
    const results = await Promise.allSettled(toRun.map((j) => run(j.id).catch((e) => { j.lastError = e.message; return 'error'; })));
    return results.filter((r) => r.status === 'fulfilled' && r.value === 'started').length;
  }

  function isSynced(full, size, mtimeMs) {
    for (const j of data.jobs) {
      const e = store.index(j.id).get(full);
      if (e && !e.x && e.d && e.s === size && Math.abs(e.m - mtimeMs) <= MTIME_TOLERANCE_MS) return true;
    }
    return false;
  }

  function retryAll() {
    const snap = uploader.snapshot();
    const resumed = snap.manualPaused || (snap.pausedUntil > 0 && snap.pausedUntil > now());
    if (resumed) uploader.resume();
    const retriedUploads = uploader.retryErrors();
    let startedJobs = 0;
    let cleared = false;
    for (const j of data.jobs) {
      if (j.lastError) { j.lastError = ''; cleared = true; }
      if (!j.enabled || j.paused || running.has(j.id) || openOf(j.id) > 0) continue;
      startedJobs++; launch(j);
    }
    if (cleared) store.saveJobs();
    log('info', 'Sync', `Retry all: ${resumed ? 'resumed queue, ' : ''}${retriedUploads} failed file(s), ${startedJobs} job(s) started.`);
    emit();
    return { resumed, retriedUploads, startedJobs, totalJobs: data.jobs.length };
  }

  const delOps = createDeletedOps({ store, drive, downloader, find, recount, log, emit });
  return { listJobs, nameOf, getPriorityPolicy, create, update, remove, run, start, stop, setPaused, reorder, tick, retryAll, onUploaded, isSynced, ...delOps };
}

module.exports = { createSync, scanSources };
