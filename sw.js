'use strict';
// e/*.bin を端末の鍵で元に戻して渡す。読んだ物は端末に保存（オフライン用）
// v1.2：
//   ・大きいファイルは、届いた所から元に戻して流す（端末への保存は後ろで進める。v1.0 は保存し終わるまで何も流さなかった）
//   ・つながらない・途中で切れた・止まったまま届かないときは、少し待って自動で取り直す（読んだ所の続きから）
//   ・次の 1 個を先に取り始めておく（小分けのファイルの間で待たない）
//   ・ページが先にまとめて保存できるように、ファイルの一覧（parts）を返す
const SW_VERSION = 'citysys-sw-1.2';
const ENC_CACHE = 'citysys-enc-v1';
const APP_CACHE = 'citysys-app-v1';
const DB_NAME = 'citysys', DB_STORE = 'k';
const SEG = 1 << 20;
const TAG = 16;
const RETRY = [800, 2000, 4500, 8000];   // 取り直すまでの待ち時間（ミリ秒）。この回数だけ取り直す
const STALL = 25000;                     // これだけ何も届かなければ、切れたとみなして取り直す

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String(e && e.message || e);

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
// 小分けにしたファイルの名前と大きさ（ps＝1 個の大きさ。公開スクリプト v0.41.5 から。無い古い物はおおよそ）
function partUrl(ent, p) { const parts = ent.p || 1; return scopePath + 'e/' + ent.i + '.bin' + (parts > 1 ? '.' + p : ''); }
function partSize(ent, p) {
  const parts = ent.p || 1, e = ent.e || 0;
  if (parts === 1) return e;
  const ps = ent.ps || Math.ceil(e / parts);
  return Math.max(0, Math.min(ps, e - p * ps));
}
function blobUrls(m) {
  const want = new Set();
  if (m && m.files) for (const rel in m.files) { const ent = m.files[rel]; for (let p = 0; p < (ent.p || 1); p++) want.add(partUrl(ent, p)); }
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
// 壊れていた・足りなかったファイル：保存した物を消す（次に開いたときネットから取り直す）
async function dropCached(ent) {
  try { const c = await caches.open(ENC_CACHE); for (let p = 0; p < (ent.p || 1); p++) await c.delete(partUrl(ent, p)); } catch (e) { }
}

// v1.2：ネットから 1 個取る。つながらないときは少し待って取り直す
async function netPart(url) {
  let last = null;
  for (let k = 0; k <= RETRY.length; k++) {
    // 返事（ヘッダー）が STALL ミリ秒来なければやめて取り直す（返事が来たら止めない＝中身の読み取りは readT が見る）
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = ac ? setTimeout(() => ac.abort(), STALL) : 0;
    try {
      const r = await fetch(url, ac ? { cache: 'no-store', signal: ac.signal } : { cache: 'no-store' });
      clearTimeout(to);
      if (r.ok) return r;
      last = new Error('HTTP ' + r.status);
      if (r.status === 404 || r.status === 403 || r.status === 410) break;   // 無い物は待っても無い
    } catch (e) { clearTimeout(to); last = e; }
    if (k < RETRY.length) await sleep(RETRY[k]);
  }
  throw new Error('受け取れません（' + errText(last) + '）');
}
// 保存してあればそれを、無ければネットから（fresh＝保存を見ないでネットから）
async function encPart(url, fresh) {
  const c = await caches.open(ENC_CACHE);
  if (!fresh) { const hit = await c.match(url); if (hit) return hit; }
  const r = await netPart(url);
  // v1.1：保存は待たずに、届いた所から流す（保存は後ろで。容量不足などで保存できなくても続ける）
  c.put(url, r.clone()).catch(() => { });
  return r;
}
// 1 回読む。STALL ミリ秒なにも届かなければ失敗にする（モバイル回線で止まったままになるのを防ぐ）
function readT(reader) {
  let to = 0;
  return Promise.race([
    reader.read(),
    new Promise((_, rej) => { to = setTimeout(() => rej(new Error('届かないまま ' + (STALL / 1000) + ' 秒')), STALL); })
  ]).finally(() => clearTimeout(to));
}

function inflateStream(src) {
  if (typeof DecompressionStream !== 'undefined') return src.pipeThrough(new DecompressionStream('gzip'));
  throw new Error('この端末のブラウザは古いので開けません（iOS 16.4 以降が必要）');
}

// v1.2：うまく渡せなかったとき、開いているページに理由を知らせる（ページの画面に出す。ページ側は「network error」としかわからないため）
async function tellPages(msg) {
  try { for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage(msg); } catch (e) { }
}

function decryptStream(ent, key, rel) {
  const parts = ent.p || 1, nonce = b64(ent.v), csize = ent.c;
  const nseg = Math.max(1, Math.ceil(csize / SEG));
  let part = 0, reader = null, seg = 0;
  let pos = 0, skip = 0, fails = 0;   // 今の 1 個の中で読んだ量・取り直したときに飛ばす量・取り直した回数
  let ahead = null;                    // 次の 1 個（先に取り始めておく）
  // v1.1：届いた断片は並べておくだけにして、1 区切り（1MB＋16）たまったら 1 回だけつなぐ（毎回つなぎ直さない）
  let chunks = [], have = 0;
  function take(n) {
    const out = new Uint8Array(n); let o = 0;
    while (o < n) {
      const c = chunks[0], k = Math.min(c.length, n - o);
      out.set(c.subarray(0, k), o); o += k;
      if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k);
    }
    have -= n; return out;
  }
  async function open(fresh) {
    let r = null;
    if (!fresh && ahead && ahead.p === part) { r = await ahead.pr; ahead = null; }
    if (!r) r = await encPart(partUrl(ent, part), fresh);
    reader = r.body.getReader();
    const q = part + 1;
    if (q < parts && !(ahead && ahead.p === q)) ahead = { p: q, pr: encPart(partUrl(ent, q), false).catch(() => null) };
  }
  async function nextChunk() {
    while (true) {
      if (!reader) {
        if (part >= parts) return null;
        await open(false); pos = 0; skip = 0;
      }
      let res;
      try { res = await readT(reader); }
      catch (e) {
        // 途中で切れた・止まった：同じ物をネットから取り直して、読んだ所まで飛ばす
        try { reader.cancel(); } catch (er) { }
        reader = null;
        if (fails >= RETRY.length) throw new Error('受け取りが途中で切れました（' + errText(e) + '）');
        await sleep(RETRY[fails++]);
        skip = Math.max(skip, pos); pos = 0;
        await open(true);
        continue;
      }
      if (res.done) {
        if (pos < skip) throw new Error('取り直したファイルが短すぎます');
        reader = null; part++; fails = 0; continue;
      }
      let v = res.value;
      if (!v || !v.length) continue;
      if (pos < skip) { const s = Math.min(v.length, skip - pos); pos += s; if (s === v.length) continue; v = v.subarray(s); }
      pos += v.length;
      return v;
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
          if (have >= need) {
            const ct = take(need);
            const iv = new Uint8Array(12); iv.set(nonce.subarray(0, 8), 0); new DataView(iv.buffer).setUint32(8, seg, false);
            let pt;
            try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([last ? 1 : 0]) }, key, ct); }
            catch (e) { await dropCached(ent); throw new Error('ファイルが壊れています（もう一度開くとネットから取り直します）'); }
            seg++; ctrl.enqueue(new Uint8Array(pt)); return;
          }
          const chunk = await nextChunk();
          if (!chunk) { await dropCached(ent); throw new Error('ファイルが途中で切れています（もう一度開くとネットから取り直します）'); }
          chunks.push(chunk); have += chunk.length;
        }
      } catch (e) { await tellPages({ type: 'swError', rel: rel || '', part, parts, message: errText(e) }); ctrl.error(e); }
    },
    cancel() { try { if (reader) reader.cancel(); } catch (e) { } reader = null; ahead = null; chunks = []; have = 0; }
  });
}

