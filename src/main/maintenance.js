/* MAP
 * §1 imports si stare  L8-L39
 * §2 reguli (validare, salvare)  L40-L75
 * §3 scanare (preview)  L76-L121
 * §4 rulare si tick  L122-L168
 */

// §1 imports si stare
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const schedule = require('./schedule');

const DAY_MS = 86400000;

function createMaintenance({ dataDir, now = Date.now, trash, isSynced, onChange = () => {} }) {
  const file = path.join(dataDir, 'maintenance.json');
  fs.mkdirSync(dataDir, { recursive: true });

  function load() {
    try {
      const st = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!st || !Array.isArray(st.rules)) throw new Error('bad shape');
      return st;
    } catch (e) {
      if (e.code !== 'ENOENT') fs.copyFileSync(file, `${file}.corupt-${now()}`); // nu pierdem tacut reguli ilizibile
      return { rules: [] };
    }
  }
  const st = load();

  function persist() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, file);
  }

  const find = (id) => st.rules.find((r) => r.id === id);

  // §2 reguli (validare, salvare)
  const list = () => st.rules.map((r) => ({ ...r }));

  function save(input) {
    const prev = input.id ? find(input.id) : null;
    const rule = { enabled: true, onlySynced: true, lastRunAt: 0, lastResult: null, ...(prev || {}), ...input };
    if (typeof rule.path !== 'string' || !path.isAbsolute(rule.path)) throw new Error('Folder path must be absolute');
    if (path.parse(rule.path).root === path.resolve(rule.path)) throw new Error('A drive root cannot be a cleanup folder');
    let stat;
    try { stat = fs.statSync(rule.path); } catch { throw new Error('Folder does not exist'); }
    if (!stat.isDirectory()) throw new Error('Path is not a folder');
    const days = Number(rule.days);
    if (!Number.isInteger(days) || days < 1 || days > 36500) throw new Error('Days must be a whole number between 1 and 36500');
    if (!['recycle', 'delete'].includes(rule.action)) throw new Error('Action must be recycle or delete');
    rule.days = days;
    rule.onlySynced = !!rule.onlySynced;
    rule.enabled = !!rule.enabled;
    rule.schedule = schedule.normalize(rule.schedule);
    rule.id = rule.id || crypto.randomBytes(6).toString('hex');
    rule.lastRunAt = Number(rule.lastRunAt) || 0;
    rule.nextRunAt = schedule.nextRun(rule.schedule, rule.lastRunAt, now());
    if (prev) Object.assign(prev, rule); else st.rules.push(rule);
    persist();
    onChange(list());
    return { ...rule };
  }

  function remove(id) {
    const i = st.rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    st.rules.splice(i, 1);
    persist();
    onChange(list());
    return true;
  }

  // §3 scanare (preview)
  // Intoarce { whole, self, entries, newest, count, size }. whole = tot subarborele poate fi sters ca un singur element (self);
  // altfel entries = elementele eligibile din interior. Orice eroare de citire face ramura "nu e veche": nu se sterge nimic din ea.
  async function scanNode(full, rule, cutoff, acc, isRoot) {
    const bad = { whole: false, entries: [] };
    let stat;
    try { stat = await fs.promises.lstat(full); } catch (e) { acc.errors.push(`${full}: ${e.code || e.message}`); return bad; }
    if (!stat.isDirectory()) { // symlink-urile raman fisiere (lstat): nu coboram in afara radacinii
      const old = stat.mtimeMs < cutoff;
      const synced = !rule.onlySynced || !old || isSynced(full, stat.size, stat.mtimeMs);
      if (old && !synced) acc.skippedUnsynced++;
      const self = { path: full, kind: 'file', size: stat.size, fileCount: 1, newestMtime: stat.mtimeMs };
      return { whole: old && synced, self, entries: [], newest: stat.mtimeMs, count: 1, size: stat.size };
    }
    let names;
    try { names = await fs.promises.readdir(full); } catch (e) { acc.errors.push(`${full}: ${e.code || e.message}`); return bad; }
    let whole = true;
    let newest = 0;
    let count = 0;
    let size = 0;
    const entries = [];
    for (const name of names) {
      const c = await scanNode(path.join(full, name), rule, cutoff, acc, false);
      if (c.whole) entries.push(c.self); else { whole = false; entries.push(...c.entries); }
      if (c.newest !== undefined) { newest = Math.max(newest, c.newest); count += c.count; size += c.size; }
      else newest = Infinity; // ramura ilizibila: nu o putem declara veche
    }
    if (names.length === 0) { newest = stat.mtimeMs; whole = stat.mtimeMs < cutoff; } // folder gol: conteaza propriul mtime
    if (isRoot) return { whole: false, entries };
    const self = { path: full, kind: 'folder', size, fileCount: count, newestMtime: newest };
    return { whole, self, entries: whole ? [] : entries, newest, count, size };
  }

  async function preview(id) {
    const rule = find(id);
    if (!rule) throw new Error('Rule not found');
    const cutoff = now() - rule.days * DAY_MS;
    const acc = { errors: [], skippedUnsynced: 0 };
    const res = await scanNode(rule.path, rule, cutoff, acc, true);
    const entries = res.entries;
    return {
      entries, totalBytes: entries.reduce((s, e) => s + e.size, 0), totalCount: entries.length,
      skippedUnsynced: acc.skippedUnsynced, errors: acc.errors,
    };
  }

  // §4 rulare si tick
  async function stillOld(entry, rule, cutoff) {
    const acc = { errors: [], skippedUnsynced: 0 };
    const r = await scanNode(entry.path, rule, cutoff, acc, false);
    return r.whole === true && acc.errors.length === 0;
  }

  async function run(id, { only } = {}) {
    const rule = find(id);
    if (!rule) throw new Error('Rule not found');
    const cutoff = now() - rule.days * DAY_MS;
    const pv = await preview(id); // preview proaspat: cel afisat in UI poate fi depasit
    const pick = only ? new Set(only) : null;
    const result = { removed: 0, bytes: 0, skipped: 0, failed: [] };
    for (const e of pv.entries) {
      if (pick && !pick.has(e.path)) continue;
      if (!(await stillOld(e, rule, cutoff))) { result.skipped++; continue; } // modificat intre preview si run
      try {
        if (rule.action === 'recycle') await trash(e.path);
        else await fs.promises.rm(e.path, { recursive: true, force: true });
        result.removed++;
        result.bytes += e.size;
      } catch (err) {
        result.failed.push({ path: e.path, error: err.message });
      }
    }
    rule.lastResult = result;
    rule.lastRunAt = now();
    rule.nextRunAt = schedule.nextRun(rule.schedule, rule.lastRunAt, now());
    persist();
    onChange(list());
    return result;
  }

  async function tick() {
    const due = st.rules.filter((r) => r.enabled && r.schedule.type !== 'manual' && r.nextRunAt > 0 && r.nextRunAt <= now());
    let ran = 0;
    for (const r of due) { // secvential: doua curatari pe acelasi disc in paralel se calca
      try { await run(r.id); ran++; } catch (e) { r.lastResult = { removed: 0, bytes: 0, skipped: 0, failed: [{ path: r.path, error: e.message }] }; persist(); }
    }
    return ran;
  }

  return { list, save, remove, preview, run, tick };
}

module.exports = { createMaintenance };
