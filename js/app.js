// =====================================================================
// TERMINAL CONSOLE - TEST VERSION
// =====================================================================
function uid() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
}
const $ = (id) => document.getElementById(id);

let passkey = "";
// Permanent device id: the same on every launch, so you never get your own messages back.
const clientId = (() => {
  let id = lsGet("device_id");
  if (!id) { id = "d_" + uid(); lsSet("device_id", id); }
  return id;
})();
let channel = null;

const _d = lsGet("disappearing");
let disappearingEnabled = _d === "" ? true : _d === "true";
let burnDuration = parseInt(lsGet("burn_duration", "10"), 10) || 10;
let currentTheme = lsGet("theme", "stealth");
let currentFont = lsGet("font", "sans");
let currentFontSize = lsGet("font_size", "15");

let outbox = [];                 // only used when no vault is configured
const pending = new Map();       // sent but not yet delivered: msgId -> sent time
const sent = new Map();          // text of messages I sent (needed to replace an undelivered one on edit)
const seenIds = new Set();       // every message already shown (stops duplicates)
const unread = new Set();        // peer messages that arrived while app was in background
let appActive = document.visibilityState === "visible";
let syncing = false;
let pingTimer = null;

let peerOnline = false;
let peerWatchdogTimer = null;
let peerTypingTimer = null;
let lastTypingBroadcast = 0;
let localTypingTimeout = null;

let activeQuotedTarget = null;
let editingTargetMsgId = null;
let activeContextTarget = null;

const stream = $("chat-stream");
const msgInput = $("msg-input");
const connState = $("conn-state");
const statusDot = $("status-dot");
const typingIndicator = $("typing-indicator");

// =====================================================================
// CUSTOM DIALOGS (replace the browser's alert / confirm / prompt)
// =====================================================================
function uiDialog(o) {
  return new Promise(res => {
    const ov = document.createElement("div");
    ov.className = "os-modal-overlay ui-modal";
    ov.style.display = "flex";
    const box = document.createElement("div");
    box.className = "os-dialog";

    const h = document.createElement("div");
    h.className = "dialog-header";
    h.textContent = o.title;
    box.appendChild(h);

    if (o.text) {
      const p = document.createElement("div");
      p.className = "dialog-text";
      p.textContent = o.text;
      box.appendChild(p);
    }

    const inputs = {};
    (o.fields || []).forEach(f => {
      const i = document.createElement("input");
      i.className = "dialog-input";
      i.type = f.type || "text";
      i.placeholder = f.placeholder || "";
      i.value = f.value || "";
      i.autocomplete = "off";
      i.spellcheck = false;
      box.appendChild(i);
      inputs[f.id] = i;
    });

    const row = document.createElement("div");
    row.className = "dialog-actions";
    const done = (v) => { ov.remove(); res(v); };

    if (!o.hideCancel) {
      const c = document.createElement("button");
      c.className = "dialog-btn";
      c.textContent = o.cancel || "Cancel";
      c.onclick = () => done(o.fields ? null : false);
      row.appendChild(c);
    }
    const k = document.createElement("button");
    k.className = "dialog-btn " + (o.danger ? "danger" : "primary");
    k.textContent = o.ok || "OK";
    k.onclick = () => {
      if (o.fields && o.fields.length) {
        const v = {};
        for (const id in inputs) v[id] = inputs[id].value;
        done(v);
      } else {
        done(true);
      }
    };
    row.appendChild(k);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);

    const first = Object.values(inputs)[0];
    if (first) setTimeout(() => first.focus(), 80);
  });
}
const uiAlert = (title, text) => uiDialog({ title, text, hideCancel: true });
const uiConfirm = (title, text, ok, danger) => uiDialog({ title, text, ok, danger });
const uiForm = (o) => uiDialog(o);

// =====================================================================
// BASIC UI
// =====================================================================
function scrollToBottom(targetNode) {
  requestAnimationFrame(() => {
    if (targetNode && targetNode.scrollIntoView) {
      targetNode.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      stream.scrollTop = stream.scrollHeight;
    }
    setTimeout(() => { stream.scrollTop = stream.scrollHeight; }, 120);
  });
}

function resizeInputBox() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 110) + "px";
}

msgInput.addEventListener("input", () => {
  resizeInputBox();
  if (!channel || !passkey) return;
  const now = Date.now();
  if (now - lastTypingBroadcast > 3000) {
    lastTypingBroadcast = now;
    dispatchRaw({ type: "typing", status: true, senderId: clientId });
  }
  clearTimeout(localTypingTimeout);
  localTypingTimeout = setTimeout(() => {
    dispatchRaw({ type: "typing", status: false, senderId: clientId });
  }, 2500);
});

msgInput.addEventListener("focus", () => scrollToBottom());
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$("numeric-key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") mountSession();
});

function triggerNativeEmojiKeyboard() { msgInput.focus(); }

// ---- App visibility: decides when a message counts as "read" ----
function setActive(v) {
  if (appActive === v) return;
  appActive = v;
  if (v) {
    flushUnread();
    if (passkey) { pingNow(); syncVault(); }
  }
}
document.addEventListener("visibilitychange", () => setActive(document.visibilityState === "visible"));
window.addEventListener("focus", () => setActive(true));
window.addEventListener("blur", () => setActive(false));

window.addEventListener("DOMContentLoaded", () => {
  setTheme(currentTheme);
  setFont(currentFont);
  setFontSize(currentFontSize);
  injectUi();
  updateDisappearingUI();
  updateSettingsLabels();

  // Tapping a link inside a message asks first, then opens it.
  stream.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest(".msg-link");
    if (a) { e.preventDefault(); openLink(a.dataset.u); }
  });

  // Ask the browser to keep saved settings (key, vault link) permanently.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const keyInput = $("numeric-key");
  setTimeout(() => { if (keyInput) { keyInput.focus(); keyInput.click(); } }, 150);
});

