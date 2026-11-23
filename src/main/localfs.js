/* MAP
 * §1 discuri si listare foldere locale  L6-L52
 */

// §1 discuri si listare foldere locale (panoul „PC” din tabul Sync); doar citire
const fs = require('fs');
const os = require('os');
const path = require('path');

const STAT_BATCH = 64;

function roots() {
  const out = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      try { fs.accessSync(d); out.push({ name: d, path: d }); } catch (e) { /* unitate inexistenta sau fara medie */ }
    }
  } else out.push({ name: '/', path: '/' });
  out.push({ name: 'Home', path: os.homedir() });
  return out;
}

async function list(dir) {
  const p = path.resolve(dir);
  const raw = await fs.promises.readdir(p, { withFileTypes: true });
  const entries = [];
  for (let i = 0; i < raw.length; i += STAT_BATCH) {
    await Promise.all(raw.slice(i, i + STAT_BATCH).map(async (e) => {
      if (!e.isDirectory() && !e.isFile()) return; // symlink-urile nu se sincronizeaza
      try {
        const st = await fs.promises.stat(path.join(p, e.name));
        entries.push({ name: e.name, path: path.join(p, e.name), isDir: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, mtimeMs: st.mtimeMs });
      } catch (err) { /* ilizibil: nu apare in lista */ }
    }));
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
  const parent = path.dirname(p);
  return { path: p, parent: parent === p ? '' : parent, entries };
}

module.exports = { roots, list };
