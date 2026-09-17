// Convobus ax: set composer value, AXPress by title, read static text.

ObjC.import("Foundation");
const appStd = Application.currentApplication();
appStd.includeStandardAdditions = true;

function env(name) {
  const v = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  if (!v || v.isNil && v.isNil()) return null;
  return ObjC.unwrap(v);
}

function readPayload() {
  const p = env("CONVO_AX_PAYLOAD");
  if (!p) return {};
  const str = $.NSString.stringWithContentsOfFileEncodingError($(p), $.NSUTF8StringEncoding, null);
  if (!str) return {};
  try {
    return JSON.parse(ObjC.unwrap(str));
  } catch (e) {
    return { error: String(e) };
  }
}

function argv0() {
  const args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments);
  // osascript, -l, JavaScript, scriptPath, action, processName
  if (args.length >= 6) return { action: args[4], name: args[5] };
  if (args.length >= 5) return { action: args[4], name: null };
  return { action: "dump", name: null };
}

function processByName(name) {
  const se = Application("System Events");
  const procs = se.processes.whose({ name: name });
  if (!procs.length) return null;
  const p = procs[0];
  try {
    p.attributes.byName("AXManualAccessibility").value = true;
  } catch (e) {}
  return p;
}

function each(col, fn) {
  try {
    const n = col.length;
    for (let i = 0; i < n; i++) fn(col[i], i);
  } catch (e) {}
}

function attr(el, name) {
  try {
    if (name === "title") return el.title() || "";
    if (name === "description") return el.description() || "";
    if (name === "role") return el.role() || "";
    if (name === "value") return String(el.value());
  } catch (e) {}
  return "";
}

function dump(name) {
  const p = processByName(name);
  if (!p) return name + ": not running";
  const rows = [];
  each(p.textAreas(), function (el) {
    rows.push("AXTextArea | " + attr(el, "title") + " | " + attr(el, "description") + " | " + attr(el, "value").slice(0, 80));
  });
  each(p.textFields(), function (el) {
    rows.push("AXTextField | " + attr(el, "title") + " | " + attr(el, "description") + " | " + attr(el, "value").slice(0, 80));
  });
  each(p.comboBoxes(), function (el) {
    rows.push("AXComboBox | " + attr(el, "title") + " | " + attr(el, "description") + " | " + attr(el, "value").slice(0, 80));
  });
  each(p.buttons(), function (el) {
    rows.push("AXButton | " + attr(el, "title") + " | " + attr(el, "description") + " | ");
  });
  each(p.staticTexts(), function (el) {
    rows.push("AXStaticText | " + attr(el, "title") + " | " + attr(el, "description") + " | " + attr(el, "value").slice(0, 80));
  });
  return name + "\n" + rows.join("\n");
}

function discoverRolesFromDump(text) {
  const composers = [];
  const buttons = [];
  const statics = [];
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(" | ");
    if (parts.length < 3) continue;
    const role = parts[0].trim();
    const title = parts[1] ? parts[1].trim() : "";
    const desc = parts[2] ? parts[2].trim() : "";
    if (/AXTextArea|AXTextField|AXComboBox/i.test(role)) {
      composers.push({ role: role.replace(/^\s+/, ""), title: title, description: desc });
    }
    if (/AXButton/i.test(role)) {
      buttons.push({ role: "AXButton", title: title, description: desc });
    }
    if (/AXStaticText/i.test(role)) {
      statics.push({ role: "AXStaticText", title: title, description: desc });
    }
  }
  const composer = composers.length ? composers[composers.length - 1] : null;
  let send = null;
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    const blob = (b.title || "") + " " + (b.description || "");
    if (/send|发送|paper plane|prompt/i.test(blob)) {
      send = b;
      break;
    }
  }
  if (!send && buttons.length) {
    send = { role: "AXButton", title: buttons[buttons.length - 1].title, description: buttons[buttons.length - 1].description, unlabeled: !buttons[buttons.length - 1].title };
  }
  const reply = statics.length ? statics[statics.length - 1] : null;
  return { composer: composer, send: send, reply: reply };
}

