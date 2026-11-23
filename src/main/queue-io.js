/* MAP
 * §1 scriere atomica sync si streaming asincron  L6-L80
 */

// §1 scriere atomica: itereaza doar persistMap (O(elemente persistate), fara a parcurge 500k fisiere sync in memorie)
const fs = require('fs');

const yieldTick = () => new Promise((r) => setImmediate(r));
const shouldPersist = (it) => !it.syncJob || (!!it.session && it.offset > 0);

function createQueueIO({ file, st, persistMap, allMap, cfg }) {
  const sourceMap = persistMap || allMap;
  let timer = null;
  let writing = false;
  let dirty = false;
  let writeSeq = 0;

  const metaHeader = () => `{"nextId":${st.nextId},"pausedUntil":${st.pausedUntil},"pauseReason":${JSON.stringify(st.pauseReason)},"manualPaused":${st.manualPaused},"workers":${st.workers || 0},"items":[`;

  function writeSync() {
    clearTimeout(timer);
    timer = null;
    dirty = false;
    const seq = ++writeSeq;
    const tmp = `${file}.s${seq}.tmp`;
    const kept = [];
    for (const it of sourceMap.values()) if (shouldPersist(it)) kept.push(it);
    const payload = { nextId: st.nextId, pausedUntil: st.pausedUntil, pauseReason: st.pauseReason, manualPaused: st.manualPaused, workers: st.workers || 0, items: kept };
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
  }

  async function writeAsync() {
    clearTimeout(timer);
    timer = null;
    if (writing) { dirty = true; return; }
    writing = true;
    dirty = false;
    const seq = ++writeSeq;
    const tmp = `${file}.a${seq}.tmp`;
    const ws = fs.createWriteStream(tmp, { encoding: 'utf8' });
    const push = (str) => new Promise((res, rej) => {
      ws.once('error', rej);
      if (ws.write(str)) { ws.removeListener('error', rej); res(); }
      else ws.once('drain', () => { ws.removeListener('error', rej); res(); });
    });
    const chunkSize = cfg.SAVE_CHUNK_ENTRIES || 2000;
    try {
      let buf = metaHeader();
      let first = true;
      let n = 0;
      for (const it of sourceMap.values()) {
        if (seq !== writeSeq) break;
        if (!shouldPersist(it)) continue;
        buf += `${first ? '' : ','}${JSON.stringify(it)}`;
        first = false;
        if (++n >= chunkSize) { await push(buf); buf = ''; n = 0; await yieldTick(); }
      }
      await push(`${buf}]}`);
      await new Promise((res, rej) => { ws.once('error', rej); ws.end(res); });
      if (seq === writeSeq) await fs.promises.rename(tmp, file);
      else await fs.promises.rm(tmp, { force: true }).catch(() => { /* tmp invechit */ });
    } catch (e) {
      ws.destroy();
      fs.promises.rm(tmp, { force: true }).catch(() => { /* tmp optional */ });
      if (seq === writeSeq) dirty = true;
    } finally {
      writing = false;
      if (dirty) save(false);
    }
  }

  function save(force) {
    if (force) return writeSync();
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => { writeAsync(); }, cfg.SAVE_DEBOUNCE_MS);
      if (timer.unref) timer.unref();
    }
  }

  return { save, writeSync };
}

module.exports = { createQueueIO, shouldPersist };
