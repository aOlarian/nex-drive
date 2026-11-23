/* MAP
 * §1 sanitizare URL si rezumat  L7-L38
 * §2 logger JSONL persistent cu rotatie  L39-L96
 */

// §1 sanitizare URL si rezumat: pastram metoda + calea fara tokenuri/upload_id din query
const fs = require('fs');
const path = require('path');

function sanitizeOp(method, urlInput) {
  const m = String(method || 'REQ').toUpperCase();
  try {
    const u = urlInput instanceof URL ? urlInput : new URL(String(urlInput));
    const ut = u.searchParams.get('uploadType');
    if (/^\/upload\//.test(u.pathname) && u.searchParams.has('upload_id')) return `${m} ${u.pathname} (session)`;
    return `${m} ${u.pathname}${ut ? `?uploadType=${ut}` : ''}`;
  } catch (e) {
    return `${m} ${String(urlInput || '').split('?')[0].slice(0, 120)}`;
  }
}

function keyOf(e) {
  const st = e.status ? `HTTP ${e.status}` : 'NET';
  return `${st} ${e.reason || 'error'}`;
}

function loadExisting(file) {
  const counts = new Map();
  let total = 0;
  const recent = [];
  if (!fs.existsSync(file)) return { counts, total, recent };
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch (err) { continue; }
      total++;
      const k = keyOf(e);
      const cur = counts.get(k) || { key: k, count: 0, lastAt: 0 };
      cur.count++;
      cur.lastAt = Math.max(cur.lastAt, Number(e.ts) || 0);
      counts.set(k, cur);
      recent.push(e);
      if (recent.length > 50) recent.shift();
    }
  } catch (e) { /* fisier indisponibil la citire initiala */ }
  return { counts, total, recent };
}

// §2 logger JSONL persistent cu rotatie: inregistreaza orice eroare primita de la Google (fara body brut sau secrete)
function createErrorLog({ dataDir, cfg = {}, now = Date.now, onEntry = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'google-errors.jsonl');
  const prevFile = path.join(dataDir, 'google-errors.prev.jsonl');
  const maxBytes = cfg.ERROR_LOG_MAX_BYTES || 5 * 1024 * 1024;
  let state = loadExisting(file);

  function rotateIfNeeded() {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
        fs.rmSync(prevFile, { force: true });
        fs.renameSync(file, prevFile);
      }
    } catch (e) { /* rotatie amanata daca fisierul e ocupat */ }
  }

  function record(raw) {
    const ts = now();
    const entry = {
      at: new Date(ts).toISOString(),
      ts,
      op: String(raw.op || '').slice(0, 160),
      status: Number(raw.status) || 0,
      reason: String(raw.reason || '').slice(0, 80),
      domain: String(raw.domain || '').slice(0, 60),
      message: String(raw.message || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      retryAfter: raw.retryAfter ? String(raw.retryAfter).slice(0, 40) : '',
      context: raw.context ? String(raw.context).slice(0, 200) : '',
    };
    try {
      rotateIfNeeded();
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (e) { /* nu blocam uploadul daca discul refuza scrierea logului */ }
    state.total++;
    const k = keyOf(entry);
    const cur = state.counts.get(k) || { key: k, count: 0, lastAt: 0 };
    cur.count++;
    cur.lastAt = ts;
    state.counts.set(k, cur);
    state.recent.push(entry);
    if (state.recent.length > 50) state.recent.shift();
    if (onEntry) onEntry(entry);
    return entry;
  }

  function summary() {
    const counts = [...state.counts.values()].sort((a, b) => b.count - a.count);
    return { file, exists: fs.existsSync(file), total: state.total, counts, recent: state.recent.slice().reverse() };
  }

  function clear() {
    try { fs.rmSync(file, { force: true }); } catch (e) { /* optional */ }
    state = { counts: new Map(), total: 0, recent: [] };
  }

  return { file, record, summary, clear };
}

module.exports = { createErrorLog, sanitizeOp };
