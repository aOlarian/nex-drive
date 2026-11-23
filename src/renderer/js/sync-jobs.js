/* MAP
 * §1 badge-uri si status live  L6-L56
 * §2 editor inline (foldere, program, Mirror, Save & Run)  L57-L128
 * §3 tabel joburi (Run/Stop, Pause/Resume, drag & drop prioritate)  L129-L250
 */

// §1 badge-uri si status live
const jobRows = new Map(); // id -> { tr, editTr, job, cells }
let dragJobId = null;
let jobsDirty = false;

const MODE_META = {
  mark: { label: 'Safe', cls: 'soft', tip: 'Deleted PC files stay in Drive and are listed in Deleted for manual review' },
  keep: { label: 'Permanent', cls: 'idle', tip: 'Permanent backup: local deletions are ignored, Drive files are never removed' },
  mirror: { label: 'Mirror', cls: 'warn', tip: 'Mirror: files removed from this PC are automatically moved to Drive Trash (30-day recovery)' },
};

const PHASE_META = {
  idle: { label: 'Idle', cls: 'idle' },
  scanning: { label: 'Scanning…', cls: 'active' },
  cleaning: { label: 'Cleaning Drive', cls: 'warn' },
  uploading: { label: 'Uploading', cls: 'active' },
  queued: { label: 'Waiting for slot', cls: 'warn' },
  throttled: { label: 'Rate limited', cls: 'warn' },
  paused: { label: 'Paused', cls: 'warn' },
  error: { label: 'Error', cls: 'err' },
  disabled: { label: 'Stopped', cls: 'off' },
};

function jobPhase(j) {
  if (j.phase && PHASE_META[j.phase]) return j.phase;
  if (!j.enabled) return 'disabled';
  if (j.paused) return 'paused';
  if (j.running) return 'scanning';
  if (j.openUploads > 0) return 'uploading';
  return 'idle';
}

function statusNodes(j) {
  const phase = jobPhase(j);
  const pm = PHASE_META[phase];
  const out = [el('span', { class: `pill ${pm.cls}` }, pm.label)];
  const detail = j.detail || (phase === 'uploading' ? `Uploading ${j.openUploads} file${j.openUploads === 1 ? '' : 's'}` : '');
  if (detail && detail !== pm.label && detail !== 'Idle') out.push(el('div', { class: 'job-detail' }, detail));
  if (j.bytesTotal > 0 && (phase === 'uploading' || phase === 'queued' || phase === 'paused' || phase === 'throttled')) {
    const pct = Math.min(100, (j.bytesDone / j.bytesTotal) * 100);
    out.push(el('div', { class: 'job-prog', title: `${fmtSize(j.bytesDone)} / ${fmtSize(j.bytesTotal)}` }, el('div', { style: `width:${pct.toFixed(1)}%` })));
  }
  if (j.lastError) out.push(el('div', { class: 'errtxt' }, j.lastError));
  return out;
}

function lastRunNodes(j) {
  const out = [j.lastRunAt ? fmtDate(j.lastRunAt) : 'Never'];
  const s = j.lastScan;
  if (s) {
    const parts = [`${fmtNum(s.total)} found`, `${fmtNum(s.fresh)} new`, `${fmtNum(s.changed)} changed`];
    if (s.markedDeleted) parts.push(`${fmtNum(s.markedDeleted)} marked deleted`);
    if (s.trashedFromDrive) parts.push(`${fmtNum(s.trashedFromDrive)} trashed in Drive`);
    out.push(el('div', { class: 'muted small' }, parts.join(' · ')));
  }
  return out;
}

// §2 editor inline (foldere sincronizate, program, Mirror + Save & Run now)
function modeRadio(groupName, value, title, desc, checked, warn) {
  const inp = el('input', { type: 'radio', name: groupName, value, checked });
  const lbl = el('label', { class: `mode-opt${warn ? ' warn-opt' : ''}` }, inp, el('span', {}, el('b', {}, title), el('small', {}, desc)));
  return { inp, lbl };
}

