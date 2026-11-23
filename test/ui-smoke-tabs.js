/* MAP
 * §1 proba taburilor Sync / Deleted / Maintenance / Versions  L5-L129
 */

// §1 proba taburilor noi: date de test puse direct in stare (fara Google real); fs/maint/settings sunt locale si reale
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SYNC = `(async () => {
  const tabsExist = ['nav-files', 'nav-sync', 'nav-maint'].every((i) => !!$(i));
  showMainTab('sync');
  await new Promise((r) => setTimeout(r, 700));
  sdrive.trail = [{ id: 'root', name: 'My Drive' }, { id: 'p', name: 'Photos' }];
  sdrive.items = [{ id: 'd1', name: '2026' }, { id: 'd2', name: 'Raw <b>x</b>' }];
  renderSyncDrive();
  const mk = (n, d, s) => ({ name: n, path: '/data/backup/' + n, isDir: d, size: s, mtimeMs: 1.78e12 });
  Object.assign(spc, { path: '/data/backup', parent: '/data', entries: [mk('alpha', true, 0), mk('b.txt', false, 2048), mk('c.bin', false, 5e6)] });
  spc.checked.clear(); spc.allMode = false; renderPc();
  const childrenHiddenBefore = $('sf-children-wrap').hidden;
  $('sp-all').click();
  const childrenShown = !$('sf-children-wrap').hidden;
  const nameDefault = $('sf-name').value;
  const allChecked = spc.checked.size;
  $('sp-rows').querySelectorAll('input')[1].click();
  const src1 = buildSources();
  $('sf-children').click();
  const src2 = buildSources();
  $('sf-children').click();
  const job = { id: 1, name: 'Backup → Photos', driveParentName: 'Photos', driveParentId: 'p', sources: [{ path: '/data/backup', mode: 'children', exclude: [] }],
    schedule: { type: 'interval', every: 1, unit: 'hours' }, scheduleText: 'Every 1 hour', enabled: true, paused: false, deleteMode: 'mark', trackDeletes: true, keepVersions: true,
    lastRunAt: Date.now() - 60000, lastScan: { total: 120, fresh: 3, changed: 1, markedDeleted: 2 }, lastError: '', running: true, phase: 'scanning', detail: 'Scanning… 120 files', openUploads: 0, files: 117, deleted: 2 };
  const job2 = { ...job, id: 2, name: 'Docs → Archive', enabled: false, paused: false, running: false, phase: 'disabled', detail: 'Stopped (click Run to activate)', openUploads: 0, deleted: 0 };
  renderJobs([job, job2]);
  const tr1 = $('sj-rows').children[0];
  const tr2 = $('sj-rows').children[1];
  const scanning = tr1.children[5].textContent;
  const btnsActive = [...tr1.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent);
  const btnsStopped = [...tr2.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent);
  const prioOk = tr1.draggable && /#1/.test(tr1.children[0].textContent) && /#2/.test(tr2.children[0].textContent);
  renderJobs([{ ...job, running: false, phase: 'uploading', detail: 'Uploading 4 files', openUploads: 4, lastError: 'Source unavailable: X' }, { ...job2, enabled: true, paused: true, phase: 'paused', detail: 'Paused by you' }]);
  const sameRow = $('sj-rows').children[0] === tr1;
  const status = tr1.children[5].textContent;
  const btnsPaused = [...tr2.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent);
  const delText = [...tr1.querySelectorAll('button')].find((b) => /^Deleted/.test(b.textContent)).textContent;
  [...tr1.querySelectorAll('button')].find((b) => b.textContent === 'Edit').click();
  await new Promise((r) => setTimeout(r, 250));
  const editorOpen = $('sj-rows').children.length === 3;
  const srcEdOk = !!document.querySelector('.edit-row .src-ed') && !!document.querySelector('.edit-row .src-chip');
  const splitterOk = !!$('sync-splitter') && !!$('activity-bar');
  const retryBtnOk = !!$('sj-retry-all') && !$('sj-retry-all').disabled;
  const sdRefreshOk = !!$('sd-refresh');
  setCommanderHeight(540);
  const cmdHeight = Math.round($('sync-commander').getBoundingClientRect().height);
  return { tabsExist, childrenHiddenBefore, childrenShown, nameDefault, allChecked, src1: JSON.stringify(src1), src2: JSON.stringify(src2),
    sdRows: $('sd-rows').children.length, pcRows: $('sp-rows').children.length, jobRows: $('sj-rows').children.length, scanning, status, sameRow, delText, editorOpen,
    srcEdOk, prioOk, btnsActive, btnsStopped, btnsPaused,
    splitterOk, retryBtnOk, sdRefreshOk, cmdHeight, xssSafe: !$('sd-rows').querySelector('b') };
})()`;

