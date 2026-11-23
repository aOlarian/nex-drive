/* MAP
 * §1 helpers DOM si iconite vectoriale  L6-L42
 * §2 formatare, confirmare HTML si stare comuna  L43-L128
 */

// §1 helpers DOM si iconite vectoriale (fara innerHTML: numele de fisiere nu se interpreteaza niciodata ca HTML)
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l1.8 2h9A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z',
  folderOpen: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5V10H5.2L3 18zM5.2 10H21l-2.1 7.8a1.5 1.5 0 0 1-1.45 1.2H3.5z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
};

function svgIcon(name) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ico-svg');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.file);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linejoin', 'round');
  p.setAttribute('stroke-linecap', 'round');
  s.append(p);
  return s;
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n[k] = v;
  }
  for (const kid of kids) n.append(kid);
  return n;
}

// §2 formatare si stare comuna
function fmtSize(b) {
  const n = Number(b);
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function fmtSpeed(bps) { return bps > 0 ? `${fmtSize(bps)}/s` : ''; }
function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${m % 60} min` : `${m} min`;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function existsPolicy() {
  const s = $('on-exists');
  if (!s.dataset.init) { s.dataset.init = '1'; s.value = localStorage.getItem('onExists') || 'skip'; s.addEventListener('change', () => localStorage.setItem('onExists', s.value)); }
  return s.value;
}

async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return undefined; }
}

function fmtDate(v) {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d.toLocaleString('en-GB') : '';
}

function fmtTime(v) {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString('en-GB') : '';
}

// Checkbox cu eticheta; textul intra ca text, nu ca HTML
function checkLabel(text, checked, title = '') {
  const box = el('input', { type: 'checkbox', checked });
  return { box, label: el('label', { class: 'chkl', title }, box, ` ${text}`) };
}

const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

// Dialog HTML de confirmare: inlocuieste window.confirm() care blocheaza focusul inputurilor in Electron pe Windows
function askConfirm(message, { title = 'Confirm', okLabel = 'Continue', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $('confirm-dlg');
    const okBtn = $('confirm-ok');
    const cancelBtn = $('confirm-cancel');
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent = message;
    okBtn.textContent = okLabel;
    okBtn.className = danger ? 'danger' : 'primary';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onOk = () => finish(true);
    const onCancel = (e) => { if (e && e.preventDefault) e.preventDefault(); finish(false); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    if (!dlg.open) dlg.showModal();
    okBtn.focus();
  });
}
