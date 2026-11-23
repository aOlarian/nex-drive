/* MAP
 * §1 clasificare erori upload  L8-L39
 * §2 telemetrie (viteza, conexiuni, throttle)  L40-L96
 * §3 protectie rate-limit pe valuri + contor 24h  L97-L178
 * §4 cache foldere si copii  L179-L232
 * §5 prioritate navigare interactiva  L233-L264
 */

// §1 clasificare erori upload
const { DriveError } = require('./drive');

class PauseSignal extends Error {
  constructor(reason, waitMs = 0) {
    super(reason);
    this.name = 'PauseSignal';
    this.reason = reason;
    this.waitMs = waitMs;
  }
}

const HARD_QUOTA = /dailyLimitExceeded|storageQuotaExceeded|quotaExceeded/i;
const RATE = /rateLimitExceeded|userRateLimitExceeded/i;
const NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function classify(e) {
  if (e instanceof PauseSignal) return 'pause';
  if (e instanceof DriveError) {
    if (e.reason === 'sessionGone') return 'session';
    if (e.status === 401) return 'auth';
    if ((e.status === 403 || e.status === 429) && (HARD_QUOTA.test(e.reason) || RATE.test(e.reason))) return 'quota';
    if (e.status === 429) return 'quota';
    if (e.status >= 500) return 'transient';
    return 'fatal';
  }
  const code = e && (e.code || (e.cause && e.cause.code));
  if (code === 'not_logged_in' || code === 'invalid_grant') return 'auth';
  if (NET_CODES.has(code) || (e instanceof TypeError && /fetch failed/.test(e.message))) return 'transient';
  return 'fatal';
}

// §2 telemetrie (viteza pe 5s, workeri activi, backoff si throttle leading+trailing)
function createTelemetry({ now, cfg, jobName, onEmit }) {
  const samples = [];
  const activeMap = new Map();
  let retryInfo = null;
  let lastEmit = 0;
  let emitTimer = null;

  function recordBytes(b) {
    const t = now();
    samples.push({ t, b });
    while (samples.length && t - samples[0].t > 5000) samples.shift();
  }

  function speed(activeCount) {
    const t = now();
    while (samples.length && t - samples[0].t > 5000) samples.shift();
    if (!samples.length || activeCount === 0) return 0;
    const total = samples.reduce((s, x) => s + x.b, 0);
    return (total * 1000) / Math.max(1000, t - samples[0].t);
  }

  function flushEmit() {
    clearTimeout(emitTimer);
    emitTimer = null;
    lastEmit = Date.now();
    onEmit();
  }

  function emit(immediate) {
    if (immediate) return flushEmit();
    const wait = (cfg.UI_PUSH_MS || 400) - (Date.now() - lastEmit);
    if (wait <= 0) return flushEmit();
    if (!emitTimer) {
      emitTimer = setTimeout(flushEmit, wait);
      if (emitTimer.unref) emitTimer.unref();
    }
  }

  function busyOwners(excludeJobId) {
    const out = [];
    for (const a of activeMap.values()) {
      if (a.syncJob === excludeJobId) continue;
      const lbl = a.syncJob ? (jobName(a.syncJob) || `Job #${a.syncJob}`) : 'manual upload';
      if (!out.includes(lbl)) out.push(lbl);
    }
    return out;
  }

  const activeItems = () => [...activeMap.values()].map((a) => ({ ...a, syncJobName: a.syncJob ? jobName(a.syncJob) : 'Manual upload' }));
  const setPhase = (id, phase) => { const cur = activeMap.get(id); if (cur) cur.phase = phase; };
  const setRetry = (info) => { retryInfo = info; };
  const getRetry = () => retryInfo;

  return { activeMap, recordBytes, speed, emit, busyOwners, activeItems, setPhase, setRetry, getRetry };
}

