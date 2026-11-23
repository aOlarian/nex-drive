/* MAP
 * §1 lista fisiere sterse  L7-L23
 * §2 actiuni: sterge din Drive, pastreaza, restaureaza  L24-L72
 */

// §1 lista fisiere sterse (extrase din sync.js pentru pastrarea limitei de 300 linii)
const fs = require('fs');
const path = require('path');
const { under } = require('./sync-scan');

function createDeletedOps({ store, drive, downloader, find, recount, log, emit }) {
  const data = store.data;

  function deleted() {
    const out = [];
    for (const j of data.jobs) {
      const bases = j.sources.map((s) => (s.mode === 'children' ? s.path : path.dirname(s.path)));
      for (const [full, e] of store.index(j.id)) {
        if (!e.x) continue;
        const base = bases.find((b) => under(full, b)) || path.dirname(full);
        out.push({ jobId: j.id, jobName: j.name, path: full, relPath: path.relative(base, full).split(path.sep).join('/'), size: e.s, deletedAt: e.x, driveId: e.d });
      }
    }
    return out;
  }

  // §2 actiuni: sterge din Drive, pastreaza, restaureaza
  const refsOf = (refs) => refs.map((r) => ({ job: find(r.jobId), path: r.path })).filter((r) => r.job);

  async function deleteFromDrive(refs) {
    let done = 0;
    const failed = [];
    for (const { job, path: p } of refsOf(refs)) {
      const idx = store.index(job.id);
      const e = idx.get(p);
      if (!e || !e.x) continue;
      try { await drive.trash(e.d); idx.delete(p); done++; }
      catch (err) { if (err.status === 404) { idx.delete(p); done++; } else failed.push({ path: p, error: err.message }); }
    }
    for (const j of data.jobs) { store.saveIndex(j.id, false); recount(j.id); }
    if (done) log('info', 'Deleted', `Moved ${done} deleted file(s) to Drive Trash.`);
    emit();
    return { done, failed };
  }

  function keep(refs) {
    let n = 0;
    for (const { job, path: p } of refsOf(refs)) { if (store.index(job.id).delete(p)) n++; }
    for (const j of data.jobs) { store.saveIndex(j.id, false); recount(j.id); }
    emit();
    return n;
  }

  function restore(refs) {
    let n = 0;
    for (const { job, path: p } of refsOf(refs)) {
      const idx = store.index(job.id);
      const e = idx.get(p);
      if (!e || !e.x || !e.d) continue;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      downloader.add([{ id: e.d, name: path.basename(p), mimeType: 'application/octet-stream', size: e.s }], path.dirname(p), 'skip', (dest) => {
        let st;
        try { st = fs.statSync(dest); } catch (err) { return; }
        idx.set(p, { s: st.size, m: st.mtimeMs, d: e.d });
        store.saveIndex(job.id, false);
        recount(job.id);
        emit();
      });
      n++;
    }
    if (n) log('info', 'Restore', `Queued ${n} file(s) to restore to this PC.`);
    return n;
  }

  return { deleted, deleteFromDrive, keep, restore };
}

module.exports = { createDeletedOps };
