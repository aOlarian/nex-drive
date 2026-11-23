/* MAP
 * §1 arbore din relPath  L7-L38
 * §2 randare cu bife tri-state si limita pe folder  L39-L94
 * §3 actiuni si deschidere  L95-L155
 */

// §1 arbore din relPath: nivel 1 = jobul, apoi foldere; frunzele sunt fisierele (singurele care intra in `refs`)
const dv = { list: [], jobFilter: null, root: null, checked: new Set(), expanded: new Set(), seenJobs: new Set(), limits: new Map() };
const dvKey = (e) => `${e.jobId}\u0000${e.path}`;
const DV_CHILD_CAP = 500; // previne blocarea DOM-ului daca un folder sters are zeci de mii de fisiere

function buildTree(list) {
  const root = { id: '', name: '', kids: new Map(), leaf: null };
  const child = (parent, name, id) => {
    if (!parent.kids.has(name)) parent.kids.set(name, { id, name, kids: new Map(), leaf: null });
    return parent.kids.get(name);
  };
  for (const e of list) {
    let node = child(root, `j${e.jobId}`, `j${e.jobId}`);
    node.name = e.jobName;
    node.top = true;
    const parts = e.relPath.split('/').filter(Boolean);
    parts.forEach((seg, i) => { node = child(node, seg, `${node.id}/${seg}`); if (i === parts.length - 1) node.leaf = e; });
  }
  return root;
}

function leavesOf(node, out = []) {
  if (node.leaf) out.push(node.leaf);
  for (const k of node.kids.values()) leavesOf(k, out);
  return out;
}

function tally(node) {
  if (node.leaf) node.t = { n: 1, c: dv.checked.has(dvKey(node.leaf)) ? 1 : 0 };
  else { node.t = { n: 0, c: 0 }; for (const k of node.kids.values()) { const t = tally(k); node.t.n += t.n; node.t.c += t.c; } }
  return node.t;
}

// §2 randare cu bife tri-state (bifa unui folder bifeaza toate frunzele de sub el, inclusiv cele neafisate)
function dvRow(node, depth) {
  const t = node.t;
  const box = el('input', { type: 'checkbox', checked: t.n > 0 && t.c === t.n, title: node.leaf ? 'Select this file' : 'Select everything inside' });
  box.indeterminate = t.c > 0 && t.c < t.n;
  box.addEventListener('change', () => {
    for (const e of leavesOf(node)) { if (box.checked) dv.checked.add(dvKey(e)); else dv.checked.delete(dvKey(e)); }
    renderDeleted();
  });
  const isDir = !node.leaf;
  const open = dv.expanded.has(node.id);
  const tg = isDir ? el('button', { class: 'tg', title: open ? 'Collapse' : 'Expand', 'aria-label': open ? 'Collapse' : 'Expand' }, open ? '▾' : '▸') : el('span', { class: 'tg' });
  if (isDir) tg.addEventListener('click', () => { if (open) dv.expanded.delete(node.id); else dv.expanded.add(node.id); renderDeleted(); });
  const meta = isDir ? `${fmtNum(t.n)} file${t.n === 1 ? '' : 's'}` : `${fmtSize(node.leaf.size)} · deleted ${fmtDate(node.leaf.deletedAt)}`;
  const nameWrap = el('span', { class: `tn name-cell${node.top ? ' top1' : ''}${isDir ? '' : ' is-file'}`, title: node.leaf ? node.leaf.path : node.name },
    svgIcon(isDir ? 'folder' : 'file'), el('span', {}, node.name));
  const row = el('div', { class: 'trow', role: 'treeitem' }, tg, box, nameWrap, el('span', { class: 'tm' }, meta));
  row.style.paddingLeft = `${8 + depth * 20}px`;
  return row;
}

function walk(node, depth, out) {
  const kids = [...node.kids.values()].sort((a, b) => (!!a.leaf === !!b.leaf ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.leaf ? 1 : -1));
  const cap = dv.limits.get(node.id) || DV_CHILD_CAP;
  const shown = kids.slice(0, cap);
  for (const k of shown) {
    out.push(dvRow(k, depth));
    if (!k.leaf && dv.expanded.has(k.id)) walk(k, depth + 1, out);
  }
  const rest = kids.length - shown.length;
  if (rest > 0) {
    const btn = el('button', { type: 'button', class: 'mini-btn' }, `Show ${Math.min(DV_CHILD_CAP, rest)} more (${fmtNum(rest)} hidden)`);
    btn.addEventListener('click', () => { dv.limits.set(node.id, cap + DV_CHILD_CAP); renderDeleted(); });
    const row = el('div', { class: 'trow' }, btn);
    row.style.paddingLeft = `${32 + depth * 20}px`;
    out.push(row);
  }
}

