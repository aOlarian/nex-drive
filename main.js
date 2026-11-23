/* MAP
 * §1 imports si instanta unica  L6-L12
 * §2 fereastra si tray  L13-L60
 */

// §1 imports si instanta unica (o singura coada pe PC: doua instante ar urca de doua ori)
const path = require('path');
const { app, BrowserWindow, Menu, Tray, nativeImage } = require('electron');
const { showEnterprise } = require('./enterprise.cjs');

if (!app.requestSingleInstanceLock()) app.quit();

// §2 fereastra si tray: inchiderea ferestrei ascunde aplicatia in tray (sync-ul continua in fundal); „Quit” din tray o opreste
let win = null;
let tray = null;
let services = null;
let quitting = false;
const startHidden = process.argv.includes('--hidden') && !process.env.NEXDRIVE_SMOKE;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 980, minHeight: 600, title: 'NexDrive', show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) { win.show(); showEnterprise(win); } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault()); // un fisier tras gresit pe fereastra nu schimba pagina
  win.on('close', (e) => {
    if (quitting || !services || !services.settings.get().closeToTray) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.focus();
  showEnterprise(win);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('NexDrive');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open NexDrive', click: showWindow },
    { label: 'Quit (stops syncing)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; if (services) services.flush(); });

app.whenReady().then(() => {
  const { registerIpc } = require('./src/main/ipc');
  services = registerIpc(() => win);
  services.settings.apply();
  createWindow();
  createTray();
  if (process.env.NEXDRIVE_SMOKE) require('./test/ui-smoke')(win, app);
});

app.on('window-all-closed', () => { if (quitting || !services || !services.settings.get().closeToTray) app.quit(); });
