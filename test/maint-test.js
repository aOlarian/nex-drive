/* MAP
 * §1 ajutoare  L8-L37
 * §2 teste a-j  L38-L112
 */

// §1 ajutoare
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createMaintenance } = require('../src/main/maintenance');

const DAY = 86400000;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-'));
let seq = 0;

function env() {
  const d = path.join(base, `t${seq++}`);
  const root = path.join(d, 'root');
  fs.mkdirSync(root, { recursive: true });
  return { d, root, data: path.join(d, 'data'), bin: path.join(d, 'bin') };
}
function put(p, ageDays) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x'.repeat(10));
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(p, t, t);
}
function make(e, extra = {}) {
  const trashed = [];
  const m = createMaintenance({
    dataDir: e.data,
    trash: async (p) => { trashed.push(p); fs.mkdirSync(e.bin, { recursive: true }); fs.renameSync(p, path.join(e.bin, `${trashed.length}-${path.basename(p)}`)); },
    isSynced: () => true,
    ...extra,
  });
  return { m, trashed };
}
const rule = (e, o = {}) => ({ path: e.root, days: 30, action: 'delete', onlySynced: false, enabled: true, schedule: { type: 'manual' }, ...o });

async function main() {
  // (a) folder vechi intreg = un singur element
  { const e = env(); const { m } = make(e);
    put(path.join(e.root, 'old/a.txt'), 100); put(path.join(e.root, 'old/sub/b.txt'), 90);
    const r = m.save(rule(e)); const pv = await m.preview(r.id);
    assert.strictEqual(pv.entries.length, 1, 'a: one entry');
    assert.strictEqual(pv.entries[0].kind, 'folder'); assert.strictEqual(pv.entries[0].fileCount, 2);
    // (c) radacina nu apare, nici cand tot continutul e vechi
    assert(!pv.entries.some((x) => x.path === e.root), 'c: root listed'); }

  // (b) folder mixt: doar fisierul vechi
  { const e = env(); const { m } = make(e);
    put(path.join(e.root, 'mix/old.txt'), 100); put(path.join(e.root, 'mix/new.txt'), 1);
    const r = m.save(rule(e)); const pv = await m.preview(r.id);
    assert.deepStrictEqual(pv.entries.map((x) => [x.kind, path.basename(x.path)]), [['file', 'old.txt']], 'b'); }

  // (d) onlySynced cu un fisier nesincronizat
  { const e = env(); const bad = path.join(e.root, 'f/unsynced.txt');
    const { m } = make(e, { isSynced: (p) => p !== bad });
    put(bad, 100); put(path.join(e.root, 'f/ok.txt'), 100);
    const r = m.save(rule(e, { onlySynced: true })); const pv = await m.preview(r.id);
    assert(!pv.entries.some((x) => x.kind === 'folder'), 'd: folder whole');
    assert(pv.skippedUnsynced > 0, 'd: skipped'); assert.strictEqual(pv.entries.length, 1); }

  // (e) recycle apeleaza trash, fisierul ajunge in alt folder; (j) preview nu sterge
  { const e = env(); const { m, trashed } = make(e);
    put(path.join(e.root, 'old/a.txt'), 100);
    const r = m.save(rule(e, { action: 'recycle' }));
    await m.preview(r.id); assert(fs.existsSync(path.join(e.root, 'old/a.txt')), 'j: preview deleted');
    const res = await m.run(r.id);
    assert.strictEqual(trashed.length, 1, 'e: trash calls'); assert.strictEqual(res.removed, 1);
    assert(!fs.existsSync(path.join(e.root, 'old')) && fs.existsSync(e.bin), 'e: moved');
    assert(fs.existsSync(e.root), 'root kept'); assert(m.list()[0].lastRunAt > 0); }

  // (f) delete sterge de pe disc, folderul cu fisier nou ramane
  { const e = env(); const { m, trashed } = make(e);
    put(path.join(e.root, 'old/a.txt'), 100); put(path.join(e.root, 'mix/old.txt'), 100); put(path.join(e.root, 'mix/new.txt'), 1);
    const r = m.save(rule(e)); const res = await m.run(r.id);
    assert.strictEqual(trashed.length, 0); assert.strictEqual(res.removed, 2); assert.strictEqual(res.bytes, 20);
    assert(!fs.existsSync(path.join(e.root, 'old')) && !fs.existsSync(path.join(e.root, 'mix/old.txt')), 'f');
    assert(fs.existsSync(path.join(e.root, 'mix/new.txt')), 'f: new kept'); }

  // (g) fisier modificat dupa preview: run recalculeaza si nu il sterge
  { const e = env(); const { m } = make(e); const f = path.join(e.root, 'x.txt'); put(f, 100);
    const r = m.save(rule(e)); assert.strictEqual((await m.preview(r.id)).entries.length, 1);
    put(f, 0);
    const res = await m.run(r.id);
    assert.strictEqual(res.removed, 0, 'g: removed'); assert(fs.existsSync(f), 'g: file gone'); }

  // (h) tick: daily/interval scadente ruleaza, manual nu; reguli noi nu ruleaza imediat
  { const e = env(); let t = Date.now(); const { m } = make(e, { now: () => t });
    put(path.join(e.root, 'a.txt'), 100);
    const iv = m.save(rule(e, { schedule: { type: 'interval', every: 1, unit: 'hours' } }));
    const dl = m.save(rule(e, { schedule: { type: 'daily', at: '03:00', everyDays: 1 } }));
    const mn = m.save(rule(e));
    assert.strictEqual(await m.tick(), 0, 'h: new rule ran immediately'); assert(iv.nextRunAt > t && dl.nextRunAt > t);
    t += 2 * DAY;
    assert.strictEqual(await m.tick(), 2, 'h: ran count');
    const L = m.list(); assert(L.find((r) => r.id === mn.id).lastRunAt === 0, 'h: manual ran');
    assert(L.find((r) => r.id === iv.id).lastRunAt === t && L.find((r) => r.id === iv.id).nextRunAt > t); }

  // (i) persistenta + fisier corupt
  { const e = env(); const { m } = make(e); const r = m.save(rule(e, { days: 7 }));
    const { m: m2 } = make(e); assert.strictEqual(m2.list().length, 1, 'i'); assert.strictEqual(m2.list()[0].id, r.id);
    assert.strictEqual(m2.remove(r.id), true); assert.strictEqual(make(e).m.list().length, 0);
    fs.writeFileSync(path.join(e.data, 'maintenance.json'), '{bad');
    assert.strictEqual(make(e).m.list().length, 0); assert(fs.readdirSync(e.data).some((n) => n.includes('.corupt-')), 'corupt copy');
    assert.throws(() => m.save(rule(e, { days: 0 })), /Days/); assert.throws(() => m.save(rule(e, { path: 'rel' })), /absolute/); }

  console.log('MAINT OK');
}

main().then(() => fs.rmSync(base, { recursive: true, force: true }), (err) => {
  console.error(`MAINT FAIL: ${err.stack || err.message}`);
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(1);
});
