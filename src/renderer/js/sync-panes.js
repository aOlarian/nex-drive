/* MAP
 * §1 stare, breadcrumb si splitter redimensionabil  L8-L70
 * §2 panou Drive (doar foldere, cache + loading instant)  L71-L132
 * §3 panou This PC (cu bife si paginare la foldere mari)  L133-L234
 */

// §1 stare, breadcrumb si splitter redimensionabil
const sdrive = { trail: [{ id: 'root', name: 'My Drive' }], items: [], reqSeq: 0, loadingId: '', cache: new Map() };
const spc = { path: '', parent: '', entries: [], checked: new Set(), allMode: false, roots: [], renderLimit: 500 };
const sdHere = () => sdrive.trail[sdrive.trail.length - 1];
const PC_PAGE_SIZE = 500; // foldere cu mii de fisiere se randeaza in transe, dar Select all bifeaza TOT
const DRIVE_CACHE_TTL_MS = 30000;

function renderTrail(nav, trail, onGo) {
  nav.replaceChildren();
  trail.forEach((c, i) => {
    if (i) nav.append(el('span', { class: 'sep' }, '›'));
    const last = i === trail.length - 1;
    const b = el('button', { type: 'button', class: `crumb${last ? ' current' : ''}`, title: last ? 'Current folder' : 'Go to this folder', disabled: last }, c.name);
    if (!last) b.addEventListener('click', () => onGo(i));
    nav.append(b);
  });
}

function setCommanderHeight(px) {
  const max = Math.max(360, Math.floor(window.innerHeight * 0.82));
  const clamped = Math.min(Math.max(Math.round(px), 240), max);
  $('sync-commander').style.setProperty('--cmd-h', `${clamped}px`);
  try { localStorage.setItem('syncCommanderHeight', String(clamped)); } catch (e) { /* storage optional */ }
}

function initSplitter() {
  const saved = Number(localStorage.getItem('syncCommanderHeight'));
  if (saved >= 240) setCommanderHeight(saved);
  const bar = $('sync-splitter');
  const cmd = $('sync-commander');
  if (!bar || !cmd) return;
  let dragging = false;
  let startY = 0;
  let startH = 0;

  bar.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = cmd.getBoundingClientRect().height;
    bar.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    setCommanderHeight(startH + (e.clientY - startY));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    document.body.classList.remove('resizing');
  });
  bar.addEventListener('dblclick', () => {
    const cur = cmd.getBoundingClientRect().height;
    setCommanderHeight(cur < 560 ? Math.floor(window.innerHeight * 0.72) : 460);
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const cur = cmd.getBoundingClientRect().height;
    setCommanderHeight(cur + (e.key === 'ArrowDown' ? 40 : -40));
  });
}

// §2 panou Drive (doar foldere): folderul curent este destinatia sync-ului; feedback instant + anulare cereri vechi
function renderSyncDriveChrome(loading) {
  renderTrail($('sd-crumbs'), sdrive.trail, (i) => navigateSyncDrive(sdrive.trail.slice(0, i + 1)));
  const destInfo = $('sd-dest-info');
  if (destInfo) destInfo.textContent = `Destination: ${sdrive.trail.map((c) => c.name).join(' › ')}${loading ? ' (loading…)' : ''}`;
  refreshSyncForm();
}

function renderSyncDriveLoading() {
  renderSyncDriveChrome(true);
  $('sd-empty').hidden = true;
  $('sd-rows').replaceChildren(el('tr', { class: 'loading-row' }, el('td', {}, 'Loading folders…')));
}

async function navigateSyncDrive(nextTrail, { force = false } = {}) {
  const target = nextTrail[nextTrail.length - 1];
  if (!target) return;
  if (!force && sdrive.loadingId === target.id) return;
  const prevTrail = sdrive.trail;
  const prevItems = sdrive.items;
  const seq = ++sdrive.reqSeq;
  sdrive.trail = nextTrail;
  sdrive.loadingId = target.id;

  const hit = !force ? sdrive.cache.get(target.id) : null;
  if (hit && Date.now() - hit.at < DRIVE_CACHE_TTL_MS) {
    sdrive.items = hit.items;
    renderSyncDrive();
  } else {
    renderSyncDriveLoading();
  }

  try {
    const raw = api.drive.listFolders ? await api.drive.listFolders(target.id) : await api.drive.list(target.id);
    if (seq !== sdrive.reqSeq) return;
    const folders = (raw || [])
      .filter((i) => !i.mimeType || i.mimeType === FOLDER)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    sdrive.cache.set(target.id, { at: Date.now(), items: folders });
    sdrive.items = folders;
    sdrive.loadingId = '';
    renderSyncDrive();
  } catch (e) {
    if (seq !== sdrive.reqSeq) return;
    sdrive.loadingId = '';
    const msg = String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (/Request cancelled|AbortError/i.test(msg)) return;
    sdrive.trail = prevTrail;
    sdrive.items = prevItems;
    renderSyncDrive();
    toast(msg || 'Failed to load Drive folder');
  }
}

function loadSyncDrive(force = false) { return navigateSyncDrive(sdrive.trail, { force }); }