function openEditor(entry) {
  if (entry.editTr) { entry.editTr.remove(); entry.editTr = null; return; }
  const j = entry.job;
  const curMode = j.deleteMode || (j.trackDeletes === false ? 'keep' : 'mark');
  const nameInp = el('input', { type: 'text', class: 'field', value: j.name });
  const sched = scheduleField(j.schedule);
  const srcEd = createSourcesEditor(j.sources);
  const gname = `edit-del-${j.id}`;
  const rMark = modeRadio(gname, 'mark', 'Safe: Track in Deleted list', 'Files stay in Drive and appear in Deleted for manual review.', curMode === 'mark', false);
  const rKeep = modeRadio(gname, 'keep', 'Permanent backup', 'Ignore local deletions; files stay in Drive forever.', curMode === 'keep', false);
  const rMirror = modeRadio(gname, 'mirror', 'Mirror: Remove from Drive when deleted locally', 'Moves removed local files (and any currently marked deleted) to Drive Trash (30-day recovery).', curMode === 'mirror', true);

  const mirrorNote = el('p', { class: 'warn', hidden: curMode !== 'mirror' }, 'Mirror enabled: running this job will move files missing from this PC (including any previously marked as deleted) to the Drive Trash.');
  const getMode = () => (rMirror.inp.checked ? 'mirror' : rKeep.inp.checked ? 'keep' : 'mark');
  for (const r of [rMark, rKeep, rMirror]) r.inp.addEventListener('change', () => { mirrorNote.hidden = getMode() !== 'mirror'; });

  const keepBox = el('input', { type: 'checkbox', checked: j.keepVersions });
  const keepLbl = el('label', { class: 'opt-toggle' }, keepBox, el('span', {},
    el('b', {}, 'Pin old file versions permanently'),
    el('small', {}, 'Drive keeps old versions of changed files for 30 days by default. Check this to keep them indefinitely.')));
  const enBox = el('input', { type: 'checkbox', checked: j.enabled });
  const enLbl = el('label', { class: 'opt-toggle' }, enBox, el('span', {},
    el('b', {}, 'Active (runs on schedule)'),
    el('small', {}, 'Untick to stop and deactivate this sync project.')));

  const saveBtn = el('button', { class: 'primary' }, 'Save');
  const saveRunBtn = el('button', {}, 'Save & Run now');
  const cancelBtn = el('button', { class: 'ghost' }, 'Cancel');
  const close = () => { if (entry.editTr) entry.editTr.remove(); entry.editTr = null; };

  async function doSave(andRun) {
    const sources = srcEd.get();
    if (!sources.length) return toast('Select at least one folder or file to sync');
    const deleteMode = getMode();
    const enabled = andRun ? true : enBox.checked;
    const patch = { name: nameInp.value.trim() || j.name, sources, schedule: sched.get(), deleteMode, trackDeletes: deleteMode === 'mark', keepVersions: keepBox.checked, enabled };
    if (andRun) patch.paused = false;
    const r = await guard(() => api.sync.update(j.id, patch));
    if (!r) return;
    close();
    if (andRun) {
      const res = await guard(() => api.sync.run(j.id, { force: true }));
      toast(res === 'busy' ? 'Saved (scan already running)' : 'Saved and sync started');
    } else toast('Sync job updated');
    refreshSyncJobs();
  }

  saveBtn.addEventListener('click', () => doSave(false));
  saveRunBtn.addEventListener('click', () => doSave(true));
  cancelBtn.addEventListener('click', close);

  const leftCol = el('fieldset', { class: 'opt-box' }, el('legend', {}, 'When files are deleted on this PC'), el('div', { class: 'mode-list' }, rMark.lbl, rKeep.lbl, rMirror.lbl));
  const rightCol = el('fieldset', { class: 'opt-box' }, el('legend', {}, 'Versions & status'), el('div', { class: 'stack' }, keepLbl, enLbl));
  entry.editTr = el('tr', { class: 'edit-row' }, el('td', { colSpan: 8 },
    el('div', { class: 'stack' },
      el('div', { class: 'inline' }, el('b', {}, 'Name:'), nameInp, el('b', {}, 'Schedule:'), sched.node),
      srcEd.node,
      el('div', { class: 'edit-grid' }, leftCol, rightCol),
      mirrorNote,
      el('div', { class: 'inline' }, saveBtn, saveRunBtn, cancelBtn))));
  entry.tr.after(entry.editTr);
}

