/* MAP
 * §1 scanare asincrona in worker thread  L8-L67
 * §2 helpers cale, diff, politica stergere, status live si Mirror trash  L68-L176
 */

// §1 scanare asincrona in worker thread (citim codul prin fs ca sa mearga si din app.asar)
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const cfg = require('./config');

let workerSource = null;
function getWorkerSource() {
  if (!workerSource) workerSource = fs.readFileSync(path.join(__dirname, 'scanner-worker.js'), 'utf8');
  return workerSource;
}

const yieldTick = () => new Promise((r) => setImmediate(r));

function scanSources(sources, { onProgress = () => {}, onWorker = null, statBatch = cfg.SCAN_STAT_BATCH, progressMs = cfg.SCAN_PROGRESS_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(getWorkerSource(), {
      eval: true,
      workerData: { sources, statBatch, progressMs },
    });
    let settled = false;
    let gotDone = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => { /* worker deja oprit */ });
      fn(val);
    };
    if (onWorker) {
      onWorker(() => {
        const err = new Error('Scan cancelled');
        err.cancelled = true;
        finish(reject, err);
      });
    }
    worker.on('message', async (msg) => {
      if (msg.type === 'progress') { onProgress({ files: msg.scanned, dirs: msg.dirs, currentDir: msg.currentDir }); return; }
      if (msg.type === 'error') { finish(reject, new Error(msg.message)); return; }
      if (msg.type === 'done') {
        gotDone = true;
        const files = new Map();
        const dirs = msg.dirs;
        const raw = msg.files;
        for (let i = 0; i < raw.length; i++) {
          const r = raw[i];
          const d = dirs[r[0]];
          files.set(path.join(d[0], r[1]), { size: r[2], mtimeMs: r[3], rel: d[1] });
          if (i > 0 && i % cfg.DIFF_YIELD_EVERY === 0) await yieldTick();
        }
        finish(resolve, { files, unreadable: msg.unreadable, errors: msg.errors, roots: msg.roots });
      }
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => {
      if (!settled && !gotDone) finish(reject, new Error(`Scanner stopped unexpectedly (code ${code})`));
    });
  });
}

// §2 helpers cale, politica stergere, status live si Mirror trash
const under = (child, parent) => child === parent || child.toLowerCase().startsWith(`${parent.toLowerCase()}${path.sep}`);

function covered(job, full) {
  return job.sources.some((s) => {
    if (!under(full, s.path)) return false;
    if (s.mode !== 'children') return true;
    const first = path.relative(s.path, full).split(path.sep)[0].toLowerCase();
    return !(s.exclude || []).some((n) => n.toLowerCase() === first);
  });
}

function resolveDeleteMode(job) {
  if (job.deleteMode === 'mark' || job.deleteMode === 'keep' || job.deleteMode === 'mirror') return job.deleteMode;
  return job.trackDeletes === false ? 'keep' : 'mark';
}

