/* MAP
 * §1 bara globala de activitate live  L6-L66
 * §2 dialog jurnal de activitate  L67-L103
 */

// §1 bara globala de activitate live: vizibila in toate taburile (arata conexiuni, viteza, scanari, limite, pauze)
const actState = { queue: null, jobs: [], dl: null, log: [] };

function updateActivityBar() {
  const bar = $('activity-bar');
  if (!bar) return;
  const q = actState.queue;
  const jobs = actState.jobs || [];
  const scanning = jobs.filter((j) => j.phase === 'scanning');
  const cleaning = jobs.filter((j) => j.phase === 'cleaning');
  const now = Date.now();
  const timed = q && q.pausedUntil > now;
  const paused = q && (q.manualPaused || timed);
  const open = q ? (q.counts.pending + q.counts.uploading) : 0;
  const activeW = q ? (q.activeWorkers ?? q.counts.uploading) : 0;
  const maxW = q ? q.workers : 3;
  const speed = q && q.speed ? fmtSpeed(q.speed) : '';

  let cls = '';
  let dot = 'idle';
  let text = `Idle · 0/${maxW} upload connections used`;
  const metaParts = [];

  if (paused) {
    cls = 'state-warn';
    dot = 'warn';
    const rem = timed ? ` · resumes at ${fmtDate(q.pausedUntil)} (in ${fmtDur(q.pausedUntil - now)})` : '';
    text = `${q.pauseReason || 'Uploads paused'}${rem}`;
    if (open) metaParts.push(`${fmtNum(open)} queued`);
  } else if (q && q.retryInfo) {
    cls = 'state-warn';
    dot = 'warn';
    const ri = q.retryInfo;
    text = ri.kind === 'rate'
      ? `Drive rate limit (wave ${ri.attempt}/${ri.max}${ri.reason ? ` · ${ri.reason}` : ''}) — backing off before retrying…`
      : `Temporary network issue (retry ${ri.attempt}/${ri.max}) — retrying…`;
    if (open) metaParts.push(`${fmtNum(open)} remaining`);
  } else if (cleaning.length) {
    dot = 'active';
    text = cleaning.map((j) => `${j.name}: ${j.detail}`).join(' · ');
  } else if (activeW > 0 || scanning.length) {
    dot = 'active';
    const parts = [];
    if (activeW > 0) parts.push(`Uploading ${activeW}/${maxW} connections${speed ? ` · ${speed}` : ''}`);
    if (scanning.length) parts.push(scanning.map((j) => `${j.name}: ${j.detail}`).join(' · '));
    text = parts.join(' | ');
    if (open) metaParts.push(`${fmtNum(open)} queued`);
  } else if (q && q.counts.error > 0) {
    cls = 'state-err';
    dot = 'err';
    text = `${q.counts.error} upload error(s) — open Queue for details`;
  } else if (actState.dl && actState.dl.active) {
    dot = 'active';
    text = `Downloading · ${fmtSpeed(actState.dl.speed) || 'working…'}`;
  }

  bar.className = `actbar${cls ? ` ${cls}` : ''}`;
  $('act-dot').className = `act-dot ${dot}`;
  $('act-text').textContent = text;
  $('act-meta').textContent = metaParts.join(' · ');

  const pBtn = $('act-pause');
  pBtn.hidden = !(open > 0 || paused);
  pBtn.textContent = paused ? 'Resume' : 'Pause';

  // Badge-uri discrete in bara de sus
  const fb = $('nav-files-badge');
  if (fb) fb.textContent = open ? (open > 999 ? '999+' : String(open)) : (q && q.counts.error ? '!' : '');
  const sb = $('nav-sync-badge');
  if (sb) {
    const busySync = jobs.filter((j) => j.phase === 'scanning' || j.phase === 'cleaning' || j.phase === 'uploading' || j.phase === 'queued').length;
    const totalDel = jobs.reduce((s, j) => s + (j.deleted || 0), 0);
    sb.textContent = busySync ? String(busySync) : (totalDel ? String(totalDel) : '');
    sb.title = busySync ? `${busySync} active sync job(s)` : (totalDel ? `${totalDel} file(s) marked deleted` : '');
  }
}

// §2 dialog jurnal de activitate
function renderActivityLog(list) {
  actState.log = list || [];
  const body = $('act-log-body');
  if (!body) return;
  if (!actState.log.length) {
    body.replaceChildren(el('p', { class: 'muted pad' }, 'No recent events yet. Scans, rate limits, Mirror cleanups, and errors will appear here.'));
    return;
  }
  const rows = actState.log.map((e) => el('div', { class: `act-entry lvl-${e.level}` },
    el('span', { class: 'act-time', title: fmtDate(e.at) }, fmtTime(e.at)),
    el('span', { class: 'act-scope', title: e.scope }, e.scope),
    el('span', {}, e.text)));
  body.replaceChildren(...rows);
}

function renderErrorSummary(s) {
  const bar = $('act-err-bar');
  if (!bar) return;
  if (!s || !s.total) {
    bar.textContent = s && s.file ? `Google error log: 0 errors recorded (${s.file})` : 'Google error log: 0 errors recorded';
    return;
  }
  const top = (s.counts || []).slice(0, 4).map((c) => `${c.key} ×${c.count}`).join(' · ');
  bar.textContent = `Google error log (${fmtNum(s.total)} total): ${top}`;
  bar.title = s.file || '';
}

function initActivity() {
  $('act-queue').addEventListener('click', () => { showMainTab('files'); showTab('up'); });
  $('act-pause').addEventListener('click', () => guard(() => {
    const q = actState.queue;
    const paused = q && (q.manualPaused || q.pausedUntil > Date.now());
    return paused ? api.queue.resume() : api.queue.pause();
  }));
  $('act-log').addEventListener('click', async () => {
    const [list, errSum] = await Promise.all([guard(() => api.activity.list()), guard(() => api.errors.summary())]);
    renderActivityLog(list || []);
    renderErrorSummary(errSum);
    $('activity-dlg').showModal();
  });
  $('act-open-errlog').addEventListener('click', () => guard(() => api.errors.open()));
  $('act-log-clear').addEventListener('click', async () => {
    await guard(() => api.activity.clear());
    renderActivityLog([]);
  });
  $('act-log-close').addEventListener('click', () => $('activity-dlg').close());
  api.on('activity:update', (list) => {
    actState.log = list;
    if ($('activity-dlg').open) renderActivityLog(list);
  });
}