function findByRole(el, wantRole, wantTitle, wantDesc, acc) {
  if (acc.length > 80) return;
  let role = "", title = "", desc = "";
  try { role = el.role(); } catch (e) {}
  try { title = el.title(); } catch (e) {}
  try { desc = el.description(); } catch (e) {}
  if (role === wantRole || (!wantRole && /AXTextArea|AXTextField|AXComboBox/.test(role))) {
    if (!wantTitle && !wantDesc) acc.push(el);
    else if (wantTitle && title === wantTitle) acc.push(el);
    else if (wantDesc && desc === wantDesc) acc.push(el);
    else if (wantTitle && /send/i.test(wantTitle) && /send|发送/i.test(title + desc)) acc.push(el);
  }
  try {
    el.uiElements().forEach(function (c) { findByRole(c, wantRole, wantTitle, wantDesc, acc); });
  } catch (e) {}
}

function setValue(el, text) {
  try {
    el.value = text;
    return true;
  } catch (e) {
    try {
      el.attributes.byName("AXValue").value = text;
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function press(el) {
  try {
    el.actions.byName("AXPress").perform();
    return true;
  } catch (e) {
    return false;
  }
}

function readValue(el) {
  try {
    return String(el.value());
  } catch (e) {
    return "";
  }
}

function lastComposer(p) {
  let el = null;
  each(p.textAreas(), function (x) { el = x; });
  if (el) return el;
  each(p.comboBoxes(), function (x) { el = x; });
  if (el) return el;
  each(p.textFields(), function (x) { el = x; });
  return el;
}

function sendButton(p) {
  let found = null;
  let last = null;
  each(p.buttons(), function (b) {
    last = b;
    const blob = attr(b, "title") + " " + attr(b, "description");
    if (/send|发送|paper plane|prompt/i.test(blob)) found = b;
  });
  return found || last;
}

function lastStaticText(p) {
  let val = "";
  each(p.staticTexts(), function (el) {
    const v = attr(el, "value");
    if (v) val = v;
  });
  return val;
}

function generatingButtons(p) {
  const acc = [];
  each(p.buttons(), function (b) {
    const blob = attr(b, "title") + " " + attr(b, "description");
    if (/Stop generating|停止生成/.test(blob)) acc.push(b);
  });
  return acc;
}

function send(payload) {
  const name = payload.processName || payload.name;
  const text = payload.text || "";
  const p = processByName(name);
  if (!p) {
    return { ok: false, fragile: true, error: name + ": not running" };
  }

  const composer = lastComposer(p);
  const sendBtn = sendButton(p);
  if (!composer || !sendBtn) {
    return {
      ok: false,
      fragile: true,
      error: "dump has not returned a composer role",
      roles: { composer: composer ? { role: "AXTextArea" } : null, send: sendBtn ? { role: "AXButton" } : null },
    };
  }

  const snap = lastStaticText(p);
  if (!setValue(composer, text)) {
    return { ok: false, fragile: true, error: "could not set composer value" };
  }
  if (!press(sendBtn)) {
    return { ok: false, fragile: true, error: "AXPress failed" };
  }

  const deadline = Date.now() + (payload.timeoutMs || 90000);
  let seenGenerating = false;
  let reply = "";
  while (Date.now() < deadline) {
    delay(0.5);
    const gens = generatingButtons(p);
    if (gens.length) seenGenerating = true;
    else if (seenGenerating) {
      reply = lastStaticText(p);
      break;
    }
    const now = lastStaticText(p);
    if (now && now !== snap) {
      reply = now;
      if (!gens.length) {
        delay(0.8);
        const settled = lastStaticText(p);
        if (settled && settled !== snap) {
          reply = settled;
          break;
        }
      }
    }
  }
  if (seenGenerating && !reply) reply = lastStaticText(p);
  if (!reply || reply === snap) {
    return {
      ok: false,
      reply: null,
      snapshot: snap,
      error: seenGenerating ? "no new reply after snapshot" : "generating control never appeared",
    };
  }
  return { ok: true, reply: reply, fragile: false, snapshot: snap };
}

const cli = argv0();
const action = cli.action || "dump";
let result = "";
if (action === "dump") {
  const name = cli.name || env("CONVO_AX_PROCESS") || "Claude";
  result = dump(name);
} else if (action === "send") {
  const payload = readPayload();
  result = JSON.stringify(send(payload));
} else {
  result = dump(cli.name || "Claude");
}
result;
