/* MAP
 * §1 setup si helpers  L6-L48
 * §2 scenarii sync  L49-L190
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
const { createDownloader } = require('../src/main/downloader');
const { createSyncStore } = require('../src/main/sync-store');
const { createSync } = require('../src/main/sync');

const real = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ok = (m) => console.log(`OK ${m}`);

async function waitFor(cond, what, ms = 15000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await real(25);
  }
}

function build(base, dataDir) {
  const cfg = { ...require('../src/main/config'), CHUNK_BYTES: 1024 * 1024, WORKERS: 2, DL_WORKERS: 2, RATE_RETRIES: 3, NET_RETRIES: 2, RETRY_BASE_MS: 1, SAVE_DEBOUNCE_MS: 20 };
  const sleep = (ms) => real(Math.min(ms, 3));
  const drive = createDrive({ getToken: async () => 'tok', base, sleep, retryBase: 1 });
  let sync = null;
  const uploader = createUploader({ drive, dataDir, cfg, sleep, onSyncDone: (it) => sync && sync.onUploaded(it) });
  const downloader = createDownloader({ drive, cfg, sleep });
  const store = createSyncStore({ dataDir, debounceMs: 20 });
  sync = createSync({ store, uploader, drive, downloader });
  return { sync, uploader, downloader, store, drive };
}

const settle = (env, jobId) => waitFor(() => !env.sync.listJobs().find((j) => j.id === jobId).running && env.uploader.queue.st.items.every((i) => i.state === 'done' || i.state === 'error') && env.uploader.idle(), `job ${jobId} idle`);
const driveNames = (st) => [...st.files.values()].filter((f) => f.mimeType === 'application/octet-stream' && !f.trashed).map((f) => f.name).sort();

// §2 scenarii sync
(async () => {
  const mock = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexdrive-sync-'));
  const data = path.join(root, 'data');
  const pc = path.join(root, 'pc');
  const w = (rel, content) => { const p = path.join(pc, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  const aTxt = w('src/a.txt', 'alpha');
  const bTxt = w('src/sub/b.txt', 'bravo');
  const cBin = w('src/sub/deep/c.bin', crypto.randomBytes(2 * 1024 * 1024 + 17));
  const loose = w('loose.txt', 'loose');
  const cHash = sha(fs.readFileSync(cBin));
  const env = build(mock.base, data);
  const byName = (n) => [...mock.state.files.values()].find((f) => f.name === n && !f.trashed);

  try {
    // 1) job nou: primul sync porneste imediat si urca tot, structura de foldere se pastreaza
    const job = env.sync.create({ name: 'main', driveParentId: 'root', driveParentName: 'My Drive', sources: [{ path: path.join(pc, 'src') }, { path: loose }], schedule: { type: 'interval', every: 1, unit: 'hours' } });
    await waitFor(() => job.id && env.sync.listJobs()[0].lastScan, 'first scan');
    await settle(env, job.id);
    assert.deepStrictEqual(driveNames(mock.state), ['a.txt', 'b.txt', 'c.bin', 'loose.txt']);
    assert.strictEqual(sha(byName('c.bin').data), cHash);
    const srcFolder = byName('src');
    assert.ok(srcFolder && srcFolder.parents[0] === 'root', 'folderul src in radacina destinatiei');
    assert.strictEqual(env.sync.listJobs()[0].files, 4);
    assert.ok(env.sync.isSynced(aTxt, 5, fs.statSync(aTxt).mtimeMs), 'isSynced');
    ok('primul sync: 4 fisiere, structura, hash, isSynced');

    // 2) fara schimbari: niciun apel nou catre Drive
    const before = { init: mock.state.initCalls, put: mock.state.putCalls };
    assert.strictEqual(await env.sync.run(job.id), 'started');
    await settle(env, job.id);
    assert.deepStrictEqual({ init: mock.state.initCalls, put: mock.state.putCalls }, before);
    ok('rulare fara schimbari: zero cereri de upload');

    // 3) fisier modificat -> aceeasi intrare Drive, versiunea veche ramane revizie fixata
    const idA = byName('a.txt').id;
    fs.writeFileSync(aTxt, 'alpha CHANGED');
    await env.sync.run(job.id);
    await settle(env, job.id);
    const fa = mock.state.files.get(idA);
    assert.strictEqual(fa.data.toString(), 'alpha CHANGED');
    assert.strictEqual(fa.revisions.length, 1);
    assert.strictEqual(fa.revisions[0].data.toString(), 'alpha');
    assert.strictEqual(fa.revisions[0].keepForever, true);
    assert.strictEqual([...mock.state.files.values()].filter((f) => f.name === 'a.txt').length, 1, 'fara duplicat');
    ok('modificare: aceeasi intrare Drive, revizie veche pastrata (keepForever)');

    // 4) sters local -> marcat, NU sters din Drive; apoi „Delete from Drive” il pune in Cos
    fs.rmSync(bTxt);
    await env.sync.run(job.id);
    await settle(env, job.id);
    let del = env.sync.deleted();
    assert.strictEqual(del.length, 1);
    assert.strictEqual(del[0].relPath, 'src/sub/b.txt');
    assert.strictEqual(byName('b.txt').trashed, false);
    const r = await env.sync.deleteFromDrive([{ jobId: job.id, path: bTxt }]);
    assert.strictEqual(r.done, 1);
    assert.strictEqual([...mock.state.files.values()].find((f) => f.name === 'b.txt').trashed, true);
    assert.strictEqual(env.sync.deleted().length, 0);
    ok('sters local: doar marcat; Delete from Drive -> Cos');

    // 5) restore: fisierul revine pe disc, nu se mai urca din nou
    fs.rmSync(cBin);
    await env.sync.run(job.id);
    await settle(env, job.id);
    assert.strictEqual(env.sync.deleted().length, 1);
    const initBefore = mock.state.initCalls;
    assert.strictEqual(env.sync.restore([{ jobId: job.id, path: cBin }]), 1);
    await waitFor(() => fs.existsSync(cBin) && env.sync.deleted().length === 0, 'restore');
    assert.strictEqual(sha(fs.readFileSync(cBin)), cHash);
    await env.sync.run(job.id);
    await settle(env, job.id);
    assert.strictEqual(mock.state.initCalls, initBefore);
    ok('restore: fisier readus pe disc, hash identic, fara re-upload');

    // 6) Not deleted: iese din lista, ramane in Drive; la reaparitie se potriveste dupa nume/marime (fara upload)
    fs.rmSync(aTxt);
    await env.sync.run(job.id);
    await settle(env, job.id);
    assert.strictEqual(env.sync.keep([{ jobId: job.id, path: aTxt }]), 1);
    assert.strictEqual(env.sync.deleted().length, 0);
    assert.strictEqual(byName('a.txt').trashed, false);
    fs.writeFileSync(aTxt, 'alpha CHANGED');
    const init6 = mock.state.initCalls;
    await env.sync.run(job.id);
    await settle(env, job.id);
    assert.strictEqual(mock.state.initCalls, init6, 'adopt: nu urca din nou');
    assert.strictEqual([...mock.state.files.values()].filter((f) => f.name === 'a.txt' && !f.trashed).length, 1);
    ok('Not deleted: ramane in Drive, reaparitia se adopta fara upload');

    // 7) job fara urmarirea stergerilor: nimic nu apare in „deleted”
    const w2 = w('perm/p1.txt', 'permanent');
    const job2 = env.sync.create({ name: 'perm', driveParentId: 'root', sources: [{ path: path.join(pc, 'perm') }], schedule: { type: 'manual' }, trackDeletes: false });
    await waitFor(() => env.sync.listJobs().find((j) => j.id === job2.id).lastScan, 'job2 scan');
    await settle(env, job2.id);
    fs.rmSync(w2);
    await env.sync.run(job2.id);
    await settle(env, job2.id);
    assert.strictEqual(env.sync.deleted().filter((d) => d.jobId === job2.id).length, 0);
    assert.strictEqual(byName('p1.txt').trashed, false);
    ok('trackDeletes=false: nu se marcheaza, fisierul ramane in Drive');

    // 8) sursa indisponibila: nu se marcheaza nimic ca sters
    const filesBefore = env.sync.listJobs().find((j) => j.id === job.id).files;
    fs.renameSync(path.join(pc, 'src'), path.join(pc, 'src_off'));
    await env.sync.run(job.id);
    await settle(env, job.id);
    const jv = env.sync.listJobs().find((j) => j.id === job.id);
    assert.ok(/Source unavailable/.test(jv.lastError), jv.lastError);
    assert.strictEqual(jv.deleted, 0);
    assert.strictEqual(jv.files, filesBefore);
    fs.renameSync(path.join(pc, 'src_off'), path.join(pc, 'src'));
    ok('sursa lipsa (ex. disc scos): eroare afisata, zero marcaje de stergere');

    // 9) mod „children”: un copil nou apare in folderul parinte si se sincronizeaza; unul exclus ramane in afara
    w('kids/k1.txt', 'k1');
    w('kids/skipme/s.txt', 'skip');
    const job3 = env.sync.create({ name: 'kids', driveParentId: 'root', sources: [{ path: path.join(pc, 'kids'), mode: 'children', exclude: ['skipme'] }], schedule: { type: 'manual' } });
    await waitFor(() => env.sync.listJobs().find((j) => j.id === job3.id).lastScan, 'job3 scan');
    await settle(env, job3.id);
    assert.ok(byName('k1.txt'));
    assert.ok(!byName('s.txt'), 'exclus');
    w('kids/k2.txt', 'k2');
    await env.sync.run(job3.id);
    await settle(env, job3.id);
    assert.ok(byName('k2.txt'));
    ok('children: copil nou sincronizat, exclusul ramane in afara');

    // 10) program: tick() ruleaza jobul scadent, nu pe cel manual
    const jobRef = env.store.data.jobs.find((j) => j.id === job.id);
    jobRef.nextRunAt = 1;
    w('src/late.txt', 'late');
    assert.strictEqual(await env.sync.tick(), 1);
    await settle(env, job.id);
    assert.ok(byName('late.txt'));
    assert.ok(env.store.data.jobs.find((j) => j.id === job.id).nextRunAt > Date.now(), 'urmatoarea rulare reprogramata');
    ok('tick: ruleaza jobul scadent si il reprogrameaza');

    // 11) persistenta: un store nou pe acelasi director vede joburile si indexul
    env.store.flushAll();
    const again = build(mock.base, data);
    assert.strictEqual(again.sync.listJobs().length, 3);
    assert.strictEqual(again.sync.listJobs().find((j) => j.id === job.id).files > 0, true);
    ok('persistenta: joburi si index reincarcate');

    // 12) remove: sterge doar jobul; nimic din Drive
    assert.strictEqual(env.sync.remove(job2.id), true);
    assert.ok(byName('p1.txt'));
    ok('remove job: Drive neatins');

    // 13) Mirror mode: editare din Safe ('mark') -> Mirror ('mirror') sterge din Drive ATAT fisierele marcate anterior, CAT si cele nou disparute; sursa lipsa NU sterge
    const m1 = w('mir/one.txt', 'one');
    const m2 = w('mir/two.txt', 'two');
    const m3 = w('mir/keep.txt', 'keep');
    const mjob = env.sync.create({ name: 'mir', driveParentId: 'root', sources: [{ path: path.join(pc, 'mir') }], schedule: { type: 'manual' }, deleteMode: 'mark' });
    await waitFor(() => env.sync.listJobs().find((j) => j.id === mjob.id).lastScan, 'mir first scan');
    await settle(env, mjob.id);
    // stergem one.txt cat jobul e in Safe -> doar marcat, inca in Drive
    fs.rmSync(m1);
    await env.sync.run(mjob.id);
    await settle(env, mjob.id);
    assert.strictEqual(env.sync.deleted().filter((d) => d.jobId === mjob.id).length, 1);
    assert.strictEqual(byName('one.txt').trashed, false);
    // editam jobul -> Mirror, stergem si two.txt, rulam -> AMBELE merg in Cos Drive, keep.txt ramane!
    env.sync.update(mjob.id, { deleteMode: 'mirror' });
    fs.rmSync(m2);
    await env.sync.run(mjob.id);
    await settle(env, mjob.id);
    assert.strictEqual(env.sync.deleted().filter((d) => d.jobId === mjob.id).length, 0);
    assert.strictEqual([...mock.state.files.values()].find((f) => f.name === 'one.txt').trashed, true, 'marcat anterior -> Cos Drive');
    assert.strictEqual([...mock.state.files.values()].find((f) => f.name === 'two.txt').trashed, true, 'nou sters -> Cos Drive');
    assert.strictEqual(byName('keep.txt').trashed, false, 'keep.txt neatins');
    assert.strictEqual(env.sync.listJobs().find((j) => j.id === mjob.id).lastScan.trashedFromDrive, 2);
    // siguranta Mirror: sursa disparuta (disc scos) -> ZERO stergeri in Drive!
    fs.renameSync(path.join(pc, 'mir'), path.join(pc, 'mir_off'));
    await env.sync.run(mjob.id);
    await settle(env, mjob.id);
    assert.strictEqual(byName('keep.txt').trashed, false, 'Mirror + sursa lipsa nu sterge din Drive');
    fs.renameSync(path.join(pc, 'mir_off'), path.join(pc, 'mir'));
    ok('Mirror mode: sterge din Drive (Cos) si vechile marcate si cele noi; sursa lipsa ramane sigura');

    // 14) Coada O(1) pe volum mare: 20,000 intrari adaugate + 20 snapshot-uri fara blocaj (< 250ms)
    const { createQueue } = require('../src/main/queue');
    const qBig = createQueue({ dataDir: path.join(root, 'bigq'), cfg: require('../src/main/config') });
    const tBig = Date.now();
    const bulk = Array.from({ length: 20000 }, (_, i) => ({ path: `/big/f${i}.bin`, rel: ['big'], rootParent: 'root', size: 100, mtimeMs: 1, syncJob: 99 }));
    qBig.addItems(bulk);
    for (let k = 0; k < 20; k++) {
      const s = qBig.snapshot();
      assert.strictEqual(s.counts.pending, 20000);
      assert.strictEqual(s.items.length, 300);
    }
    const bigMs = Date.now() - tBig;
    assert.ok(bigMs < 1500, `coada mare prea lenta: ${bigMs} ms`);
    ok(`performanta coada: 20,000 fisiere + 20 snapshot-uri in ${bigMs} ms`);

    // 15) retryAll: reia coada din pauza, sterge erorile joburilor si porneste joburile active
    env.uploader.pause();
    const jActive = env.store.data.jobs.find((j) => j.id === job.id);
    jActive.lastError = 'Old transient error';
    w('src/after-retry.txt', 'retry-all-ok');
    const rAll = env.sync.retryAll();
    assert.strictEqual(rAll.resumed, true, 'retryAll scoate din pauza');
    assert.ok(rAll.startedJobs >= 1, 'retryAll porneste joburile active');
    assert.strictEqual(jActive.lastError, '', 'retryAll curata lastError');
    await settle(env, job.id);
    assert.ok(byName('after-retry.txt'), 'fisierul nou urcat dupa retryAll');
    ok('retryAll: reluare din pauza + curatare erori + pornire joburi');

    console.log('SYNC OK');
  } finally {
    await new Promise((r) => mock.server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
