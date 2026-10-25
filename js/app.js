/* ============================================================
   1. STORAGE KEYS & PERSISTENT DEVICE IDENTITY
   ============================================================ */
const STORAGE = {
  DEVICE_ID: "chat_device_id",
  RELAY_KEY: "chat_relay_key",
  VAULT_URL: "chat_vault_url",
  THEME: "chat_theme",
  FONT_FAMILY: "chat_font_family",
  FONT_SIZE: "chat_font_size",
  DISAPPEARING_ACTIVE: "chat_disappearing_active",
  BURN_SECONDS: "chat_burn_seconds"
};

// Deterministic Device ID (Prevents Sender/Receiver Inversion)
let MY_DEVICE_ID = localStorage.getItem(STORAGE.DEVICE_ID);
if (!MY_DEVICE_ID) {
  MY_DEVICE_ID = 'dev_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  localStorage.setItem(STORAGE.DEVICE_ID, MY_DEVICE_ID);
}

// App runtime states
let passKey = "";
let piesocket = null;
let channel = null;
let activeQuotedTarget = null;
let editingMessageId = null;
let currentDialogType = null;

// Settings states
let disappearingActive = true;
let burnDuration = 10;
let relayKey = "";
let vaultUrl = "";

/* ============================================================
   2. INITIALIZE & RESTORE PREVIOUS SETTINGS ON LOAD
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  restorePersistedSettings();
});

function restorePersistedSettings() {
  // 1. Device ID label
  const devLabel = document.getElementById('my-device-id-label');
  if (devLabel) devLabel.textContent = MY_DEVICE_ID;

  // 2. Restore Relay Key
  relayKey = localStorage.getItem(STORAGE.RELAY_KEY) || (typeof CONFIG !== 'undefined' ? CONFIG.DEFAULT_PIESOCKET_KEY : "");
  const relayLabel = document.getElementById('current-relay-label');
  if (relayLabel) {
    relayLabel.textContent = relayKey ? (relayKey.length > 12 ? relayKey.substring(0, 10) + "..." : relayKey) : "Not Configured";
  }

  // 3. Restore Offline Vault URL
  vaultUrl = localStorage.getItem(STORAGE.VAULT_URL) || "";
  const vaultLabel = document.getElementById('current-vault-label');
  if (vaultLabel) {
    vaultLabel.textContent = vaultUrl || "Not Configured";
  }

  // 4. Restore Theme
  const savedTheme = localStorage.getItem(STORAGE.THEME) || "emerald";
  applyTheme(savedTheme, false);

  // 5. Restore Typography
  const savedFont = localStorage.getItem(STORAGE.FONT_FAMILY) || "system";
  applyFont(savedFont, false);

  // 6. Restore Font Size
  const savedSize = localStorage.getItem(STORAGE.FONT_SIZE) || "15px";
  applyFontSize(savedSize, false);

  // 7. Restore Disappearing Messages
  const savedDisappearing = localStorage.getItem(STORAGE.DISAPPEARING_ACTIVE);
  if (savedDisappearing !== null) {
    disappearingActive = savedDisappearing === "true";
  }
  const savedBurn = localStorage.getItem(STORAGE.BURN_SECONDS);
  if (savedBurn) {
    burnDuration = parseInt(savedBurn, 10);
  }
  updateDisappearingUI();
}

/* ============================================================
   3. SETTINGS HANDLERS (BYOK, VAULT, THEME, DIALOGS)
   ============================================================ */
function configureRelayKey() {
  const current = localStorage.getItem(STORAGE.RELAY_KEY) || "";
  const input = prompt("Enter your PieSocket Relay Product Key (BYOK):", current);
  if (input !== null) {
    const trimmed = input.trim();
    localStorage.setItem(STORAGE.RELAY_KEY, trimmed);
    relayKey = trimmed;
    const relayLabel = document.getElementById('current-relay-label');
    if (relayLabel) relayLabel.textContent = trimmed ? (trimmed.length > 12 ? trimmed.substring(0, 10) + "..." : trimmed) : "Not Configured";
  }
}