function renderDeleted() {
  const t = tally(dv.root);
  const rows = [];
  walk(dv.root, 0, rows);
  $('dv-tree').replaceChildren(...rows);
  $('dv-tree').hidden = t.n === 0;
  $('dv-empty').hidden = t.n > 0;
  $('dv-all').checked = t.n > 0 && t.c === t.n;
  $('dv-all').indeterminate = t.c > 0 && t.c < t.n;
  $('dv-count').textContent = t.n ? `${fmtNum(t.c)} of ${fmtNum(t.n)} files ticked` : '';
  for (const id of ['dv-restore', 'dv-keep', 'dv-delete']) $(id).disabled = t.c === 0;
  $('dv-delete-all').disabled = t.n === 0;
}

// §3 actiuni si deschidere
async function loadDeleted() {
  const all = await guard(() => api.sync.deleted());
  if (!all) return;
  dv.list = dv.jobFilter === null ? all : all.filter((e) => e.jobId === dv.jobFilter);
  const keys = new Set(dv.list.map(dvKey));
  for (const k of [...dv.checked]) if (!keys.has(k)) dv.checked.delete(k);
  dv.root = buildTree(dv.list);
  for (const id of dv.root.kids.keys()) if (!dv.seenJobs.has(id)) { dv.seenJobs.add(id); dv.expanded.add(id); }
  renderDeleted();
}

function openDeleted(jobId = null, jobName = '') {
  dv.jobFilter = jobId;
  dv.checked.clear();
  dv.limits.clear();
  dv.root = buildTree([]);
  $('dv-title').textContent = jobId === null ? 'Deleted files (all sync jobs)' : `Deleted files: ${jobName}`;
  $('sync-home').hidden = true;
  $('deleted-view').hidden = false;
  renderDeleted();
  loadDeleted();
}

function closeDeleted() {
  $('deleted-view').hidden = true;
  $('sync-home').hidden = false;
  refreshSyncJobs();
}

const refsOf = (entries) => entries.map((e) => ({ jobId: e.jobId, path: e.path }));
const tickedLeaves = () => dv.list.filter((e) => dv.checked.has(dvKey(e)));

async function deleteFromDrive(entries, what) {
  if (!entries.length) return;
  if (!(await askConfirm(`Delete ${what} from Drive?\n\n${entries.length} file${entries.length === 1 ? '' : 's'} will be moved to the Drive Trash and can be recovered there for 30 days. The copies on this PC (if any) are not touched.`, { title: 'Delete from Drive', okLabel: 'Delete from Drive', danger: true }))) return;
  const r = await guard(() => api.sync.deleteFromDrive(refsOf(entries)));
  if (r) toast(`${r.done} moved to the Drive Trash${r.failed.length ? `; ${r.failed.length} failed (${r.failed[0].error})` : ''}`);
  loadDeleted();
}

function initDeleted() {
  $('dv-back').addEventListener('click', closeDeleted);
  $('dv-refresh').addEventListener('click', loadDeleted);
  $('dv-all').addEventListener('change', (e) => {
    dv.checked = e.target.checked ? new Set(dv.list.map(dvKey)) : new Set();
    renderDeleted();
  });
  $('dv-restore').addEventListener('click', async () => {
    const n = await guard(() => api.sync.restore(refsOf(tickedLeaves())));
    if (n !== undefined) toast(`${n} file${n === 1 ? '' : 's'} downloading to their original location on this PC (progress in Files > Downloads)`);
    loadDeleted();
  });
  $('dv-keep').addEventListener('click', async () => {
    const n = await guard(() => api.sync.keep(refsOf(tickedLeaves())));
    if (n !== undefined) toast(`${n} file${n === 1 ? '' : 's'} kept in Drive and removed from this list`);
    loadDeleted();
  });
  $('dv-delete').addEventListener('click', () => deleteFromDrive(tickedLeaves(), 'the ticked files'));
  $('dv-delete-all').addEventListener('click', () => deleteFromDrive(dv.list, `ALL ${dv.list.length} listed files`));
}