// Adds the extra settings rows, the call screen and the settings entries.
function injectUi() {
  const card = $("current-vault-label").closest(".os-card");
  const mkRow = (iconPath, title, subId, subText, onclick) => {
    const row = document.createElement("div");
    row.className = "os-row";
    row.onclick = onclick;
    row.innerHTML = `
      <svg class="row-icon-svg" viewBox="0 0 24 24">${iconPath}</svg>
      <div class="row-content">
        <div class="row-title">${title}</div>
        <div class="row-subtitle" id="${subId}">${subText}</div>
      </div>
      <div class="row-arrow">›</div>`;
    return row;
  };
  card.appendChild(mkRow('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    "Keep Undelivered Messages", "current-retention-label", "7 days", () => openDialog("retention")));
  card.appendChild(mkRow('<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
    "Call Relay (TURN)", "current-turn-label", "Not set", configureTurn));

  const cs = document.createElement("div");
  cs.id = "call-screen";
  cs.className = "call-screen";
  cs.innerHTML = `
    <video id="remote-media" autoplay playsinline></video>
    <video id="local-media" autoplay playsinline muted></video>
    <div class="call-info"><div id="call-title"></div><div id="call-sub"></div></div>
    <div class="call-controls">
      <button class="call-btn" id="call-mic" onclick="toggleMic()">Mute</button>
      <button class="call-btn" id="call-cam" onclick="toggleCam()">Camera</button>
      <button class="call-btn" id="call-spk" onclick="toggleSpeaker()">Speaker</button>
      <button class="call-btn accept" id="call-accept" onclick="acceptCall()">Accept</button>
      <button class="call-btn end" id="call-end" onclick="hangUp()">End</button>
    </div>`;
  document.body.appendChild(cs);
}

function panicExit() {
  endCall("CALL ENDED", true);
  ftCleanup();
  stream.innerHTML = "";
  outbox = [];
  pending.clear();
  passkey = "";
  keys = null;
  if (window.history.length > 1) window.history.back();
  else window.location.reload();
}

let mounting = false;
async function mountSession() {
  if (mounting) return;
  const val = $("numeric-key").value.trim();
  if (!val) return;

  mounting = true;
  const btn = document.querySelector(".passkey-btn");
  const oldLabel = btn.innerText;
  btn.innerText = "AUTHENTICATING…";
  btn.disabled = true;
  try {
    keys = await deriveKeys(val);
  } catch (e) {
    btn.innerText = oldLabel;
    btn.disabled = false;
    mounting = false;
    return uiAlert("Secure crypto unavailable",
      "This browser can't run the secure key function. Open the app from its https link.");
  }
  mounting = false;
  btn.innerText = oldLabel;
  btn.disabled = false;

  passkey = val;
  $("passkey-dialog").style.display = "none";
  setTimeout(() => msgInput.focus(), 100);

  initRelay();
  syncVault();

  // One-time setup: ask for the key and vault link only if they have never been saved.
  if (lsGet("setup_done") !== "1") {
    (async () => {
      if (!getStoredApiKey()) await configureRelayKey();
      if (!getStoredVaultUrl()) await configureVaultUrl();
      lsSet("setup_done", "1");
    })();
  }
}

// =====================================================================
// ENCRYPTION + TRANSPORT
// =====================================================================
// Passkey -> strong keys: PBKDF2 (200,000 rounds, SHA-256) gives 64 bytes that are
// split into the AES-GCM key, the relay channel name and the vault room name.
const te = new TextEncoder();
let keys = null;
const hex = (a) => Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
function b64(buf) {
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
async function deriveKeys(pass) {
  if (!(window.crypto && crypto.subtle)) throw new Error("no-subtle");
  const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: te.encode("terminal-console-v2"), iterations: 200000, hash: "SHA-256" }, base, 512));
  const aes = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { aes, chan: hex(bits.slice(32, 48)), room: hex(bits.slice(48, 64)) };
}
// AES-GCM also detects tampering. Output: base64( 12-byte random IV + ciphertext ).
async function encrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.aes, te.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}
async function decrypt(cipher) {
  try {
    const raw = unb64(cipher);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, keys.aes, raw.slice(12));
    return new TextDecoder().decode(pt);
  } catch (e) {
    return null;
  }
}
function dispatchRaw(dataObj) {
  if (!channel) return;
  const jsonStr = JSON.stringify(dataObj);
  if (typeof channel.publish === "function") channel.publish("message", jsonStr);
  else if (typeof channel.send === "function") channel.send(jsonStr);
}
// Every command is encrypted, so only someone with the passkey can send one.
let sendChain = Promise.resolve();   // keeps commands in the order they were issued
function sendCtl(obj) {
  sendChain = sendChain.then(async () => {
    if (!keys) return;
    const c = await encrypt(JSON.stringify(obj));
    dispatchRaw({ type: "ctl", c, senderId: clientId });
  }).catch(() => {});
  return sendChain;
}

function initRelay() {
  const apiKey = getStoredApiKey();
  if (!apiKey) {
    setPeerStatusUI("KEY REQUIRED", "offline");
    logSys("SETUP: Add your Relay Product Key in Settings (three dots).");
    return;
  }
  setPeerStatusUI("CONNECTING RELAY...", "connecting");
  try {
    const PS = window.PieSocket?.default || window.PieSocket;
    if (typeof PS !== "function") {
      setPeerStatusUI("LIB ERROR", "offline");
      logSys("ERR: PieSocket library failed to load.");
      return;
    }
    const piesocket = new PS({ clusterId: PIESOCKET_CLUSTER_ID, apiKey: apiKey, notifySelf: false });
    const dynamicChannel = "ch_" + keys.chan;
    const subResult = piesocket.subscribe(dynamicChannel);
    if (subResult && typeof subResult.then === "function") {
      subResult.then((ch) => setupChannel(ch)).catch(() => {
        setPeerStatusUI("AUTH FAILED", "offline");
        logSys("SOCKET ERROR: invalid key or network rejected.");
      });
    } else {
      setupChannel(subResult);
    }
  } catch (e) {
    setPeerStatusUI("INIT ERROR", "offline");
    logSys("ERR: " + e.message);
  }
}

function setupChannel(ch) {
  channel = ch;
  setPeerStatusUI("WAITING FOR PEER...", "connecting");
  const onMsg = (raw) => handlePacket(typeof raw === "string" ? raw : JSON.stringify(raw));
  if (typeof channel.listen === "function") channel.listen("message", onMsg);
  else if (typeof channel.on === "function") channel.on("message", onMsg);

  clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (appActive) pingNow(); }, 25000);
  pingNow();
}
function pingNow() { dispatchRaw({ type: "ping", senderId: clientId }); }

function refreshPeerWatchdog() {
  const wasOffline = !peerOnline;
  peerOnline = true;
  clearTimeout(peerWatchdogTimer);
  setPeerStatusUI("PEER ONLINE", "online");
  if (wasOffline) broadcastConfigSync();
  peerWatchdogTimer = setTimeout(() => {
    peerOnline = false;
    clearTimeout(peerTypingTimer);
    typingIndicator.style.display = "none";
    setPeerStatusUI("WAITING FOR PEER...", "connecting");
  }, 70000);
}

function setPeerStatusUI(text, state) {
  connState.innerText = text;
  statusDot.className = "status-dot";
  if (state === "online") statusDot.classList.add("online");
  else if (state === "offline") statusDot.classList.add("offline");
}

function handlePacket(raw) {
  try {
    const pkg = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!pkg || pkg.senderId === clientId) return;

    if (pkg.type === "ping") {
      const was = !peerOnline;
      refreshPeerWatchdog();
      if (was) pingNow();
      return;
    }
    if (pkg.type === "typing") {
      refreshPeerWatchdog();
      handlePeerTyping(pkg.status);
      return;
    }
    if (pkg.type === "ctl") {
      recvChain = recvChain.then(async () => {
        const plain = await decrypt(pkg.c);
        if (!plain) return;
        refreshPeerWatchdog();
        handleCtl(JSON.parse(plain));
      }).catch(() => {});
    }
  } catch (e) {}
}
let recvChain = Promise.resolve();