function configureVaultUrl() {
  const current = localStorage.getItem(STORAGE.VAULT_URL) || "";
  const input = prompt("Enter Offline Vault URL / Webhook Endpoint:", current);
  if (input !== null) {
    const trimmed = input.trim();
    localStorage.setItem(STORAGE.VAULT_URL, trimmed);
    vaultUrl = trimmed;
    const vaultLabel = document.getElementById('current-vault-label');
    if (vaultLabel) vaultLabel.textContent = trimmed || "Not Configured";
  }
}

// Dialog Options Definition
const DIALOG_CONFIG = {
  theme: {
    title: "Select Theme",
    options: [
      { id: "emerald", label: "Stealth Emerald" },
      { id: "cyberpunk", label: "Cyberpunk Neon" },
      { id: "matrix", label: "Matrix Terminal" },
      { id: "nordic", label: "Nordic Slate" }
    ]
  },
  font: {
    title: "Select Typography",
    options: [
      { id: "system", label: "System Modern" },
      { id: "mono", label: "Terminal Monospace" },
      { id: "sans", label: "Clean Sans-Serif" }
    ]
  },
  fontSize: {
    title: "Chat Font Size",
    options: [
      { id: "13px", label: "Compact (13px)" },
      { id: "15px", label: "Default (15px)" },
      { id: "17px", label: "Large (17px)" }
    ]
  },
  burn: {
    title: "Auto-Burn Timer",
    options: [
      { id: "5", label: "5 Seconds" },
      { id: "10", label: "10 Seconds" },
      { id: "30", label: "30 Seconds" },
      { id: "60", label: "60 Seconds" }
    ]
  }
};

function openDialog(type) {
  currentDialogType = type;
  const cfg = DIALOG_CONFIG[type];
  if (!cfg) return;

  document.getElementById('modal-dialog-title').textContent = cfg.title;
  const listEl = document.getElementById('modal-options-list');
  listEl.innerHTML = "";

  cfg.options.forEach(opt => {
    const row = document.createElement('div');
    row.style.padding = "12px 14px";
    row.style.cursor = "pointer";
    row.style.borderBottom = "1px solid var(--border-color)";
    row.style.fontSize = "14px";
    row.textContent = opt.label;
    row.onclick = () => selectDialogOption(type, opt.id, opt.label);
    listEl.appendChild(row);
  });

  document.getElementById('selection-modal').style.display = 'flex';
}

function closeDialog() {
  document.getElementById('selection-modal').style.display = 'none';
  currentDialogType = null;
}

function selectDialogOption(type, id, label) {
  if (type === 'theme') applyTheme(id, true, label);
  if (type === 'font') applyFont(id, true, label);
  if (type === 'fontSize') applyFontSize(id, true, label);
  if (type === 'burn') applyBurnTimer(id, true, label);
  closeDialog();
}

function applyTheme(themeId, save = true, label = null) {
  if (themeId === "emerald") document.body.removeAttribute('data-theme');
  else document.body.setAttribute('data-theme', themeId);

  if (save) localStorage.setItem(STORAGE.THEME, themeId);
  const targetLabel = document.getElementById('current-theme-label');
  if (targetLabel) {
    const found = DIALOG_CONFIG.theme.options.find(o => o.id === themeId);
    targetLabel.textContent = label || (found ? found.label : "Stealth Emerald");
  }
}

function applyFont(fontId, save = true, label = null) {
  let fontRule = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  if (fontId === "mono") fontRule = 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
  if (fontId === "sans") fontRule = '"Helvetica Neue", Arial, sans-serif';

  document.documentElement.style.setProperty('--font-family', fontRule);
  if (save) localStorage.setItem(STORAGE.FONT_FAMILY, fontId);

  const targetLabel = document.getElementById('current-font-label');
  if (targetLabel) {
    const found = DIALOG_CONFIG.font.options.find(o => o.id === fontId);
    targetLabel.textContent = label || (found ? found.label : "System Modern");
  }
}

function applyFontSize(size, save = true, label = null) {
  document.documentElement.style.setProperty('--chat-font-size', size);
  if (save) localStorage.setItem(STORAGE.FONT_SIZE, size);
  const targetLabel = document.getElementById('current-size-label');
  if (targetLabel) targetLabel.textContent = label || size;
}

