/* MAP
 * §1 scanare in worker thread cu tabela compacta de foldere  L7-L82
 */

// §1 scanare in worker thread: trimite o tabela compacta `dirs` + [dirIdx, name, size, mtimeMs] (5x mai putina memorie la 700k fisiere)
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const { sources, statBatch = 64, progressMs = 250 } = workerData;
const dirs = [];  // [fullDir, relDirs]
const files = []; // [dirIdx, name, size, mtimeMs]
const unreadable = [];
const errors = [];
const roots = [];
let lastReport = 0;
let currentDir = '';

function report(force) {
  const t = Date.now();
  if (!force && t - lastReport < progressMs) return;
  lastReport = t;
  parentPort.postMessage({ type: 'progress', scanned: files.length, dirs: dirs.length, currentDir });
}

async function scanDir(dir, relDirs) {
  const dirIdx = dirs.length;
  dirs.push([dir, relDirs]);
  currentDir = dir;
  report(false);
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { unreadable.push(dir); return; }
  const subdirs = [];
  const localFiles = [];
  for (const e of entries) {
    if (e.isDirectory()) subdirs.push({ full: path.join(dir, e.name), name: e.name });
    else if (e.isFile()) localFiles.push(e.name);
  }
  for (let i = 0; i < localFiles.length; i += statBatch) {
    await Promise.all(localFiles.slice(i, i + statBatch).map(async (name) => {
      const full = path.join(dir, name);
      try {
        const st = await fs.promises.stat(full);
        files.push([dirIdx, name, st.size, st.mtimeMs]);
      } catch (e) { unreadable.push(full); }
    }));
    report(false);
  }
  for (const sub of subdirs) {
    await scanDir(sub.full, [...relDirs, sub.name]);
  }
}

async function expandSources() {
  const items = [];
  for (const s of sources) {
    if (s.mode !== 'children') { items.push(s.path); continue; }
    try {
      const skip = new Set((s.exclude || []).map((n) => n.toLowerCase()));
      for (const e of await fs.promises.readdir(s.path, { withFileTypes: true })) {
        if ((e.isDirectory() || e.isFile()) && !skip.has(e.name.toLowerCase())) items.push(path.join(s.path, e.name));
      }
    } catch (e) {
      errors.push(`Source unavailable: ${s.path} (${e.code || e.message})`);
      unreadable.push(s.path);
    }
  }
  return items;
}

(async () => {
  for (const p of await expandSources()) {
    let st;
    try { st = await fs.promises.stat(p); } catch (e) {
      errors.push(`Source unavailable: ${p} (${e.code || e.message})`);
      unreadable.push(p);
      continue;
    }
    roots.push(p);
    if (st.isDirectory()) await scanDir(p, [path.basename(p)]);
    else {
      const dirIdx = dirs.length;
      dirs.push([path.dirname(p), []]);
      files.push([dirIdx, path.basename(p), st.size, st.mtimeMs]);
    }
  }
  report(true);
  parentPort.postMessage({ type: 'done', dirs, files, unreadable, errors, roots });
})().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message || String(err) });
});
