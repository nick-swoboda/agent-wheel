'use strict';

const { spawnSync } = require('child_process');

function jsonEscapeForScript(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Fixed template. Payload is JSON-escaped into execute javascript.
 * ChatGPT execute javascript only after probe proves the command exists.
 */
function chatGPTSendTemplate(payloadJson) {
  const escaped = jsonEscapeForScript(payloadJson);
  return (
    'tell application "ChatGPT"\n' +
    '  if (count of windows) is 0 then return "no-windows"\n' +
    '  execute (active tab of window 1) javascript "' + escaped + '"\n' +
    'end tell\n'
  );
}

function sendJavascript(payload) {
  const js =
    '(function(){var p=' +
    JSON.stringify(payload) +
    ';var nodes=document.querySelectorAll("textarea,[contenteditable=true], [role=textbox],[role=combobox]");' +
    'var el=nodes[nodes.length-1];if(!el)return "no-composer";' +
    'el.focus();' +
    'if(el.tagName==="TEXTAREA"||el.tagName==="INPUT"){el.value=p.body;el.dispatchEvent(new Event("input",{bubbles:true}));}' +
    'else{el.textContent=p.body;el.dispatchEvent(new InputEvent("input",{bubbles:true}));}' +
    'var btns=[].slice.call(document.querySelectorAll("button"));' +
    'var send=btns.find(function(b){var t=(b.getAttribute("aria-label")||b.title||b.innerText||"");return /send|发送/i.test(t);});' +
    'if(send){send.click();return "sent";}' +
    'return "no-send";})()';
  return js;
}

const PROBE_MS = 4000;

function osaTimedOut(r) {
  return !!(r && r.error && (r.error.code === 'ETIMEDOUT' || r.error.killed));
}

function osaDenied(r) {
  const text = ((r && r.stdout) || '') + ((r && r.stderr) || '') + (r && r.error ? r.error.message : '');
  return /not allowed|not authorized|Apple event|Access not allowed|(-1743)|(-1712)|(-1723)/i.test(text);
}

function runOsascript(script, timeout) {
  return spawnSync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: timeout || PROBE_MS,
    killSignal: 'SIGKILL',
  });
}

function probeChatGPT() {
  const windows = runOsascript('tell application "ChatGPT" to get {name, id} of windows', PROBE_MS);
  const wFail = osaTimedOut(windows) || osaDenied(windows) || windows.status !== 0;
  if (wFail) {
    return {
      windows,
      js: null,
      dictionary: false,
      jsOpen: false,
      tcc: osaDenied(windows) || osaTimedOut(windows),
      timeout: osaTimedOut(windows),
      stdout:
        'windows:\n' +
        (windows.stdout || '') +
        (windows.stderr || '') +
        (windows.error ? windows.error.message : ''),
    };
  }
  const js = runOsascript(
    'tell application "ChatGPT" to execute (active tab of window 1) javascript "1+1"',
    PROBE_MS,
  );
  const jsOpen = String(js.stdout || '').trim() === '2';
  const tcc = osaDenied(js) || osaTimedOut(js);
  return {
    windows,
    js,
    dictionary: true,
    jsOpen,
    tcc,
    timeout: osaTimedOut(js),
    stdout:
      'windows:\n' +
      (windows.stdout || '') +
      (windows.stderr || '') +
      '\njs:\n' +
      (js.stdout || '') +
      (js.stderr || ''),
  };
}

function sendApplescript(card, opts) {
  const o = opts || {};
  const app = o.app || 'ChatGPT';
  if (app !== 'ChatGPT' || card.seat !== 'chatgpt-app') {
    return { ok: false, miss: true, reason: 'no dictionary template for ' + card.seat, method: 'applescript' };
  }
  const probe = o.probe || probeChatGPT();
  if (probe.tcc) {
    return {
      ok: false,
      miss: true,
      tcc: true,
      method: 'applescript',
      reason: 'osascript/TCC denied',
      probe,
    };
  }
  if (!probe.dictionary || !probe.jsOpen) {
    return {
      ok: false,
      miss: true,
      method: 'applescript',
      reason: 'gate closed → ax',
      fallback: 'ax',
      probe,
    };
  }
  const js = sendJavascript({ id: card.id, body: card.body, seat: card.seat });
  const script = chatGPTSendTemplate(js);
  const r = runOsascript(script, o.timeout || 8000);
  const out = String(r.stdout || '').trim();
  const err = String(r.stderr || '').trim();
  if (r.status !== 0 || /error/i.test(err)) {
    return {
      ok: false,
      miss: true,
      method: 'applescript',
      reason: err || 'applescript failed',
      stdout: r.stdout,
      stderr: r.stderr,
      probe,
    };
  }
  return {
    ok: false,
    miss: true,
    method: 'applescript',
    reply: null,
    stdout: r.stdout,
    stderr: r.stderr,
    submitted: out === 'sent',
    reason: 'applescript submit has no reply',
    probe,
  };
}

module.exports = {
  jsonEscapeForScript,
  chatGPTSendTemplate,
  probeChatGPT,
  sendApplescript,
  sendJavascript,
  PROBE_MS,
};