function applyBurnTimer(secondsStr, save = true, label = null) {
  burnDuration = parseInt(secondsStr, 10);
  if (save) localStorage.setItem(STORAGE.BURN_SECONDS, secondsStr);
  updateDisappearingUI();
}

function toggleDisappearingSetting(save = true) {
  disappearingActive = !disappearingActive;
  if (save) localStorage.setItem(STORAGE.DISAPPEARING_ACTIVE, disappearingActive);
  updateDisappearingUI();
}

function updateDisappearingUI() {
  const toggle = document.getElementById('disappearing-toggle');
  if (toggle) toggle.classList.toggle('active', disappearingActive);

  const sub = document.getElementById('disappearing-master-sub');
  if (sub) {
    sub.textContent = disappearingActive ? `On (${burnDuration}s auto-burn)` : "Off";
  }

  const burnLabel = document.getElementById('current-burn-label');
  if (burnLabel) burnLabel.textContent = `${burnDuration} Seconds`;
}

function purgeBothScreens() {
  if (confirm("Shred all message buffers and wipe vault screen?")) {
    document.getElementById('chat-stream').innerHTML = '';
    closeSettings();
  }
}

function openSettings() {
  document.getElementById('settings-screen').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settings-screen').style.display = 'none';
}

function panicExit() {
  document.body.innerHTML = `
    <div style="display:flex;height:100vh;align-items:center;justify-content:center;background:#000;color:#ef4444;font-family:monospace;font-size:18px;">
      [SYSTEM PURGED & LOCKED]
    </div>`;
}

/* ============================================================
   4. MOUNT SESSION & CONNECT TO RELAY (PIESOCKET)
   ============================================================ */
function mountSession() {
  const inputPin = document.getElementById('numeric-key').value.trim();
  if (!inputPin) return;
  passKey = inputPin;
  document.getElementById('passkey-dialog').style.display = 'none';

  initPieSocket();
}

function initPieSocket() {
  const effectiveKey = relayKey || (typeof CONFIG !== 'undefined' ? CONFIG.DEFAULT_PIESOCKET_KEY : "");
  const cluster = (typeof CONFIG !== 'undefined' ? CONFIG.DEFAULT_CLUSTER : "free.blr1");

  try {
    piesocket = new PieSocket.default({
      apiKey: effectiveKey,
      cluster: cluster
    });

    channel = piesocket.subscribe('room-' + passKey);

    channel.on('open', () => {
      document.getElementById('conn-state').textContent = "AES-256 ENCRYPTED";
      document.getElementById('status-dot').classList.add('online');
    });

    channel.on('message', (event) => {
      handleIncomingPayload(event.data);
    });
  } catch (err) {
    document.getElementById('conn-state').textContent = "CONN ERROR";
  }
}

/* ============================================================
   5. BULLETPROOF SENDER/RECEIVER ENCRYPTION & 120 FPS GPAY CARDS
   ============================================================ */
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !channel) return;

  const payload = {
    msgId: 'msg_' + Date.now() + Math.random().toString(36).substring(2, 6),
    senderId: MY_DEVICE_ID, // <-- Stamped persistently
    content: text,
    timestamp: Date.now(),
    type: editingMessageId ? 'edit' : 'text',
    editTargetId: editingMessageId,
    replyTo: activeQuotedTarget,
    burnAfter: disappearingActive ? burnDuration : 0
  };

  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(payload), passKey).toString();
  channel.publish('chat-event', encrypted);

  if (editingMessageId) {
    applyMessageEdit(payload.editTargetId, payload.content);
  } else {
    renderGooglePayBubble(payload, true);
  }

  cancelReplyOrEdit();
  input.value = "";
  input.style.height = 'auto';
}

function handleIncomingPayload(encryptedStr) {
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedStr, passKey);
    const data = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));

    // WebRTC Signaling Handshake
    if (data.type === 'signal') {
      if (data.senderId !== MY_DEVICE_ID) handleWebRTCSignal(data.signal);
      return;
    }

    // Push-to-Talk Audio Stream
    if (data.type === 'ptt-audio') {
      if (data.senderId !== MY_DEVICE_ID) playIncomingPTTAudio(data.audio);
      return;
    }

    // Strict Device Filter: Never echo self
    if (data.senderId === MY_DEVICE_ID) {
      return;
    }

    if (data.type === 'edit') {
      applyMessageEdit(data.editTargetId, data.content);
      return;
    }

    renderGooglePayBubble(data, false);
  } catch (e) {
    console.error("Payload decryption error:", e);
  }
}

