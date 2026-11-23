/* MAP
 * §1 helpers cai si acoperire surse  L7-L50
 * §2 componenta editor surse inline (chips + browser pe partitie + Add folder)  L51-L198
 */

// §1 helpers cai si acoperire surse
const SRC_BS = String.fromCharCode(92);
const SRC_PAGE_SIZE = 300;

function normSrcPath(p) {
  if (!p) return '';
  const win = p.includes(SRC_BS) || /^[a-zA-Z]:/.test(p);
  let s = String(p).replace(win ? /\\+$/ : /\/+$/, '');
  if (win && /^[a-zA-Z]:$/.test(s)) s += SRC_BS;
  if (!win && s === '') s = '/';
  return win ? s.toLowerCase() : s;
}

function parentSrcDir(p) {
  if (!p) return '';
  const sep = p.includes(SRC_BS) ? SRC_BS : '/';
  const trimmed = p.replace(/[\\/]+$/, '');
  if (!trimmed) return sep;
  if (/^[a-zA-Z]:$/.test(trimmed)) return `${trimmed}${SRC_BS}`;
  const i = Math.max(trimmed.lastIndexOf(SRC_BS), trimmed.lastIndexOf('/'));
  if (i < 0) return trimmed;
  if (i === 0) return '/';
  const head = trimmed.slice(0, i);
  return /^[a-zA-Z]:$/.test(head) ? `${head}${SRC_BS}` : head;
}

function srcUnder(child, parent) {
  const c = normSrcPath(child);
  const p = normSrcPath(parent);
  if (!c || !p || c === p) return false;
  const sep = p.includes(SRC_BS) ? SRC_BS : '/';
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

function commonSrcParent(sources) {
  if (!sources || !sources.length) return '';
  if (sources.length === 1 && sources[0].mode === 'children') return sources[0].path;
  const dirs = sources.map((s) => (s.mode === 'children' ? s.path : parentSrcDir(s.path)));
  let cur = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    while (cur && normSrcPath(dirs[i]) !== normSrcPath(cur) && !srcUnder(dirs[i], cur)) {
      const up = parentSrcDir(cur);
      if (normSrcPath(up) === normSrcPath(cur)) { cur = ''; break; }
      cur = up;
    }
  }
  return cur || dirs[0];
}

