/* MAP
 * §1 jurnal de activitate in memorie  L6-L31
 */

// §1 jurnal de activitate in memorie: retine ultimele N evenimente (scanari, limite, erori, curatari) pentru panoul din UI
function createActivity({ max = 80, now = Date.now, onChange = () => {} } = {}) {
  const entries = [];
  let nextId = 1;

  function log(level, scope, text) {
    const item = { id: nextId++, at: now(), level: level || 'info', scope: scope || 'App', text: String(text || '') };
    entries.unshift(item);
    if (entries.length > max) entries.length = max;
    onChange(entries.slice());
    return item;
  }

  function clear() {
    entries.length = 0;
    onChange([]);
  }

  return { log, list: () => entries.slice(), clear };
}

module.exports = { createActivity };
