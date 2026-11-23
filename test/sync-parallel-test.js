/* MAP
 * §1 setup si mock controlat (bariera de concurenta)  L7-L56
 * §2 scenarii: paralelism 5 proiecte/3 conexiuni, reorder, pause/resume, stop/start, edit foldere  L57-L215
 */

// §1 setup si mock controlat: permite verificarea exacta a sloturilor active simultan pe 5 proiecte cu 3 conexiuni
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUploader } = require('../src/main/uploader');
const { createSyncStore } = require('../src/main/sync-store');
const { createSync } = require('../src/main/sync');

const real = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`OK ${m}`);

async function waitFor(cond, what, ms = 15000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await real(15);
  }
}

function createControlledDrive() {
  let seq = 1;
  let hold = false;
  const inflight = []; // { name, resolve }
  const started = [];  // ordinea in care au intrat fisierele in uploadMultipart
  const uploaded = new Map(); // name -> { id, parentId, buf }
  const folders = new Map();

  function releaseAll() {
    hold = false;
    while (inflight.length) inflight.shift().resolve();
  }

  function releaseOne(match) {
    const idx = match ? inflight.findIndex((x) => match(x.name)) : 0;
    if (idx < 0) return false;
    const [x] = inflight.splice(idx, 1);
    x.resolve();
    return true;
  }

  const drive = {
    async listAll() { return []; },
    async ensureFolderEx(parentId, name) {
      const k = `${parentId}|${name}`;
      if (!folders.has(k)) folders.set(k, `fld_${seq++}`);
      return { id: folders.get(k), created: true };
    },
    async uploadMultipart({ name, parentId, buf }) {
      started.push(name);
      if (hold) await new Promise((resolve) => inflight.push({ name, resolve }));
      const id = `file_${seq++}`;
      uploaded.set(name, { id, parentId, buf });
      return { id };
    },
    async trash() { return {}; },
  };

  return { drive, inflight, started, uploaded, setHold: (v) => { hold = v; }, releaseAll, releaseOne };
}

function buildEnv(dataDir, ctrl, workers = 3) {
  const cfg = { ...require('../src/main/config'), WORKERS: workers, MAX_WORKERS: 8, MULTIPART_MAX_BYTES: 2 * 1024 * 1024, SAVE_DEBOUNCE_MS: 20 };
  const sleep = (ms) => real(Math.min(ms, 3));
  let sync = null;
  const uploader = createUploader({
    drive: ctrl.drive, dataDir, cfg, sleep,
    getJobPolicy: () => (sync ? sync.getPriorityPolicy() : null),
    onSyncDone: (it) => sync && sync.onUploaded(it),
  });
  const store = createSyncStore({ dataDir, debounceMs: 20 });
  sync = createSync({ store, uploader, drive: ctrl.drive, downloader: { add: () => {} } });
  return { sync, uploader, store };
}

