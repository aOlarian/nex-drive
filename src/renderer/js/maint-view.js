/* MAP
 * §1 formular regula  L7-L61
 * §2 preview (tabel cu bife)  L62-L93
 * §3 lista de reguli si actiuni  L94-L163
 */

// §1 formular regula: acelasi formular pentru „Add rule” si „Edit”
let mtSched;
let mtEditing = '';
let mtRules = [];
const mtPreview = new Map(); // id regula -> { data, checked:Set }
const mtBusy = new Set();
const ACTION_TEXT = { recycle: 'Move to Recycle Bin', delete: 'Delete permanently' };
const MT_MAX_ROWS = 500; // randare limitata; „Select all” si Run now conteaza tot preview-ul

function resetMtForm() {
  mtEditing = '';
  $('mt-path').value = '';
  $('mt-days').value = '30';
  $('mt-action').value = 'recycle';
  $('mt-synced').checked = true;
  $('mt-enabled').checked = true;
  mtSched.set({ type: 'manual' });
  $('mt-title').textContent = 'Add rule';
  $('mt-save').textContent = 'Add rule';
  $('mt-cancel').hidden = true;
  $('mt-warn').hidden = true;
}

function editRule(r) {
  mtEditing = r.id;
  $('mt-path').value = r.path;
  $('mt-days').value = String(r.days);
  $('mt-action').value = r.action;
  $('mt-synced').checked = r.onlySynced;
  $('mt-enabled').checked = r.enabled;
  mtSched.set(r.schedule);
  $('mt-title').textContent = 'Edit rule';
  $('mt-save').textContent = 'Save changes';
  $('mt-cancel').hidden = false;
  $('mt-warn').hidden = r.action !== 'delete';
  $('mt-form').scrollIntoView({ block: 'start' });
}

async function saveRule(e) {
  e.preventDefault();
  const rule = {
    path: $('mt-path').value.trim(), days: Number($('mt-days').value), action: $('mt-action').value,
    onlySynced: $('mt-synced').checked, schedule: mtSched.get(), enabled: $('mt-enabled').checked,
  };
  if (!rule.path) return toast('Choose a folder');
  const wasEdit = !!mtEditing;
  if (mtEditing) rule.id = mtEditing;
  const r = await guard(() => api.maint.save(rule));
  if (!r) return;
  mtPreview.delete(r.id);
  toast(wasEdit ? 'Rule updated' : 'Rule added');
  resetMtForm();
  loadRules();
}

// §2 preview (tabel cu bife): doar citire, nimic nu se sterge aici
function previewBox(pv) {
  const d = pv.data;
  const out = el('div', {}, el('p', { class: 'pad-s' },
    `${d.totalCount} item${d.totalCount === 1 ? '' : 's'} (${fmtSize(d.totalBytes)}) can be removed. ${d.skippedUnsynced ? `${d.skippedUnsynced} old file(s) skipped because they are not synced to Drive yet. ` : ''}Nothing has been deleted.`));
  if (d.errors.length) out.append(el('p', { class: 'pad-s errtxt' }, `${d.errors.length} read error(s), those items were left alone: ${d.errors.slice(0, 3).join('; ')}`));
  if (!d.entries.length) return out;
  const rerender = () => renderRules(mtRules);
  const all = el('input', { type: 'checkbox', checked: pv.checked.size === d.entries.length, title: 'Select all' });
  all.indeterminate = pv.checked.size > 0 && pv.checked.size < d.entries.length;
  all.addEventListener('change', () => { pv.checked = all.checked ? new Set(d.entries.map((x) => x.path)) : new Set(); rerender(); });
  const rows = d.entries.slice(0, MT_MAX_ROWS).map((e) => {
    const c = el('input', { type: 'checkbox', checked: pv.checked.has(e.path) });
    c.addEventListener('change', () => { if (c.checked) pv.checked.add(e.path); else pv.checked.delete(e.path); rerender(); });
    return el('tr', {}, el('td', { class: 'chk' }, c), el('td', {}, e.kind), el('td', {}, e.path), el('td', { class: 'num' }, fmtSize(e.size)),
      el('td', {}, fmtDate(e.newestMtime)), el('td', { class: 'num' }, String(e.fileCount)));
  });
  const head = el('tr', {}, el('th', { class: 'chk' }, all), el('th', {}, 'Type'), el('th', {}, 'Path'), el('th', { class: 'num' }, 'Size'), el('th', {}, 'Newest change'), el('th', { class: 'num' }, 'Files'));
  out.append(el('div', { class: 'pvbox' }, el('table', { class: 'pv' }, el('thead', {}, head), el('tbody', {}, ...rows))));
  if (d.entries.length > MT_MAX_ROWS) out.append(el('p', { class: 'muted small' }, `Showing the first ${MT_MAX_ROWS} of ${d.entries.length}. "Select all" and "Run now" apply to all of them.`));
  return out;
}

