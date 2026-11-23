/* MAP
 * §1 randare coada cu viteza, conexiuni si retry  L6-L67
 * §2 butoane coada  L68-L86
 */

// §1 randare coada cu viteza, conexiuni si retry (lista DOM de 300 randuri se reface doar cand tabul e vizibil)
let lastSnap = null;
let lastDone = -1;
let refreshTimer = null;
let queueListDirty = false;

function autoRefresh(done) {
  const grew = lastDone >= 0 && done > lastDone;
  lastDone = done;
  if (!grew || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (!$('main').hidden) loadFolder();
    refreshAccount();
  }, 5000);
}

function renderQueueList(s) {
  const list = $('q-list');
  list.replaceChildren();
  const activeById = new Map((s.activeItems || []).map((a) => [a.id, a]));
  for (const it of s.items) {
    const where = it.rel.length ? `${it.rel.join('/')}/` : '';
    const act = activeById.get(it.id);
    let label;
    let cls = 'st';
    if (it.state === 'done') { label = it.note || 'done'; cls += ' ok'; }
    else if (it.state === 'error') { label = it.error || 'error'; cls += ' err'; }
    else if (it.state === 'uploading') {
      const p = it.size ? Math.floor((it.offset / it.size) * 100) : 0;
      label = act && act.phase && act.phase !== 'uploading' ? `${act.phase} (${p}%)` : `${p}%`;
    } else label = it.offset ? `${Math.floor((it.offset / it.size) * 100)}% (paused)` : 'waiting';
    const x = el('button', { title: 'Remove from queue', onclick: () => guard(() => window.nexDrive.queue.remove(it.id)) }, '✕');
    list.append(el('li', { class: it.state === 'error' ? 'errrow' : '' },
      el('span', { class: 'nm', title: `${where}${it.name}` }, `${where}${it.name}`),
      el('span', { class: 'muted' }, fmtSize(it.size)),
      el('span', { class: cls, title: label }, label.length > 32 ? `${label.slice(0, 30)}…` : label),
      x));
  }
  queueListDirty = false;
}

function flushQueueView() {
  if (queueListDirty && lastSnap && !$('main').hidden && !$('view-up').hidden) renderQueueList(lastSnap);
}

function renderQueue(s) {
  lastSnap = s;
  actState.queue = s;
  autoRefresh(s.counts.done);
  updateActivityBar();

  const now = Date.now();
  const status = $('q-status');
  const waitMs = s.pausedUntil - now;
  const timed = s.pausedUntil > 0 && waitMs > 0;
  const activeW = s.activeWorkers ?? s.counts.uploading;
  const speed = s.speed ? ` · ${fmtSpeed(s.speed)}` : '';
  status.className = `status${timed || s.manualPaused ? ' paused' : ''}`;
  if (s.manualPaused) status.textContent = s.pauseReason || 'Paused';
  else if (timed) status.textContent = `${s.pauseReason || 'Paused'}. Next automatic retry at ${fmtDate(s.pausedUntil)} (in ${fmtDur(waitMs)}). Real clock time counts, so sleeping does not extend the wait.`;
  else if (s.counts.uploading) status.textContent = `Uploading ${s.counts.uploading} file(s) (${activeW}/${s.workers} connections${speed})`;
  else if (s.counts.pending) status.textContent = `Waiting (${fmtNum(s.counts.pending)} queued)`;
  else status.textContent = 'The queue is empty';

  const rb = $('q-retry-banner');
  if (rb) {
    if (s.retryInfo && !timed && !s.manualPaused) {
      const ri = s.retryInfo;
      rb.hidden = false;
      rb.textContent = ri.kind === 'rate'
        ? `Google Drive rate limit (wave ${ri.attempt}/${ri.max}${ri.reason ? ` · ${ri.reason}` : ''}): backing off before retrying…`
        : `Network hiccup (${ri.attempt}/${ri.max}): ${ri.reason || 'retrying automatically…'}`;
    } else rb.hidden = true;
  }

  const pct = s.bytesTotal ? (s.bytesDone / s.bytesTotal) * 100 : 0;
  $('q-bar').style.width = `${pct.toFixed(1)}%`;
  $('q-summary').textContent = `${fmtSize(s.bytesDone)} of ${fmtSize(s.bytesTotal)} · done ${fmtNum(s.counts.done)} · waiting ${fmtNum(s.counts.pending + s.counts.uploading)} · errors ${fmtNum(s.counts.error)}`;
  $('q-pause').textContent = s.manualPaused || timed ? 'Resume now' : 'Pause';
  const open = s.counts.pending + s.counts.uploading;
  $('badge-up').textContent = open ? (open > 999 ? '999+' : String(open)) : (s.counts.error ? '!' : '');
  if (document.activeElement !== $('q-workers')) $('q-workers').value = String(s.workers);

  if ($('main').hidden || $('view-up').hidden) { queueListDirty = true; return; }
  renderQueueList(s);
}

// §2 butoane coada
function initQueueButtons() {
  const q = window.nexDrive.queue;
  $('q-pause').addEventListener('click', () => guard(() => {
    const timed = lastSnap && lastSnap.pausedUntil > Date.now();
    return lastSnap && (lastSnap.manualPaused || timed) ? q.resume() : q.pause();
  }));
  $('q-retry').addEventListener('click', () => guard(() => q.retry()));
  $('q-clear-done').addEventListener('click', () => guard(() => q.clear('done')));
  $('q-clear-all').addEventListener('click', async () => {
    if (await askConfirm('Clear the WHOLE queue? What is already uploaded stays in Drive; what was not uploaded will have to be added again.', { title: 'Clear queue', okLabel: 'Clear all', danger: true })) guard(() => q.clear('all'));
  });
  const sel = $('q-workers');
  for (const n of [1, 2, 3, 4, 6, 8]) sel.append(el('option', { value: String(n) }, String(n)));
  sel.addEventListener('change', () => guard(() => q.setWorkers(Number(sel.value))));
  window.nexDrive.on('queue:update', renderQueue);
  setInterval(() => { if (lastSnap) renderQueue(lastSnap); }, 30000);
}
