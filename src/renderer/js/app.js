/* MAP
 * §1 stare si conectare  L6-L42
 * §2 navigare si tabel  L43-L116
 * §3 actiuni si drag & drop  L117-L216
 */

// §1 stare si conectare
const api = window.nexDrive;
const FOLDER = 'application/vnd.google-apps.folder';
const state = { trail: [{ id: 'root', name: 'My Drive' }], items: [], selected: new Set(), anchor: -1, reqSeq: 0, loadingId: '' };
const here = () => state.trail[state.trail.length - 1];

async function refreshAccount() {
  const about = await guard(() => api.drive.about());
  if (!about) { $('account').textContent = 'Unknown account'; return; }
  const q = about.storageQuota || {};
  $('account').textContent = `${about.user.emailAddress} · ${fmtSize(q.usage)}${q.limit ? ` / ${fmtSize(q.limit)}` : ''}`;
}

async function showForAuth() {
  const s = await api.auth.status();
  $('setup').hidden = s.loggedIn;
  setAuthed(s.loggedIn);
  $('btn-logout').hidden = !s.loggedIn;
  $('btn-audit').hidden = !s.loggedIn;
  $('import-state').textContent = s.hasClient ? '✔ imported' : '';
  $('btn-login').disabled = !s.hasClient;
  if (s.loggedIn) { refreshAccount(); loadFolder(); refreshSyncJobs(); }
}

function initAuth() {
  $('btn-import').addEventListener('click', async () => {
    $('setup-msg').textContent = '';
    try { if (await api.auth.importClient()) showForAuth(); } catch (e) { $('setup-msg').textContent = e.message; }
  });
  $('btn-login').addEventListener('click', async () => {
    $('setup-msg').textContent = 'Waiting for authorization in the browser…';
    try { await api.auth.login(); $('setup-msg').textContent = ''; showForAuth(); } catch (e) { $('setup-msg').textContent = e.message; }
  });
  $('btn-logout').addEventListener('click', async () => { await api.auth.logout(); showForAuth(); });
}

// §2 navigare si tabel
async function navigateFolder(nextTrail, { force = false } = {}) {
  const target = nextTrail[nextTrail.length - 1];
  if (!target || (!force && state.loadingId === target.id)) return;
  const prevTrail = state.trail;
  const prevItems = state.items;
  const seq = ++state.reqSeq;
  state.trail = nextTrail;
  state.loadingId = target.id;
  renderCrumbs();
  $('empty').hidden = true;
  $('rows').replaceChildren(el('tr', { class: 'loading-row' }, el('td', { colSpan: 4 }, 'Loading…')));
  try {
    const items = await api.drive.list(target.id);
    if (seq !== state.reqSeq) return;
    state.loadingId = '';
    state.items = items || [];
    state.selected.clear();
    state.anchor = -1;
    renderFiles();
  } catch (e) {
    if (seq !== state.reqSeq) return;
    state.loadingId = '';
    const msg = String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (/Request cancelled|AbortError/i.test(msg)) return;
    state.trail = prevTrail;
    state.items = prevItems;
    renderFiles();
    toast(msg || 'Failed to load Drive folder');
  }
}

function loadFolder() { return navigateFolder(state.trail, { force: true }); }

function renderCrumbs() {
  const nav = $('crumbs');
  nav.replaceChildren();
  state.trail.forEach((c, i) => {
    if (i) nav.append(el('span', { class: 'sep' }, '›'));
    const last = i === state.trail.length - 1;
    const b = el('button', { class: `crumb${last ? ' current' : ''}`, title: last ? 'Current folder' : 'Go to this folder', disabled: last },
      svgIcon(last ? 'folderOpen' : 'folder'), c.name);
    if (!last) b.addEventListener('click', () => navigateFolder(state.trail.slice(0, i + 1)));
    nav.append(b);
  });
}

function selectRow(e, idx) {
  const id = state.items[idx].id;
  const multi = e.ctrlKey || e.metaKey;
  if (e.shiftKey && state.anchor >= 0) {
    const [a, b] = [Math.min(state.anchor, idx), Math.max(state.anchor, idx)];
    if (!multi) state.selected.clear();
    for (let i = a; i <= b; i++) state.selected.add(state.items[i].id);
  } else if (multi) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    state.anchor = idx;
  } else {
    state.selected = new Set([id]);
    state.anchor = idx;
  }
  renderFiles();
}

function renderFiles() {
  renderCrumbs();
  const rows = $('rows');
  rows.replaceChildren();
  $('empty').hidden = state.items.length > 0;
  state.items.forEach((it, idx) => {
    const isDir = it.mimeType === FOLDER;
    const sel = state.selected.has(it.id);
    const chk = el('input', { type: 'checkbox', checked: sel });
    const nameWrap = el('span', { class: `name-cell${isDir ? '' : ' is-file'}` }, svgIcon(isDir ? 'folder' : 'file'), el('span', {}, it.name));
    const tr = el('tr', { class: `row${sel ? ' sel' : ''}` },
      el('td', { class: 'chk' }, chk),
      el('td', { title: it.name }, nameWrap),
      el('td', { class: 'num' }, isDir ? '' : fmtSize(it.size)),
      el('td', {}, it.modifiedTime ? new Date(it.modifiedTime).toLocaleString('en-GB') : ''));
    chk.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.selected.has(it.id)) state.selected.delete(it.id); else state.selected.add(it.id);
      state.anchor = idx;
      renderFiles();
    });
    tr.addEventListener('click', (e) => selectRow(e, idx));
    if (isDir) tr.addEventListener('dblclick', () => navigateFolder([...state.trail, { id: it.id, name: it.name }]));
    tr.dataset.folderId = isDir ? it.id : '';
    rows.append(tr);
  });
  $('chk-all').checked = state.items.length > 0 && state.selected.size === state.items.length;
  const one = state.selected.size === 1 && selectedItems()[0].mimeType !== FOLDER;
  $('btn-versions').disabled = !one;
  $('selinfo').textContent = state.selected.size ? `${state.selected.size} selected of ${state.items.length} (Ctrl+click: add, Shift+click: range, Ctrl+A: all)` : '';
}

