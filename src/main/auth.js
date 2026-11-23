/* MAP
 * §1 imports si stocare criptata  L8-L35
 * §2 client OAuth (import JSON)  L36-L44
 * §3 login PKCE pe loopback  L45-L97
 * §4 token de acces + logout  L98-L120
 */

// §1 imports si stocare criptata
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { safeStorage, shell } = require('electron');
const cfg = require('./config');

function createAuth(dataDir, { onError = null } = {}) {
  const file = path.join(dataDir, 'auth.bin');
  fs.mkdirSync(dataDir, { recursive: true });

  // Tot ce e secret (client secret, refresh token) se scrie criptat cu DPAPI (cheia Windows a utilizatorului).
  function read() {
    try {
      const buf = fs.readFileSync(file);
      return JSON.parse(safeStorage.decryptString(buf));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('auth.bin ilizibil:', e.message);
      return {};
    }
  }
  function write(obj) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption (DPAPI) is not available for this account');
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(obj)));
  }
  const patch = (p) => write({ ...read(), ...p });

  // §2 client OAuth (import JSON descarcat din Google Cloud Console)
  function importClient(jsonPath) {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const c = raw.installed || raw.web;
    if (!c || !c.client_id || !c.client_secret) throw new Error('This file is not an OAuth client ID of type Desktop app');
    patch({ clientId: c.client_id, clientSecret: c.client_secret });
    return true;
  }

  // §3 login PKCE pe loopback (browserul de sistem; parola Google nu trece prin aplicatie)
  const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function tokenCall(params) {
    const s = read();
    const body = new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, ...params });
    let res;
    try {
      res = await fetch(cfg.TOKEN_URL, { method: 'POST', body });
    } catch (e) {
      if (onError) onError({ op: 'POST /oauth2/token', status: 0, reason: (e && e.code) || 'network', domain: 'oauth', message: e.message || String(e) });
      throw e;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = j.error_description || j.error || `HTTP ${res.status}`;
      if (onError) onError({ op: 'POST /oauth2/token', status: res.status, reason: j.error || 'oauth_error', domain: 'oauth', message: msg });
      const e = new Error(msg);
      e.code = j.error;
      throw e;
    }
    return j;
  }

  function login() {
    const s = read();
    if (!s.clientId) return Promise.reject(new Error('Import the OAuth client file first'));
    const verifier = b64u(crypto.randomBytes(48));
    const state = b64u(crypto.randomBytes(16));
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/') { res.writeHead(404).end(); return; }
        const done = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<body style="font:16px sans-serif;padding:40px">${msg}</body>`); };
        if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
          done('Authorization rejected or invalid. You can close this tab.');
          server.close();
          reject(new Error(u.searchParams.get('error') || 'Authorization rejected'));
          return;
        }
        try {
          const redirect = `http://127.0.0.1:${server.address().port}`;
          const t = await tokenCall({ code: u.searchParams.get('code'), code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect });
          if (!t.refresh_token) throw new Error('Google did not return a refresh token; try again (revoke the old access in your Google account first)');
          patch({ refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
          done('Connected. You can close this tab and return to NexDrive.');
          resolve(true);
        } catch (e) { done(`Eroare: ${e.message}`); reject(e); }
        server.close();
      });
      server.listen(0, '127.0.0.1', () => {
        const redirect = `http://127.0.0.1:${server.address().port}`;
        const url = new URL(cfg.AUTH_URL);
        const q = {
          client_id: s.clientId, redirect_uri: redirect, response_type: 'code', scope: cfg.SCOPE, state,
          code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
          access_type: 'offline', prompt: 'consent',
        };
        for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
        shell.openExternal(url.toString());
      });
      setTimeout(() => { server.close(); reject(new Error('Autorizarea a expirat (5 minute)')); }, 5 * 60 * 1000).unref();
    });
  }

  // §4 token de acces + logout
  async function getToken(force) {
    const s = read();
    if (!s.refreshToken) throw Object.assign(new Error('Not signed in'), { code: 'not_logged_in' });
    if (!force && s.accessToken && s.expiresAt - 60000 > Date.now()) return s.accessToken;
    try {
      const t = await tokenCall({ refresh_token: s.refreshToken, grant_type: 'refresh_token' });
      patch({ accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
      return t.access_token;
    } catch (e) {
      if (e.code === 'invalid_grant') patch({ refreshToken: '', accessToken: '' }); // revocat sau expirat (app in „Testing” = 7 zile)
      throw e;
    }
  }

  const status = () => { const s = read(); return { hasClient: !!s.clientId, loggedIn: !!s.refreshToken }; };
  const logout = () => patch({ refreshToken: '', accessToken: '', expiresAt: 0 });

  return { importClient, login, getToken, status, logout };
}

module.exports = { createAuth };
