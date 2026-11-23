/* MAP
 * §1 imports si erori  L9-L36
 * §2 cerere HTTP cu token si timeout  L37-L119
 * §3 metadate: list/listFolders/listFiles/mkdir/trash  L120-L199
 * §4 upload resumabil si multipart  L200-L273
 * §5 download si revizii  L274-L299
 */

// §1 imports si erori
const crypto = require('crypto');
const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { sanitizeOp } = require('./error-log');

class DriveError extends Error {
  constructor(status, reason, message, extra = {}) {
    super(message || reason || `HTTP ${status}`);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason || '';
    this.domain = extra.domain || '';
    this.op = extra.op || '';
    this.retryAfterMs = extra.retryAfterMs || 0;
  }
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function parseRetryAfter(hdr) {
  if (!hdr) return 0;
  const secs = Number(hdr);
  if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  const dt = Date.parse(hdr);
  return Number.isFinite(dt) && dt > Date.now() ? dt - Date.now() : 0;
}

function buildSignal(userSignal, timeoutMs) {
  const parts = [];
  if (userSignal) parts.push(userSignal);
  if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) parts.push(AbortSignal.timeout(timeoutMs));
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : (AbortSignal.any ? AbortSignal.any(parts) : parts[0]);
}

function createDrive({ getToken, base, sleep, retryBase = 1000, onError = null, metaTimeoutMs = 60000, interactiveTimeoutMs = 20000, uploadTimeoutMs = 180000 }) {
  // §2 cerere HTTP cu token si timeout
  const report = (entry) => { if (onError) onError(entry); };

  async function raw(url, opts = {}, again = true) {
    const { timeoutMs = 0, ...fetchOpts } = opts;
    const userSignal = fetchOpts.signal;
    if (userSignal && userSignal.aborted) { const a = new Error('Request cancelled'); a.name = 'AbortError'; throw a; }
    const token = await getToken(false);
    const op = sanitizeOp(fetchOpts.method || 'GET', url);
    const signal = buildSignal(userSignal, timeoutMs);
    let res;
    try {
      res = await fetch(url, { ...fetchOpts, signal, headers: { ...fetchOpts.headers, Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (userSignal && userSignal.aborted) { e.name = 'AbortError'; throw e; }
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const code = timedOut ? 'ETIMEDOUT' : ((e && (e.code || (e.cause && e.cause.code))) || 'network');
      report({ op, status: 0, reason: code, domain: 'network', message: timedOut ? `Request timed out (${Math.round(timeoutMs / 1000)}s)` : (e.message || String(e)) });
      if (timedOut) { const te = new Error(`Google Drive request timed out after ${Math.round(timeoutMs / 1000)}s`); te.code = 'ETIMEDOUT'; throw te; }
      throw e;
    }
    if (res.status === 401 && again) {
      await getToken(true);
      return raw(url, opts, false);
    }
    return res;
  }

  async function toError(res, op = '') {
    let body = {};
    try { body = await res.json(); } catch (e) { body = { error: { message: `non-JSON response (${e.message})` } }; }
    const e = body.error || {};
    const first = (e.errors && e.errors[0]) || {};
    const reason = first.reason || e.status || '';
    const domain = first.domain || '';
    const retryAfter = res.headers && res.headers.get ? (res.headers.get('retry-after') || '') : '';
    const retryAfterMs = parseRetryAfter(retryAfter);
    const message = e.message || res.statusText || reason || `HTTP ${res.status}`;
    report({ op, status: res.status, reason, domain, message, retryAfter });
    return new DriveError(res.status, reason, message, { domain, op, retryAfterMs });
  }

  // JSON cu reincercari scurte pe 5xx / retea / rafala scurta de rate-limit; POST pe timeout nu se repeta orb (evita duplicate).
  async function json(method, path, { query, body, signal, interactive = false } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const op = sanitizeOp(method, url);
    const timeoutMs = interactive ? interactiveTimeoutMs : metaTimeoutMs;
    const idempotent = method === 'GET' || method === 'PATCH';
    for (let n = 0; ; n++) {
      let res;
      try {
        res = await raw(url, {
          method,
          signal,
          timeoutMs,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if ((signal && signal.aborted) || e.name === 'AbortError') throw e;
        if (e.code === 'ETIMEDOUT' && (!idempotent || n >= 1)) throw e;
        if (n < 3) { await sleep(retryBase * 2 ** n); continue; }
        throw e;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      const err = await toError(res, op);
      const isRate = res.status === 429 || (res.status === 403 && (err.reason === 'userRateLimitExceeded' || err.reason === 'rateLimitExceeded'));
      const retryable = res.status >= 500 || (isRate && n < 2);
      if (retryable && n < 3 && !(signal && signal.aborted)) { await sleep(Math.max(retryBase * 2 ** n, err.retryAfterMs || 0)); continue; }
      throw err;
    }
  }

  // §3 metadate: list / listFolders / listFiles / mkdir / trash
  const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,shared';

  async function about() {
    return json('GET', '/drive/v3/about', { query: { fields: 'user(emailAddress,displayName),storageQuota' } });
  }

  async function list(parentId, pageToken, opts = {}) {
    const query = {
      q: `'${esc(parentId)}' in parents and trashed=false`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: 'folder,name',
      pageSize: '1000',
    };
    if (pageToken) query.pageToken = pageToken;
    return json('GET', '/drive/v3/files', { query, signal: opts.signal, interactive: !!opts.interactive });
  }

  async function listQuery(baseQuery, opts = {}) {
    const out = [];
    let token;
    do {
      const query = token ? { ...baseQuery, pageToken: token } : baseQuery;
      const r = await json('GET', '/drive/v3/files', { query, signal: opts.signal, interactive: !!opts.interactive });
      out.push(...r.files);
      token = r.nextPageToken;
    } while (token);
    return out;
  }

  const listAll = (parentId, opts = {}) => listQuery({
    q: `'${esc(parentId)}' in parents and trashed=false`,
    fields: `nextPageToken,files(${FILE_FIELDS})`,
    orderBy: 'folder,name',
    pageSize: '1000',
  }, opts);

  // Doar subfolderele directe (commander Sync) / doar fisiere nesortate (cache uploader, fara cost orderBy)
  const listFolders = (parentId, opts = {}) => listQuery({
    q: `'${esc(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'nextPageToken,files(id,name,mimeType)',
    orderBy: 'name',
    pageSize: '1000',
  }, opts);

  const listFiles = (parentId, opts = {}) => listQuery({
    q: `'${esc(parentId)}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'nextPageToken,files(id,name,size)',
    pageSize: '1000',
  }, opts);

  async function findChild(parentId, name, folderOnly) {
    let q = `name='${esc(name)}' and '${esc(parentId)}' in parents and trashed=false`;
    if (folderOnly) q += " and mimeType='application/vnd.google-apps.folder'";
    const r = await json('GET', '/drive/v3/files', { query: { q, fields: `files(${FILE_FIELDS})`, pageSize: '10' } });
    return r.files[0] || null;
  }

  async function ensureFolderEx(parentId, name) {
    const hit = await findChild(parentId, name, true);
    if (hit) return { id: hit.id, created: false };
    const made = await json('POST', '/drive/v3/files', {
      query: { fields: 'id' },
      body: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    });
    return { id: made.id, created: true };
  }

  async function ensureFolder(parentId, name) {
    return (await ensureFolderEx(parentId, name)).id;
  }

  async function createEmptyFile(parentId, name) {
    return json('POST', '/drive/v3/files', { query: { fields: 'id,size' }, body: { name, parents: [parentId] } });
  }

  // Coș Drive (recuperabil 30 zile), nu stergere definitiva.
  async function trash(id) {
    return json('PATCH', `/drive/v3/files/${encodeURIComponent(id)}`, { query: { fields: 'id' }, body: { trashed: true } });
  }

  // §4 upload resumabil si multipart
  // updateId: inlocuieste continutul unui fisier existent (Drive pastreaza versiunea veche ca revizie; keepForever o fixeaza).
  async function initUpload({ name, parentId, size, updateId, keepForever }) {
    const method = updateId ? 'PATCH' : 'POST';
    const url = updateId
      ? new URL(`${base}/upload/drive/v3/files/${encodeURIComponent(updateId)}?uploadType=resumable&fields=id,size${keepForever ? '&keepRevisionForever=true' : ''}`)
      : new URL(`${base}/upload/drive/v3/files?uploadType=resumable&fields=id,size`);
    const res = await raw(url, {
      method,
      timeoutMs: metaTimeoutMs,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify(updateId ? {} : { name, parents: [parentId] }),
    });
    if (!res.ok) throw await toError(res, sanitizeOp(method, url));
    const loc = res.headers.get('location');
    if (!loc) throw new DriveError(res.status, 'noSessionUri', 'Drive nu a returnat adresa sesiunii de upload');
    return loc;
  }

  // Raspuns unificat: {done:true,file} | {done:false,next} ; sesiune pierduta => DriveError sessionGone
  async function readUploadResponse(res, op) {
    if (res.status === 200 || res.status === 201) return { done: true, file: await res.json() };
    if (res.status === 308) {
      const m = /bytes=0-(\d+)/.exec(res.headers.get('range') || '');
      return { done: false, next: m ? Number(m[1]) + 1 : 0 };
    }
    if (res.status === 404 || res.status === 410) {
      report({ op, status: res.status, reason: 'sessionGone', domain: 'upload', message: 'Upload session expired' });
      throw new DriveError(404, 'sessionGone', 'Sesiunea de upload a expirat', { op });
    }
    throw await toError(res, op);
  }

  async function putChunk(sessionUri, buf, start, total) {
    const res = await raw(sessionUri, {
      method: 'PUT',
      redirect: 'manual',
      timeoutMs: uploadTimeoutMs,
      headers: { 'Content-Range': `bytes ${start}-${start + buf.length - 1}/${total}` },
      body: buf,
    });
    return readUploadResponse(res, sanitizeOp('PUT', sessionUri));
  }

  async function queryOffset(sessionUri, total) {
    const res = await raw(sessionUri, { method: 'PUT', redirect: 'manual', timeoutMs: metaTimeoutMs, headers: { 'Content-Range': `bytes */${total}` } });
    return readUploadResponse(res, sanitizeOp('PUT', sessionUri));
  }

  // Upload dintr-o singura cerere pentru fisiere mici (<= 2 MiB): trimite metadate + continut intr-un singur HTTP POST/PATCH
  async function uploadMultipart({ name, parentId, buf, updateId, keepForever }) {
    const boundary = `nd_${crypto.randomBytes(12).toString('hex')}`;
    const meta = JSON.stringify(updateId ? {} : { name, parents: [parentId] });
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const body = Buffer.concat([head, buf, tail]);
    const method = updateId ? 'PATCH' : 'POST';
    const url = updateId
      ? new URL(`${base}/upload/drive/v3/files/${encodeURIComponent(updateId)}?uploadType=multipart&fields=id,size${keepForever ? '&keepRevisionForever=true' : ''}`)
      : new URL(`${base}/upload/drive/v3/files?uploadType=multipart&fields=id,size`);
    const res = await raw(url, {
      method,
      timeoutMs: uploadTimeoutMs,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) },
      body,
    });
    if (!res.ok) throw await toError(res, sanitizeOp(method, url));
    return res.json();
  }

  // §5 download si revizii
  // Fisiere normale: alt=media. Fisiere Google (Docs/Sheets/Slides): /export cu un tip de iesire (exportMime).
  async function listRevisions(id) {
    const r = await json('GET', `/drive/v3/files/${encodeURIComponent(id)}/revisions`, { query: { fields: 'revisions(id,modifiedTime,size,keepForever)', pageSize: '200' } });
    return r.revisions || [];
  }

  async function setKeepForever(id, revisionId, keepForever) {
    return json('PATCH', `/drive/v3/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`, { query: { fields: 'id,keepForever' }, body: { keepForever: !!keepForever } });
  }

  // revisionId: descarca o versiune veche a fisierului in loc de cea curenta.
  async function download(id, dest, { signal, onProgress, exportMime, revisionId } = {}) {
    const url = new URL(`${base}/drive/v3/files/${encodeURIComponent(id)}${revisionId ? `/revisions/${encodeURIComponent(revisionId)}` : ''}${exportMime ? '/export' : ''}`);
    if (exportMime) url.searchParams.set('mimeType', exportMime); else url.searchParams.set('alt', 'media');
    const res = await raw(url, { signal });
    if (!res.ok) throw await toError(res, sanitizeOp('GET', url));
    const counter = new Transform({ transform(chunk, _enc, cb) { if (onProgress) onProgress(chunk.length); cb(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest), { signal });
  }

  return { json, about, list, listAll, listFolders, listFiles, findChild, ensureFolder, ensureFolderEx, createEmptyFile, trash, initUpload, putChunk, queryOffset, uploadMultipart, download, listRevisions, setKeepForever };
}

module.exports = { createDrive, DriveError };