async function previewRule(rule) {
  mtBusy.add(rule.id);
  renderRules(mtRules);
  const d = await guard(() => api.maint.preview(rule.id));
  mtBusy.delete(rule.id);
  if (d) mtPreview.set(rule.id, { data: d, checked: new Set(d.entries.map((x) => x.path)) });
  renderRules(mtRules);
}

// §3 lista de reguli si actiuni
async function runRule(rule) {
  if (!mtPreview.has(rule.id)) await previewRule(rule); // fara preview nu avem ce confirma
  const pv = mtPreview.get(rule.id);
  if (!pv) return;
  const sel = pv.data.entries.filter((e) => pv.checked.has(e.path));
  if (!sel.length) return toast(pv.data.entries.length ? 'Tick at least one item in the preview' : 'Nothing to remove');
  const bytes = sel.reduce((s, e) => s + e.size, 0);
  const verb = rule.action === 'recycle' ? 'Move to the Recycle Bin' : 'PERMANENTLY DELETE';
  if (!(await askConfirm(`${verb} ${sel.length} item${sel.length === 1 ? '' : 's'} (${fmtSize(bytes)}) from\n${rule.path}?${rule.action === 'delete' ? '\n\nCannot be undone.' : ''}`, { title: 'Run cleanup', okLabel: verb, danger: rule.action === 'delete' }))) return;
  mtBusy.add(rule.id);
  renderRules(mtRules);
  const r = await guard(() => api.maint.run(rule.id, sel.map((e) => e.path)));
  mtBusy.delete(rule.id);
  mtPreview.delete(rule.id);
  if (r) toast(`Removed ${r.removed} item${r.removed === 1 ? '' : 's'} (${fmtSize(r.bytes)})${r.skipped ? `, ${r.skipped} skipped (changed meanwhile)` : ''}${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
  loadRules();
}

function lastRunLine(r) {
  const res = r.lastResult;
  const txt = r.lastRunAt && res
    ? `Last run ${fmtDate(r.lastRunAt)}: removed ${res.removed} item${res.removed === 1 ? '' : 's'} (${fmtSize(res.bytes)})${res.skipped ? `, ${res.skipped} skipped` : ''}${res.failed.length ? `, ${res.failed.length} failed` : ''}`
    : 'Never run';
  const out = [el('div', { class: 'muted' }, txt)];
  if (res && res.failed.length) out.push(el('div', { class: 'errtxt small' }, res.failed.slice(0, 3).map((f) => `${f.path}: ${f.error}`).join(' | ')));
  if (r.enabled && r.nextRunAt) out.push(el('div', { class: 'muted small' }, `Next run: ${fmtDate(r.nextRunAt)}`));
  return out;
}

function ruleCard(r) {
  const busy = mtBusy.has(r.id);
  const btn = (text, fn, cls = '') => { const b = el('button', { class: cls, disabled: busy }, text); b.addEventListener('click', fn); return b; };
  const acts = el('div', { class: 'acts' },
    btn('Preview', () => previewRule(r)), btn('Run now', () => runRule(r)), btn('Edit', () => editRule(r)),
    btn('Remove rule', async () => {
      if (!(await askConfirm(`Remove this rule?\n${r.path}\n\nFiles already removed stay removed; removing the rule touches no files.`, { title: 'Remove rule', okLabel: 'Remove', danger: true }))) return;
      await guard(() => api.maint.remove(r.id));
      mtPreview.delete(r.id);
      loadRules();
    }, 'danger'));
  const card = el('div', { class: `rule${r.enabled ? '' : ' off'}` },
    el('div', { class: 'rp' }, r.path),
    el('div', {}, `Older than ${r.days} days · ${ACTION_TEXT[r.action]} · ${fmtSchedule(r.schedule)} · ${r.onlySynced ? 'only items synced to Drive' : 'synced or not'}${r.enabled ? '' : ' · Disabled'}`),
    ...lastRunLine(r), acts);
  if (busy) card.append(el('div', { class: 'muted small' }, 'Working…'));
  if (mtPreview.has(r.id)) card.append(previewBox(mtPreview.get(r.id)));
  return card;
}

function renderRules(rules) {
  mtRules = rules;
  $('mt-empty').hidden = rules.length > 0;
  $('mt-rules').replaceChildren(...rules.map(ruleCard));
}

async function loadRules() {
  const rules = await guard(() => api.maint.list());
  if (rules) renderRules(rules);
}

function initMaint() {
  mtSched = scheduleField({ type: 'manual' });
  $('mt-sched').replaceChildren(mtSched.node);
  $('mt-form').addEventListener('submit', saveRule);
  $('mt-cancel').addEventListener('click', resetMtForm);
  $('mt-action').addEventListener('change', () => { $('mt-warn').hidden = $('mt-action').value !== 'delete'; });
  $('mt-browse').addEventListener('click', async () => { const p = await guard(() => api.maint.pickFolder()); if (p) $('mt-path').value = p; });
  api.on('maint:update', renderRules);
}
