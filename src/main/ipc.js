/* MAP
 * §1 imports si servicii  L7-L62
 * §2 handlere IPC  L63-L148
 * §3 ceas program + trezire  L149-L166
 */

// §1 imports si servicii
const { app, ipcMain, dialog, powerMonitor, shell, nativeTheme } = require('electron');
const fs = require('fs');
const cfg = require('./config');
const { createAuth } = require('./auth');
const { createDrive } = require('./drive');
const { createUploader } = require('./uploader');
const { createAudit } = require('./audit');
const { createDownloader } = require('./downloader');
const { createSyncStore } = require('./sync-store');
const { createSync } = require('./sync');
const { createMaintenance } = require('./maintenance');
const { createSettings } = require('./settings');
const { createActivity } = require('./activity');
const { createErrorLog } = require('./error-log');
const localfs = require('./localfs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function registerIpc(getWindow) {
  const dataDir = app.getPath('userData');
  const push = (ch, payload) => { const w = getWindow(); if (w && !w.isDestroyed()) w.webContents.send(ch, payload); };

  // Throttle leading + trailing: nu incarca IPC-ul la 1000 ev/s, dar trimite MEREU ultima stare
  function throttled(ch, ms = cfg.UI_PUSH_MS || 400) {
    let last = 0;
    let timer = null;
    let latest = null;
    return (payload) => {
      latest = payload;
      const wait = ms - (Date.now() - last);
      if (wait <= 0) {
        clearTimeout(timer);
        timer = null;
        last = Date.now();
        push(ch, latest);
      } else if (!timer) {
        timer = setTimeout(() => { timer = null; last = Date.now(); push(ch, latest); }, wait);
        if (timer.unref) timer.unref();
      }
    };
  }

  const pushSync = throttled('sync:update');
  const pushActivity = throttled('activity:update', 300);
  const activity = createActivity({ max: cfg.ACTIVITY_MAX, onChange: pushActivity });
  const errorLog = createErrorLog({
    dataDir, cfg,
    onEntry: (e) => {
      const lvl = (e.status === 403 || e.status === 429) ? 'warn' : 'error';
      const head = e.status ? `HTTP ${e.status}` : 'NET';
      activity.log(lvl, 'Google API', `${head} ${e.reason || 'error'} (${e.op}): ${e.message}`);
    },
  });
  const settings = createSettings({ dataDir, app, nativeTheme });
  const auth = createAuth(dataDir, { onError: errorLog.record });
  const drive = createDrive({ getToken: auth.getToken, base: cfg.DRIVE_BASE, sleep, onError: errorLog.record, metaTimeoutMs: cfg.META_TIMEOUT_MS, interactiveTimeoutMs: cfg.INTERACTIVE_TIMEOUT_MS, uploadTimeoutMs: cfg.UPLOAD_TIMEOUT_MS });
  const audit = createAudit(drive);

  let syncRef = null;
  const uploader = createUploader({
    drive, dataDir, cfg, sleep, activity,
    getSettings: settings.get,
    getJobPolicy: () => (syncRef ? syncRef.getPriorityPolicy() : null),
    jobName: (id) => (syncRef ? syncRef.nameOf(id) : ''),
    onSyncDone: (it) => { if (syncRef) syncRef.onUploaded(it); },
    onChange: (snap) => {
      push('queue:update', snap);
      if (syncRef) pushSync(syncRef.listJobs()); // actualiza live sloturile / pauza si in tabul Sync
    },
  });

  const downloader = createDownloader({ drive, cfg, sleep, onChange: throttled('dl:update', 250) });
  const store = createSyncStore({ dataDir, debounceMs: cfg.INDEX_SAVE_DEBOUNCE_MS });
  const sync = createSync({ store, uploader, drive, downloader, onChange: pushSync, activity });
  syncRef = sync;
  const maint = createMaintenance({ dataDir, trash: (p) => shell.trashItem(p), isSynced: sync.isSynced, onChange: (rules) => push('maint:update', rules) });

  // §2 handlere IPC (toate intorc date simple; erorile se propaga la renderer ca mesaj)
  const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));
  const refocus = () => { const w = getWindow(); if (w && !w.isDestroyed()) { w.focus(); w.webContents.focus(); } };
  const openDlg = async (opts) => { try { return await dialog.showOpenDialog(getWindow(), opts); } finally { refocus(); } };
  const saveDlg = async (opts) => { try { return await dialog.showSaveDialog(getWindow(), opts); } finally { refocus(); } };

  handle('auth:status', () => auth.status());
  handle('auth:import', async () => {
    const r = await openDlg({ title: 'OAuth client file (JSON)', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return false;
    return auth.importClient(r.filePaths[0]);
  });
  handle('auth:login', async () => { await auth.login(); uploader.resume(); return true; });
  handle('auth:logout', () => { auth.logout(); return true; });

  const navAborts = new Map();
  async function runInteractive(slot, fn) {
    const prev = navAborts.get(slot);
    if (prev) prev.abort();
    const ac = new AbortController();
    navAborts.set(slot, ac);
    const release = uploader.beginInteractive();
    try {
      return await fn(ac.signal);
    } finally {
      release();
      if (navAborts.get(slot) === ac) navAborts.delete(slot);
    }
  }

  handle('drive:about', () => drive.about());
  handle('drive:list', (id) => runInteractive('files', (signal) => drive.listAll(id || 'root', { signal, interactive: true })));
  handle('drive:listFolders', (id) => runInteractive('syncDrive', (signal) => drive.listFolders(id || 'root', { signal, interactive: true })));
  handle('drive:mkdir', async (parentId, name) => { const rel = uploader.beginInteractive(); try { return await drive.ensureFolder(parentId || 'root', name); } finally { rel(); } });
  handle('drive:trash', async (ids) => { for (const id of ids) await drive.trash(id); return ids.length; });
  handle('drive:download', async (items, onExists) => {
    const r = await openDlg({ title: 'Download into folder…', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return 0;
    return downloader.add(items, r.filePaths[0], onExists);
  });
  handle('dl:snapshot', () => downloader.snapshot());
  handle('dl:cancel', () => downloader.cancelAll());
  handle('dl:retry', () => downloader.retryErrors());
  handle('dl:clear', (mode) => downloader.clear(mode));

  handle('audit:run', () => audit.run((p) => push('audit:progress', p)));
  handle('audit:private', (id, onlyPublic) => audit.makePrivate(id, { onlyPublic }));

  handle('queue:add', (paths, parentId, onExists) => uploader.add(paths, parentId || 'root', onExists));
  handle('queue:pick', async (parentId, wantFolders, onExists) => {
    const r = await openDlg({ properties: [wantFolders ? 'openDirectory' : 'openFile', 'multiSelections'] });
    return r.canceled ? 0 : uploader.add(r.filePaths, parentId || 'root', onExists);
  });
  handle('queue:snapshot', () => uploader.snapshot());
  handle('queue:remove', (id) => uploader.remove(id));
  handle('queue:clear', (mode) => uploader.clear(mode));
  handle('queue:retry', () => uploader.retryErrors());
  handle('queue:pause', () => uploader.pause());
  handle('queue:resume', () => uploader.resume());
  handle('queue:workers', (n) => uploader.setWorkers(n));

  handle('activity:list', () => activity.list());
  handle('activity:clear', () => { activity.clear(); return true; });
  handle('errors:summary', () => errorLog.summary());
  handle('errors:clear', () => { errorLog.clear(); return true; });
  handle('errors:open', () => {
    if (!fs.existsSync(errorLog.file)) fs.writeFileSync(errorLog.file, '', 'utf8');
    shell.showItemInFolder(errorLog.file);
    return errorLog.file;
  });

  handle('drive:revisions', (id) => drive.listRevisions(id));
  handle('drive:keepRevision', (id, revisionId, keep) => drive.setKeepForever(id, revisionId, keep));
  handle('drive:downloadRevision', async (id, revisionId, name) => {
    const r = await saveDlg({ title: 'Save this version as…', defaultPath: name });
    if (r.canceled) return false;
    await drive.download(id, r.filePath, { revisionId });
    return r.filePath;
  });

  handle('fs:roots', () => localfs.roots());
  handle('fs:list', (dir) => localfs.list(dir));
  handle('shell:show', (p) => shell.showItemInFolder(p));

  handle('sync:jobs', () => sync.listJobs());
  handle('sync:create', (p) => sync.create(p));
  handle('sync:update', (id, p) => sync.update(id, p));
  handle('sync:remove', (id) => sync.remove(id));
  handle('sync:run', (id, opts) => sync.run(id, opts));
  handle('sync:start', (id) => sync.start(id));
  handle('sync:stop', (id) => sync.stop(id));
  handle('sync:pause', (id) => sync.setPaused(id, true));
  handle('sync:resume', (id) => sync.setPaused(id, false));
  handle('sync:reorder', (ids) => sync.reorder(ids));
  handle('sync:pickFolders', async (defaultPath) => {
    const opts = { title: 'Add folders to sync', properties: ['openDirectory', 'multiSelections'] };
    if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
    const r = await openDlg(opts);
    return r.canceled ? [] : r.filePaths;
  });
  handle('sync:retryAll', () => sync.retryAll());
  handle('sync:deleted', () => sync.deleted());
  handle('sync:deleteFromDrive', (refs) => sync.deleteFromDrive(refs));
  handle('sync:keep', (refs) => sync.keep(refs));
  handle('sync:restore', (refs) => sync.restore(refs));

  handle('maint:list', () => maint.list());
  handle('maint:save', (rule) => maint.save(rule));
  handle('maint:remove', (id) => maint.remove(id));
  handle('maint:preview', (id) => maint.preview(id));
  handle('maint:run', (id, only) => maint.run(id, { only }));
  handle('maint:pickFolder', async () => {
    const r = await openDlg({ title: 'Choose a folder', properties: ['openDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
  });

  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => settings.set(patch));

  // §3 ceas program + trezire din somn
  const tickAuto = async () => {
    const st = await auth.status();
    if (!st.loggedIn) return;
    try { await sync.tick(); } catch (e) { /* eroarea ramane pe job (lastError) */ }
    try { await maint.tick(); } catch (e) { /* eroarea ramane pe regula (lastResult) */ }
  };
  const autoTimer = setInterval(tickAuto, 60 * 1000);
  autoTimer.unref();
  powerMonitor.on('resume', () => { uploader.tick(); tickAuto(); });
  powerMonitor.on('unlock-screen', () => { uploader.tick(); tickAuto(); });
  uploader.start();
  setTimeout(tickAuto, 5000);
  return { uploader, sync, maint, settings, activity, flush: () => { store.flushAll(); uploader.queue.save(true); } };
}

module.exports = { registerIpc };
