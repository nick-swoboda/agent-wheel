'use strict';

const fs = require('fs');
const http = require('http');

function cdpPort(opts) {
  const o = opts || {};
  if (o.cdpPort) return Number(o.cdpPort);
  if (process.env.CONVOBUS_CURSOR_CDP_PORT) return Number(process.env.CONVOBUS_CURSOR_CDP_PORT);
  return 9222;
}

function httpJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 2000, () => {
      req.destroy();
      reject(new Error('cdp http timeout'));
    });
  });
}

async function listTargets(port) {
  try {
    return await httpJson('http://127.0.0.1:' + port + '/json/list');
  } catch {
    try {
      return await httpJson('http://127.0.0.1:' + port + '/json');
    } catch {
      return null;
    }
  }
}

function pickPage(targets) {
  if (!Array.isArray(targets)) return null;
  const pages = targets.filter((t) => t && (t.type === 'page' || t.webSocketDebuggerUrl) && t.webSocketDebuggerUrl);
  return (
    pages.find((t) => /Convo Cursor App/i.test(t.title || '')) ||
    pages.find((t) => /cursor/i.test(t.title || t.url || '')) ||
    pages[0] ||
    null
  );
}

function cdpCall(ws, id, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error('cdp timeout ' + method));
    }, timeoutMs || 8000);
    function onMsg(ev) {
      let msg;
      try {
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString();
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withCdp(port, fn) {
  const targets = await listTargets(port);
  const page = pickPage(targets);
  if (!page) return { ok: false, reason: 'no cdp page', looked: { port, n: Array.isArray(targets) ? targets.length : 0 } };
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  try {
    return await fn(ws, page);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

function readComposerExpr() {
  return `(() => {
    const el = document.querySelector('.aislash-editor-input');
    if (!el) return { found: false };
    const t = (el.innerText || el.textContent || el.value || '').replace(/\\u00a0/g, ' ');
    return { found: true, text: t, n: t.length };
  })()`;
}

function normalizeComposerText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/[\r\u2028\u2029]/g, '\n');
}

function selectComposerContentsExpr() {
  return `(() => {
    const el = document.querySelector('.aislash-editor-input');
    if (!el) return { ok: false, reason: 'no composer' };
    el.focus({ preventScroll: true });
    if (typeof el.select === 'function') el.select();
    else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { ok: true };
  })()`;
}

function replaceComposerExpr(text) {
  return `(() => {
    const el = document.querySelector('.aislash-editor-input');
    if (!el) return { ok: false, reason: 'no composer' };
    el.focus({ preventScroll: true });
    if (typeof el.select === 'function') el.select();
    else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { ok: document.execCommand('insertText', false, ${JSON.stringify(String(text))}) };
  })()`;
}

function focusComposerExpr() {
  return `(() => {
    const el = document.querySelector('.aislash-editor-input');
    if (!el) return { ok: false, reason: 'no composer' };
    el.focus({ preventScroll: true });
    return { ok: true, focused: document.activeElement === el };
  })()`;
}

function clickSendExpr() {
  return `(() => {
    const send = document.querySelector('.send-with-mode .anysphere-icon-button') || document.querySelector('.send-with-mode');
    if (!send) return { ok: false, reason: 'no send-with-mode' };
    const br = send.getBoundingClientRect();
    return { ok: true, x: br.x + br.width / 2, y: br.y + br.height / 2, w: br.width, h: br.height };
  })()`;
}

function sidebarNeedleExpr(needle) {
  return (
    '(() => { const needle = ' +
    JSON.stringify(needle) +
    '; const cells = [...document.querySelectorAll(".agent-sidebar-cell")]; const cell = cells.find((n) => { const t = n.innerText || ""; return t.includes(needle) && !/^\\s*New Agent/.test(t); }); if (!cell) return { ok: false, n: cells.length }; const br = cell.getBoundingClientRect(); const x = br.left + Math.min(24, br.width / 2); const y = br.top + br.height / 2; for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) { cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: 1 })); } cell.click(); return { ok: true, text: cell.innerText.slice(0, 80) }; })()'
  );
}

function firstUserQuery(sessionFile) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return null;
  const raw = fs.readFileSync(sessionFile, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const text = o && o.message && Array.isArray(o.message.content) ? o.message.content.map((c) => c && c.text).filter(Boolean).join('\n') : '';
      const m = String(text).match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
      const q = (m ? m[1] : text).trim();
      if (q) return q.slice(0, 80);
    } catch {
      /* skip */
    }
  }
  return null;
}