const DELETED = `(async () => {
  const e = (jobId, jobName, rel, size) => ({ jobId, jobName, path: '/data/' + rel, relPath: rel, size, deletedAt: 1.78e12, driveId: 'x' + rel });
  dv.jobFilter = null; dv.checked.clear(); dv.expanded.clear(); dv.seenJobs.clear();
  dv.list = [e(1, 'Backup', 'folder/sub/a.txt', 10), e(1, 'Backup', 'folder/b.txt', 20), e(1, 'Backup', 'c.txt', 5), e(2, 'Docs', 'd.pdf', 7)];
  dv.root = buildTree(dv.list);
  for (const id of dv.root.kids.keys()) dv.expanded.add(id);
  dv.expanded.add('j1/folder');
  $('sync-home').hidden = true; $('deleted-view').hidden = false;
  renderDeleted();
  const rowsOpen = $('dv-tree').children.length;
  const folderRow = [...$('dv-tree').children].find((r) => r.textContent.includes('folder') && !r.textContent.includes('sub') && !r.textContent.includes('b.txt'));
  folderRow.querySelector('input').click();
  const afterFolder = dv.checked.size;
  const top = $('dv-tree').children[0].querySelector('input');
  const topIndeterminate = top.indeterminate;
  const countText = $('dv-count').textContent;
  $('dv-all').click();
  const allSel = dv.checked.size;
  $('dv-all').click();
  const none = dv.checked.size;
  return { rowsOpen, afterFolder, topIndeterminate, countText, allSel, none, restoreDisabled: $('dv-restore').disabled };
})()`;

const MAINT = `(async () => {
  $('sync-home').hidden = false; $('deleted-view').hidden = true;
  showMainTab('maint');
  await new Promise((r) => setTimeout(r, 500));
  const formShown = !$('mt-form').hidden && !$('maint-view').hidden;
  const rule = { id: 'r1', path: 'C:/Temp/Old', days: 30, action: 'delete', onlySynced: true, enabled: true, schedule: { type: 'daily', at: '03:00', everyDays: 2 },
    lastRunAt: Date.now() - 3600e3, nextRunAt: Date.now() + 3600e3, lastResult: { removed: 4, bytes: 3e6, skipped: 0, failed: [{ path: 'C:/Temp/Old/x', error: 'EBUSY' }] } };
  renderRules([rule]);
  mtPreview.set('r1', { data: { entries: [{ path: 'C:/Temp/Old/a', kind: 'folder', size: 1e6, newestMtime: 1.7e12, fileCount: 3 }, { path: 'C:/Temp/Old/b.log', kind: 'file', size: 5e5, newestMtime: 1.7e12, fileCount: 1 }],
    totalBytes: 1.5e6, totalCount: 2, skippedUnsynced: 1, errors: [] }, checked: new Set(['C:/Temp/Old/a', 'C:/Temp/Old/b.log']) });
  renderRules([rule]);
  const ruleText = $('mt-rules').textContent;
  $('mt-action').value = 'delete'; $('mt-action').dispatchEvent(new Event('change'));
  const warnShown = !$('mt-warn').hidden;
  $('mt-rules').querySelector('.pvbox tbody input').click();
  const pvRows = $('mt-rules').querySelectorAll('.pvbox tbody tr').length;
  const pvChecked = mtPreview.get('r1').checked.size;
  $('btn-settings').click();
  await new Promise((r) => setTimeout(r, 300));
  const settingsOpen = $('settings-dlg').open;
  const tray = $('set-tray').checked;
  const limitRetry = $('set-limit-retry').checked;
  const limitMins = $('set-limit-mins').value;
  const errLogBtn = !!$('act-open-errlog');
  const themeSelOk = !!$('set-theme') && !!$('btn-theme');
  $('settings-dlg').close();
  $('btn-theme').click();
  await new Promise((r) => setTimeout(r, 120));
  const theme1 = document.documentElement.dataset.theme;
  const sun1 = !$('ico-theme-sun').hasAttribute('hidden');
  const moon1 = !$('ico-theme-moon').hasAttribute('hidden');
  $('btn-theme').click();
  await new Promise((r) => setTimeout(r, 120));
  const theme2 = document.documentElement.dataset.theme;
  const sun2 = !$('ico-theme-sun').hasAttribute('hidden');
  const moon2 = !$('ico-theme-moon').hasAttribute('hidden');
  const iconFlipOk = (theme1 === 'light' ? (moon1 && !sun1 && sun2 && !moon2) : (sun1 && !moon1 && moon2 && !sun2));
  return { formShown, ruleText, warnShown, pvRows, pvChecked, settingsOpen, tray, limitRetry, limitMins, errLogBtn, themeSelOk, theme1, theme2, iconFlipOk };
})()`;

