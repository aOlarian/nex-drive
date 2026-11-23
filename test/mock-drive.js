/* MAP
 * §1 stare si helpers  L6-L24
 * §2 rutare cereri  L25-L102
 */

// §1 stare si helpers
const http = require('http');
const crypto = require('crypto');

function startMock() {
  const state = {
    files: new Map(),       // id -> {id,name,parents,mimeType,size,trashed,data?}
    sessions: new Map(),    // id -> {meta,total,chunks:[],received}
    budget: Infinity,       // octeti acceptati pana la 403 userRateLimitExceeded
    putBytes: 0, putCalls: 0, initCalls: 0,
    nextId: 1,
  };
  const newId = () => `id${state.nextId++}`;
  const send = (res, code, obj, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(obj === undefined ? '' : JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });

  // §2 rutare cereri
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    const p = url.pathname;

    // Multipart upload (fisiere mici <= 2 MiB: metadate + binar intr-o singura cerere)
    if ((req.method === 'POST' || req.method === 'PATCH') && url.searchParams.get('uploadType') === 'multipart' && p.startsWith('/upload/drive/v3/files')) {
      const m = /boundary=([^\s;]+)/.exec(req.headers['content-type'] || '');
      const sep = Buffer.from(`--${m[1]}`);
      const i1 = body.indexOf(sep);
      const i2 = body.indexOf(sep, i1 + sep.length);
      const i3 = body.indexOf(sep, i2 + sep.length);
      const part1 = body.subarray(i1 + sep.length, i2);
      const part2 = body.subarray(i2 + sep.length, i3);
      const meta = JSON.parse(part1.subarray(part1.indexOf('\r\n\r\n') + 4).toString('utf8').trim() || '{}');
      const rawData = part2.subarray(part2.indexOf('\r\n\r\n') + 4, part2.length - 2);
      state.initCalls++;
      state.putCalls++;
      if (state.putBytes + rawData.length > state.budget) {
        return send(res, 403, { error: { code: 403, message: 'User rate limit exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } });
      }
      state.putBytes += rawData.length;
      if (req.method === 'PATCH') {
        const updateId = p.split('/')[5];
        const f = state.files.get(updateId);
        if (!f) return send(res, 404, { error: { message: 'nf' } });
        const keep = url.searchParams.get('keepRevisionForever') === 'true';
        (f.revisions = f.revisions || []).push({ id: `r${f.revisions.length + 1}`, modifiedTime: new Date().toISOString(), size: f.size, keepForever: keep, data: f.data });
        f.data = Buffer.from(rawData);
        f.size = String(f.data.length);
        return send(res, 200, { id: f.id, size: f.size });
      }
      const id = newId();
      state.files.set(id, { id, name: meta.name, parents: meta.parents, mimeType: 'application/octet-stream', size: String(rawData.length), trashed: false, data: Buffer.from(rawData) });
      return send(res, 200, { id, size: String(rawData.length) });
    }
    if (req.method === 'POST' && p === '/upload/drive/v3/files') {
      state.initCalls++;
      const meta = JSON.parse(body.toString() || '{}');
      const sid = crypto.randomBytes(6).toString('hex');
      state.sessions.set(sid, { meta, total: Number(req.headers['x-upload-content-length']), parts: [], received: 0 });
      return send(res, 200, {}, { Location: `http://127.0.0.1:${server.address().port}/session/${sid}` });
    }
    if (req.method === 'PATCH' && /^\/upload\/drive\/v3\/files\/[^/]+$/.test(p)) { // inlocuire continut (revizie)
      const updateId = p.split('/')[5];
      if (!state.files.has(updateId)) return send(res, 404, { error: { message: 'nf' } });
      state.initCalls++;
      state.keepForever = url.searchParams.get('keepRevisionForever') === 'true';
      const sid = crypto.randomBytes(6).toString('hex');
      state.sessions.set(sid, { meta: {}, updateId, total: Number(req.headers['x-upload-content-length']), parts: [], received: 0 });
      return send(res, 200, {}, { Location: `http://127.0.0.1:${server.address().port}/session/${sid}` });
    }
    if (req.method === 'PUT' && p.startsWith('/session/')) {
      const s = state.sessions.get(p.split('/')[2]);
      if (!s) return send(res, 404, { error: { message: 'gone' } });
      const cr = /bytes (?:(\d+)-(\d+)|\*)\/(\d+)/.exec(req.headers['content-range'] || '');
      if (body.length === 0) { // interogare de offset
        const hdr = s.received > 0 ? { Range: `bytes=0-${s.received - 1}` } : {};
        return send(res, 308, undefined, hdr);
      }
      state.putCalls++;
      if (state.putBytes + body.length > state.budget) {
        return send(res, 403, { error: { code: 403, message: 'User rate limit exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } });
      }
      if (Number(cr[1]) !== s.received) return send(res, 308, undefined, { Range: `bytes=0-${s.received - 1}` });
      state.putBytes += body.length;
      s.parts.push(body);
      s.received += body.length;
      if (s.received >= s.total) {
        const data = Buffer.concat(s.parts);
        if (s.updateId) {
          const f = state.files.get(s.updateId);
          (f.revisions = f.revisions || []).push({ id: `r${f.revisions.length + 1}`, modifiedTime: new Date().toISOString(), size: f.size, keepForever: !!state.keepForever, data: f.data });
          f.data = data;
          f.size = String(data.length);
          return send(res, 200, { id: f.id, size: f.size });
        }
        const id = newId();
        state.files.set(id, { id, name: s.meta.name, parents: s.meta.parents, mimeType: 'application/octet-stream', size: String(data.length), trashed: false, data });
        return send(res, 200, { id, size: String(data.length) });
      }
      return send(res, 308, undefined, { Range: `bytes=0-${s.received - 1}` });
    }
    if (req.method === 'POST' && p === '/drive/v3/files') {
      const meta = JSON.parse(body.toString());
      const id = newId();
      state.files.set(id, { id, name: meta.name, parents: meta.parents, mimeType: meta.mimeType || 'text/plain', size: meta.mimeType ? undefined : '0', trashed: false });
      return send(res, 200, { id, size: '0' });
    }
    if (req.method === 'GET' && /^\/drive\/v3\/files\/[^/]+(\/export)?$/.test(p)) { // descarcare / export
      const f = state.files.get(p.split('/')[4]);
      if (!f) return send(res, 404, { error: { message: 'nf' } });
      const isExport = p.endsWith('/export');
      const google = f.mimeType.startsWith('application/vnd.google-apps.');
      if (!isExport && google) return send(res, 403, { error: { code: 403, message: 'Only files with binary content can be downloaded. Use Export with Docs Editors files.', errors: [{ reason: 'fileNotDownloadable' }] } });
      if (isExport && !url.searchParams.get('mimeType')) return send(res, 400, { error: { message: 'mimeType lipsa' } });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(isExport ? Buffer.from(`EXPORT:${f.name}`) : f.data || Buffer.alloc(0));
    }
    if (req.method === 'GET' && /^\/drive\/v3\/files\/[^/]+\/revisions(\/[^/]+)?$/.test(p)) {
      const parts = p.split('/');
      const f = state.files.get(parts[4]);
      if (!f) return send(res, 404, { error: { message: 'nf' } });
      if (!parts[6]) return send(res, 200, { revisions: (f.revisions || []).map(({ data, ...m }) => m) });
      const r = (f.revisions || []).find((x) => x.id === parts[6]);
      if (!r) return send(res, 404, { error: { message: 'nf' } });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(r.data || Buffer.alloc(0));
    }
    if (req.method === 'GET' && p === '/drive/v3/files') {
      const q = url.searchParams.get('q') || '';
      const name = /name='((?:[^'\\]|\\.)*)'/.exec(q);
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q);
      const folderOnly = q.includes("mimeType='application/vnd.google-apps.folder'");
      const noFolder = q.includes("mimeType!='application/vnd.google-apps.folder'");
      const out = [...state.files.values()].filter((f) => !f.trashed
        && (!name || f.name === name[1].replace(/\\(.)/g, '$1'))
        && (!parent || (f.parents || []).includes(parent[1]))
        && (!folderOnly || f.mimeType === 'application/vnd.google-apps.folder')
        && (!noFolder || f.mimeType !== 'application/vnd.google-apps.folder'));
      return send(res, 200, { files: out.map(({ data, ...m }) => m) });
    }
    if (req.method === 'PATCH' && p.startsWith('/drive/v3/files/')) {
      const f = state.files.get(p.split('/')[4]);
      if (!f) return send(res, 404, { error: { message: 'nf' } });
      Object.assign(f, JSON.parse(body.toString()));
      return send(res, 200, { id: f.id });
    }
    return send(res, 404, { error: { message: `neimplementat ${req.method} ${p}` } });
  });

  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { startMock };
