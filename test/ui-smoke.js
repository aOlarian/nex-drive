/* MAP
 * §1 proba UI in Electron real  L5-L66
 */

// §1 proba UI in Electron real: umple UI cu date de test, simuleaza Ctrl/Shift+click, dialogul „Folder nou”, tab descarcari; verifica DOM + erori consola; captura
const fs = require('fs');
const path = require('path');

const snap = async (win, name) => {
  const file = path.join(process.env.TEMP || '.', name);
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  return file;
};

module.exports = (win, app) => {
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.on('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 800));
      const out = await win.webContents.executeJavaScript(`(async () => {
        document.getElementById('setup').hidden = true;
        setAuthed(true);
        state.trail = [{ id: 'root', name: 'My Drive' }, { id: 'a', name: 'Backup 2026' }];
        state.items = ['Alfa', 'Beta', 'Gama', 'Delta', 'Epsilon'].map((n, i) => ({ id: 'f' + i, name: n + (i < 2 ? '' : '.zip'), mimeType: i < 2 ? FOLDER : 'application/zip', size: String(700e6 + i), modifiedTime: '2026-11-19T10:00:00Z' }));
        renderFiles();
        const click = (i, o = {}) => document.querySelectorAll('#rows tr')[i].dispatchEvent(new MouseEvent('click', { bubbles: true, ...o }));
        click(1);                              // simplu: doar Beta
        const simple = state.selected.size;
        click(3, { ctrlKey: true });           // Ctrl: + Delta
        const ctrl = state.selected.size;
        click(4, { shiftKey: true });          // Shift de la Delta la Epsilon
        const shift = state.selected.size;
        click(0, { shiftKey: true });          // Shift de la Delta (ancora) la Alfa: Alfa..Delta
        const shift2 = [...state.selected].sort().join(',');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
        const all = state.selected.size;
        const crumbsBelow = document.getElementById('crumbs').getBoundingClientRect().top >= document.querySelector('.bar').getBoundingClientRect().bottom - 1;
        const crumbText = document.getElementById('crumbs').innerText.replace(/\\s+/g, ' ');
        document.getElementById('btn-mkdir').click();
        const mkdirOpen = document.getElementById('mkdir-dlg').open;
        const mkdirActive = document.activeElement && document.activeElement.id;
        return { simple, ctrl, shift, shift2, all, crumbsBelow, crumbText, mkdirOpen, mkdirActive };
      })()`);
      // Testam scriere reala cu tastatura in New folder (inclusiv dupa un dialog de confirmare HTML)
      await new Promise((r) => setTimeout(r, 150));
      for (const ch of 'Docs2026') {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
        win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
      }
      await new Promise((r) => setTimeout(r, 150));
      const mkdirShot = await snap(win, 'nex-drive-mkdir.png');
      const out2 = await win.webContents.executeJavaScript(`(async () => {
        const mkdirTyped = document.getElementById('mkdir-name').value;
        document.getElementById('mkdir-dlg').close();
        const pConf = askConfirm('Test confirm message', { title: 'Confirm test', okLabel: 'Yes', danger: true });
        const confOpen = document.getElementById('confirm-dlg').open;
        document.getElementById('confirm-cancel').click();
        const confVal = await pConf;
        renderQueue({ now: Date.now(), pausedUntil: Date.now() + 23.5 * 3600e3, pauseReason: 'Daily upload limit reached', manualPaused: false, workers: 4,
          counts: { pending: 2, uploading: 1, done: 1, error: 1 }, bytesTotal: 9e9, bytesDone: 3.2e9,
          items: [{ id: 1, name: 'a.zip', rel: ['Backup 2026'], size: 5e9, offset: 3.2e9, state: 'uploading', error: '' }, { id: 2, name: 'rau.bin', rel: [], size: 10, offset: 0, state: 'error', error: 'File no longer exists' }] });
        renderDownloads({ counts: { pending: 4, downloading: 2, done: 7, error: 1, cancelled: 0 }, totalBytes: 2.4e9, speed: 31e6, active: true, items: [
          { id: 1, name: 'film-mare.zip', state: 'downloading', bytes: 700e6, size: 1.4e9, error: '' },
          { id: 2, name: 'Formular', state: 'error', bytes: 0, size: 0, error: 'Google type without export (Forms/Sites/Maps)' },
          { id: 3, name: 'x.pdf', state: 'done', bytes: 5e6, size: 5e6, error: '' } ] });
        showTab('dl');
        return { mkdirTyped, confOpen, confVal,
          workersValue: document.getElementById('q-workers').value, dlRows: document.querySelectorAll('#d-list li').length,
          dlStatus: document.getElementById('d-status').textContent, dlVisible: !document.getElementById('view-dl').hidden };
      })()`);
      Object.assign(out, out2, { mkdirShot });
      await new Promise((r) => setTimeout(r, 500));
      const file = await snap(win, 'nex-drive-ui.png');
      const tabsOut = await require('./ui-smoke-tabs')(win, snap);
      console.log('UI_SMOKE', JSON.stringify({ ...out, ...tabsOut, errors, screenshot: file }));
      const ok = out.simple === 1 && out.ctrl === 2 && out.shift === 2 && out.shift2 === 'f0,f1,f2,f3' && out.all === 5
        && out.crumbsBelow && /My Drive.*Backup 2026/.test(out.crumbText) && out.mkdirOpen && out.mkdirActive === 'mkdir-name'
        && out.mkdirTyped === 'Docs2026' && out.confOpen && out.confVal === false && out.workersValue === '4'
        && tabsOut.ok && out.dlRows === 3 && /MB\/s/.test(out.dlStatus) && out.dlVisible && errors.length === 0;
      console.log(ok ? 'UI_SMOKE_OK' : 'UI_SMOKE_FAIL');
      app.exit(ok ? 0 : 1);
    } catch (e) { console.log('UI_SMOKE_FAIL', e.message); app.exit(1); }
  });
};