// §3 tabel joburi (Run/Stop, Pause/Resume, drag & drop prioritate)
function clearDropMarks() {
  for (const e of jobRows.values()) e.tr.classList.remove('dragging', 'drop-before', 'drop-after');
}

async function applyReorder(fromId, toId, after) {
  const ids = (actState.jobs || []).map((j) => j.id);
  const fi = ids.indexOf(fromId);
  const ti = ids.indexOf(toId);
  if (fi < 0 || ti < 0 || fi === ti) return;
  ids.splice(fi, 1);
  const idx = ids.indexOf(toId);
  ids.splice(after ? idx + 1 : idx, 0, fromId);
  const updated = await guard(() => api.sync.reorder(ids));
  if (updated) renderJobs(updated);
}

function wireRowDrag(entry) {
  const tr = entry.tr;
  tr.draggable = true;
  tr.classList.add('job-row');
  tr.addEventListener('dragstart', (e) => {
    if (e.target && e.target.closest && e.target.closest('button, input, select, textarea, a')) { e.preventDefault(); return; }
    dragJobId = entry.job.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragJobId));
    tr.classList.add('dragging');
  });
  tr.addEventListener('dragover', (e) => {
    if (dragJobId === null || dragJobId === entry.job.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = tr.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    tr.classList.toggle('drop-before', !after);
    tr.classList.toggle('drop-after', after);
  });
  tr.addEventListener('dragleave', () => { tr.classList.remove('drop-before', 'drop-after'); });
  tr.addEventListener('drop', (e) => {
    if (dragJobId === null || dragJobId === entry.job.id) return;
    e.preventDefault();
    const fromId = dragJobId;
    const rect = tr.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    dragJobId = null;
    clearDropMarks();
    applyReorder(fromId, entry.job.id, after);
  });
  tr.addEventListener('dragend', () => {
    const wasDragging = dragJobId !== null;
    dragJobId = null;
    clearDropMarks();
    if (wasDragging && actState.jobs) renderJobs(actState.jobs);
  });
}

function makeJobRow(j) {
  const c = {};
  for (const k of ['name', 'dest', 'src', 'sched', 'last', 'status', 'acts']) c[k] = el('td');
  c.files = el('td', { class: 'num' });
  const entry = { job: j, editTr: null, cells: c };
  entry.toggleBtn = el('button', {});
  entry.toggleBtn.addEventListener('click', async () => {
    const active = entry.job.enabled;
    const r = await guard(() => (active ? api.sync.stop(entry.job.id) : api.sync.start(entry.job.id)));
    if (r) toast(active ? `Stopped: ${entry.job.name}` : `Started: ${entry.job.name}`);
  });
  entry.pauseBtn = el('button', {});
  entry.pauseBtn.addEventListener('click', async () => {
    const paused = !!entry.job.paused;
    const r = await guard(() => (paused ? api.sync.resume(entry.job.id) : api.sync.pause(entry.job.id)));
    if (r) toast(paused ? `Resumed: ${entry.job.name}` : `Paused: ${entry.job.name}`);
  });
  const edit = el('button', {}, 'Edit');
  edit.addEventListener('click', () => openEditor(entry));
  const rm = el('button', { class: 'danger' }, 'Remove');
  rm.addEventListener('click', async () => {
    if (!(await askConfirm(`Remove the sync job "${entry.job.name}"?\n\nThis only stops syncing and forgets the job. Nothing is deleted from Drive or from this PC.`, { title: 'Remove sync job', okLabel: 'Remove', danger: true }))) return;
    await guard(() => api.sync.remove(entry.job.id));
    refreshSyncJobs();
  });
  entry.delBtn = el('button', { title: 'Files deleted on this PC but still in Drive' });
  entry.delBtn.addEventListener('click', () => openDeleted(entry.job.id, entry.job.name));
  c.acts.append(el('div', { class: 'acts' }, entry.toggleBtn, entry.pauseBtn, edit, entry.delBtn, rm));
  entry.tr = el('tr', {}, c.name, c.dest, c.src, c.sched, c.last, c.status, c.files, c.acts);
  wireRowDrag(entry);
  return entry;
}

