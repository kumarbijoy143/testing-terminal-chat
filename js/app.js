/* ============================================================
   1. DETERMINISTIC IDENTITY: NEVER SWAPS SENDER/RECEIVER
   ============================================================ */
let MY_DEVICE_ID = localStorage.getItem(CONFIG.DEVICE_ID_STORAGE_KEY);
if (!MY_DEVICE_ID) {
  MY_DEVICE_ID = 'dev_' + Math.random().toString(36).substring(2, 8) + Date.now().toString(36);
  localStorage.setItem(CONFIG.DEVICE_ID_STORAGE_KEY, MY_DEVICE_ID);
}

let passKey = "";
let piesocket = null;
let channel = null;
let activeQuotedTarget = null;
let editingMessageId = null;
let disappearingActive = true;
let burnDuration = CONFIG.DEFAULT_AUTO_BURN_SECONDS;

/* ============================================================
   2. SESSION MOUNT & PIESOCKET WEBSOCKET
   ============================================================ */
function mountSession() {
  const pin = document.getElementById('numeric-key').value.trim();
  if (!pin) return;
  passKey = pin;
  document.getElementById('passkey-dialog').style.display = 'none';
  
  const savedKey = localStorage.getItem('custom_relay_key') || CONFIG.DEFAULT_PIESOCKET_KEY;
  document.getElementById('current-relay-label').textContent = savedKey === CONFIG.DEFAULT_PIESOCKET_KEY ? "Default" : "Custom Key";

  initPieSocket(savedKey);
}

function initPieSocket(apiKey) {
  try {
    piesocket = new PieSocket.default({
      apiKey: apiKey,
      cluster: CONFIG.DEFAULT_CLUSTER
    });

    channel = piesocket.subscribe('room-' + passKey);

    channel.on('open', () => {
      document.getElementById('conn-state').textContent = "AES-256 SECURED";
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
   3. BULLETPROOF SENDER/RECEIVER ENCRYPTED MESSAGING
   ============================================================ */
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !channel) return;

  const payload = {
    msgId: 'msg_' + Date.now() + Math.random().toString(36).substring(2, 6),
    senderId: MY_DEVICE_ID, // <-- Stamped deterministically
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

    // Push-to-Talk Binary Audio Stream
    if (data.type === 'ptt-audio') {
      if (data.senderId !== MY_DEVICE_ID) playIncomingPTTAudio(data.audio);
      return;
    }

    // Strict Device Check: Ignore echo of my own regular text message
    if (data.senderId === MY_DEVICE_ID) {
      return;
    }

    if (data.type === 'edit') {
      applyMessageEdit(data.editTargetId, data.content);
      return;
    }

    renderGooglePayBubble(data, false);
  } catch (e) {
    console.error("Payload decryption failure:", e);
  }
}

/* ============================================================
   4. 120 FPS GOOGLE PAY BUBBLE RENDERING
   ============================================================ */
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

  // Attach context menu events (Long-press / Right-click)
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
   5. MESSAGE INTERACTIONS (REPLY, EDIT, CONTEXT MENU)
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
  
  editItem.style.display = isOutgoing ? 'flex' : 'none';
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
   6. IN-APP FAST EMOJI TRAY
   ============================================================ */
function toggleEmojiTray() {
  const tray = document.getElementById('emoji-tray');
  tray.classList.toggle('emoji-tray-hidden');
}

function insertEmoji(char) {
  const input = document.getElementById('msg-input');
  input.value += char;
  input.focus();
}

/* ============================================================
   7. PUSH-TO-TALK (PTT) MICROPHONE PIPELINE
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
    console.error("PTT Mic Blocked:", err);
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
   8. WEBRTC P2P AUDIO & VIDEO CALL ENGINE
   ============================================================ */
let peerConn = null;
let localStream = null;

async function initiateCall(isVideo) {
  document.getElementById('call-modal').classList.remove('call-modal-hidden');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
    document.getElementById('local-video').srcObject = localStream;

    peerConn = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
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
    alert("Camera/Mic Permission Required: " + err.message);
    endCall();
  }
}

async function handleWebRTCSignal(signal) {
  if (!peerConn) {
    document.getElementById('call-modal').classList.remove('call-modal-hidden');
    peerConn = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
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

/* ============================================================
   9. SETTINGS, THEMES, AND PANIC ACTIONS
   ============================================================ */
function panicExit() {
  document.body.innerHTML = "<div style='display:flex;height:100vh;align-items:center;justify-content:center;background:#000;color:#333;font-family:monospace;'>SESSION TERMINATED</div>";
}

function purgeBothScreens() {
  document.getElementById('chat-stream').innerHTML = '';
  closeSettings();
}

function openSettings() {
  document.getElementById('settings-screen').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settings-screen').style.display = 'none';
}

function toggleSpeaker() {
  const remoteVid = document.getElementById('remote-video');
  remoteVid.muted = !remoteVid.muted;
}

function toggleDisappearingSetting() {
  disappearingActive = !disappearingActive;
  const toggle = document.getElementById('disappearing-toggle');
  toggle.classList.toggle('active', disappearingActive);
  document.getElementById('disappearing-master-sub').textContent = disappearingActive ? `On (${burnDuration}s auto-burn)` : "Off";
}
