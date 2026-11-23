/* MAP
 * §1 setari aplicatie  L6-L44
 */

// §1 setari aplicatie: inchidere in tray, pornire cu Windows, tema light/dark, reluare automata dupa limite Google
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const THEMES = new Set(['system', 'light', 'dark']);
const DEFAULTS = { closeToTray: true, openAtLogin: false, limitAutoRetry: true, limitRetryMinutes: cfg.LIMIT_RETRY_MINUTES, theme: 'system' };
const clampMins = (v) => Math.min(Math.max(Math.round(Number(v)) || cfg.LIMIT_RETRY_MINUTES, 5), 1440);

function normalize(raw) {
  return {
    closeToTray: raw.closeToTray !== undefined ? !!raw.closeToTray : DEFAULTS.closeToTray,
    openAtLogin: raw.openAtLogin !== undefined ? !!raw.openAtLogin : DEFAULTS.openAtLogin,
    limitAutoRetry: raw.limitAutoRetry !== undefined ? !!raw.limitAutoRetry : DEFAULTS.limitAutoRetry,
    limitRetryMinutes: raw.limitRetryMinutes !== undefined ? clampMins(raw.limitRetryMinutes) : DEFAULTS.limitRetryMinutes,
    theme: THEMES.has(raw.theme) ? raw.theme : DEFAULTS.theme,
  };
}

function createSettings({ dataDir, app, nativeTheme = null }) {
  const file = path.join(dataDir, 'settings.json');
  let cur = { ...DEFAULTS };
  try { cur = normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* prima pornire: implicite */ }

  function apply() {
    if (app && app.isPackaged) app.setLoginItemSettings({ openAtLogin: cur.openAtLogin, args: ['--hidden'] }); // doar in aplicatia instalata, nu la dezvoltare
    if (nativeTheme) nativeTheme.themeSource = cur.theme;
  }

  function set(patch) {
    cur = normalize({ ...cur, ...patch });
    fs.writeFileSync(file, JSON.stringify(cur));
    apply();
    return { ...cur };
  }

  return { get: () => ({ ...cur }), set, apply };
}

module.exports = { createSettings };