function handleCtl(o) {
  switch (o.op) {
    case "chat":
      clearTimeout(peerTypingTimer);
      typingIndicator.style.display = "none";
      receiveMessage(o.m);
      if (getStoredVaultUrl() && o.m && o.m.msgId) vaultCall({ action: "delete", ids: [o.m.msgId] });
      break;
    case "ack": markDelivered(o.id); break;
    case "read": (o.ids || []).forEach(markRead); break;
    case "edit": applyRemoteEdit(o.id, String(o.text || "")); break;
    case "react": applyReactionToBubble(o.id, o.emoji); break;
    case "purge":
      wipeLocal();
      logSys("SESSION BUFFER SHREDDED BY PEER.");
      break;
    case "cfg": applyRemoteConfig(o.enabled, o.duration); break;
    case "call": handleCallSignal(o); break;
    case "ft": handleFileSignal(o); break;
  }
}

function handlePeerTyping(isTyping) {
  clearTimeout(peerTypingTimer);
  if (isTyping) {
    typingIndicator.style.display = "flex";
    scrollToBottom(typingIndicator);
    peerTypingTimer = setTimeout(() => { typingIndicator.style.display = "none"; }, 3500);
  } else {
    typingIndicator.style.display = "none";
  }
}

// =====================================================================
// OFFLINE VAULT (messages wait here until delivered)
// =====================================================================
function getVaultRoomHash() {
  return "v_" + keys.room;
}

async function vaultCall(body) {
  const url = getStoredVaultUrl();
  if (!url || !passkey) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ room: getVaultRoomHash(), ...body })
    });
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function storeInVault(m) {
  const r = await vaultCall({
    action: "store",
    msgId: m.msgId,
    from: clientId,
    envelope: await encrypt(JSON.stringify(m)),
    ttlDays: getVaultDays()
  });
  if (r && r.status === "stored") return true;
  const why = {
    room_full: "VAULT FULL",
    storage_full: "VAULT STORAGE FULL",
    too_large: "MESSAGE TOO LARGE FOR VAULT",
    busy: "VAULT BUSY",
    unknown_action: "VAULT SCRIPT NEEDS THE NEW VERSION"
  }[r && r.code] || "VAULT UNREACHABLE";
  logSys(why + ". SENT LIVE ONLY.");
  return false;
}

// Collects waiting messages, shows them, then removes only those from the vault.
async function syncVault() {
  if (syncing || !passkey || !getStoredVaultUrl()) return;
  syncing = true;
  try {
    const r = await vaultCall({ action: "list" });
    if (!r || r.status !== "ok") return;
    const own = new Set();
    const del = [];
    let fresh = 0;

    for (const item of r.messages) {
      let m = null;
      try {
        const p = await decrypt(item.envelope);
        if (p) m = JSON.parse(p);
      } catch (e) {}
      if (!m) continue;
      if (m.senderId === clientId) { own.add(item.id); continue; }
      if (m.edit) {                       // an edit that was saved while we were away
        applyRemoteEdit(String(m.target || ""), String(m.text || ""));
        del.push(item.id);
        continue;
      }
      if (receiveMessage(m)) fresh++;
      del.push(item.id);
    }
    if (del.length) vaultCall({ action: "delete", ids: del });

    if (!r.more) {
      const now = Date.now();
      [...pending.keys()].forEach(id => {
        if (!own.has(id) && now - pending.get(id) > 8000) markDelivered(id, true);
      });
    }
    if (fresh) logSys(`${fresh} OFFLINE MESSAGE(S) RECEIVED.`);
  } finally {
    syncing = false;
  }
}
setInterval(() => { if (appActive && passkey && getStoredVaultUrl()) syncVault(); }, 20000);

// =====================================================================
// MESSAGES: send, receive, delivered, read
// =====================================================================
function getFormattedTime() {
  const d = new Date();
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !passkey) { msgInput.focus(); return; }

  clearTimeout(localTypingTimeout);
  dispatchRaw({ type: "typing", status: false, senderId: clientId });

  if (editingTargetMsgId) {
    const editId = editingTargetMsgId;
    applyLocalEdit(editId, text);
    sendCtl({ op: "edit", id: editId, text });
    if (getStoredVaultUrl()) {
      const original = sent.get(editId);
      if (original && pending.has(editId)) {
        // Not delivered yet: replace the waiting copy so the peer receives the edited text.
        original.text = text;
        storeInVault(original);
      } else {
        // Already delivered: leave a small edit note for a phone that missed the live one.
        storeInVault({ msgId: "e_" + uid(), edit: true, target: editId, text, senderId: clientId });
      }
    }
    msgInput.value = "";
    msgInput.style.height = "auto";
    cancelReplyOrEdit();
    msgInput.focus();
    return;
  }

  const m = {
    msgId: "m_" + uid(),
    text,
    timestamp: getFormattedTime(),
    burn: disappearingEnabled ? burnDuration : 0,
    reply: activeQuotedTarget ? { ...activeQuotedTarget } : null,
    senderId: clientId
  };

  msgInput.value = "";
  msgInput.style.height = "auto";
  cancelReplyOrEdit();
  msgInput.focus();

  const bubble = renderBubble(m.text, "you", m.msgId, m.timestamp, m.burn, m.reply);
  pending.set(m.msgId, Date.now());
  sent.set(m.msgId, m);
  sendCtl({ op: "chat", m });   // instant path when the peer is online

  if (getStoredVaultUrl()) {
    storeInVault(m);            // safety copy until the peer confirms delivery
  } else {
    outbox.push({ m, tries: 0, next: Date.now() + 4000 });
  }
  scrollToBottom(bubble);
}

// Without a vault: retry up to 3 times, then stop.
setInterval(() => {
  if (!channel || !outbox.length) return;
  const now = Date.now();
  outbox.forEach(o => {
    if (now < o.next || o.tries >= 3) return;
    o.tries++;
    o.next = now + (o.tries === 1 ? 15000 : 60000);
    sendCtl({ op: "chat", m: o.m });
  });
}, 5000);

// Returns true if the message is new.
function receiveMessage(m) {
  if (!m || typeof m.msgId !== "string") return false;
  if (seenIds.has(m.msgId)) {
    sendCtl({ op: "ack", id: m.msgId });
    return false;
  }
  seenIds.add(m.msgId);

  let reply = null;
  if (m.reply && m.reply.text) {
    // "You" and "Peer" are from the sender's point of view, so swap them.
    reply = { sender: m.reply.sender === "You" ? "Peer" : "You", text: String(m.reply.text) };
  }
  renderBubble(String(m.text || ""), "peer", m.msgId, String(m.timestamp || ""), Number(m.burn) || 0, reply);
  sendCtl({ op: "ack", id: m.msgId });
  afterPeerBubble(m.msgId);
  return true;
}

// "Read" means the app is actually open and visible.
function afterPeerBubble(id) {
  if (appActive) markPeerRead([id]);
  else unread.add(id);
}
function markPeerRead(ids) {
  const ok = [];
  ids.forEach(id => {
    unread.delete(id);
    const w = $(id);
    if (!w) return;
    ok.push(id);
    const b = parseInt(w.dataset.burnSecs || 0, 10);
    if (b > 0) startBurn(w, b);
  });
  if (ok.length) sendCtl({ op: "read", ids: ok });
}
function flushUnread() {
  if (unread.size) markPeerRead([...unread]);
}

