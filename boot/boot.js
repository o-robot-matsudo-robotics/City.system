(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DB = 'citysys', STORE = 'k';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const ui = {
    status(t) { $('boot-status').textContent = t || ''; },
    bar(p) { $('boot-bar').firstChild.style.width = Math.round(clamp(p, 0, 1) * 100) + '%'; },
    hint(t) { $('boot-hint').textContent = t || ''; },
    fatal(m) { $('boot-fatal').textContent = m || ''; ui.status(''); },
    hide() { $('boot').hidden = true; },
    // v1.2：「もう一度」のボタン（fn を渡さなければ隠す）
    retry(label, fn) {
      let b = $('boot-retry');
      if (!b) { b = document.createElement('button'); b.id = 'boot-retry'; b.type = 'button'; b.className = 'go'; const f = $('boot-fatal'); f.parentNode.insertBefore(b, f.nextSibling); }
      b.textContent = label || 'もう一度'; b.hidden = !fn; b.onclick = fn ? () => { b.hidden = true; fn(); } : null;
    },
  };

  function swMsg(msg, onProgress, timeoutMs) {
    return new Promise((res) => {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller; if (!sw) return res(null);
      const ch = new MessageChannel(); let to = 0;
      if (timeoutMs !== 0) to = setTimeout(() => res(null), timeoutMs || 15000);
      ch.port1.onmessage = (e) => { const d = e.data || {}; if (d.type === 'cacheProgress') { if (onProgress) onProgress(d); return; } clearTimeout(to); res(d); };
      sw.postMessage(msg, [ch.port2]);
    });
  }
  function idb() { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function idbPut(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
  async function idbDel(k) { const db = await idb(); return new Promise((res) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(k); t.oncomplete = () => res(); t.onerror = () => res(); }); }
  function b64(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  // 全角→半角・小文字・空白とハイフンを無視（公開スクリプトと同じ）
  function normPw(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\-‐‑–—―ーｰ_・]/g, ''); }
  async function unwrapKey(k, pw) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normPw(pw)), 'PBKDF2', false, ['deriveKey']);
    const kek = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(k.salt), iterations: k.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(k.iv) }, kek, b64(k.wrapped))); } catch (e) { return null; }
  }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { } return null; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // この版のページが必要とする sw.js の版（これより古い sw.js のときは、新しい物に切り替わるまで待つ）
  const SW_WANT = 1.2;
  const swNum = (v) => { const m = /(\d+)\.(\d+)$/.exec(String(v || '')); return m ? +m[1] + (+m[2]) / 10 : 0; };
  function waitController(ms) {
    return new Promise((r) => { const t = setTimeout(r, ms); navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); r(); }, { once: true }); });
  }

  async function setupWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return { mode: 'plain' };
    let reg = null;
    try { reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }); } catch (e) { return { mode: 'plain', err: e }; }
    // v1.2：新しい sw.js が公開されていれば、それに切り替わってから進む（古い sw.js のままだと、直した所が効かない）
    try { await Promise.race([reg.update(), sleep(6000)]); } catch (e) { }
    if (navigator.serviceWorker.controller && (reg.installing || reg.waiting)) await waitController(8000);
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await waitController(4000);
      if (!navigator.serviceWorker.controller) { if (!ss('citysys-sw-reload')) { ss('citysys-sw-reload', '1'); location.reload(); await new Promise(() => { }); } return { mode: 'plain' }; }
    }
    ss('citysys-sw-reload', null);
    let st = await swMsg({ type: 'status' }, null, 15000);
    if (st && !st.plain && swNum(st.version) < SW_WANT) {
      // まだ古い sw.js が受け持っている：少し待って、だめなら 1 回だけ開き直す
      await waitController(5000);
      st = await swMsg({ type: 'status' }, null, 15000);
      if (st && swNum(st.version) < SW_WANT && !ss('citysys-sw-upd')) { ss('citysys-sw-upd', '1'); location.reload(); await new Promise(() => { }); }
    }
    B.swVersion = st && st.version || '';
    if (!st || st.plain) return { mode: 'plain' };
    return { mode: 'enc', ok: st.ok };
  }

  function askPassword() {
    return new Promise((resolve) => {
      const f = $('boot-form'), inp = $('boot-pw'), err = $('boot-err');
      f.hidden = false; ui.status('パスワードを入れてください（この端末で 1 回だけ）'); ui.bar(0);
      ui.hint('大文字・小文字・「-」は区別しません。\n入れた鍵はこの端末だけに保存されます。');
      let busy = false;
      async function tryIt(ev) {
        if (ev) ev.preventDefault();
        if (busy) return;
        if (!inp.value) { err.textContent = 'パスワードを入れてください'; return; }
        busy = true;
        try {
          err.textContent = ''; ui.status('鍵を確かめています…');
          let j = null;
          try { j = await (await fetch('files.json', { cache: 'no-store' })).json(); } catch (e) { err.textContent = 'ネットにつながっていません。はじめの 1 回はネットが必要です'; ui.status(''); return; }
          const key = await unwrapKey(j.key, inp.value);
          if (!key) { err.textContent = 'パスワードが違います'; ui.status(''); return; }
          await idbPut('content', key);
          const r = await swMsg({ type: 'reloadKey' }, null, 20000);
          if (!r || !r.ok) { err.textContent = '鍵は合いましたが、ファイルの一覧を開けませんでした。もう一度試してください'; ui.status(''); return; }
          inp.value = ''; f.hidden = true; ui.hint(''); resolve();
        } finally { busy = false; }
      }
      f.addEventListener('submit', tryIt);
    });
  }

  async function loadCfg() {
    const el = $('app-cfg');
    if (el) { try { return JSON.parse(el.textContent); } catch (e) { } }
    const r = await fetch('app/cfg.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' cfg');
    return await r.json();
  }
  function loadCss(href) { return new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = res; l.onerror = res; document.head.appendChild(l); }); }
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('読み込めません: ' + src)); document.body.appendChild(s); }); }

  const B = window.__boot = { ui, swMsg, forgetKey: () => idbDel('content'), cfg: null, mode: 'plain', normPw };

  async function start() {
    try {
      ui.status('準備しています…');
      const w = await setupWorker();
      B.mode = w.mode;
      if (w.mode === 'enc' && !w.ok) await askPassword();
      ui.status('読み込んでいます…');
      B.cfg = await loadCfg();
      await loadCss('app/game.css');
      await loadScript('app/game.js');
    } catch (e) {
      console.error(e);
      ui.fatal('開けませんでした。\n' + String(e && e.message || e) + '\n\nネットにつながっているか確かめて、もう一度開いてください');
      ui.retry('もう一度開く', () => location.reload());
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