function describeLive(j, st, { isRunning, scanProg, cleanProg, now }) {
  if (!j.enabled) return { phase: 'disabled', detail: 'Stopped (click Run to activate)' };
  if (j.paused) return { phase: 'paused', detail: st.open > 0 ? `Paused by you (${st.open.toLocaleString('en-US')} queued)` : 'Paused by you' };
  if (cleanProg) return { phase: 'cleaning', detail: `Moving removed files to Drive Trash: ${cleanProg.done} / ${cleanProg.total}` };
  if (isRunning) {
    const dirName = scanProg && scanProg.currentDir ? path.basename(scanProg.currentDir) || scanProg.currentDir : '';
    return { phase: 'scanning', detail: scanProg ? `Scanning… ${scanProg.files.toLocaleString('en-US')} files${dirName ? ` (${dirName})` : ''}` : 'Scanning…' };
  }
  if (st.open > 0) {
    if (st.manualPaused) return { phase: 'paused', detail: `${st.pauseReason || 'Paused'} (${st.pending} waiting)` };
    if (st.pausedUntil > now()) return { phase: 'paused', detail: `${st.pauseReason || 'Paused'} (${st.pending} waiting)` };
    if (st.retryInfo && st.uploading > 0) {
      const ri = st.retryInfo;
      const why = ri.kind === 'rate' ? `Drive rate limit (${ri.attempt}/${ri.max})` : `Network retry (${ri.attempt}/${ri.max})`;
      return { phase: 'throttled', detail: `${why} · ${st.open} remaining` };
    }
    if (st.uploading > 0) return { phase: 'uploading', detail: `Uploading ${st.uploading} active${st.pending ? `, ${st.pending.toLocaleString('en-US')} queued` : ''}` };
    if (st.pending > 0 && st.activeWorkers >= st.maxWorkers) {
      const who = st.busyWith.length ? ` with ${st.busyWith.slice(0, 2).join(', ')}` : '';
      return { phase: 'queued', detail: `Waiting for free slot (${st.activeWorkers}/${st.maxWorkers} connections busy${who}) · ${st.pending.toLocaleString('en-US')} queued` };
    }
    if (st.pending > 0) return { phase: 'queued', detail: `${st.pending.toLocaleString('en-US')} queued` };
    if (st.error > 0) return { phase: 'error', detail: `${st.error} upload error(s) — check Uploads queue` };
  }
  return { phase: 'idle', detail: 'Idle' };
}

// Muta in Cosul Drive in paralel limitat (recuperabil 30 zile); esecurile raman marcate in index
async function trashMirrorBatch({ drive, idx, list, now, onProgress }) {
  let done = 0;
  const failed = [];
  onProgress({ done: 0, total: list.length });
  let cursor = 0;
  const workers = Math.min(cfg.TRASH_CONCURRENCY || 4, list.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < list.length) {
      const item = list[cursor++];
      try {
        if (item.driveId) await drive.trash(item.driveId);
        idx.delete(item.path);
        done++;
      } catch (err) {
        if (err.status === 404) { idx.delete(item.path); done++; }
        else {
          const e = idx.get(item.path);
          if (e && !e.x) e.x = now();
          failed.push(`${path.basename(item.path)}: ${err.message}`);
        }
      }
      onProgress({ done, total: list.length });
    }
  }));
  return { done, failed };
}

// Compara fisierele gasite pe disc cu indexul local si planifica uploadurile / stergerile
async function diffScan({ files, unreadable, idx, job, mode, now, toleranceMs = 2 }) {
  const queued = [];
  let fresh = 0;
  let changed = 0;
  let step = 0;
  for (const [full, f] of files) {
    if (!job.enabled) return null;
    const e = idx.get(full);
    if (e && e.x) delete e.x;
    if (!(e && e.d && e.s === f.size && Math.abs(e.m - f.mtimeMs) <= toleranceMs)) {
      if (e && e.d) changed++; else fresh++;
      queued.push({ path: full, rel: f.rel, rootParent: job.driveParentId, size: f.size, mtimeMs: f.mtimeMs, syncJob: job.id, updateId: e && e.d ? e.d : '', keepForever: job.keepVersions });
    }
    if (++step % cfg.DIFF_YIELD_EVERY === 0) await yieldTick();
  }
  let markedDeleted = 0;
  const toTrash = [];
  step = 0;
  for (const [full, e] of idx) {
    if (files.has(full) || unreadable.some((u) => under(full, u))) continue;
    if (!covered(job, full)) { idx.delete(full); continue; }
    if (mode === 'mirror') toTrash.push({ path: full, driveId: e.d });
    else if (mode === 'mark') { if (!e.x) { e.x = now(); markedDeleted++; } }
    else idx.delete(full);
    if (++step % cfg.DIFF_YIELD_EVERY === 0) await yieldTick();
  }
  return { queued, fresh, changed, markedDeleted, toTrash };
}

module.exports = { scanSources, yieldTick, under, covered, resolveDeleteMode, describeLive, trashMirrorBatch, diffScan };