function markDelivered(id, skipVaultDelete) {
  pending.delete(id);
  outbox = outbox.filter(o => o.m.msgId !== id);
  const w = $(id);
  if (w && w.dataset.role === "you") {
    const t = w.querySelector(".ticks");
    if (t && !t.classList.contains("seen")) t.innerText = "✓✓";
  }
  if (!skipVaultDelete && getStoredVaultUrl()) vaultCall({ action: "delete", ids: [id] });
}
function markRead(id) {
  markDelivered(id, true);
  const w = $(id);
  if (!w || w.dataset.role !== "you") return;
  const t = w.querySelector(".ticks");
  if (t) { t.innerText = "✓✓"; t.classList.add("seen"); }
  const b = parseInt(w.dataset.burnSecs || 0, 10);
  if (b > 0) startBurn(w, b);
}

function startBurn(node, seconds) {
  if (node.dataset.burning) return;
  node.dataset.burning = "1";
  let s = seconds;
  const digit = node.querySelector(".burn-digit");
  const interval = setInterval(() => {
    s--;
    if (digit) digit.innerText = `${s}s`;
    if (s <= 0) {
      clearInterval(interval);
      node.style.opacity = "0";
      node.style.transform = "scale(0.9)";
      node.style.transition = "opacity 0.25s ease, transform 0.25s ease";
      setTimeout(() => node.remove(), 250);
    }
  }, 1000);
}

function wipeLocal() {
  stream.innerHTML = "";
  stream.appendChild(typingIndicator);
  outbox = [];
  pending.clear();
  unread.clear();
}

