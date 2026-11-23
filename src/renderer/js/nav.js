/* MAP
 * §1 taburi principale  L6-L39
 * §2 tema light/dark  L40-L72
 * §3 dialog setari  L73-L108
 */

// §1 taburi principale: Files | Sync | Maintenance; ecranele raman in DOM, doar se ascund
const VIEWS = { files: 'main', sync: 'sync-view', maint: 'maint-view' };
let curTab = 'files';
let authed = false;
let syncOpened = false;

function renderNav() {
  $('nav').hidden = !authed;
  $('btn-settings').hidden = !authed;
  $('activity-bar').hidden = !authed;
  for (const [tab, id] of Object.entries(VIEWS)) {
    $(id).hidden = !authed || tab !== curTab;
    $(`nav-${tab}`).classList.toggle('on', tab === curTab);
  }
}

function showMainTab(tab) {
  curTab = tab;
  renderNav();
  if (!authed) return;
  if (tab === 'files' && typeof flushQueueView === 'function') flushQueueView();
  if (tab === 'sync') {
    if (!syncOpened) { syncOpened = true; initSyncPanes(); }
    if (typeof flushSyncJobs === 'function') flushSyncJobs();
    refreshSyncJobs();
  }
  if (tab === 'maint') loadRules();
}

function setAuthed(v) {
  authed = v;
  if (!v) syncOpened = false;
  renderNav();
  if (v) showMainTab(curTab);
}

// §2 tema light/dark: comutator rapid in bara de sus + selector System/Light/Dark in Settings
let curTheme = 'system';
const sysDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
const isDarkNow = () => curTheme === 'dark' || (curTheme === 'system' && sysDark());

function applyTheme(mode) {
  curTheme = mode === 'light' || mode === 'dark' ? mode : 'system';
  if (curTheme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = curTheme;
  try { localStorage.setItem('nexdrive-theme', curTheme); } catch (e) { /* storage optional */ }
  const dark = isDarkNow();
  const moon = $('ico-theme-moon');
  const sun = $('ico-theme-sun');
  if (moon) moon.toggleAttribute('hidden', dark);
  if (sun) sun.toggleAttribute('hidden', !dark);
  const btn = $('btn-theme');
  if (btn) {
    const lbl = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.title = `${lbl} (current: ${curTheme})`;
    btn.setAttribute('aria-label', lbl);
  }
  const sel = $('set-theme');
  if (sel && sel.value !== curTheme) sel.value = curTheme;
}

function setTheme(mode) {
  applyTheme(mode);
  guard(() => api.settings.set({ theme: curTheme }));
}

// §3 dialog setari
function initNav() {
  try { applyTheme(localStorage.getItem('nexdrive-theme') || 'system'); } catch (e) { applyTheme('system'); }
  api.settings.get().then((s) => { if (s && s.theme) applyTheme(s.theme); }).catch(() => { /* setari implicite */ });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (curTheme === 'system') applyTheme('system'); });
  }
  $('btn-theme').addEventListener('click', () => setTheme(isDarkNow() ? 'light' : 'dark'));
  $('set-theme').addEventListener('change', (e) => setTheme(e.target.value));

  for (const tab of Object.keys(VIEWS)) $(`nav-${tab}`).addEventListener('click', () => showMainTab(tab));
  $('btn-settings').addEventListener('click', async () => {
    const s = await guard(() => api.settings.get());
    if (!s) return;
    $('set-theme').value = s.theme || curTheme;
    $('set-tray').checked = s.closeToTray;
    $('set-login').checked = s.openAtLogin;
    $('set-limit-retry').checked = s.limitAutoRetry !== false;
    $('set-limit-mins').value = String(s.limitRetryMinutes || 60);
    $('set-limit-mins').disabled = !$('set-limit-retry').checked;
    $('settings-dlg').showModal();
  });
  $('set-tray').addEventListener('change', (e) => guard(() => api.settings.set({ closeToTray: e.target.checked })));
  $('set-login').addEventListener('change', (e) => guard(() => api.settings.set({ openAtLogin: e.target.checked })));
  $('set-limit-retry').addEventListener('change', (e) => {
    $('set-limit-mins').disabled = !e.target.checked;
    guard(() => api.settings.set({ limitAutoRetry: e.target.checked }));
  });
  $('set-limit-mins').addEventListener('change', async (e) => {
    const s = await guard(() => api.settings.set({ limitRetryMinutes: Number(e.target.value) }));
    if (s) e.target.value = String(s.limitRetryMinutes);
  });
  $('set-close').addEventListener('click', () => $('settings-dlg').close());
  initActivity();
  wireSyncPanes();
  initSyncForm();
  initSyncJobs();
  initDeleted();
  initMaint();
  initVersions();
}