function renderSyncDrive() {
  renderSyncDriveChrome(false);
  const rows = $('sd-rows');
  rows.replaceChildren();
  $('sd-empty').hidden = sdrive.items.length > 0;
  for (const it of sdrive.items) {
    const cell = el('span', { class: 'name-cell' }, svgIcon('folder'), el('span', {}, it.name));
    const tr = el('tr', { class: 'row', title: 'Double-click to open' }, el('td', { class: 'nm' }, cell));
    tr.addEventListener('dblclick', () => navigateSyncDrive([...sdrive.trail, { id: it.id, name: it.name }]));
    rows.append(tr);
  }
}

// §3 panou This PC: bifele sunt per folder; la navigare se goleste selectia, ca „sursa curenta” sa nu fie ambigua
const BS = String.fromCharCode(92);
const pcTrail = (p) => {
  const sep = p.includes(BS) ? BS : '/';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out = sep === '/' ? [{ id: '/', name: '/' }] : [];
  let acc = sep === '/' ? '/' : '';
  parts.forEach((s, i) => {
    acc = i === 0 && sep === BS ? `${s}${BS}` : `${acc}${acc.endsWith(sep) ? '' : sep}${s}`;
    out.push({ id: acc, name: i === 0 && sep === BS ? `${s}${BS}` : s });
  });
  return out;
};

async function loadPc(dir) {
  const r = await guard(() => api.fs.list(dir));
  if (!r) return;
  Object.assign(spc, { path: r.path, parent: r.parent, entries: r.entries, renderLimit: PC_PAGE_SIZE });
  spc.checked.clear();
  spc.allMode = false;
  renderPc();
}

function pcInfo() {
  const n = spc.checked.size;
  const total = spc.entries.length;
  $('sp-info').textContent = n ? `${fmtNum(n)} of ${fmtNum(total)} ticked` : `${fmtNum(total)} item(s) — tick files or folders to sync`;
  $('sp-all').checked = total > 0 && n === total;
  $('sp-all').indeterminate = n > 0 && n < total;
  refreshSyncForm();
}

function renderPc() {
  const trail = pcTrail(spc.path);
  renderTrail($('sp-crumbs'), trail, (i) => loadPc(trail[i].id));
  $('sp-up').disabled = !spc.parent;
  for (const b of $('sp-roots').children) b.classList.toggle('on', spc.path.toLowerCase().startsWith(b.dataset.root.toLowerCase()));
  const rows = $('sp-rows');
  rows.replaceChildren();
  $('sp-empty').hidden = spc.entries.length > 0;
  const slice = spc.entries.slice(0, spc.renderLimit);
  for (const e of slice) {
    const chk = el('input', { type: 'checkbox', checked: spc.checked.has(e.path) });
    const nameCell = el('span', { class: `name-cell${e.isDir ? '' : ' is-file'}` }, svgIcon(e.isDir ? 'folder' : 'file'), el('span', {}, e.name));
    const tr = el('tr', { class: `row${chk.checked ? ' sel' : ''}` },
      el('td', { class: 'chk' }, chk), el('td', { class: 'nm', title: e.name }, nameCell),
      el('td', { class: 'num' }, e.isDir ? '' : fmtSize(e.size)), el('td', {}, fmtDate(e.mtimeMs)));
    chk.addEventListener('change', () => {
      if (chk.checked) spc.checked.add(e.path); else spc.checked.delete(e.path);
      if (!spc.checked.size) spc.allMode = false;
      tr.classList.toggle('sel', chk.checked);
      pcInfo();
    });
    if (e.isDir) tr.addEventListener('dblclick', () => loadPc(e.path));
    rows.append(tr);
  }
  const rest = spc.entries.length - slice.length;
  const wrap = $('sp-more-wrap');
  if (wrap) {
    wrap.hidden = rest <= 0;
    if (rest > 0) {
      $('sp-more').textContent = `Show ${Math.min(PC_PAGE_SIZE, rest)} more (${fmtNum(rest)} remaining)`;
      $('sp-more-all').textContent = `Show all ${fmtNum(spc.entries.length)}`;
    }
  }
  pcInfo();
}

function resetPcSelection() {
  spc.checked.clear();
  spc.allMode = false;
  renderPc();
}

async function initSyncPanes() {
  loadSyncDrive();
  const roots = await guard(() => api.fs.roots());
  if (!roots) return;
  const box = $('sp-roots');
  box.replaceChildren();
  for (const r of roots) {
    const b = el('button', { type: 'button', title: r.path }, r.name);
    b.dataset.root = r.path;
    b.addEventListener('click', () => loadPc(r.path));
    box.append(b);
  }
  if (!spc.path) loadPc(roots[roots.length - 1].path);
}

function wireSyncPanes() {
  initSplitter();
  $('sd-refresh').addEventListener('click', () => { sdrive.cache.delete(sdHere().id); loadSyncDrive(true); });
  $('sd-mkdir').addEventListener('click', () => openMkdir({ id: sdHere().id, name: sdHere().name, done: () => { sdrive.cache.delete(sdHere().id); loadSyncDrive(true); } }));
  $('sp-up').addEventListener('click', () => { if (spc.parent) loadPc(spc.parent); });
  $('sp-all').addEventListener('change', (e) => {
    spc.checked = e.target.checked ? new Set(spc.entries.map((x) => x.path)) : new Set();
    spc.allMode = e.target.checked;
    renderPc();
  });
  $('sp-more').addEventListener('click', () => { spc.renderLimit += PC_PAGE_SIZE; renderPc(); });
  $('sp-more-all').addEventListener('click', () => { spc.renderLimit = spc.entries.length; renderPc(); });
}