function renderGooglePayBubble(data, isOutgoing) {
  const stream = document.getElementById('chat-stream');
  const wrap = document.createElement('div');
  wrap.className = `msg-bubble-wrap ${isOutgoing ? 'outgoing' : 'incoming'}`;
  wrap.id = data.msgId;

  const timeStr = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let replyHtml = '';
  if (data.replyTo) {
    replyHtml = `
      <div class="quoted-box">
        <b>${data.replyTo.sender}</b>: ${escapeHtml(data.replyTo.text)}
      </div>`;
  }

  wrap.innerHTML = `
    <div class="gpay-card">
      ${replyHtml}
      <div class="gpay-text">${escapeHtml(data.content)}</div>
      <div class="gpay-meta">
        <span>${timeStr}</span>
        ${isOutgoing ? '<span>✓✓</span>' : ''}
      </div>
    </div>
  `;

  attachMessageInteractions(wrap, data, isOutgoing);
  stream.appendChild(wrap);
  stream.scrollTop = stream.scrollHeight;

  // Auto-Burn Handling
  if (data.burnAfter > 0) {
    setTimeout(() => {
      wrap.style.transition = 'opacity 0.3s, transform 0.3s';
      wrap.style.opacity = '0';
      wrap.style.transform = 'scale(0.85)';
      setTimeout(() => wrap.remove(), 300);
    }, data.burnAfter * 1000);
  }
}

function applyMessageEdit(msgId, newText) {
  const wrap = document.getElementById(msgId);
  if (!wrap) return;
  const textEl = wrap.querySelector('.gpay-text');
  if (textEl) {
    textEl.textContent = newText;
    const meta = wrap.querySelector('.gpay-meta');
    if (meta && !meta.innerHTML.includes('(edited)')) {
      meta.insertAdjacentHTML('afterbegin', '<span>(edited) </span>');
    }
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}

/* ============================================================
   6. CONTEXT MENU & QUOTED REPLIES
   ============================================================ */
let activeContextTarget = null;
let pressTimer = null;

function attachMessageInteractions(el, data, isOutgoing) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, data, isOutgoing);
  });

  el.addEventListener('pointerdown', (e) => {
    pressTimer = setTimeout(() => {
      openContextMenu(e.clientX, e.clientY, data, isOutgoing);
    }, 550);
  });

  el.addEventListener('pointerup', () => clearTimeout(pressTimer));
  el.addEventListener('pointerleave', () => clearTimeout(pressTimer));
}

function openContextMenu(x, y, data, isOutgoing) {
  activeContextTarget = { elementId: data.msgId, data: data, isOutgoing: isOutgoing };
  const menu = document.getElementById('msg-context-menu');
  const editItem = document.getElementById('context-edit-item');
  
  if (editItem) editItem.style.display = isOutgoing ? 'flex' : 'none';
  menu.style.left = `${Math.min(x, window.innerWidth - 150)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 150)}px`;
  menu.style.display = 'block';
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#msg-context-menu')) {
    document.getElementById('msg-context-menu').style.display = 'none';
  }
});

function triggerContextAction(action) {
  document.getElementById('msg-context-menu').style.display = 'none';
  if (!activeContextTarget) return;

  if (action === 'copy') {
    navigator.clipboard.writeText(activeContextTarget.data.content);
  } else if (action === 'reply') {
    activeQuotedTarget = {
      sender: activeContextTarget.isOutgoing ? 'You' : 'Peer',
      text: activeContextTarget.data.content
    };
    document.getElementById('reply-target-title').textContent = `Replying to ${activeQuotedTarget.sender}`;
    document.getElementById('reply-target-text').textContent = activeQuotedTarget.text;
    document.getElementById('reply-preview-bar').style.display = 'flex';
  } else if (action === 'edit') {
    editingMessageId = activeContextTarget.data.msgId;
    document.getElementById('reply-target-title').textContent = "Editing message";
    document.getElementById('reply-target-text').textContent = activeContextTarget.data.content;
    document.getElementById('reply-preview-bar').style.display = 'flex';
    document.getElementById('msg-input').value = activeContextTarget.data.content;
  }
}

