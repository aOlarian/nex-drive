/* MAP
 * §1 setup si helpers  L6-L39
 * §2 scenariu cap-coada  L40-L144
 */

// §1 setup si helpers
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startMock } = require('./mock-drive');
const { createDrive } = require('../src/main/drive');
const { createUploader } = require('../src/main/uploader');
const { createRateGuard, createInteractiveGate } = require('../src/main/upload-telemetry');
const { createSettings } = require('../src/main/settings');
const { createErrorLog } = require('../src/main/error-log');
const { createDownloader } = require('../src/main/downloader');

const MiB = 1024 * 1024;
const H = 3600 * 1000;
const real = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function waitFor(cond, what, ms = 15000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await real(25);
  }
}

function makeUploader(base, dataDir, clock, extraCfg = {}, opts = {}) {
  const cfg = {
    ...require('../src/main/config'),
    CHUNK_BYTES: 1 * MiB, WORKERS: 2, PAUSE_MS: 24 * H, LIMIT_RETRY_MINUTES: 0, RATE_PAUSE_WAVES: 3, DAILY_QUOTA_BYTES: 3 * MiB, NET_RETRIES: 2, RETRY_BASE_MS: 1, SAVE_DEBOUNCE_MS: 20,
    ...extraCfg,
  };
  const sleep = (ms) => { clock.t += Math.min(ms, 5); return real(Math.min(ms, 3)); };
  const drive = createDrive({ getToken: async () => 'tok', base, sleep, retryBase: 1, onError: opts.onError || null });
  return createUploader({ drive, dataDir, cfg, now: () => clock.t, sleep, getSettings: opts.getSettings || null });
}