const selectedItems = () => state.items.filter((i) => state.selected.has(i.id));

// §3 actiuni si drag & drop
let mkdirTarget = null;
function openMkdir(target = { id: here().id, name: here().name, done: loadFolder }) {
  mkdirTarget = target;
  const dlg = $('mkdir-dlg');
  const inp = $('mkdir-name');
  const okBtn = $('mkdir-ok');
  $('mkdir-where').textContent = target.name;
  inp.value = '';
  inp.disabled = false;
  okBtn.disabled = false;
  okBtn.textContent = 'Create';
  if (!dlg.open) dlg.showModal();
  inp.focus();
  requestAnimationFrame(() => inp.focus());
}

function initMkdir() {
  $('btn-mkdir').addEventListener('click', () => openMkdir());
  $('mkdir-cancel').addEventListener('click', () => $('mkdir-dlg').close());
  $('mkdir-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('mkdir-name');
    const okBtn = $('mkdir-ok');
    const name = inp.value.trim();
    if (!name) { inp.focus(); return; }
    inp.disabled = true;
    okBtn.disabled = true;
    okBtn.textContent = 'Creating…';
    const id = await guard(() => api.drive.mkdir(mkdirTarget.id, name));
    inp.disabled = false;
    okBtn.disabled = false;
    okBtn.textContent = 'Create';
    if (id) {
      $('mkdir-dlg').close();
      toast(`Folder created: ${name}`);
      mkdirTarget.done();
    } else inp.focus();
  });
}

function initActions() {
  $('chk-all').addEventListener('change', (e) => {
    state.selected = e.target.checked ? new Set(state.items.map((i) => i.id)) : new Set();
    renderFiles();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('main').hidden) {
      e.preventDefault();
      state.selected = new Set(state.items.map((i) => i.id));
      renderFiles();
    }
  });
  $('btn-refresh').addEventListener('click', loadFolder);
  $('btn-up-files').addEventListener('click', async () => { const n = await guard(() => api.queue.pick(here().id, false, existsPolicy())); if (n) { toast(`${n} files added to the queue`); showTab('up'); } });
  $('btn-up-folder').addEventListener('click', async () => { const n = await guard(() => api.queue.pick(here().id, true, existsPolicy())); if (n) { toast(`${n} files added to the queue`); showTab('up'); } });
  initMkdir();
  $('btn-download').addEventListener('click', async () => {
    const sel = selectedItems();
    if (!sel.length) return toast('Tick what you want to download');
    const n = await guard(() => api.drive.download(sel, existsPolicy()));
    if (n) { showTab('dl'); toast(`${n} items queued for download`); }
  });
  $('btn-trash').addEventListener('click', async () => {
    const sel = selectedItems();
    if (!sel.length) return toast('Tick what you want to delete');
    const preview = sel.slice(0, 3).map((i) => `• ${i.name}`).join('\n') + (sel.length > 3 ? `\n…and ${sel.length - 3} more` : '');
    if (!(await askConfirm(`Move ${sel.length} item(s) to the Drive Trash? (recoverable for 30 days)\n\n${preview}`, { title: 'Move to Drive Trash', okLabel: 'Delete', danger: true }))) return;
    await guard(() => api.drive.trash(sel.map((i) => i.id)));
    loadFolder();
  });

  const drop = $('drop');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer.types || [])].includes('Files');
  drop.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; $('dropzone').hidden = false; e.preventDefault(); } });
  drop.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('dropzone').hidden = true; } });
  drop.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.querySelectorAll('tr.dropt').forEach((r) => r.classList.remove('dropt'));
    const row = e.target.closest('tr.row');
    if (row && row.dataset.folderId) row.classList.add('dropt');
  });
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    $('dropzone').hidden = true;
    const row = e.target.closest('tr.row');
    const target = row && row.dataset.folderId ? row.dataset.folderId : here().id;
    document.querySelectorAll('tr.dropt').forEach((r) => r.classList.remove('dropt'));
    const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    if (!paths.length) return;
    const n = await guard(() => api.queue.add(paths, target, existsPolicy()));
    if (n !== undefined) { toast(`${n} files added to the queue`); showTab('up'); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
}

(async function init() {
  existsPolicy();
  initAuth();
  initActions();
  initQueueButtons();
  initDownloadView();
  initNav();
  initAudit();
  renderQueue(await api.queue.snapshot());
  renderDownloads(await api.dl.snapshot());
  showForAuth();
})();