// §3 protectie rate-limit pe valuri + contor 24h (evita pauza falsa cand N workeri lovesc aceeasi rafala)
function createRateGuard({ cfg, now = Date.now, getSettings = null }) {
  let streak = 0;
  let waveUntil = 0;
  let okCount = 0;
  const buckets = new Map(); // hourEpoch -> bytes uploaded

  function prune(t) {
    const cut = Math.floor(t / 3600000) - 24;
    for (const h of buckets.keys()) if (h <= cut) buckets.delete(h);
  }

  function addUploaded(bytes) {
    if (!bytes) return;
    const t = now();
    prune(t);
    const h = Math.floor(t / 3600000);
    buckets.set(h, (buckets.get(h) || 0) + bytes);
  }

  function uploaded24h() {
    prune(now());
    let total = 0;
    for (const b of buckets.values()) total += b;
    return total;
  }

  function pauseDuration() {
    const s = getSettings ? getSettings() : null;
    if (s && s.limitAutoRetry === false) return cfg.PAUSE_MS;
    if (s && Number(s.limitRetryMinutes) > 0) return Number(s.limitRetryMinutes) * 60 * 1000;
    if (cfg.LIMIT_RETRY_MINUTES === 0) return cfg.PAUSE_MS;
    return (cfg.LIMIT_RETRY_MINUTES || 60) * 60 * 1000;
  }

  function effectiveWorkers(configured) {
    if (streak <= 0) return configured;
    if (streak === 1) return Math.max(1, Math.floor(configured / 2));
    return 1;
  }

  function onSuccess() {
    if (streak > 0 && ++okCount >= (cfg.RATE_RECOVER_OK || 5)) {
      streak = 0;
      waveUntil = 0;
      okCount = 0;
      return true;
    }
    return false;
  }

  function onRateError(e) {
    okCount = 0;
    const reasonStr = (e && e.reason) || '';
    if (/storage/i.test(reasonStr)) return { pause: true, reason: 'Drive storage is full', waitMs: pauseDuration() };
    if (HARD_QUOTA.test(reasonStr)) return { pause: true, reason: 'Daily upload limit reached (750 GB/day)', waitMs: pauseDuration() };
    const t = now();
    const maxWaves = cfg.RATE_PAUSE_WAVES || 6;
    const jitterMax = Math.min(Math.round((cfg.RETRY_BASE_MS || 2000) * 0.25), 500);
    const jitter = jitterMax > 0 ? Math.floor(Math.random() * jitterMax) : 0;
    if (t < waveUntil) {
      return { pause: false, sameWave: true, wave: streak, max: maxWaves, waitMs: Math.max(1, waveUntil - t) + jitter };
    }
    streak++;
    if (streak >= maxWaves) {
      streak = 0;
      waveUntil = 0;
      const daily = uploaded24h() >= (cfg.DAILY_QUOTA_BYTES || 700 * 1024 ** 3);
      const reason = daily ? 'Daily upload limit reached (750 GB/day)' : `Google Drive rate limit (HTTP ${(e && e.status) || 429} ${reasonStr || 'rateLimit'})`;
      return { pause: true, reason, waitMs: pauseDuration() };
    }
    const exp = (cfg.RETRY_BASE_MS || 2000) * 2 ** (streak - 1);
    const baseWait = Math.min(cfg.RATE_BACKOFF_MAX_MS || 64000, Math.max(exp, (e && e.retryAfterMs) || 0));
    waveUntil = t + baseWait;
    return { pause: false, sameWave: false, wave: streak, max: maxWaves, waitMs: baseWait + jitter };
  }

  function reset() { streak = 0; waveUntil = 0; okCount = 0; }

  return { addUploaded, uploaded24h, pauseDuration, effectiveWorkers, onSuccess, onRateError, reset };
}

// §4 cache foldere si copii (evita mii de cereri findChild pe foldere deja cunoscute sau nou create)
function createFolderCache({ drive, cfg, now, withRetry }) {
  const folderCache = new Map(); // "parent|a/b" -> Promise<folderId>
  const childCache = new Map();  // folderId -> { at, promise: Promise<Map<name, {id,size}>> }
  const CHILD_TTL_MS = 10 * 60 * 1000;

  function putChildren(folderId, promise) {
    childCache.delete(folderId);
    childCache.set(folderId, { at: now(), promise });
    const max = cfg.CHILD_CACHE_MAX || 500;
    while (childCache.size > max) childCache.delete(childCache.keys().next().value);
    promise.catch(() => childCache.delete(folderId));
  }

  function getChildren(folderId, it) {
    const cur = childCache.get(folderId);
    if (cur && now() - cur.at < CHILD_TTL_MS) { childCache.delete(folderId); childCache.set(folderId, cur); return cur.promise; }
    const p = withRetry(() => (drive.listFiles ? drive.listFiles(folderId) : drive.listAll(folderId)), it).then((list) => {
      const m = new Map();
      for (const f of list) if (f.mimeType !== 'application/vnd.google-apps.folder') m.set(f.name, { id: f.id, size: Number(f.size || 0) });
      return m;
    });
    putChildren(folderId, p);
    return p;
  }

  function resolveParent(it) {
    let parent = Promise.resolve(it.rootParent);
    const trail = [];
    for (const seg of it.rel) {
      trail.push(seg);
      const key = `${it.rootParent}|${trail.join('/')}`;
      const prev = parent;
      if (!folderCache.has(key)) {
        folderCache.set(key, prev.then(async (pid) => {
          const r = drive.ensureFolderEx ? await drive.ensureFolderEx(pid, seg) : { id: await drive.ensureFolder(pid, seg), created: false };
          if (r.created) putChildren(r.id, Promise.resolve(new Map())); // folder nou = 0 apeluri list/findChild
          return r.id;
        }));
      }
      parent = folderCache.get(key);
      parent.catch(() => folderCache.delete(key));
    }
    return parent;
  }

  function remember(parentId, name, id, size) {
    const cur = childCache.get(parentId);
    if (cur) cur.promise.then((m) => m.set(name, { id, size })).catch(() => { /* cache optional */ });
  }

  return { getChildren, resolveParent, remember };
}

// §5 prioritate navigare interactiva: cedeaza scurt pornirea de bucati noi cat timp userul navigheaza in Drive
function createInteractiveGate({ maxWaitMs = 3000 } = {}) {
  let depth = 0;
  let safety = null;
  let waiters = [];

  function flush() {
    clearTimeout(safety);
    safety = null;
    const list = waiters;
    waiters = [];
    for (const r of list) r();
  }

  function begin() {
    depth++;
    clearTimeout(safety);
    safety = setTimeout(() => { depth = 0; flush(); }, maxWaitMs);
    if (safety.unref) safety.unref();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      depth = Math.max(0, depth - 1);
      if (depth === 0) flush();
    };
  }

  function wait() {
    if (depth === 0) return Promise.resolve();
    return new Promise((r) => waiters.push(r));
  }

  return { begin, wait, active: () => depth > 0 };
}

module.exports = { PauseSignal, HARD_QUOTA, classify, createTelemetry, createRateGuard, createFolderCache, createInteractiveGate };
