/* MAP
 * §1 formular „New sync job”  L5-L72
 */

// §1 formular „New sync job”: 3 moduri clare de stergere (mark / keep / mirror) + optiuni grupate
let sfSched;
let sfNameTouched = false;

// „Select all” (sau toate bifate) permite sursa 'children': si ce apare nou in folder mai tarziu se sincronizeaza
const childrenEligible = () => spc.checked.size > 0 && (spc.allMode || spc.checked.size === spc.entries.length);

function selectedDeleteMode() {
  const r = document.querySelector('input[name="sf-delmode"]:checked');
  return r ? r.value : 'mark';
}

function setDeleteMode(mode) {
  const r = document.querySelector(`input[name="sf-delmode"][value="${mode}"]`);
  if (r) r.checked = true;
}

function defaultSyncName() {
  return spc.path ? `${baseName(spc.path)} → ${sdHere().name}` : '';
}

function refreshSyncForm() {
  if (!sfSched) return;
  $('sf-children-wrap').hidden = !childrenEligible();
  if (!sfNameTouched) $('sf-name').value = defaultSyncName();
  const n = spc.checked.size;
  const destPath = sdrive.trail.map((c) => c.name).join(' / ');
  $('sf-info').textContent = n ? `${fmtNum(n)} source(s) from ${baseName(spc.path)}  →  ${destPath}` : `Tick files or folders in This PC  →  ${destPath}`;
}

function buildSources() {
  const asChildren = childrenEligible() && $('sf-children').checked;
  if (asChildren) return [{ path: spc.path, mode: 'children', exclude: spc.entries.filter((e) => !spc.checked.has(e.path)).map((e) => e.name) }];
  return [...spc.checked].map((p) => ({ path: p, mode: 'item' }));
}

function resetSyncForm() {
  sfNameTouched = false;
  sfSched.set({ type: 'interval', every: 1, unit: 'hours' });
  setDeleteMode('mark');
  $('sf-keep').checked = true;
  $('sf-children').checked = true;
  resetPcSelection();
}

async function startSync(e) {
  e.preventDefault();
  const dest = sdHere();
  if (!dest) return toast('Choose a Drive destination folder');
  if (!spc.checked.size) return toast('Tick at least one file or folder in "This PC"');
  const btn = $('sf-start');
  btn.disabled = true;
  const name = $('sf-name').value.trim() || defaultSyncName() || 'Sync job';
  const deleteMode = selectedDeleteMode();
  const job = await guard(() => api.sync.create({
    name, driveParentId: dest.id, driveParentName: dest.name, sources: buildSources(), schedule: sfSched.get(),
    deleteMode, trackDeletes: deleteMode === 'mark', keepVersions: $('sf-keep').checked,
  }));
  btn.disabled = false;
  if (!job) return;
  toast(`Sync started: ${name}`);
  resetSyncForm();
  refreshSyncJobs();
}

function initSyncForm() {
  sfSched = scheduleField();
  $('sf-sched').replaceChildren(sfSched.node);
  $('sf-name').addEventListener('input', () => { sfNameTouched = $('sf-name').value !== ''; });
  $('sync-form').addEventListener('submit', startSync);
}