function cancelReplyOrEdit() {
  activeQuotedTarget = null;
  editingMessageId = null;
  document.getElementById('reply-preview-bar').style.display = 'none';
}

/* ============================================================
   7. IN-APP FAST EMOJI TRAY
   ============================================================ */
function toggleEmojiTray() {
  const tray = document.getElementById('emoji-tray');
  if (tray) tray.classList.toggle('emoji-tray-hidden');
}

function insertEmoji(char) {
  const input = document.getElementById('msg-input');
  input.value += char;
  input.focus();
}

/* ============================================================
   8. PUSH-TO-TALK (PTT) MICROPHONE PIPELINE
   ============================================================ */
let mediaRecorder = null;
let pttChunks = [];

async function startPTT(e) {
  e.preventDefault();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pttChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (ev) => pttChunks.push(ev.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(pttChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = () => {
        sendPayloadOverSocket({
          type: 'ptt-audio',
          audio: reader.result
        });
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.start();
    document.getElementById('mic-toggle-btn').style.color = '#ef4444';
  } catch (err) {
    console.error("PTT Mic access denied:", err);
  }
}

function stopPTT(e) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    document.getElementById('mic-toggle-btn').style.color = '';
  }
}

function playIncomingPTTAudio(base64) {
  const audio = new Audio(base64);
  audio.play();
}

function sendPayloadOverSocket(obj) {
  obj.senderId = MY_DEVICE_ID;
  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(obj), passKey).toString();
  channel.publish('chat-event', encrypted);
}

/* ============================================================
   9. WEBRTC P2P AUDIO & VIDEO CALL ENGINE
   ============================================================ */
let peerConn = null;
let localStream = null;

async function initiateCall(isVideo) {
  document.getElementById('call-modal').classList.remove('call-modal-hidden');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
    document.getElementById('local-video').srcObject = localStream;

    peerConn = new RTCPeerConnection({
      iceServers: (typeof CONFIG !== 'undefined' ? CONFIG.ICE_SERVERS : [{ urls: 'stun:stun.l.google.com:19302' }])
    });

    localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));

    peerConn.ontrack = (e) => {
      document.getElementById('remote-video').srcObject = e.streams[0];
    };

    peerConn.onicecandidate = (e) => {
      if (e.candidate) {
        sendPayloadOverSocket({ type: 'signal', signal: { candidate: e.candidate } });
      }
    };

    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    sendPayloadOverSocket({ type: 'signal', signal: { offer: offer } });
  } catch (err) {
    alert("Camera/Mic permission needed: " + err.message);
    endCall();
  }
}

async function handleWebRTCSignal(signal) {
  if (!peerConn) {
    document.getElementById('call-modal').classList.remove('call-modal-hidden');
    peerConn = new RTCPeerConnection({
      iceServers: (typeof CONFIG !== 'undefined' ? CONFIG.ICE_SERVERS : [{ urls: 'stun:stun.l.google.com:19302' }])
    });
    peerConn.ontrack = (e) => {
      document.getElementById('remote-video').srcObject = e.streams[0];
    };
  }

  if (signal.offer) {
    await peerConn.setRemoteDescription(new RTCSessionDescription(signal.offer));
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream = stream;
    document.getElementById('local-video').srcObject = localStream;
    stream.getTracks().forEach(t => peerConn.addTrack(t, stream));

    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    sendPayloadOverSocket({ type: 'signal', signal: { answer: answer } });
  } else if (signal.answer) {
    await peerConn.setRemoteDescription(new RTCSessionDescription(signal.answer));
  } else if (signal.candidate) {
    await peerConn.addIceCandidate(new RTCIceCandidate(signal.candidate));
  }
}

function endCall() {
  if (peerConn) peerConn.close();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  peerConn = null;
  localStream = null;
  document.getElementById('call-modal').classList.add('call-modal-hidden');
}

function toggleSpeaker() {
  const remoteVid = document.getElementById('remote-video');
  if (remoteVid) remoteVid.muted = !remoteVid.muted;
}