async function serveEncrypted(ent, rel) {
  const key = await getKey();
  if (!key) return new Response('locked', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  let body = decryptStream(ent, key, rel);
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
      if (ent) return serveEncrypted(ent, rel);
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
    else if (d.type === 'ping') { reply({ type: 'pong', version: SW_VERSION }); }
    else if (d.type === 'parts') { reply(await partsInfo(d)); }
    else if (d.type === 'checkUpdate') {
      let latest = null;
      try { const r = await fetch(scopePath + 'files.json', { cache: 'no-store' }); if (r.ok) latest = await r.json(); } catch (er) { }
      const cur = manifest && manifest.raw;
      reply({ type: 'update', online: !!latest, update: !!(latest && latest.m && cur && cur.m && latest.m.iv !== cur.m.iv) });
    }
    else if (d.type === 'cacheAll') { await cacheAll(reply); }
    else if (d.type === 'cacheInfo') { reply(await cacheInfo()); }
    else if (d.type === 'clear') { await caches.delete(ENC_CACHE); reply({ type: 'cleared' }); }
  })().catch(er => reply({ type: 'error', message: errText(er) }));
  try { e.waitUntil(job); } catch (er) { }
});

// v1.2：ページが先に保存する物の一覧（files＝名前、prefixes＝この文字で始まる物）。have＝もう端末にある
async function partsInfo(d) {
  const m = await getManifest();
  if (!m || !m.files) return { type: 'parts', ok: false, version: SW_VERSION };
  const files = new Set(d.files || []), pre = d.prefixes || [];
  const c = await caches.open(ENC_CACHE);
  const keys = new Set((await c.keys()).map(r => new URL(r.url).pathname));
  const list = [];
  for (const rel in m.files) {
    if (!files.has(rel) && !pre.some(p => rel.startsWith(p))) continue;
    const ent = m.files[rel];
    const exact = (ent.p || 1) === 1 || !!ent.ps;   // 大きさが正確にわかる（確かめに使える）
    for (let p = 0; p < (ent.p || 1); p++) { const u = partUrl(ent, p); list.push({ rel, url: u, size: partSize(ent, p), exact, have: keys.has(u) }); }
  }
  return { type: 'parts', ok: true, version: SW_VERSION, cache: ENC_CACHE, list };
}

async function cacheInfo() {
  const m = await getManifest();
  if (!m || !m.files) return { type: 'cacheInfo', total: 0, have: 0, bytesTotal: 0, bytesHave: 0 };
  const c = await caches.open(ENC_CACHE);
  const keys = new Set((await c.keys()).map(r => new URL(r.url).pathname));
  let total = 0, have = 0, bt = 0, bh = 0;
  for (const rel in m.files) {
    const ent = m.files[rel];
    for (let p = 0; p < (ent.p || 1); p++) {
      const u = partUrl(ent, p), sz = partSize(ent, p);
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
    const ent = m.files[rel];
    for (let p = 0; p < (ent.p || 1); p++) { const u = partUrl(ent, p); if (!keys.has(u)) list.push(u); }
  }
  await pruneEnc(m);
  let done = 0, failed = 0; const total = list.length; const N = 4; let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const u = list[idx++];
      try { const r = await netPart(u); await c.put(u, r); } catch (e) { failed++; }
      done++; if (done % 5 === 0 || done === total) reply({ type: 'cacheProgress', done, total, failed });
    }
  }
  await Promise.all(Array.from({ length: N }, worker));
  reply({ type: 'cacheDone', ok: failed === 0, done, total, failed });
}