function flushSyncJobs() {
  if (jobsDirty && actState.jobs && !$('sync-view').hidden) renderJobs(actState.jobs);
}

function renderJobs(jobs) {
  actState.jobs = jobs;
  updateActivityBar();
  if ($('sync-view').hidden) { jobsDirty = true; return; }
  jobsDirty = false;
  const body = $('sj-rows');
  $('sj-empty').hidden = jobs.length > 0;
  if ($('sj-retry-all')) $('sj-retry-all').disabled = jobs.length === 0;
  const sum = $('sj-summary');
  if (sum) {
    const totalFiles = jobs.reduce((s, j) => s + (j.files || 0), 0);
    sum.textContent = jobs.length ? `${jobs.length} job(s) · ${fmtNum(totalFiles)} indexed files · Drag rows to set priority` : '';
  }
  const want = [];
  const seen = new Set();
  jobs.forEach((j, idx) => {
    seen.add(j.id);
    if (!jobRows.has(j.id)) jobRows.set(j.id, makeJobRow(j));
    const e = jobRows.get(j.id);
    e.job = j;
    const c = e.cells;
    const dm = MODE_META[j.deleteMode || (j.trackDeletes === false ? 'keep' : 'mark')] || MODE_META.mark;
    c.name.replaceChildren(el('div', { class: 'job-name-row' },
      el('span', { class: 'drag-handle', title: 'Drag to reorder priority (top = highest)' }, '⋮⋮'),
      el('span', { class: 'prio-num', title: `Priority #${idx + 1}` }, `#${idx + 1}`),
      el('b', {}, j.name),
      el('span', { class: `pill ${dm.cls}`, title: dm.tip }, dm.label)));
    c.dest.textContent = j.driveParentName || j.driveParentId;
    c.src.textContent = String(j.sources.length);
    c.src.title = j.sources.map((s) => (s.mode === 'children' ? `${s.path} (everything inside${s.exclude && s.exclude.length ? `, excluding ${s.exclude.join(', ')}` : ''})` : s.path)).join('\n');
    c.sched.textContent = j.scheduleText;
    c.last.replaceChildren(...lastRunNodes(j));
    c.status.replaceChildren(...statusNodes(j));
    c.files.textContent = fmtNum(j.files);
    e.toggleBtn.textContent = j.enabled ? 'Stop' : 'Run';
    e.toggleBtn.className = j.enabled ? '' : 'primary';
    e.toggleBtn.title = j.enabled ? 'Stop and deactivate this sync project' : 'Activate and run this sync project';
    e.pauseBtn.hidden = !j.enabled;
    e.pauseBtn.textContent = j.paused ? 'Resume' : 'Pause';
    e.pauseBtn.className = j.paused ? 'primary' : '';
    e.pauseBtn.title = j.paused ? 'Resume uploads for this project' : 'Pause this project so other projects can use connections';
    e.delBtn.textContent = `Deleted (${j.deleted})`;
    want.push(e.tr);
    if (e.editTr) want.push(e.editTr);
  });
  for (const id of [...jobRows.keys()]) if (!seen.has(id)) jobRows.delete(id);
  if (dragJobId === null) {
    want.forEach((n, i) => { if (body.children[i] !== n) body.insertBefore(n, body.children[i] || null); });
    while (body.children.length > want.length) body.lastChild.remove();
  }
}

async function refreshSyncJobs() {
  const jobs = await guard(() => api.sync.jobs());
  if (jobs) renderJobs(jobs);
}

function initSyncJobs() {
  $('sj-retry-all').addEventListener('click', async () => {
    const r = await guard(() => api.sync.retryAll());
    if (!r) return;
    const parts = [r.resumed && 'queue resumed', r.retriedUploads && `${r.retriedUploads} failed file(s)`, r.startedJobs && `${r.startedJobs} job(s) started`].filter(Boolean);
    toast(parts.length ? `Retrying all: ${parts.join(', ')}` : 'All enabled jobs are already active');
    refreshSyncJobs();
  });
  $('sj-deleted-all').addEventListener('click', () => openDeleted());
  api.on('sync:update', renderJobs);
}