// =====================================================================
// BUBBLE RENDERING (all peer-supplied values are escaped)
// =====================================================================
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}
// Turns http(s) links into tappable links. Everything else stays escaped text.
function linkify(text) {
  text = String(text || "");
  const re = /https?:\/\/[^\s<>"']+/gi;
  let out = "", last = 0, m;
  while ((m = re.exec(text))) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    out += escapeHtml(text.slice(last, m.index));
    out += `<a class="msg-link" href="#" data-u="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
    re.lastIndex = last;
  }
  return out + escapeHtml(text.slice(last));
}

async function openLink(u) {
  let url;
  try { url = new URL(u); } catch (e) { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  const ok = await uiConfirm("Open this link?", url.hostname + "\n\n" + url.href, "Open");
  if (!ok) return;
  if (window.AndroidBridge && typeof window.AndroidBridge.openLink === "function") {
    window.AndroidBridge.openLink(url.href);   // in-app browser, if the wrapper supports it
  } else {
    window.open(url.href, "_blank", "noopener");
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  ta.remove();
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function renderBubble(text, role, msgId, timeStr, burnSecs, replyData, fileData) {
  const wrap = document.createElement("div");
  wrap.className = `msg-wrap ${role}`;
  wrap.id = msgId;
  wrap.dataset.role = role;

  burnSecs = Number(burnSecs) || 0;
  const displayTime = escapeHtml(timeStr || getFormattedTime());
  const isSolo = !fileData && checkIsSoloEmoji(text);
  const isImg = !!(fileData && /^image\/(png|jpe?g|gif|webp)$/.test(fileData.mime || ""));

  const badgeHtml = burnSecs > 0 ? `
    <span class="burn-badge">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>
      <span class="burn-digit">${burnSecs}s</span>
    </span>` : "";

  const quotedHtml = (replyData && replyData.text) ? `
    <div class="quoted-card">
      <strong style="color:var(--accent); font-size:11px;">${escapeHtml(replyData.sender)}</strong><br/>
      ${escapeHtml(replyData.text)}
    </div>` : "";

  const textBodyHtml = isImg ? "" : `<span class="msg-text">${linkify(text)}</span>`;
  wrap.dataset.kind = fileData ? "file" : "text";
  const ticksHtml = role === "you" ? '<span class="ticks">✓</span>' : "";

  wrap.innerHTML = `
    <div class="swipe-reply-icon">
      <svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
    </div>
    <div class="bubble ${isSolo ? "emoji-solo" : ""}">
      ${quotedHtml}
      <div class="media-slot"></div>
      ${textBodyHtml}
      <div class="msg-meta">
        ${badgeHtml}
        <span class="timestamp">${displayTime}</span>
        ${ticksHtml}
      </div>
      <div class="bubble-reaction"></div>
    </div>`;
  wrap.dataset.burnSecs = burnSecs;

  // Files are attached with DOM calls only (never built from text).
  if (fileData && fileData.url && String(fileData.url).startsWith("blob:")) {
    const slot = wrap.querySelector(".media-slot");
    if (isImg) {
      const img = document.createElement("img");
      img.className = "media-preview";
      img.src = fileData.url;
      img.alt = "Image";
      slot.appendChild(img);
    } else {
      const a = document.createElement("a");
      a.className = "file-card";
      a.href = fileData.url;
      a.download = fileData.name || "file";
      a.textContent = "📎 " + (fileData.name || "File") + " (" + fmtSize(fileData.size) + ")";
      slot.appendChild(a);
    }
  }

  setupBubbleInteractions(wrap, text, role);
  stream.insertBefore(wrap, typingIndicator);
  scrollToBottom(wrap);
  return wrap;
}

function logSys(msg) {
  const el = document.createElement("div");
  el.className = "sys-log";
  el.innerText = msg;
  stream.insertBefore(el, typingIndicator);
  scrollToBottom(el);
}

// =====================================================================
// BUBBLE GESTURES, REPLY, EDIT, REACTIONS
// =====================================================================
// The text as currently shown (it changes after an edit).
function liveText(wrap, fallback) {
  const n = wrap.querySelector(".msg-text");
  return n ? n.innerText : fallback;
}

function setupBubbleInteractions(wrap, text, role) {
  let startX = 0, currentX = 0, isSwiping = false, longPressTimer = null;
  const swipeIcon = wrap.querySelector(".swipe-reply-icon");

  // Never let a long press select the words inside a bubble.
  wrap.addEventListener("contextmenu", (e) => e.preventDefault());
  wrap.addEventListener("selectstart", (e) => e.preventDefault());

  wrap.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    isSwiping = false;
    longPressTimer = setTimeout(() => {
      if (!isSwiping) openClampedContextMenu(wrap, liveText(wrap, text), role);
    }, 450);
  }, { passive: true });

  wrap.addEventListener("touchmove", (e) => {
    currentX = e.touches[0].clientX;
    const diffX = currentX - startX;
    if (diffX > 10) {
      clearTimeout(longPressTimer);
      isSwiping = true;
      const boundedX = Math.min(diffX, 60);
      wrap.style.transform = `translateX(${boundedX}px)`;
      if (swipeIcon) swipeIcon.style.opacity = boundedX / 60;
    }
  }, { passive: true });

  wrap.addEventListener("touchend", () => {
    clearTimeout(longPressTimer);
    const diffX = currentX - startX;
    if (isSwiping && diffX >= 50) {
      if (navigator.vibrate) navigator.vibrate(12);
      setReplyTarget(liveText(wrap, text), role === "you" ? "You" : "Peer");
    }
    wrap.style.transform = "translateX(0px)";
    if (swipeIcon) swipeIcon.style.opacity = 0;
    isSwiping = false;
    startX = 0;
    currentX = 0;
  });
}

let ctxOpenedAt = 0;

// Long press: highlight the message and show only the reactions plus a ⋮ button.
function openClampedContextMenu(bubbleWrap, text, role) {
  hideContext();
  activeContextTarget = { wrap: bubbleWrap, text, role, id: bubbleWrap.id, menuTop: 0, menuLeft: 0 };
  bubbleWrap.classList.add("msg-selected");

  const dock = $("reaction-dock");
  const canEdit = role === "you" && bubbleWrap.dataset.kind !== "file";
  $("context-edit-item").style.display = canEdit ? "flex" : "none";

  const rect = bubbleWrap.getBoundingClientRect();
  const streamRect = stream.getBoundingClientRect();
  const screenWidth = window.innerWidth;
  const isNearTop = (rect.top - streamRect.top) < 65;

  const dockTop = isNearTop ? (rect.bottom - streamRect.top + 8) : (rect.top - streamRect.top - 46);
  const dockLeft = role === "you"
    ? Math.max(12, screenWidth - 300)
    : Math.min(screenWidth - 300, Math.max(12, rect.left - streamRect.left));

  activeContextTarget.menuTop = isNearTop ? (dockTop + 48) : (rect.bottom - streamRect.top + 6);
  activeContextTarget.menuLeft = role === "you"
    ? Math.max(12, screenWidth - 170)
    : Math.max(12, rect.left - streamRect.left);

  dock.style.top = `${dockTop}px`;
  dock.style.left = `${dockLeft}px`;
  dock.style.display = "flex";
  $("msg-context-menu").style.display = "none";
  if (navigator.vibrate) navigator.vibrate(15);

  ctxOpenedAt = Date.now();
  setTimeout(() => {
    document.addEventListener("click", ctxOutside);
    document.addEventListener("touchstart", ctxOutside);
  }, 100);
}

// ⋮ button: show Copy / Reply / Edit under the message.
function openMoreMenu() {
  if (!activeContextTarget) return;
  const menu = $("msg-context-menu");
  menu.style.top = `${activeContextTarget.menuTop}px`;
  menu.style.left = `${activeContextTarget.menuLeft}px`;
  menu.style.display = "flex";
}

function hideContext() {
  $("reaction-dock").style.display = "none";
  $("msg-context-menu").style.display = "none";
  if (activeContextTarget && activeContextTarget.wrap) activeContextTarget.wrap.classList.remove("msg-selected");
  document.removeEventListener("click", ctxOutside);
  document.removeEventListener("touchstart", ctxOutside);
}

function ctxOutside(e) {
  if (Date.now() - ctxOpenedAt < 400) return;   // ignore the finger lifting after the long press
  if (!$("reaction-dock").contains(e.target) && !$("msg-context-menu").contains(e.target)) hideContext();
}

function triggerContextAction(action) {
  if (!activeContextTarget) return;
  const t = activeContextTarget;
  if (action === "reply") {
    setReplyTarget(t.text, t.role === "you" ? "You" : "Peer");
  } else if (action === "copy") {
    copyText(t.text);
  } else if (action === "edit") {
    startEditMessage(t.id, t.text);
  }
  hideContext();
}

function startEditMessage(msgId, currentText) {
  editingTargetMsgId = msgId;
  activeQuotedTarget = null;
  $("reply-target-title").innerText = "Editing message";
  $("reply-target-text").innerText = currentText;
  $("reply-preview-bar").style.display = "flex";
  msgInput.value = currentText;
  resizeInputBox();
  msgInput.focus();
}

function applyLocalEdit(msgId, newText) {
  const wrap = $(msgId);
  if (wrap) {
    const node = wrap.querySelector(".msg-text");
    if (node) node.innerHTML = linkify(newText);
    addEditedBadge(wrap);
  }
}
function applyRemoteEdit(msgId, newText) {
  const wrap = $(msgId);
  if (wrap && wrap.dataset.role === "peer") {   // a peer can only edit its own messages
    const node = wrap.querySelector(".msg-text");
    if (node) node.innerHTML = linkify(newText);
    addEditedBadge(wrap);
  }
}
function addEditedBadge(wrap) {
  const meta = wrap.querySelector(".msg-meta");
  if (meta && !meta.querySelector(".edited-badge")) {
    const b = document.createElement("span");
    b.className = "edited-badge";
    b.innerText = "edited";
    meta.insertBefore(b, meta.firstChild);
  }
}

function setReplyTarget(text, senderLabel) {
  editingTargetMsgId = null;
  activeQuotedTarget = { sender: senderLabel, text };
  $("reply-target-title").innerText = `Replying to ${senderLabel}`;
  $("reply-target-text").innerText = text;
  $("reply-preview-bar").style.display = "flex";
  msgInput.focus();
}
function cancelReplyOrEdit() {
  activeQuotedTarget = null;
  editingTargetMsgId = null;
  $("reply-preview-bar").style.display = "none";
}

function selectReaction(emoji) {
  if (!activeContextTarget) return;
  applyReactionToBubble(activeContextTarget.id, emoji);
  sendCtl({ op: "react", id: activeContextTarget.id, emoji });
  hideContext();
}
function applyReactionToBubble(msgId, emoji) {
  const wrap = $(msgId);
  if (!wrap) return;
  const el = wrap.querySelector(".bubble-reaction");
  if (el) { el.innerText = String(emoji || "").slice(0, 8); el.style.display = "block"; }
}

// =====================================================================
// CALLS (voice + video) over WebRTC
// =====================================================================
const call = { state: "idle", video: false, pc: null, local: null, ice: [], timer: null, tick: null, t0: 0, micOn: true, camOn: true };

function getIceServers() {
  const list = [{ urls: "stun:stun.l.google.com:19302" }];
  const t = getTurnConfig();
  if (t && t.url) list.push({ urls: t.url, username: t.user || undefined, credential: t.cred || undefined });
  return list;
}

function triggerCallHandOff(isVideo) { startCall(!!isVideo); }

function callUI(show, title, sub, mode) {
  $("call-screen").style.display = show ? "flex" : "none";
  if (!show) return;
  $("call-title").innerText = title;
  $("call-sub").innerText = sub || "";
  $("call-accept").hidden = mode !== "ringing";
  $("call-mic").hidden = mode === "ringing";
  $("call-spk").hidden = mode === "ringing";
  $("call-cam").hidden = mode === "ringing" || !call.video;
  $("call-end").innerText = mode === "ringing" ? "Decline" : "End";
  refreshCallButtons();
}

function refreshCallButtons() {
  const remote = $("remote-media");
  $("call-mic").innerText = call.micOn ? "Mute" : "Unmute";
  $("call-mic").classList.toggle("off", !call.micOn);
  $("call-cam").innerText = call.camOn ? "Camera off" : "Camera on";
  $("call-cam").classList.toggle("off", !call.camOn);
  $("call-spk").classList.toggle("off", !!remote.muted);
  const hdrMic = $("mic-toggle-btn");
  const hdrSpk = $("speaker-toggle-btn");
  if (hdrMic) hdrMic.classList.toggle("mic-active", call.state !== "idle" && call.micOn);
  if (hdrSpk) hdrSpk.classList.toggle("speaker-muted", !!remote.muted);
}

function showLocal() {
  const lv = $("local-media");
  lv.srcObject = call.local;
  lv.style.display = call.video && call.local ? "block" : "none";
}

async function getMedia(video) {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: "user" } : false });
}

async function startCall(video) {
  if (call.state !== "idle") return;
  if (!passkey || !channel || !peerOnline) {
    return uiAlert("Peer is offline", "Calls need both phones online with the app open.");
  }
  try {
    call.local = await getMedia(video);
  } catch (e) {
    return uiAlert("Permission needed", "Microphone" + (video ? " and camera" : "") + " access was blocked.");
  }
  call.state = "calling";
  call.video = video;
  call.micOn = true;
  call.camOn = true;
  showLocal();
  callUI(true, "Calling…", video ? "Video call" : "Voice call", "calling");
  sendCtl({ op: "call", k: "invite", video });
  call.timer = setTimeout(() => { if (call.state === "calling") endCall("NO ANSWER", true); }, 45000);
}

async function acceptCall() {
  if (call.state !== "ringing") return;
  clearTimeout(call.timer);
  try {
    call.local = await getMedia(call.video);
  } catch (e) {
    sendCtl({ op: "call", k: "decline" });
    call.state = "idle";
    callUI(false);
    return uiAlert("Permission needed", "Microphone" + (call.video ? " and camera" : "") + " access was blocked.");
  }
  call.micOn = true;
  call.camOn = true;
  showLocal();
  await buildPeer();
  callUI(true, "Connecting…", "", "calling");
  sendCtl({ op: "call", k: "accept" });
}

function hangUp() {
  if (call.state === "ringing") endCall("CALL DECLINED", true);
  else endCall("CALL ENDED", true);
}

async function buildPeer() {
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });
  call.pc = pc;
  call.ice = [];
  pc.onicecandidate = (e) => {
    if (e.candidate) sendCtl({ op: "call", k: "ice", c: e.candidate });
  };
  pc.ontrack = (e) => {
    const rm = $("remote-media");
    if (e.streams && e.streams[0]) {
      rm.srcObject = e.streams[0];
      rm.play().catch(() => {});
    }
  };
  pc.onconnectionstatechange = () => {
    if (call.pc !== pc) return;
    if (pc.connectionState === "connected" && call.state !== "active") {
      call.state = "active";
      call.t0 = Date.now();
      callUI(true, call.video ? "Video call" : "Voice call", "00:00", "active");
      clearInterval(call.tick);
      call.tick = setInterval(() => {
        const s = Math.floor((Date.now() - call.t0) / 1000);
        $("call-sub").innerText = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      }, 1000);
    } else if (pc.connectionState === "failed") {
      endCall("CONNECTION FAILED. A TURN SERVER MAY BE NEEDED ON MOBILE DATA.", true);
    }
  };
  call.local.getTracks().forEach(t => pc.addTrack(t, call.local));
}

async function drainCallIce() {
  while (call.pc && call.pc.remoteDescription && call.ice.length) {
    try { await call.pc.addIceCandidate(call.ice.shift()); } catch (e) {}
  }
}

async function handleCallSignal(o) {
  try {
    switch (o.k) {
      case "invite":
        if (call.state !== "idle") { sendCtl({ op: "call", k: "busy" }); return; }
        call.state = "ringing";
        call.video = !!o.video;
        callUI(true, "Incoming " + (o.video ? "video" : "voice") + " call", "Peer is calling…", "ringing");
        if (navigator.vibrate) navigator.vibrate([300, 200, 300, 200, 300]);
        call.timer = setTimeout(() => { if (call.state === "ringing") endCall("MISSED CALL", true); }, 45000);
        break;
      case "accept":
        if (call.state !== "calling") return;
        clearTimeout(call.timer);
        callUI(true, "Connecting…", "", "calling");
        await buildPeer();
        {
          const offer = await call.pc.createOffer();
          await call.pc.setLocalDescription(offer);
          sendCtl({ op: "call", k: "sdp", sdp: call.pc.localDescription });
        }
        break;
      case "sdp":
        if (!call.pc) return;
        await call.pc.setRemoteDescription(o.sdp);
        await drainCallIce();
        if (o.sdp.type === "offer") {
          const ans = await call.pc.createAnswer();
          await call.pc.setLocalDescription(ans);
          sendCtl({ op: "call", k: "sdp", sdp: call.pc.localDescription });
        }
        break;
      case "ice":
        if (!call.pc) return;
        call.ice.push(o.c);
        await drainCallIce();
        break;
      case "decline": endCall("CALL DECLINED", false); break;
      case "busy": endCall("PEER IS BUSY", false); break;
      case "end": endCall("CALL ENDED", false); break;
    }
  } catch (e) {
    endCall("CALL ERROR", true);
  }
}

function endCall(reason, notify) {
  if (call.state === "idle") return;
  if (notify) sendCtl({ op: "call", k: call.state === "ringing" ? "decline" : "end" });
  clearTimeout(call.timer);
  clearInterval(call.tick);
  if (call.local) call.local.getTracks().forEach(t => t.stop());
  if (call.pc) { try { call.pc.close(); } catch (e) {} }
  const rm = $("remote-media");
  rm.srcObject = null;
  rm.muted = false;
  $("local-media").srcObject = null;
  call.state = "idle";
  call.pc = null;
  call.local = null;
  call.ice = [];
  callUI(false);
  refreshCallButtons();
  if (reason) logSys(reason);
}

function toggleMic() {
  if (!call.local) return uiAlert("No active call", "Start a voice or video call first.");
  call.micOn = !call.micOn;
  call.local.getAudioTracks().forEach(t => { t.enabled = call.micOn; });
  refreshCallButtons();
}
function toggleCam() {
  if (!call.local) return;
  call.camOn = !call.camOn;
  call.local.getVideoTracks().forEach(t => { t.enabled = call.camOn; });
  $("local-media").style.display = call.camOn ? "block" : "none";
  refreshCallButtons();
}
function toggleSpeaker() {
  if (call.state === "idle") return uiAlert("No active call", "Start a voice or video call first.");
  const rm = $("remote-media");
  rm.muted = !rm.muted;
  refreshCallButtons();
}

// =====================================================================
// FILE TRANSFER: direct phone-to-phone over a WebRTC data channel
// =====================================================================
let ft = null;
const FT_MAX = 50 * 1024 * 1024;

function setProgress(text) {
  let el = $("ft-progress");
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "ft-progress";
    el.className = "sys-log";
    stream.insertBefore(el, typingIndicator);
  }
  el.innerText = text;
  scrollToBottom(el);
}

function ftCleanup() {
  if (!ft) return;
  try { if (ft.dc) ft.dc.close(); } catch (e) {}
  try { if (ft.pc) ft.pc.close(); } catch (e) {}
  clearTimeout(ft.timer);
  setProgress(null);
  ft = null;
}

function ftFail(msg) {
  const failedId = ft && ft.msgId;
  ftCleanup();
  if (failedId) {
    const t = $(failedId) && $(failedId).querySelector(".ticks");
    if (t) { t.innerText = "!"; t.style.color = "#ef4444"; }
    pending.delete(failedId);
  }
  logSys("FILE TRANSFER FAILED: " + msg);
}

function ftNewPeer(t) {
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });
  pc.onicecandidate = (e) => { if (e.candidate) sendCtl({ op: "ft", k: "ice", t, c: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (ft && ft.pc === pc && pc.connectionState === "failed") {
      ftFail("Connection failed. A TURN server may be needed on mobile data.");
    }
  };
  return pc;
}

async function ftDrain() {
  while (ft && ft.pc.remoteDescription && ft.ice.length) {
    try { await ft.pc.addIceCandidate(ft.ice.shift()); } catch (e) {}
  }
}

function triggerFileSelect() { $("file-picker").click(); }

function handleFileSelected(event) {
  const f = event.target.files[0];
  event.target.value = "";
  if (f) sendFile(f);
}

async function sendFile(file) {
  if (!passkey || !channel) return uiAlert("Not connected", "Enter the passkey and wait for the relay to connect.");
  if (!peerOnline) return uiAlert("Peer is offline", "Files go directly from phone to phone, so both of you need the app open.");
  if (ft) return uiAlert("Transfer in progress", "Wait for the current file to finish.");
  if (file.size > FT_MAX) return uiAlert("File too large", "The limit is 50 MB.");

  const t = uid();
  const msgId = "m_" + uid();
  const nowTime = getFormattedTime();
  const burn = disappearingEnabled ? burnDuration : 0;
  const url = URL.createObjectURL(file);
  renderBubble(file.name, "you", msgId, nowTime, burn, null, { url, name: file.name, mime: file.type, size: file.size });
  pending.set(msgId, Date.now());

  const pc = ftNewPeer(t);
  const dc = pc.createDataChannel("file", { ordered: true });
  dc.binaryType = "arraybuffer";
  ft = {
    t, pc, dc, msgId, role: "send", ice: [],
    timer: setTimeout(() => { if (ft && ft.t === t && dc.readyState !== "open") ftFail("Could not connect to peer."); }, 20000)
  };
  setProgress("CONNECTING…");

  dc.onopen = async () => {
    try {
      dc.send(JSON.stringify({ k: "meta", msgId, name: file.name, mime: file.type, size: file.size, timestamp: nowTime, burn }));
      dc.bufferedAmountLowThreshold = 512 * 1024;
      let off = 0;
      while (off < file.size) {
        if (!ft || ft.t !== t) return;
        if (dc.bufferedAmount > 1024 * 1024) {
          await new Promise(r => dc.addEventListener("bufferedamountlow", r, { once: true }));
        }
        const buf = await file.slice(off, off + 16384).arrayBuffer();
        dc.send(buf);
        off += buf.byteLength;
        setProgress("SENDING " + Math.round(off / file.size * 100) + "%");
      }
    } catch (e) {
      ftFail("Send error.");
    }
  };
  dc.onmessage = (e) => {
    if (e.data === "ok") {
      markDelivered(msgId, true);
      ftCleanup();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendCtl({ op: "ft", k: "sdp", t, sdp: pc.localDescription });
}

async function handleFileSignal(o) {
  try {
    if (o.k === "sdp" && o.sdp && o.sdp.type === "offer") {
      if (ft) ftCleanup();
      const pc = ftNewPeer(o.t);
      ft = {
        t: o.t, pc, role: "recv", chunks: [], bytes: 0, meta: null, ice: [],
        timer: setTimeout(() => { if (ft && ft.t === o.t && !ft.meta) ftFail("Timed out."); }, 25000)
      };
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dc.binaryType = "arraybuffer";
        if (ft && ft.t === o.t) ft.dc = dc;
        dc.onmessage = (ev) => ftReceive(dc, ev.data);
      };
      await pc.setRemoteDescription(o.sdp);
      await ftDrain();
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      sendCtl({ op: "ft", k: "sdp", t: o.t, sdp: pc.localDescription });
    } else if (o.k === "sdp") {
      if (ft && ft.t === o.t && ft.role === "send") {
        await ft.pc.setRemoteDescription(o.sdp);
        await ftDrain();
      }
    } else if (o.k === "ice") {
      if (!ft || ft.t !== o.t) return;
      ft.ice.push(o.c);
      await ftDrain();
    }
  } catch (e) {
    ftFail("Signalling error.");
  }
}

function ftReceive(dc, data) {
  if (!ft) return;
  if (typeof data === "string") {
    try {
      const j = JSON.parse(data);
      if (j.k === "meta") {
        const size = Number(j.size);
        if (!(size > 0 && size <= FT_MAX) || typeof j.msgId !== "string") return ftFail("Invalid file.");
        ft.meta = j;
        ft.meta.size = size;
        setProgress("RECEIVING " + String(j.name || "file").slice(0, 40) + "…");
      }
    } catch (e) {}
    return;
  }
  if (!ft.meta) return;
  ft.chunks.push(data);
  ft.bytes += data.byteLength;
  setProgress("RECEIVING " + Math.min(100, Math.round(ft.bytes / ft.meta.size * 100)) + "%");
  if (ft.bytes >= ft.meta.size) {
    const m = ft.meta;
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(m.mime || "") ? m.mime : "application/octet-stream";
    const url = URL.createObjectURL(new Blob(ft.chunks, { type: mime }));
    const tt = ft.t;
    try { dc.send("ok"); } catch (e) {}
    setTimeout(() => { if (ft && ft.t === tt) ftCleanup(); }, 1500);
    if (!seenIds.has(m.msgId)) {
      seenIds.add(m.msgId);
      renderBubble(String(m.name || "file").slice(0, 120), "peer", m.msgId, String(m.timestamp || ""),
        Number(m.burn) || 0, null, { url, name: String(m.name || "file").slice(0, 120), mime, size: m.size });
      sendCtl({ op: "ack", id: m.msgId });
      afterPeerBubble(m.msgId);
    }
  }
}

// =====================================================================
// SETTINGS, DISAPPEARING MESSAGES, DIALOGS, PURGE, THEMES
// =====================================================================
function broadcastConfigSync() {
  if (!passkey) return;
  sendCtl({ op: "cfg", enabled: disappearingEnabled, duration: burnDuration });
}

function toggleDisappearingSetting(broadcast) {
  disappearingEnabled = !disappearingEnabled;
  lsSet("disappearing", disappearingEnabled);
  updateDisappearingUI();
  if (broadcast) {
    broadcastConfigSync();
    logSys(disappearingEnabled
      ? `YOU SET DISAPPEARING MESSAGES TO ${burnDuration}s.`
      : "YOU TURNED OFF DISAPPEARING MESSAGES.");
  }
}

function setDisappearingDuration(val, label, broadcast) {
  burnDuration = val;
  lsSet("burn_duration", burnDuration);
  updateDisappearingUI();
  if (broadcast) {
    broadcastConfigSync();
    logSys(`YOU SET DISAPPEARING MESSAGES TO ${label}.`);
  }
}

function applyRemoteConfig(enabled, duration) {
  disappearingEnabled = !!enabled;
  burnDuration = parseInt(duration, 10) || 10;
  lsSet("disappearing", disappearingEnabled);
  lsSet("burn_duration", burnDuration);
  updateDisappearingUI();
  logSys(disappearingEnabled
    ? `PEER SET DISAPPEARING MESSAGES TO ${burnDuration}s.`
    : "PEER TURNED OFF DISAPPEARING MESSAGES.");
}

function updateDisappearingUI() {
  const toggleEl = $("disappearing-toggle");
  const masterSub = $("disappearing-master-sub");
  const timerRow = $("burn-timer-row");
  const burnLabel = $("current-burn-label");
  if (burnLabel) burnLabel.innerText = `${burnDuration} Seconds`;
  if (disappearingEnabled) {
    toggleEl.classList.add("active");
    masterSub.innerText = `On (${burnDuration}s auto-burn)`;
    timerRow.classList.remove("disabled");
  } else {
    toggleEl.classList.remove("active");
    masterSub.innerText = "Off";
    timerRow.classList.add("disabled");
  }
}

function openSettings() {
  updateSettingsLabels();
  $("settings-screen").style.display = "flex";
  history.pushState({ modal: "settings" }, "");
}
function closeSettings() {
  $("settings-screen").style.display = "none";
  if (history.state && history.state.modal === "settings") history.back();
}
window.addEventListener("popstate", () => {
  const settingsScreen = $("settings-screen");
  const selectionModal = $("selection-modal");
  if (selectionModal && selectionModal.style.display === "flex") {
    selectionModal.style.display = "none";
    return;
  }
  if (settingsScreen && settingsScreen.style.display === "flex") settingsScreen.style.display = "none";
});

const dialogData = {
  theme: {
    title: "Select Console Theme",
    options: [
      { label: "Stealth Emerald", val: "stealth" },
      { label: "Matrix Green", val: "matrix" },
      { label: "OLED Black", val: "oled" },
      { label: "Charcoal Slate", val: "charcoal" },
      { label: "Vintage Amber", val: "amber" }
    ],
    current: () => currentTheme,
    onSelect: (val, label) => {
      currentTheme = val;
      lsSet("theme", val);
      setTheme(val);
      $("current-theme-label").innerText = label;
    }
  },
  font: {
    title: "Select Typography",
    options: [
      { label: "System Modern", val: "sans" },
      { label: "Courier Terminal", val: "mono" },
      { label: "Classic Serif", val: "serif" }
    ],
    current: () => currentFont,
    onSelect: (val, label) => {
      currentFont = val;
      lsSet("font", val);
      setFont(val);
      $("current-font-label").innerText = label;
    }
  },
  fontSize: {
    title: "Select Font Size",
    options: [
      { label: "Small (13px)", val: "13" },
      { label: "Medium (15px)", val: "15" },
      { label: "Large (17px)", val: "17" },
      { label: "Extra Large (19px)", val: "19" }
    ],
    current: () => currentFontSize,
    onSelect: (val) => {
      currentFontSize = val;
      lsSet("font_size", val);
      setFontSize(val);
    }
  },
  burn: {
    title: "Select Burn Duration",
    options: [
      { label: "10 Seconds", val: 10 },
      { label: "20 Seconds", val: 20 },
      { label: "30 Seconds", val: 30 },
      { label: "60 Seconds", val: 60 }
    ],
    current: () => burnDuration,
    onSelect: (val, label) => setDisappearingDuration(val, label, true)
  },
  retention: {
    title: "Keep Undelivered Messages",
    options: [
      { label: "1 day", val: 1 },
      { label: "7 days", val: 7 },
      { label: "30 days", val: 30 }
    ],
    current: () => getVaultDays(),
    onSelect: (val) => { lsSet("vault_days", val); updateSettingsLabels(); }
  }
};

function openDialog(type) {
  const config = dialogData[type];
  $("modal-dialog-title").innerText = config.title;
  const list = $("modal-options-list");
  list.innerHTML = "";
  const activeVal = config.current();
  config.options.forEach(opt => {
    const row = document.createElement("div");
    row.className = "dialog-option";
    row.innerHTML = `
      <div class="os-radio ${opt.val == activeVal ? "selected" : ""}"><div class="os-radio-dot"></div></div>
      <span>${escapeHtml(opt.label)}</span>`;
    row.onclick = () => { config.onSelect(opt.val, opt.label); closeDialog(); };
    list.appendChild(row);
  });
  $("selection-modal").style.display = "flex";
}
function closeDialog() { $("selection-modal").style.display = "none"; }

async function purgeBothScreens() {
  const ok = await uiConfirm("Shred everything?",
    "This clears the chat on both phones and empties the offline vault. It cannot be undone.",
    "Shred", true);
  if (!ok) return;
  wipeLocal();
  sendCtl({ op: "purge" });
  if (getStoredVaultUrl() && passkey) vaultCall({ action: "purge" });
  closeSettings();
  logSys("LOCAL & VAULT BUFFERS SHREDDED.");
}

const THEME_VARS = ["--bg", "--panel-bg", "--card-bg", "--card-border", "--dialog-bg", "--you-bubble", "--peer-bubble", "--accent"];
const THEMES = {
  stealth:  ["#090a0f", "#0e1015", "#161922", "#212631", "#1c202a", "#005c4b", "#1a222d", "#00a884"],
  matrix:   ["#050b07", "#09140c", "#102115", "#1b3824", "#14281a", "#133b1e", "#0f2015", "#22c55e"],
  oled:     ["#000000", "#080808", "#121212", "#1f1f1f", "#171717", "#262626", "#161616", "#ffffff"],
  charcoal: ["#121316", "#17181c", "#202227", "#2e3138", "#25272e", "#2d3748", "#1a202c", "#38bdf8"],
  amber:    ["#0e0905", "#150e08", "#20160d", "#362516", "#2a1c10", "#3d2708", "#211606", "#f59e0b"]
};
function setTheme(t) {
  const v = THEMES[t] || THEMES.stealth;
  THEME_VARS.forEach((n, i) => document.documentElement.style.setProperty(n, v[i]));
}
function setFont(f) {
  const fonts = {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Devanagari", "Devanagari MT", Helvetica, Arial, sans-serif',
    mono: '"Courier New", Courier, monospace',
    serif: 'Georgia, Cambria, "Times New Roman", serif'
  };
  document.documentElement.style.setProperty("--font-stack", fonts[f] || fonts.sans);
}
function setFontSize(sz) {
  document.documentElement.style.setProperty("--font-size", sz + "px");
  const label = $("current-size-label");
  if (label) label.innerText = `${sz}px`;
}