async function sendCursorComposer(text, opts) {
  const port = cdpPort(opts);
  if (typeof WebSocket !== 'function') {
    return { ok: false, miss: true, submitted: false, method: 'ax', reason: 'no WebSocket' };
  }
  const body = String(text || '');
  if (!body) {
    return { ok: false, miss: true, submitted: false, method: 'ax', reason: 'empty body' };
  }
  let id = 0;
  const next = () => ++id;
  try {
    const result = await withCdp(port, async (ws) => {
      await cdpCall(ws, next(), 'Runtime.enable');
      const needle = firstUserQuery(opts && opts.sessionFile);
      if (needle) {
        const side = await cdpCall(ws, next(), 'Runtime.evaluate', {
          expression: sidebarNeedleExpr(needle),
          returnByValue: true,
        });
        const sideVal = side && side.result && side.result.value;
        if (sideVal && sideVal.ok) await sleep(400);
      }
      const focused = await cdpCall(ws, next(), 'Runtime.evaluate', {
        expression: focusComposerExpr(),
        returnByValue: true,
      });
      const focusVal = focused && focused.result && focused.result.value;
      if (!focusVal || !focusVal.ok) {
        return { ok: false, reason: 'composer not in page', focus: focusVal };
      }
      await sleep(80);
      let read = await cdpCall(ws, next(), 'Runtime.evaluate', {
        expression: readComposerExpr(),
        returnByValue: true,
      });
      let got = read && read.result && read.result.value;
      if (!got || normalizeComposerText(got.text) !== normalizeComposerText(body)) {
        await cdpCall(ws, next(), 'Runtime.evaluate', {
          expression: selectComposerContentsExpr(),
          returnByValue: true,
        });
        await cdpCall(ws, next(), 'Input.insertText', { text: body });
        await sleep(120);
        read = await cdpCall(ws, next(), 'Runtime.evaluate', {
          expression: readComposerExpr(),
          returnByValue: true,
        });
        got = read && read.result && read.result.value;
      }
      if (!got || normalizeComposerText(got.text) !== normalizeComposerText(body)) {
        await cdpCall(ws, next(), 'Runtime.evaluate', {
          expression: replaceComposerExpr(body),
          returnByValue: true,
        });
        await sleep(120);
        read = await cdpCall(ws, next(), 'Runtime.evaluate', {
          expression: readComposerExpr(),
          returnByValue: true,
        });
        got = read && read.result && read.result.value;
      }
      if (!got || normalizeComposerText(got.text) !== normalizeComposerText(body)) {
        return { ok: false, submitted: false, reason: 'cdp insert did not land', read: got };
      }
      const loc = await cdpCall(ws, next(), 'Runtime.evaluate', {
        expression: clickSendExpr(),
        returnByValue: true,
      });
      const clickVal = loc && loc.result && loc.result.value;
      if (!clickVal || !clickVal.ok || !clickVal.x) {
        return { ok: false, reason: 'cdp send click missed', click: clickVal, read: got, inserted: true };
      }
      const x = clickVal.x;
      const y = clickVal.y;
      await cdpCall(ws, next(), 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdpCall(ws, next(), 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await cdpCall(ws, next(), 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await sleep(300);
      const after = await cdpCall(ws, next(), 'Runtime.evaluate', {
        expression: readComposerExpr(),
        returnByValue: true,
      });
      const afterVal = after && after.result && after.result.value;
      const still = afterVal && String(afterVal.text || '').includes(body);
      if (still) {
        return { ok: false, reason: 'send did not clear composer', click: clickVal, read: afterVal, inserted: true };
      }
      return {
        ok: true,
        submitted: true,
        inserted: true,
        click: clickVal,
        read: got,
      };
    });
    if (!result || !result.ok) {
      return {
        ok: false,
        miss: true,
        submitted: false,
        method: 'ax',
        reason: (result && result.reason) || 'cdp insert failed',
        detail: result,
      };
    }
    return {
      ok: false,
      miss: false,
      submitted: true,
      method: 'ax',
      reply: null,
      reason: null,
      click: result.click,
      read: result.read,
    };
  } catch (e) {
    return {
      ok: false,
      miss: true,
      submitted: false,
      method: 'ax',
      reason: String(e && e.message ? e.message : e),
    };
  }
}

module.exports = {
  normalizeComposerText,
  selectComposerContentsExpr,
  replaceComposerExpr,
  cdpPort,
  listTargets,
  sendCursorComposer,
};
