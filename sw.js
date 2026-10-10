'use strict';
// e/*.bin を端末の鍵で元に戻して渡す。読んだ物は端末に保存（オフライン用）
const SW_VERSION = 'citysys-sw-1.0';
const ENC_CACHE = 'citysys-enc-v1';
const APP_CACHE = 'citysys-app-v1';
const DB_NAME = 'citysys', DB_STORE = 'k';
const SEG = 1 << 20;
const TAG = 16;

let scopePath = new URL(self.registration.scope).pathname;
// 目録は「ページを開いたとき」に読んだ物を使い続ける（途中で新しい版を公開しても混ざらない）
let manifest = null, manifestState = 0, manifestPromise = null, manifestSeq = 0;
let keyPromise = null;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [ENC_CACHE, APP_CACHE];
    for (const k of await caches.keys()) if (k.startsWith('citysys-') && !keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
async function loadKey() {
  try {
    const raw = await idbGet('content');
    if (!raw) return null;
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  } catch (e) { return null; }
}
function getKey(reload) { if (!keyPromise || reload) keyPromise = loadKey(); return keyPromise; }

function b64(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
// net＝ネットの最新を読む（ページを開いたとき・鍵を入れたとき）。それ以外は保存してある目録
async function fetchManifestJson(net) {
  const url = scopePath + 'files.json';
  const c = await caches.open(APP_CACHE);
  if (!net) { const m = await c.match(url); if (m) { try { return await m.json(); } catch (e) { } } }
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) { await c.put(url, r.clone()); return await r.json(); }
    if (r.status === 404) return { plain: true };
  } catch (e) { /* オフライン */ }
  const m = await c.match(url);
  return m ? await m.json() : null;
}
async function loadManifest(force, net) {
  const j = await fetchManifestJson(net);
  if (!j) return null;
  if (j.plain || !j.m) return { plain: true, raw: j };
  const key = await getKey(force);
  if (!key) return { locked: true, raw: j };
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(j.m.iv) }, key, b64(j.m.data));
    const files = JSON.parse(new TextDecoder().decode(pt));
    return { raw: j, files: files.files || {}, build: files.build || '' };
  } catch (e) { return { locked: true, wrongKey: true, raw: j }; }
}
function getManifest(opts) {
  opts = opts || {};
  const retry = manifestState === 2 && (!manifest || manifest.locked);
  if (opts.force || manifestState === 0 || retry) {
    const my = ++manifestSeq; manifestState = 1;
    manifestPromise = loadManifest(!!opts.force, !!opts.net).then(
      (m) => { if (my === manifestSeq) { manifest = m; manifestState = 2; } return m; },
      () => { if (my === manifestSeq) { manifest = null; manifestState = 2; } return null; });
  }
  return manifestPromise;
}
function blobUrls(m) {
  const want = new Set();
  if (m && m.files) for (const rel in m.files) { const ent = m.files[rel]; const parts = ent.p || 1; for (let p = 0; p < parts; p++) want.add(scopePath + 'e/' + ent.i + '.bin' + (parts > 1 ? '.' + p : '')); }
  return want;
}
// 今の目録に無い古い暗号ファイルを端末から消す
async function pruneEnc(m) {
  if (!m || !m.files) return 0;
  const want = blobUrls(m); if (want.size === 0) return 0;
  const c = await caches.open(ENC_CACHE); let n = 0;
  for (const r of await c.keys()) { if (!want.has(new URL(r.url).pathname)) { try { await c.delete(r); n++; } catch (e) { } } }
  return n;
}

async function encPart(url) {
  const c = await caches.open(ENC_CACHE);
  const hit = await c.match(url);
  if (hit) return hit;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  try { await c.put(url, r.clone()); } catch (e) { /* 容量不足など：保存しないで続ける */ }
  return r;
}

function inflateStream(src) {
  if (typeof DecompressionStream !== 'undefined') return src.pipeThrough(new DecompressionStream('gzip'));
  throw new Error('この端末のブラウザは古いので開けません（iOS 16.4 以降が必要）');
}

function decryptStream(ent, key) {
  const parts = ent.p || 1, nonce = b64(ent.v), csize = ent.c;
  const nseg = Math.max(1, Math.ceil(csize / SEG));
  let part = 0, reader = null, buf = new Uint8Array(0), seg = 0;
  async function nextChunk() {
    while (true) {
      if (!reader) {
        if (part >= parts) return null;
        const url = scopePath + 'e/' + ent.i + '.bin' + (parts > 1 ? '.' + part : '');
        part++;
        const r = await encPart(url);
        reader = r.body.getReader();
      }
      const { done, value } = await reader.read();
      if (done) { reader = null; continue; }
      return value;
    }
  }
  return new ReadableStream({
    async pull(ctrl) {
      try {
        while (true) {
          if (seg >= nseg) { ctrl.close(); return; }
          const last = seg === nseg - 1;
          const plainLen = last ? csize - seg * SEG : SEG;
          const need = plainLen + TAG;
          if (buf.length >= need) {
            const ct = buf.subarray(0, need); buf = buf.slice(need);
            const iv = new Uint8Array(12); iv.set(nonce.subarray(0, 8), 0); new DataView(iv.buffer).setUint32(8, seg, false);
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([last ? 1 : 0]) }, key, ct);
            seg++; ctrl.enqueue(new Uint8Array(pt)); return;
          }
          const chunk = await nextChunk();
          if (!chunk) throw new Error('ファイルが途中で切れています');
          const nb = new Uint8Array(buf.length + chunk.length); nb.set(buf, 0); nb.set(chunk, buf.length); buf = nb;
        }
      } catch (e) { ctrl.error(e); }
    }
  });
}