// §2 scenariu cap-coada
(async () => {
  const mock = await startMock();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'nxd-src-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nxd-data-'));
  fs.mkdirSync(path.join(src, 'proj', 'sub'), { recursive: true });
  const files = { 'proj/a.bin': 3 * MiB + 17, 'proj/sub/c.bin': 3 * MiB, 'proj/empty.txt': 0 };
  const hashes = {};
  for (const [rel, size] of Object.entries(files)) {
    const buf = crypto.randomBytes(size);
    fs.writeFileSync(path.join(src, rel), buf);
    hashes[path.basename(rel)] = sha(buf);
  }
  const clock = { t: Date.parse('2026-11-20T10:00:00Z') };
  const t0 = clock.t;

  // 1) Limita zilnica: Drive accepta doar ~4 MiB, apoi 403 userRateLimitExceeded
  mock.state.budget = 4 * MiB;
  let up = makeUploader(mock.base, data, clock);
  await up.add([path.join(src, 'proj')], 'ROOT');
  await waitFor(() => up.snapshot().pausedUntil > 0, 'pauza la limita');
  await waitFor(() => up.idle(), 'workeri opriti');
  let snap = up.snapshot();
  assert.ok(snap.pausedUntil >= t0 + 24 * H && snap.pausedUntil <= t0 + 24 * H + 1000, 'pauza = +24h reale');
  assert.ok(/750 GB\/day/.test(snap.pauseReason), `motiv 750GB: ${snap.pauseReason}`);
  assert.ok(snap.counts.pending > 0 && snap.bytesDone > 0, 'coada pastreaza restul si progresul');
  const pausedPuts = mock.state.putCalls;
  console.log('OK limita: pauza pana la', new Date(snap.pausedUntil).toISOString(), '| gata', snap.counts.done, 'in asteptare', snap.counts.pending);

  // 2) "Somn": PC repornit dupa 23h => aplicatie noua, coada incarcata de pe disc, tot in pauza, zero trafic
  clock.t = t0 + 23 * H;
  up = makeUploader(mock.base, data, clock);
  up.start();
  await real(100);
  assert.strictEqual(mock.state.putCalls, pausedPuts, 'la 23h nu se urca nimic');
  assert.ok(up.snapshot().pausedUntil > 0, 'inca in pauza la 23h');

  // 3) La 24h+1min reia singura, de unde a ramas (offset din sesiune), fara fisiere refacute
  clock.t = t0 + 24 * H + 60 * 1000;
  mock.state.budget = Infinity;
  up.tick();
  await waitFor(() => up.snapshot().counts.done === 3, 'toate gata dupa reluare');
  snap = up.snapshot();
  assert.strictEqual(snap.pausedUntil, 0);
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  assert.ok(mock.state.putBytes <= total + 2 * MiB, `fara retrimitere masiva: ${mock.state.putBytes} vs ${total}`);

  // 4) Continutul din "Drive" identic (hash), structura corecta, un singur folder "proj"
  const stored = [...mock.state.files.values()].filter((f) => f.data);
  for (const f of stored) assert.strictEqual(sha(f.data), hashes[f.name], `hash ${f.name}`);
  assert.strictEqual(stored.length, 2);
  const folders = [...mock.state.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
  assert.deepStrictEqual(folders.map((f) => f.name).sort(), ['proj', 'sub']);
  const empty = [...mock.state.files.values()].find((f) => f.name === 'empty.txt');
  assert.ok(empty, 'fisierul gol creat');
  console.log('OK reluare + hash-uri + structura; trimis', mock.state.putBytes, 'din', total);

  // 5) Re-adaugare a acelorasi cai nu dubleaza nimic dupa terminare (dedupe pe Drive)
  const before = mock.state.files.size;
  await up.add([path.join(src, 'proj')], 'ROOT');
  await waitFor(() => up.snapshot().counts.done === 6 && up.idle(), 'readaugare');
  assert.strictEqual(mock.state.files.size, before, 'nu s-au creat duplicate');

  // 6) Stergerea cozilor
  assert.strictEqual(up.clear('done') >= 3, true);
  assert.strictEqual(up.snapshot().items.length, 0);
  await up.add([path.join(src, 'proj', 'a.bin')], 'ROOT2');
  up.pause();
  assert.ok(up.clear('all') >= 0);
  assert.strictEqual(up.snapshot().items.length, 0, 'coada golita');

  // 7) Descarcari: folder cu fisier normal, Google Doc (export), formular (fara export) si scurtatura; eroarea NU opreste restul
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'nxd-dl-'));
  const GA = 'application/vnd.google-apps.';
  const put = (id, name, mimeType, parents, data) => mock.state.files.set(id, { id, name, mimeType, parents, size: data ? String(data.length) : undefined, trashed: false, data });
  put('D1', 'Arhiva', GA + 'folder', ['ROOT']);
  put('D2', 'raport.txt', 'text/plain', ['D1'], Buffer.from('salut drive'));
  put('D3', 'Document Google', GA + 'document', ['D1']);
  put('D4', 'Formular', GA + 'form', ['D1']);
  put('D5', 'Scurtatura', GA + 'shortcut', ['D1']);
  put('D6', 'raport.txt', 'text/plain', ['D1'], Buffer.from('al doilea, acelasi nume'));
  const cfgDl = { ...require('../src/main/config'), DL_WORKERS: 2, NET_RETRIES: 1, RETRY_BASE_MS: 1 };
  const snaps = [];
  const dl = createDownloader({ drive: createDrive({ getToken: async () => 'tok', base: mock.base, sleep: (ms) => real(Math.min(ms, 3)), retryBase: 1 }), cfg: cfgDl, sleep: (ms) => real(Math.min(ms, 3)), onChange: (x) => snaps.push(x) });
  dl.add([{ id: 'D1', name: 'Arhiva', mimeType: GA + 'folder' }], dest);
  await waitFor(() => { const c = dl.snapshot().counts; return dl.idle() && c.pending === 0 && c.downloading === 0 && c.done + c.error >= 5; }, 'descarcari terminate');
  const ds = dl.snapshot();
  assert.strictEqual(ds.counts.done, 3, 'raport x2 + Doc exportat');
  assert.strictEqual(ds.counts.error, 2, 'formular + scurtatura raportate, nu opresc restul');
  assert.ok(ds.items.filter((i) => i.state === 'error').every((i) => i.error.length > 5), 'eroarea are motiv');
  const folder = path.join(dest, 'Arhiva');
  assert.deepStrictEqual(fs.readdirSync(folder).sort(), ['Document Google.docx', 'raport-1.txt', 'raport.txt']);
  assert.strictEqual(fs.readFileSync(path.join(folder, 'Document Google.docx'), 'utf8'), 'EXPORT:Document Google');
  assert.ok(ds.totalBytes > 0 && snaps.length > 0, 'progres raportat');
  assert.strictEqual(fs.readdirSync(folder).some((n) => n.endsWith('.part')), false, 'fara .part ramase');
  console.log('OK descarcari: 3 gata, 2 erori raportate cu motiv, fisierul Google exportat');

  // 7b) Politica la fisier existent: skip / replace / rename (upload si download)
  {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nxd-pol-'));
    const f = path.join(d2, 'x.txt');
    const live = () => [...mock.state.files.values()].filter((x) => x.parents && x.parents[0] === 'ROOT3' && !x.trashed);
    const run = async (txt, pol, n) => {
      fs.writeFileSync(f, txt);
      await upx.add([f], 'ROOT3', pol);
      await waitFor(() => upx.snapshot().counts.done === n && upx.idle(), 'politica ' + pol);
    };
    const upx = makeUploader(mock.base, fs.mkdtempSync(path.join(os.tmpdir(), 'nxd-data2-')), clock);
    await run('v1', 'skip', 1);
    upx.clear('done');
    await run('versiunea 2', 'skip', 1);
    assert.deepStrictEqual(live().map((x) => x.name), ['x.txt']);
    assert.strictEqual(live()[0].data.toString(), 'v1', 'skip nu atinge fisierul');
    upx.clear('done');
    await run('versiunea 3', 'replace', 1);
    assert.deepStrictEqual(live().map((x) => x.name), ['x.txt']);
    assert.strictEqual(live()[0].data.toString(), 'versiunea 3', 'replace pune continutul nou');
    upx.clear('done');
    await run('versiunea 4', 'rename', 1);
    assert.deepStrictEqual(live().map((x) => x.name).sort(), ['x-1.txt', 'x.txt']);
    upx.clear('done');
    await run('versiunea 5', 'rename', 1);
    assert.deepStrictEqual(live().map((x) => x.name).sort(), ['x-1.txt', 'x-2.txt', 'x.txt']);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nxd-pdl-'));
    const item = [{ id: 'D2', name: 'raport.txt', mimeType: 'text/plain' }];
    const dlp = () => createDownloader({ drive: createDrive({ getToken: async () => 'tok', base: mock.base, sleep: (ms) => real(Math.min(ms, 3)), retryBase: 1 }), cfg: { ...require('../src/main/config'), DL_WORKERS: 1, NET_RETRIES: 1, RETRY_BASE_MS: 1 }, sleep: (ms) => real(Math.min(ms, 3)) });
    const go = async (pol) => { const d = dlp(); d.add(item, out, pol); await waitFor(() => d.idle() && d.snapshot().counts.done === 1, 'dl ' + pol); };
    fs.writeFileSync(path.join(out, 'raport.txt'), 'local');
    await go('skip');
    assert.strictEqual(fs.readFileSync(path.join(out, 'raport.txt'), 'utf8'), 'local');
    await go('rename');
    assert.strictEqual(fs.readFileSync(path.join(out, 'raport-1.txt'), 'utf8'), 'salut drive');
    await go('replace');
    assert.strictEqual(fs.readFileSync(path.join(out, 'raport.txt'), 'utf8'), 'salut drive');
    assert.deepStrictEqual(fs.readdirSync(out).sort(), ['raport-1.txt', 'raport.txt']);
    console.log('OK politici skip/replace/rename la upload si download');
  }

  // 8) Paralelism configurabil la upload
  assert.strictEqual(up.setWorkers(99), 8);
  assert.strictEqual(up.setWorkers(0) >= 1, true);

  // 9) Valuri rate-limit (4 workeri simultan = 1 singur val, fara pauza falsa)
  {
    const c9 = { t: Date.parse('2026-11-22T10:00:00Z') };
    const rg = createRateGuard({ cfg: { ...require('../src/main/config'), RATE_PAUSE_WAVES: 4, RETRY_BASE_MS: 2000, RATE_RECOVER_OK: 3 }, now: () => c9.t });
    const e403 = { status: 403, reason: 'userRateLimitExceeded' };
    const w1 = rg.onRateError(e403);
    const w2 = rg.onRateError(e403);
    const w3 = rg.onRateError(e403);
    const w4 = rg.onRateError(e403);
    assert.strictEqual(w1.pause, false);
    assert.strictEqual(w1.wave, 1);
    assert.strictEqual(w2.sameWave, true);
    assert.strictEqual(w3.sameWave, true);
    assert.strictEqual(w4.sameWave, true);
    assert.strictEqual(rg.effectiveWorkers(8), 4, 'paralelism redus la jumatate dupa valul 1');
    c9.t += 3000;
    const w5 = rg.onRateError(e403);
    assert.strictEqual(w5.wave, 2);
    assert.strictEqual(rg.effectiveWorkers(8), 1, 'paralelism redus la 1 dupa valul 2');
    assert.strictEqual(rg.onSuccess(), false);
    assert.strictEqual(rg.onSuccess(), false);
    assert.strictEqual(rg.onSuccess(), true, 'paralelism refacut dupa RATE_RECOVER_OK reusite');
    assert.strictEqual(rg.effectiveWorkers(8), 8);
    console.log('OK rate-limit pe valuri: 4 workeri simultan = 1 val, backoff + throttling + recuperare');
  }

  // 10) Reluare automata din ora in ora (settings) + log persistent google-errors.jsonl
  {
    const c10 = { t: Date.parse('2026-11-22T12:00:00Z') };
    const d10 = fs.mkdtempSync(path.join(os.tmpdir(), 'nxd-log-'));
    const elog = createErrorLog({ dataDir: d10, now: () => c10.t });
    const f10 = path.join(src, 'proj', 'tiny.txt');
    fs.writeFileSync(f10, 'hello hourly retry');
    mock.state.budget = mock.state.putBytes; // refuza imediat cu 403 userRateLimitExceeded
    const up10 = makeUploader(mock.base, d10, c10,
      { LIMIT_RETRY_MINUTES: 60, DAILY_QUOTA_BYTES: 700 * 1024 ** 3, RATE_PAUSE_WAVES: 3, WORKERS: 1 },
      { onError: elog.record, getSettings: () => ({ limitAutoRetry: true, limitRetryMinutes: 60 }) });
    await up10.add([f10], 'ROOT_HOURLY');
    await waitFor(() => up10.snapshot().pausedUntil > 0 && up10.idle(), 'pauza orara');
    const s10 = up10.snapshot();
    const diffMin = Math.round((s10.pausedUntil - Date.parse('2026-11-22T12:00:00Z')) / 60000);
    assert.strictEqual(diffMin, 60, `pauza orara 60 min (primit ${diffMin})`);
    assert.ok(/HTTP 403 userRateLimitExceeded/.test(s10.pauseReason), `motiv exact Google: ${s10.pauseReason}`);
    assert.ok(!/750 GB/.test(s10.pauseReason), 'nu pretinde fals 750 GB');
    const sum = elog.summary();
    assert.ok(sum.exists && sum.total >= 3, `google-errors.jsonl are ${sum.total} intrari`);
    const rawLog = fs.readFileSync(elog.file, 'utf8');
    assert.ok(/userRateLimitExceeded/.test(rawLog) && !/Bearer/.test(rawLog), 'log JSONL curat fara token');
    // Dupa 59 min tot in pauza; dupa 61 min cu buget refacut reia automat!
    c10.t = s10.pausedUntil - 60000;
    const calls59 = mock.state.putCalls;
    up10.tick();
    await real(60);
    assert.strictEqual(mock.state.putCalls, calls59, 'la 59 min inca in pauza');
    c10.t = s10.pausedUntil + 1000;
    mock.state.budget = Infinity;
    up10.tick();
    await waitFor(() => up10.snapshot().counts.done === 1 && up10.idle(), 'reluat automat dupa 1 ora');
    console.log('OK reluare automata la 60 min + google-errors.jsonl:', sum.total, 'erori logate');
  }

  // 11) listFolders returneaza DOAR foldere (ignora fisierele), respecta AbortSignal, interactiveGate cedeaza si elibereaza instant, settings.theme persista + nativeTheme
  {
    const d11 = createDrive({ getToken: async () => 'tok', base: mock.base, sleep: (ms) => real(Math.min(ms, 3)), retryBase: 1, metaTimeoutMs: 5000 });
    const GA = 'application/vnd.google-apps.';
    mock.state.files.set('F_SUB1', { id: 'F_SUB1', name: 'SubA', parents: ['D1'], mimeType: GA + 'folder', trashed: false });
    const onlyFolders = await d11.listFolders('D1');
    assert.deepStrictEqual(onlyFolders.map((f) => f.name), ['SubA'], 'listFolders intoarce doar foldere');
    const onlyFiles = await d11.listFiles('D1');
    assert.strictEqual(onlyFiles.some((f) => f.name === 'SubA'), false, 'listFiles exclude folderele');
    assert.ok(onlyFiles.some((f) => f.name === 'raport.txt'), 'listFiles intoarce fisierele');
    const ac = new AbortController();
    ac.abort();
    let aborted = false;
    try { await d11.listFolders('D1', { signal: ac.signal }); } catch (e) { aborted = e.name === 'AbortError'; }
    assert.strictEqual(aborted, true, 'listFolders anulat curat cu AbortSignal');

    const gate = createInteractiveGate({ maxWaitMs: 500 });
    const release = gate.begin();
    let unblocked = false;
    const pWait = gate.wait().then(() => { unblocked = true; });
    await real(15);
    assert.strictEqual(unblocked, false, 'gate tine workerii cat navigheaza userul');
    release();
    await pWait;
    assert.strictEqual(unblocked, true, 'gate elibereaza instant dupa terminarea navigarii');

    const fakeNative = { themeSource: 'system' };
    const sDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxd-set-'));
    const st1 = createSettings({ dataDir: sDir, app: null, nativeTheme: fakeNative });
    assert.strictEqual(st1.get().theme, 'system');
    st1.set({ theme: 'dark' });
    assert.strictEqual(fakeNative.themeSource, 'dark');
    const st2 = createSettings({ dataDir: sDir, app: null, nativeTheme: fakeNative });
    assert.strictEqual(st2.get().theme, 'dark');
    // 11b) POST pe timeout nu se repeta orb in drive.json (evita foldere duplicate) si interactiveTimeoutMs < metaTimeoutMs
    const http = require('http');
    let postHits = 0;
    const slowSrv = http.createServer((req, res) => { if (req.method === 'POST') postHits++; setTimeout(() => { if (!res.writableEnded) { res.writeHead(200); res.end('{"files":[]}'); } }, 250); });
    await new Promise((r) => slowSrv.listen(0, '127.0.0.1', r));
    const dSlow = createDrive({ getToken: async () => 'tok', base: `http://127.0.0.1:${slowSrv.address().port}`, sleep: (ms) => real(Math.min(ms, 3)), retryBase: 1, metaTimeoutMs: 60, interactiveTimeoutMs: 40 });
    await assert.rejects(() => dSlow.json('POST', '/drive/v3/files', { body: { name: 'x' } }), (e) => e.code === 'ETIMEDOUT');
    assert.strictEqual(postHits, 1, 'POST pe timeout nu se repeta orb');
    slowSrv.close();
    console.log('OK listFolders + listFiles + AbortSignal + POST timeout + interactiveGate + settings.theme');
  }

  console.log('SMOKE OK');
  mock.server.close();
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAIL', e); process.exit(1); });