const FILES = `(async () => {
  showMainTab('files');
  const f = (id, mime) => ({ id, name: id, mimeType: mime, size: '10', modifiedTime: '2026-11-19T10:00:00Z' });
  state.items = [f('x0', FOLDER), f('x1', 'text/plain'), f('x2', 'text/plain')];
  const en = (ids) => { state.selected = new Set(ids); renderFiles(); return !$('btn-versions').disabled; };
  return { verFile: en(['x1']), verFolder: en(['x0']), verTwo: en(['x1', 'x2']), verNone: en([]) };
})()`;

module.exports = async (win, snap) => {
  const ev = (code) => win.webContents.executeJavaScript(code);
  const sync = await ev(SYNC);
  await wait(300);
  const shotSync = await snap(win, 'nex-drive-sync.png');
  await ev("document.querySelector('.jobs-card').scrollIntoView({ behavior: 'instant', block: 'start' });");
  await wait(250);
  const shotJobs = await snap(win, 'nex-drive-sync-jobs.png');
  const del = await ev(DELETED);
  await wait(300);
  const shotDel = await snap(win, 'nex-drive-deleted.png');
  const maint = await ev(MAINT);
  await wait(300);
  const shotMaint = await snap(win, 'nex-drive-maint.png');
  win.setContentSize(980, 700); // latimea minima: fara depasire orizontala in niciun tab
  await wait(400);
  const overflow = await ev(`['main','sync-view','maint-view'].map((id) => { showMainTab(id === 'main' ? 'files' : id === 'sync-view' ? 'sync' : 'maint'); const n = document.getElementById(id); return n.scrollWidth - n.clientWidth; })`);
  await ev("showMainTab('sync'); $('sync-home').hidden = false; $('deleted-view').hidden = true;");
  await wait(300);
  const shotNarrow = await snap(win, 'nex-drive-sync-980.png');
  const files = await ev(FILES);
  const ok = sync.tabsExist && sync.childrenHiddenBefore && sync.childrenShown && sync.nameDefault === 'backup → Photos' && sync.allChecked === 3
    && sync.src1 === '[{"path":"/data/backup","mode":"children","exclude":["b.txt"]}]'
    && JSON.parse(sync.src2).length === 2 && JSON.parse(sync.src2)[0].mode === 'item'
    && sync.sdRows === 2 && sync.pcRows === 3 && /Scanning/.test(sync.scanning) && /Uploading 4 files/.test(sync.status) && /Source unavailable/.test(sync.status)
    && sync.sameRow && sync.delText === 'Deleted (2)' && sync.editorOpen && sync.srcEdOk && sync.prioOk
    && sync.btnsActive.includes('Stop') && sync.btnsActive.includes('Pause')
    && sync.btnsStopped.includes('Run') && !sync.btnsStopped.includes('Pause')
    && sync.btnsPaused.includes('Stop') && sync.btnsPaused.includes('Resume')
    && sync.splitterOk && sync.retryBtnOk && sync.sdRefreshOk && sync.cmdHeight >= 400 && sync.xssSafe && sync.jobRows === 3
    && del.rowsOpen === 7 && del.afterFolder === 2 && del.topIndeterminate && /2 of 4/.test(del.countText) && del.allSel === 4 && del.none === 0 && del.restoreDisabled
    && maint.formShown && /Delete permanently/.test(maint.ruleText) && /Daily at|Every 2 days at 03:00/.test(maint.ruleText) && /removed 4 items/.test(maint.ruleText) && /1 failed/.test(maint.ruleText)
    && maint.warnShown && maint.pvRows === 2 && maint.pvChecked === 1 && maint.settingsOpen && maint.limitRetry && maint.limitMins === '60' && maint.errLogBtn
    && maint.themeSelOk && maint.iconFlipOk && ((maint.theme1 === 'dark' && maint.theme2 === 'light') || (maint.theme1 === 'light' && maint.theme2 === 'dark'))
    && overflow.every((x) => x <= 1) && files.verFile && !files.verFolder && !files.verTwo && !files.verNone;
  return { ok, sync, del, maint, overflow, files, shots: [shotSync, shotJobs, shotDel, shotMaint, shotNarrow] };
};