// §2 scenarii: paralelism 5 proiecte/3 conexiuni, reorder, pause/resume, stop/start, edit foldere
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexdrive-par-'));
  const pc = path.join(root, 'pc');
  const w = (rel, txt = 'data') => { const p = path.join(pc, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); return p; };

  try {
    // 1) 5 proiecte, 3 conexiuni: primele 3 proiecte iau simultan cate 1 conexiune
    const ctrl = createControlledDrive();
    const env = buildEnv(path.join(root, 'd1'), ctrl, 3);
    ctrl.setHold(true);
    env.uploader.pause(); // cream toate 5 proiectele, le lasam sa scaneze, apoi dam resume simultan
    const jobs = [];
    for (let i = 1; i <= 5; i++) {
      w(`p${i}/p${i}-a.txt`, `a${i}`);
      w(`p${i}/p${i}-b.txt`, `b${i}`);
      const j = env.sync.create({ name: `Proj ${i}`, driveParentId: `dst_${i}`, sources: [{ path: path.join(pc, `p${i}`) }], schedule: { type: 'manual' } });
      jobs.push(j);
    }
    await waitFor(() => env.sync.listJobs().every((j) => j.lastScan && !j.running), 'toate 5 scanate');
    assert.strictEqual(env.uploader.snapshot().counts.pending, 10, '10 fisiere in coada din 5 proiecte');

    env.uploader.resume();
    await waitFor(() => ctrl.inflight.length === 3, '3 conexiuni active simultan');
    const first3 = ctrl.inflight.map((x) => x.name.slice(0, 2)).sort();
    assert.deepStrictEqual(first3, ['p1', 'p2', 'p3'], `primele 3 proiecte iau cate 1 conexiune (primit: ${first3.join(',')})`);
    ok('5 proiecte + 3 conexiuni: primele 3 proiecte primesc cate o conexiune in paralel');

    // 2) Reorder drag & drop: mutam Proj 4 pe locul 1; la eliberarea unui slot de la p3, p4 preia imediat conexiunea!
    env.sync.reorder([jobs[3].id, jobs[0].id, jobs[1].id, jobs[2].id, jobs[4].id]);
    assert.deepStrictEqual(env.sync.listJobs().map((j) => j.id), [jobs[3].id, jobs[0].id, jobs[1].id, jobs[2].id, jobs[4].id]);
    ctrl.releaseOne((n) => n.startsWith('p3-'));
    await waitFor(() => ctrl.inflight.length === 3, 'slot eliberat ocupat de urmatorul prioritar');
    const afterReorder = ctrl.inflight.map((x) => x.name.slice(0, 2)).sort();
    assert.deepStrictEqual(afterReorder, ['p1', 'p2', 'p4'], `dupa reorder, p4 intra inaintea lui p3 (primit: ${afterReorder.join(',')})`);
    ok('reorder prioritate: mutarea Proj 4 sus ii da imediat urmatorul slot liber');

    // 3) Pause pe un proiect activ (Proj 1): elibereaza conexiunea pentru Proj 3, pastrand coada Proj 1 intacta; Resume il termina
    env.sync.setPaused(jobs[0].id, true);
    const v1 = env.sync.listJobs().find((j) => j.id === jobs[0].id);
    assert.strictEqual(v1.paused, true);
    assert.strictEqual(v1.phase, 'paused');
    const activeP1 = ctrl.inflight.find(({ name }) => name.startsWith('p1-')).name;
    const queuedP1 = activeP1 === 'p1-a.txt' ? 'p1-b.txt' : 'p1-a.txt';
    ctrl.releaseOne((n) => n.startsWith('p1-'));
    await waitFor(() => ctrl.inflight.length === 3, 'slotul de la p1 preluat de alt proiect');
    const afterPause = ctrl.inflight.map((x) => x.name.slice(0, 2)).sort();
    assert.deepStrictEqual(afterPause, ['p2', 'p3', 'p4'], `p1 in pauza cedeaza slotul catre p3 (primit: ${afterPause.join(',')})`);
    ctrl.releaseAll();
    await waitFor(() => env.uploader.idle(), 'restul proiectelor terminate cat p1 e in pauza');
    assert.strictEqual(env.uploader.queue.openCountForJob(jobs[0].id), 1, 'p1 pastreaza fisierul ramas in coada');
    assert.strictEqual(ctrl.uploaded.has(queuedP1), false, `${queuedP1} nu s-a urcat cat p1 era in pauza`);
    // Resume p1 -> termina ultimul fisier
    env.sync.setPaused(jobs[0].id, false);
    await waitFor(() => env.uploader.idle() && env.uploader.queue.openCountForJob(jobs[0].id) === 0, 'p1 reluat si terminat');
    assert.strictEqual(ctrl.uploaded.has(queuedP1), true, `${queuedP1} urcat dupa Resume`);
    ok('Pause / Resume per proiect: cedeaza conexiunea, pastreaza coada si reia curat');

    // 4) Stop / Start (Run/Stop toggle): Stop dezactiveaza si curata coada; tick nu il porneste; Start il reactiveaza si sincronizeaza
    ctrl.setHold(true);
    w('p2/p2-c.txt', 'c2');
    await env.sync.run(jobs[1].id);
    await waitFor(() => ctrl.inflight.some((x) => x.name === 'p2-c.txt'), 'p2-c in curs');
    const stopped = env.sync.stop(jobs[1].id);
    assert.strictEqual(stopped.enabled, false);
    assert.strictEqual(stopped.phase, 'disabled');
    assert.strictEqual(env.uploader.queue.openCountForJob(jobs[1].id), 0, 'Stop scoate itemele din coada');
    ctrl.releaseAll();
    await waitFor(() => env.uploader.idle(), 'idle dupa Stop');
    // tick nu ruleaza proiectul oprit
    env.store.data.jobs.find((j) => j.id === jobs[1].id).nextRunAt = 1;
    assert.strictEqual(await env.sync.tick(), 0, 'tick ignora proiectul oprit');
    // Start il reactiveaza si urca fisierul nou
    w('p2/p2-d.txt', 'd2');
    const startedView = env.sync.start(jobs[1].id);
    assert.strictEqual(startedView.enabled, true);
    await waitFor(() => !env.sync.listJobs().find((j) => j.id === jobs[1].id).running && env.uploader.idle() && ctrl.uploaded.has('p2-d.txt'), 'Start reactiveaza si urca');
    ok('Stop / Run (Start): dezactiveaza complet, ignora la tick, reactiveaza si sincronizeaza la Run');

    // 5) Editare foldere sincronizate (adaugare + scoatere pe aceeasi partitie): curata coada folderului scos si urca folderul nou
    w('extra-add/new.txt', 'hello-new');
    w('p5/p5-drop.txt', 'drop-me');
    env.uploader.pause();
    await env.sync.run(jobs[4].id);
    assert.strictEqual(env.uploader.queue.openCountForJob(jobs[4].id), 1, 'p5-drop in coada');
    env.sync.update(jobs[4].id, { sources: [{ path: path.join(pc, 'extra-add'), mode: 'item' }] });
    assert.strictEqual(env.uploader.queue.openCountForJob(jobs[4].id), 0, 'coada folderului scos curatata la Edit');
    env.uploader.resume();
    await env.sync.run(jobs[4].id, { force: true });
    await waitFor(() => env.uploader.idle() && ctrl.uploaded.has('new.txt'), 'folderul nou adaugat urcat');
    assert.strictEqual(ctrl.uploaded.has('p5-drop.txt'), false, 'folderul scos nu s-a urcat');
    ok('Editare foldere: scoate coada folderului eliminat si sincronizeaza folderul nou adaugat');

    console.log('SYNC PARALLEL OK');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