async function serveEncrypted(ent) {
  const key = await getKey();
  if (!key) return new Response('locked', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  let body = decryptStream(ent, key);
  if (ent.z) body = inflateStream(body);
  const h = { 'Content-Type': ent.t || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (ent.n >= 0) h['Content-Length'] = String(ent.n);
  return new Response(body, { status: 200, headers: h });
}

// 起動用のファイル：ネット優先・だめなら保存から（オフラインでも開けるように）
async function appShell(req) {
  const c = await caches.open(APP_CACHE);
  try {
    const r = await fetch(req, { cache: 'no-cache' });
    if (r.ok && req.method === 'GET') { try { await c.put(req, r.clone()); } catch (e) { } }
    return r;
  } catch (e) {
    const m = await c.match(req, { ignoreSearch: true });
    if (m) return m;
    if (req.mode === 'navigate') { const i = await c.match(scopePath + 'index.html') || await c.match(scopePath); if (i) return i; }
    throw e;
  }
}
// 鍵が無くても読める物（パスワードの画面だけ）
function isOpen(rel) { return rel === '' || rel === 'index.html' || rel === 'sw.js' || rel === 'manifest.webmanifest' || /^boot\/[^/]+$/.test(rel); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return;
  let rel = decodeURIComponent(url.pathname.substring(scopePath.length));
  if (rel === 'files.json' || rel.startsWith('e/')) return;
  e.respondWith((async () => {
    const m = await getManifest();
    if (m && m.files) {
      const ent = m.files[rel];
      if (ent) return serveEncrypted(ent);
    } else if (m && m.locked && !isOpen(rel)) {
      return new Response('locked', { status: 403, headers: { 'Content-Type': 'text/plain' } });
    }
    return appShell(req);
  })());
});

self.addEventListener('message', (e) => {
  const d = e.data || {}; const port = e.ports && e.ports[0];
  const reply = (x) => { try { if (port) port.postMessage(x); else if (e.source) e.source.postMessage(x); } catch (er) { } };
  const job = (async () => {
    if (d.type === 'reloadKey') { await getKey(true); const m = await getManifest({ force: true, net: true }); reply({ type: 'key', ok: !!(m && m.files), locked: !!(m && m.locked), wrongKey: !!(m && m.wrongKey), plain: !!(m && m.plain) }); }
    else if (d.type === 'status') {
      // ページを開いたとき：ネットの最新の目録にする（この後はこれを使い続ける）
      const m = await getManifest({ force: true, net: true });
      reply({ type: 'status', version: SW_VERSION, ok: !!(m && m.files), locked: !!(m && m.locked), plain: !!(m && m.plain), build: m && m.build || '' });
      if (m && m.files) { try { await pruneEnc(m); } catch (er) { } }
    }
    else if (d.type === 'checkUpdate') {
      let latest = null;
      try { const r = await fetch(scopePath + 'files.json', { cache: 'no-store' }); if (r.ok) latest = await r.json(); } catch (er) { }
      const cur = manifest && manifest.raw;
      reply({ type: 'update', online: !!latest, update: !!(latest && latest.m && cur && cur.m && latest.m.iv !== cur.m.iv) });
    }
    else if (d.type === 'cacheAll') { await cacheAll(reply); }
    else if (d.type === 'cacheInfo') { reply(await cacheInfo()); }
    else if (d.type === 'clear') { await caches.delete(ENC_CACHE); reply({ type: 'cleared' }); }
  })().catch(er => reply({ type: 'error', message: String(er && er.message || er) }));
  try { e.waitUntil(job); } catch (er) { }
});

async function cacheInfo() {
  const m = await getManifest();
  if (!m || !m.files) return { type: 'cacheInfo', total: 0, have: 0, bytesTotal: 0, bytesHave: 0 };
  const c = await caches.open(ENC_CACHE);
  const keys = new Set((await c.keys()).map(r => new URL(r.url).pathname));
  let total = 0, have = 0, bt = 0, bh = 0;
  for (const rel in m.files) {
    const ent = m.files[rel]; const parts = ent.p || 1;
    for (let p = 0; p < parts; p++) {
      const u = scopePath + 'e/' + ent.i + '.bin' + (parts > 1 ? '.' + p : '');
      const sz = Math.ceil((ent.e || 0) / parts);
      total++; bt += sz; if (keys.has(u)) { have++; bh += sz; }
    }
  }
  return { type: 'cacheInfo', total, have, bytesTotal: bt, bytesHave: bh };
}

async function cacheAll(reply) {
  const m = await getManifest();
  if (!m || !m.files) { reply({ type: 'cacheDone', ok: false, message: '鍵がありません' }); return; }
  const c = await caches.open(ENC_CACHE);
  const keys = new Set((await c.keys()).map(r => new URL(r.url).pathname));
  const list = [];
  for (const rel in m.files) {
    const ent = m.files[rel]; const parts = ent.p || 1;
    for (let p = 0; p < parts; p++) { const u = scopePath + 'e/' + ent.i + '.bin' + (parts > 1 ? '.' + p : ''); if (!keys.has(u)) list.push(u); }
  }
  await pruneEnc(m);
  let done = 0, failed = 0; const total = list.length; const N = 4; let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const u = list[idx++];
      try { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); await c.put(u, r); } catch (e) { failed++; }
      done++; if (done % 5 === 0 || done === total) reply({ type: 'cacheProgress', done, total, failed });
    }
  }
  await Promise.all(Array.from({ length: N }, worker));
  reply({ type: 'cacheDone', ok: failed === 0, done, total, failed });
}