// §2 componenta editor surse inline (chips + browser pe partitie + Add folder)
function createSourcesEditor(initialSources) {
  const list = (initialSources || []).map((s) => ({
    path: s.path,
    mode: s.mode === 'children' ? 'children' : 'item',
    exclude: [...(s.exclude || [])],
  }));
  const br = { path: '', parent: '', entries: [], roots: [], limit: SRC_PAGE_SIZE, err: '' };

  const chipsBox = el('div', { class: 'src-chips' });
  const browserWrap = el('div', { class: 'src-browser' });
  const rootsBox = el('div', { class: 'roots' });
  const upBtn = el('button', { type: 'button', class: 'mini-btn', title: 'Parent folder' }, 'Up');
  const crumbsNav = el('nav', { class: 'pathline' });
  const listBox = el('div', { class: 'src-list' });
  const childrenChk = el('input', { type: 'checkbox' });
  const childrenLbl = el('label', { class: 'chkl small src-child-opt', hidden: true }, childrenChk, el('span', {}, 'Include future items added to this folder'));
  const addBtn = el('button', { type: 'button', class: 'mini-btn' }, 'Add folder…');
  const toggleBtn = el('button', { type: 'button', class: 'mini-btn ghost' }, 'Hide folder browser');

  const findChildren = (dir) => list.find((s) => s.mode === 'children' && normSrcPath(s.path) === normSrcPath(dir));
  const findExact = (p) => list.find((s) => normSrcPath(s.path) === normSrcPath(p));

  function coveringAncestor(p) {
    return list.find((s) => {
      if (!srcUnder(p, s.path)) return false;
      if (s.mode !== 'children') return true;
      const base = normSrcPath(s.path);
      const sep = base.includes(SRC_BS) ? SRC_BS : '/';
      const rel = normSrcPath(p).slice(base.endsWith(sep) ? base.length : base.length + 1);
      const first = rel.split(/[\\/]/)[0];
      return !(s.exclude || []).some((n) => n.toLowerCase() === first.toLowerCase());
    });
  }

  function addItemPath(p) {
    if (!p || findExact(p) || coveringAncestor(p)) return;
    for (let i = list.length - 1; i >= 0; i--) if (srcUnder(list[i].path, p)) list.splice(i, 1);
    list.push({ path: p, mode: 'item', exclude: [] });
  }

  function renderChips() {
    chipsBox.replaceChildren();
    if (!list.length) {
      chipsBox.append(el('span', { class: 'errtxt' }, 'Select at least one folder or file to sync.'));
      return;
    }
    list.forEach((s, idx) => {
      const rm = el('button', { type: 'button', class: 'src-rm', title: 'Remove from this sync job' }, '×');
      rm.addEventListener('click', () => { list.splice(idx, 1); renderAll(); });
      const meta = s.mode === 'children'
        ? el('span', { class: 'pill soft' }, s.exclude.length ? `All inside (−${s.exclude.length})` : 'All inside')
        : null;
      const pathBtn = el('button', { type: 'button', class: 'src-path', title: 'Open in folder browser' }, s.path);
      pathBtn.addEventListener('click', () => loadDir(s.mode === 'children' ? s.path : parentSrcDir(s.path)));
      chipsBox.append(el('div', { class: 'src-chip' }, svgIcon('folder'), pathBtn, meta, rm));
    });
  }

  function renderBrowser() {
    if (!br.path) {
      listBox.replaceChildren(el('p', { class: 'muted small pad-s' }, br.err || 'Choose a drive above to browse folders.'));
      childrenLbl.hidden = true;
      return;
    }
    const trail = pcTrail(br.path);
    renderTrail(crumbsNav, trail, (i) => loadDir(trail[i].id));
    upBtn.disabled = !br.parent;
    for (const b of rootsBox.children) b.classList.toggle('on', br.path.toLowerCase().startsWith(b.dataset.root.toLowerCase()));

    const cs = findChildren(br.path);
    const slice = br.entries.slice(0, br.limit);
    const nodes = [];
    for (const e of slice) {
      let checked = false;
      let inherited = false;
      if (cs) checked = !cs.exclude.some((n) => n.toLowerCase() === e.name.toLowerCase());
      else if (findExact(e.path)) checked = true;
      else if (coveringAncestor(e.path)) { checked = true; inherited = true; }
      const chk = el('input', { type: 'checkbox', checked, disabled: inherited });
      chk.addEventListener('change', () => {
        if (cs) {
          cs.exclude = cs.exclude.filter((n) => n.toLowerCase() !== e.name.toLowerCase());
          if (!chk.checked) cs.exclude.push(e.name);
        } else if (chk.checked) {
          addItemPath(e.path);
        } else {
          const i = list.findIndex((s) => normSrcPath(s.path) === normSrcPath(e.path));
          if (i >= 0) list.splice(i, 1);
        }
        renderAll();
      });
      const lbl = el('span', { class: `src-entry-name${e.isDir ? ' is-dir' : ''}`, title: inherited ? 'Included via parent folder' : (e.isDir ? 'Double-click to open folder' : e.name) },
        svgIcon(e.isDir ? 'folder' : 'file'), el('span', {}, e.name));
      if (e.isDir) lbl.addEventListener('dblclick', () => loadDir(e.path));
      const openBtn = e.isDir ? el('button', { type: 'button', class: 'mini-btn ghost src-open', title: 'Browse inside this folder' }, 'Open') : null;
      if (openBtn) openBtn.addEventListener('click', () => loadDir(e.path));
      nodes.push(el('div', { class: `src-entry${checked ? ' on' : ''}` }, chk, lbl, openBtn));
    }
    if (!nodes.length) nodes.push(el('p', { class: 'muted small pad-s' }, 'Empty folder.'));
    const rest = br.entries.length - slice.length;
    if (rest > 0) {
      const more = el('button', { type: 'button', class: 'mini-btn ghost' }, `Show all (${fmtNum(br.entries.length)})`);
      more.addEventListener('click', () => { br.limit = br.entries.length; renderBrowser(); });
      nodes.push(el('div', { class: 'src-more' }, more));
    }
    listBox.replaceChildren(...nodes);

    const allTicked = br.entries.length > 0 && br.entries.every((e) => findExact(e.path));
    childrenLbl.hidden = !cs && !allTicked;
    childrenChk.checked = !!cs;
  }

  function renderAll() {
    renderChips();
    renderBrowser();
  }

  async function loadDir(dir) {
    if (!dir) return;
    try {
      const r = await api.fs.list(dir);
      Object.assign(br, { path: r.path, parent: r.parent, entries: r.entries, limit: SRC_PAGE_SIZE, err: '' });
    } catch (e) {
      br.err = `Folder not accessible on this PC: ${dir}`;
    }
    renderBrowser();
  }

  async function initBrowser() {
    try {
      const roots = await api.fs.roots();
      br.roots = roots || [];
      rootsBox.replaceChildren();
      for (const r of br.roots) {
        const b = el('button', { type: 'button', title: r.path }, r.name);
        b.dataset.root = r.path;
        b.addEventListener('click', () => loadDir(r.path));
        rootsBox.append(b);
      }
      const start = commonSrcParent(list) || (br.roots[0] && br.roots[0].path) || '';
      if (start) await loadDir(start);
      if (!br.path && br.roots.length) await loadDir(br.roots[0].path);
    } catch (e) {
      br.err = 'Could not load PC folders.';
      renderBrowser();
    }
  }

  childrenChk.addEventListener('change', () => {
    const cs = findChildren(br.path);
    if (childrenChk.checked && !cs) {
      const exclude = br.entries.filter((e) => !findExact(e.path)).map((e) => e.name);
      for (let i = list.length - 1; i >= 0; i--) {
        if (normSrcPath(list[i].path) === normSrcPath(br.path) || srcUnder(list[i].path, br.path)) list.splice(i, 1);
      }
      list.push({ path: br.path, mode: 'children', exclude });
    } else if (!childrenChk.checked && cs) {
      const idx = list.indexOf(cs);
      if (idx >= 0) list.splice(idx, 1);
      for (const e of br.entries) {
        if (!cs.exclude.some((n) => n.toLowerCase() === e.name.toLowerCase())) addItemPath(e.path);
      }
    }
    renderAll();
  });

  upBtn.addEventListener('click', () => { if (br.parent) loadDir(br.parent); });
  addBtn.addEventListener('click', async () => {
    const picked = await guard(() => api.sync.pickFolders(br.path || commonSrcParent(list)));
    if (!picked || !picked.length) return;
    for (const p of picked) addItemPath(p);
    renderAll();
  });
  toggleBtn.addEventListener('click', () => {
    browserWrap.hidden = !browserWrap.hidden;
    toggleBtn.textContent = browserWrap.hidden ? 'Browse folders' : 'Hide folder browser';
  });

  browserWrap.append(
    el('div', { class: 'src-br-head' }, upBtn, crumbsNav, rootsBox),
    listBox,
    childrenLbl,
  );
  const node = el('fieldset', { class: 'opt-box src-ed' },
    el('legend', {}, 'Synced folders & files'),
    chipsBox,
    el('div', { class: 'inline src-tools' }, addBtn, toggleBtn),
    browserWrap,
  );

  renderChips();
  initBrowser();

  return {
    node,
    get: () => list.map((s) => ({ path: s.path, mode: s.mode, exclude: [...s.exclude] })),
  };
}
