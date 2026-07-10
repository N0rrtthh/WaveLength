const SUPABASE_URL = window.WAVELENGTH_CONFIG?.supabaseUrl ?? '';
function getAnonKey() { return window.WAVELENGTH_CONFIG?.supabaseAnonKey ?? ''; }

const DEV_MODE = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const RELAY_URL = DEV_MODE
  ? null
  : `${SUPABASE_URL}/functions/v1/relay`;

const configured = SUPABASE_URL.startsWith('https://') && getAnonKey().length > 20;
const sb = configured ? window.supabase.createClient(SUPABASE_URL, getAnonKey(), {
  realtime: { params: { eventsPerSecond: 10 } }
}) : null;

function updateStatus(ok, msg) {
  const dot = document.getElementById('connStatus');
  if (!dot) return;
  dot.title = msg;
  dot.style.background = ok ? 'var(--teal)' : 'var(--signal)';
  dot.style.boxShadow = ok ? '0 0 6px var(--teal)' : 'none';
}

function monitorConnection() {
  if (!sb) return;
  try { if (typeof sb.realtime.onOpen === 'function') sb.realtime.onOpen(() => updateStatus(true, 'Connected')); } catch {}
  try { if (typeof sb.realtime.onClose === 'function') sb.realtime.onClose(() => updateStatus(false, 'Disconnected')); } catch {}
  try { if (typeof sb.realtime.onError === 'function') sb.realtime.onError(() => updateStatus(false, 'Connection error')); } catch {}
  const probe = sb.channel('wavelength-probe');
  probe.subscribe(status => {
    if (status === 'SUBSCRIBED') updateStatus(true, 'Connected');
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') updateStatus(false, 'Connection failed');
  });
}

monitorConnection();

const REACTION_EMOJIS = ['❤️', '😂', '👍', '🔥', '😮', '😢', '🎉'];

async function relaySend(channel, payload) {
  if (DEV_MODE) {
    const ch = sb.channel(channel);
    try {
      await ch.send({ type: 'broadcast', event: 'data', payload: { ...payload, _serverVerified: true } });
    } catch { return 'error'; }
    return 'ok';
  }
  try {
    const res = await fetch(RELAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAnonKey()}`,
      },
      body: JSON.stringify({ channel, payload }),
    });
    if (res.status === 429) return 'rate-limited';
    if (!res.ok) return 'error';
    return 'ok';
  } catch { return 'error'; }
}

const CHANNEL_NAME_RE = /^[a-z0-9_-]{1,64}$/;
function makeChannel(name) {
  if (!CHANNEL_NAME_RE.test(name)) { console.error('Invalid channel name:', name); return null; }
  const channel = sb.channel(name, { config: { broadcast: { self: DEV_MODE } } });
  let handler = null;
  let closed = false;
  channel.on('broadcast', { event: 'data' }, (msg) => {
    if (handler && (DEV_MODE || msg.payload?._serverVerified === true))
      handler({ data: msg.payload });
  });
  channel.subscribe((status) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      if (!closed) {
        setTimeout(() => { if (!closed) channel.subscribe(); }, 1500);
      }
    }
  });
  return {
    set onmessage(fn) { handler = fn; },
    async postMessage(payload) { return relaySend(name, payload); },
    close() { closed = true; sb.removeChannel(channel); }
  };
}

const ADJ = ['Quiet', 'Faint', 'Static', 'Distant', 'Hollow', 'Loose', 'Idle', 'Pale', 'Drift', 'Low', 'Odd', 'Blank', 'Grey', 'Slow', 'Faded'];
const NOUN = ['Signal', 'Echo', 'Frequency', 'Ghost', 'Wire', 'Channel', 'Pulse', 'Radio', 'Wave', 'Node', 'Static', 'Relay', 'Beacon'];
function genCallsign() {
  return `${ADJ[Math.floor(Math.random() * ADJ.length)]}${NOUN[Math.floor(Math.random() * NOUN.length)]}-${Math.floor(Math.random() * 90 + 10)}`;
}

function randHex(n) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
}
const myId = randHex(8);
let myName = genCallsign();

const landingNameInput = document.getElementById('landingNameInput');
landingNameInput.value = myName;
landingNameInput.oninput = () => { const v = sanitizeName(landingNameInput.value); if (v) myName = v; };
document.getElementById('landingRegenBtn').onclick = () => { myName = genCallsign(); landingNameInput.value = myName; };
document.getElementById('connectBtn').onclick = () => {
  const v = sanitizeName(landingNameInput.value);
  if (v) myName = v;
  document.getElementById('nameDisplay').textContent = myName;
  document.getElementById('landing').style.display = 'none';
  render();
};
landingNameInput.onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('connectBtn').click(); };

document.getElementById('nameDisplay').textContent = myName;
document.getElementById('homeBtn').onclick = () => {
  leaveEverything();
  render();
  document.getElementById('landing').style.display = 'flex';
  landingNameInput.value = myName;
};

const _sendTimes = [];
function isRateLimited() {
  const now = Date.now();
  while (_sendTimes.length && now - _sendTimes[0] > 3000) _sendTimes.shift();
  if (_sendTimes.length >= 5) return true;
  _sendTimes.push(now);
  return false;
}

let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed')
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}
function playClick() {
  try {
    const ctx = getAudioCtx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.06);
    g.gain.setValueAtTime(0.18, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    o.start(); o.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}

let unreadCount = 0;
const baseTitle = document.title;
function flashUnread() {
  if (document.hidden) { unreadCount++; document.title = `(${unreadCount}) ${baseTitle}`; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unreadCount = 0; document.title = baseTitle; }
});

let mode = 'hop';
let hopState = 'idle';
let lobbyChan = null, pairChan = null, pairPeerName = null, pairRoom = null;
let pendingTarget = null, pendingRoom = null, pendingTimer = null, lookInterval = null;
let channelChan = null, currentChannelName = null;
const takenIds = new Set();

const ROOMS = [
  { name: 'general',     tag: 'anything goes' },
  { name: 'late-night',  tag: 'for the sleepless' },
  { name: 'confessions', tag: 'say the quiet part' },
  { name: 'vent',        tag: 'get it out' },
  { name: 'study-hall',  tag: 'quiet company' },
];
const customRooms = [];

const msgState = new Map();
const rowByMid = new Map();

const panel = document.getElementById('panel');

const VALID_MODES = new Set(['hop', 'channels']);
const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach((t, i) => {
  t.onclick = () => activateTab(t.dataset.mode);
  t.onkeydown = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(i + dir + tabs.length) % tabs.length];
      next.focus();
      activateTab(next.dataset.mode);
    }
  };
});
function activateTab(m) {
  if (!VALID_MODES.has(m)) return;
  tabs.forEach(x => x.classList.remove('active'));
  tabs.find(x => x.dataset.mode === m).classList.add('active');
  mode = m;
  leaveEverything();
  render();
}

function closeLobby() {
  if (lookInterval) { clearInterval(lookInterval); lookInterval = null; }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (lobbyChan) { lobbyChan.close(); lobbyChan = null; }
}

function leaveEverything() {
  stopHeartbeat();
  closeLobby();
  if (pairChan) { pairChan.close(); pairChan = null; }
  if (channelChan) { channelChan.close(); channelChan = null; }
  hopState = 'idle'; pairPeerName = null; pairRoom = null;
  pendingTarget = null; pendingRoom = null;
  currentChannelName = null;
}

function render() {
  panel.innerHTML = '';
  if (!configured) {
    panel.innerHTML = `
      <div class="setup-gate">
        <h2><span class="status-dot bad"></span>Not connected yet</h2>
        <p>Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in config.js. Deploy the relay Edge Function. No tables needed — Realtime Broadcast only.</p>
      </div>`;
    return;
  }
  if (mode === 'hop') {
    if (hopState === 'idle') renderHopIdle();
    else if (hopState === 'searching' || hopState === 'pending') renderHopSearching();
    else if (hopState === 'matched') renderChat({ peer: pairPeerName, onLeave: leaveHop });
  } else {
    if (currentChannelName) renderChat({ peer: '#' + currentChannelName, onLeave: leaveChannel, isChannel: true });
    else renderChannelList();
  }
}

function renderHopIdle() {
  panel.innerHTML = `
    <div class="hop-idle">
      <div class="dial">
        <svg viewBox="0 0 120 120" fill="none">
          <circle cx="60" cy="60" r="56" stroke="#262f3f" stroke-width="2"/>
          <circle cx="60" cy="60" r="40" stroke="#3a6b60" stroke-width="1.4" stroke-dasharray="4 6"/>
          <circle cx="60" cy="60" r="5" fill="#6fd8c4"/>
        </svg>
      </div>
      <p>Get matched with a random stranger for a one-on-one, no-names conversation. Leave anytime — nothing is saved.</p>
      <button class="btn-primary" id="findBtn" type="button">Search for a signal</button>
    </div>`;
  document.getElementById('findBtn').onclick = startHopSearch;
}

function renderHopSearching() {
  panel.innerHTML = `
    <div class="hop-idle">
      <div class="searching-pulse"></div>
      <p>${hopState === 'pending' ? 'Found a signal — connecting…' : 'Scanning for another open frequency…'}</p>
      <button class="btn-ghost" id="cancelBtn" type="button">Cancel</button>
    </div>`;
  document.getElementById('cancelBtn').onclick = () => leaveHop();
}

function startHopSearch() {
  hopState = 'searching';
  render();
  lobbyChan = makeChannel('wavelength-lobby');
  lobbyChan.onmessage = handleLobby;
  lobbyChan.postMessage({ type: 'looking', id: myId, fromName: myName });
  lookInterval = setInterval(() => {
    if (hopState === 'searching' && lobbyChan) lobbyChan.postMessage({ type: 'looking', id: myId, fromName: myName });
  }, 1500);
}

function handleLobby(e) {
  const m = e.data;
  if (m.type === 'looking' && m.id && m.id !== myId) {
    if (takenIds.has(m.id)) return;
    if (hopState === 'searching' && myId < m.id && !pendingTarget) {
      hopState = 'pending';
      pendingTarget = m.id;
      pendingRoom = 'wavelength-pair-' + [myId, m.id].sort().join('-');
      pendingTimer = setTimeout(() => {
        if (hopState === 'pending') {
          hopState = 'searching';
          pendingTarget = null;
          render();
        }
      }, 5000);
      lobbyChan.postMessage({ type: 'claim', to: m.id, from: myId, fromName: myName, room: pendingRoom });
    }
  }
  if (m.type === 'claim' && m.to === myId) {
    if (hopState === 'searching') {
      hopState = 'matched';
      takenIds.add(myId);
      pairRoom = m.room;
      pairPeerName = sanitizeName(m.fromName);
      lobbyChan.postMessage({ type: 'claim-ack', to: m.from, from: myId, fromName: myName });
      lobbyChan.postMessage({ type: 'claimed', id: myId });
      closeLobby();
      connectPair();
    }
  }
  if (m.type === 'claim-ack' && m.to === myId) {
    if (hopState === 'pending') {
      hopState = 'matched';
      takenIds.add(myId);
      pairPeerName = sanitizeName(m.fromName);
      lobbyChan.postMessage({ type: 'claimed', id: myId });
      closeLobby();
      connectPair();
    }
  }
  if (m.type === 'claimed' && typeof m.id === 'string') takenIds.add(m.id);
}

function connectPair() {
  hopState = 'matched';
  if (lobbyChan) { lobbyChan.close(); lobbyChan = null; }
  pairChan = makeChannel(pairRoom);
  render();
  pushSystemMsg(`Connected to ${pairPeerName}.`);
  startHeartbeat(pairChan, true);
  pairChan.onmessage = (e) => {
    const m = e.data;
    lastPeerHeard = Date.now();
    if (peerDead && hbIsPair) recoverPeer();
    if (m.type === 'msg' && m.from !== myId && typeof m.text === 'string') appendMsg(m.text.slice(0, 500), 'them', sanitizeName(m.fromName), m.id);
    else if (m.type === 'typing' && m.from !== myId) setTyping(pairPeerName, m.state === true);
    else if (m.type === 'heartbeat') { /* handled above */ }
    else if (m.type === 'react' && m.mid) applyReaction(m.mid, m.emoji, m.from, m.add === true);
    else if (m.type === 'leave' && m.from !== myId) {
      stopHeartbeat();
      setTyping('', false);
      pushSystemMsg(`${pairPeerName} disconnected.`);
      if (pairChan) { pairChan.close(); pairChan = null; }
      disableComposer();
      showDisconnectedBar();
    }
  };
}

function leaveHop() {
  if (pairChan) { pairChan.postMessage({ type: 'leave', from: myId }); pairChan.close(); pairChan = null; }
  closeLobby();
  stopHeartbeat();
  hopState = 'idle';
  pairPeerName = null;
  render();
}

function renderChannelList() {
  panel.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'channel-list';
  [...ROOMS, ...customRooms].forEach(r => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'channel-item';
    b.innerHTML = `<div><div class="name">#${escapeHtml(r.name)}</div><div class="tag">${escapeHtml(r.tag || 'custom room')}</div></div><span class="active-dot" style="opacity:0"></span>`;
    b.onclick = () => joinChannel(r.name);
    list.appendChild(b);
  });
  panel.appendChild(list);

  const box = document.createElement('div');
  box.className = 'room-create';
  box.innerHTML = `<input id="newRoomInput" type="text" placeholder="Create or join a room…" maxlength="64" autocomplete="off" aria-label="Room name"><button id="newRoomBtn" class="btn-ghost" type="button">Go</button>`;
  panel.appendChild(box);
  const input = box.querySelector('#newRoomInput');
  const go = () => {
    const name = input.value.trim().toLowerCase();
    if (!CHANNEL_NAME_RE.test(name)) { input.classList.add('warn'); return; }
    if (!customRooms.some(c => c.name === name) && !ROOMS.some(r => r.name === name))
      customRooms.push({ name, tag: 'custom room' });
    joinChannel(name);
  };
  box.querySelector('#newRoomBtn').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

function joinChannel(name) {
  if (typeof name !== 'string' || !CHANNEL_NAME_RE.test(name)) return;
  currentChannelName = name;
  channelChan = makeChannel('wavelength-room-' + name);
  if (!channelChan) return;
  render();
  pushSystemMsg(`You joined #${escapeHtml(name)} as ${escapeHtml(myName)}.`);
  startHeartbeat(channelChan, false);
  channelChan.onmessage = (e) => {
    const m = e.data;
    lastPeerHeard = Date.now();
    if (m.type === 'msg' && m.from !== myId && typeof m.text === 'string')
      appendMsg(m.text.slice(0, 500), 'them', sanitizeName(m.fromName), m.id);
    else if (m.type === 'typing' && m.from !== myId) setTyping(sanitizeName(m.fromName), m.state === true);
    else if (m.type === 'join' && m.from !== myId) pushSystemMsg(`${sanitizeName(m.fromName)} joined.`);
    else if (m.type === 'leave' && m.from !== myId) {
      setTyping(sanitizeName(m.fromName), false);
      pushSystemMsg(`${sanitizeName(m.fromName)} left.`);
    }
    else if (m.type === 'react' && m.mid) applyReaction(m.mid, m.emoji, m.from, m.add === true);
  };
  channelChan.postMessage({ type: 'join', from: myId, fromName: myName });
}

function leaveChannel() {
  if (channelChan) {
    channelChan.postMessage({ type: 'leave', from: myId, fromName: myName });
    channelChan.close(); channelChan = null;
  }
  stopHeartbeat();
  currentChannelName = null;
  render();
}

let hbInterval = null, hbWatch = null, hbIsPair = false, lastPeerHeard = 0, peerDead = false;
function startHeartbeat(chan, isPair) {
  stopHeartbeat();
  hbIsPair = isPair;
  lastPeerHeard = Date.now();
  peerDead = false;
  hbInterval = setInterval(() => { if (chan) chan.postMessage({ type: 'heartbeat', from: myId }); }, 4000);
  hbWatch = setInterval(() => { if (hbIsPair && !peerDead && Date.now() - lastPeerHeard > 12000) onPeerDead(); }, 4000);
}
function stopHeartbeat() {
  if (hbInterval) clearInterval(hbInterval);
  if (hbWatch) clearInterval(hbWatch);
  hbInterval = hbWatch = null;
  hbIsPair = false;
}
function onPeerDead() {
  peerDead = true;
  pushSystemMsg(`${pairPeerName} disconnected.`);
  disableComposer();
  showDisconnectedBar();
  const dot = document.querySelector('.online-dot');
  if (dot) { dot.style.background = 'var(--text-dim)'; dot.style.boxShadow = 'none'; }
}
function recoverPeer() {
  peerDead = false;
  removeDisconnectedBar();
  pushSystemMsg(`${pairPeerName} reconnected.`);
  const dot = document.querySelector('.online-dot');
  if (dot) { dot.style.background = 'var(--teal)'; dot.style.boxShadow = '0 0 5px var(--teal)'; }
}

function renderChat({ peer, onLeave, isChannel }) {
  const safePeer = escapeHtml(peer);
  panel.innerHTML = `
    <div class="chat-header">
      <span class="who"><span class="online-dot"></span>${safePeer}</span>
    </div>
    <div class="msgs" id="msgs" role="log" aria-live="polite"></div>
    <button class="scroll-btn" id="scrollBtn" type="button">↓</button>
    <div class="typing-indicator" id="typingEl"></div>
    <div class="composer">
      <button class="btn-leave" id="leaveBtn" type="button">Leave</button>
      <input id="msgInput" type="text" placeholder="Say something…" maxlength="500" autocomplete="off">
      <button class="btn-send" id="sendBtn" type="button" disabled>Send</button>
    </div>
    <div class="char-count" id="charCount"></div>`;

  document.getElementById('leaveBtn').onclick = () => showConfirmBar(onLeave);

  const input = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const charCount = document.getElementById('charCount');
  const msgsEl = document.getElementById('msgs');

  let iAmTyping = false, typingDebounceTimer = null;
  function sendTypingState(state) {
    if (mode === 'hop' && pairChan)
      pairChan.postMessage({ type: 'typing', from: myId, state });
    else if (mode === 'channels' && channelChan)
      channelChan.postMessage({ type: 'typing', from: myId, fromName: myName, state });
  }

  input.oninput = () => {
    const len = input.value.length;
    const hasText = input.value.trim() !== '';
    sendBtn.disabled = !hasText;
    if (len > 400) {
      charCount.textContent = `${500 - len} left`;
      charCount.classList.toggle('warn', len > 460);
    } else {
      charCount.textContent = '';
      charCount.classList.remove('warn');
    }
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = setTimeout(() => {
      if (hasText && !iAmTyping) { iAmTyping = true; sendTypingState(true); }
      else if (!hasText && iAmTyping) { iAmTyping = false; sendTypingState(false); }
    }, 500);
  };

  const emojiBtn = document.createElement('button');
  emojiBtn.type = 'button';
  emojiBtn.className = 'emoji-btn'; emojiBtn.textContent = '😊'; emojiBtn.title = 'Emoji';
  const composer = panel.querySelector('.composer');
  composer.style.position = 'relative';
  composer.insertBefore(emojiBtn, input);
  let tray = null;
  emojiBtn.onclick = (e) => {
    e.stopPropagation();
    if (tray) { tray.remove(); tray = null; return; }
    tray = document.createElement('div'); tray.className = 'emoji-tray';
    REACTION_EMOJIS.forEach(em => {
      const s = document.createElement('button');
      s.type = 'button'; s.textContent = em;
      s.onclick = () => { input.value += em; input.dispatchEvent(new Event('input')); tray.remove(); tray = null; input.focus(); };
      tray.appendChild(s);
    });
    composer.appendChild(tray);
  };
  document.addEventListener('click', () => { if (tray) { tray.remove(); tray = null; } }, { capture: true });

  const send = async () => {
    const text = input.value.trim();
    if (!text || text.length > 500) return;
    if (isRateLimited()) {
      const warn = document.createElement('div');
      warn.className = 'msg system'; warn.style.color = 'var(--signal)';
      warn.textContent = 'Slow down — too many messages.';
      msgsEl.appendChild(warn);
      setTimeout(() => warn.remove(), 2000);
      return;
    }
    if (iAmTyping) { iAmTyping = false; sendTypingState(false); }
    playClick();
    const mid = randHex(8);
    appendMsg(text, 'me', undefined, mid);
    let result;
    if (mode === 'hop' && pairChan)
      result = await pairChan.postMessage({ type: 'msg', from: myId, fromName: myName, text, id: mid });
    else if (mode === 'channels' && channelChan)
      result = await channelChan.postMessage({ type: 'msg', from: myId, fromName: myName, text, id: mid });
    if (result === 'rate-limited') {
      const warn = document.createElement('div');
      warn.className = 'msg system'; warn.style.color = 'var(--signal)';
      warn.textContent = 'Rate limited by server.';
      msgsEl.appendChild(warn);
      setTimeout(() => warn.remove(), 2000);
    }
    input.value = ''; sendBtn.disabled = true;
    charCount.textContent = ''; charCount.classList.remove('warn');
  };

  sendBtn.onclick = send;
  input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
  input.focus();
}

function showDisconnectedBar() {
  if (document.getElementById('discBar')) return;
  const bar = document.createElement('div');
  bar.className = 'disconnected-bar'; bar.id = 'discBar';
  bar.innerHTML = `<span>Signal lost.</span><div class="dbar-btns"><button class="dbar-next" id="dbarNext" type="button">Find new</button><button class="dbar-menu" id="dbarMenu" type="button">Main menu</button></div>`;
  const charCount = document.getElementById('charCount');
  if (charCount) charCount.after(bar);
  document.getElementById('dbarNext').onclick = () => { leaveHop(); startHopSearch(); };
  document.getElementById('dbarMenu').onclick = () => leaveHop();
  const dot = document.querySelector('.online-dot');
  if (dot) { dot.style.background = 'var(--text-dim)'; dot.style.boxShadow = 'none'; }
}
function removeDisconnectedBar() {
  const bar = document.getElementById('discBar');
  if (bar) bar.remove();
}

function showConfirmBar(onConfirm) {
  const existing = document.getElementById('confirmBar');
  if (existing) { existing.remove(); return; }
  const bar = document.createElement('div');
  bar.className = 'confirm-bar'; bar.id = 'confirmBar';
  bar.innerHTML = `<span>Leave this chat?</span><div class="cbar-btns"><button class="cbar-yes" id="cbarYes" type="button">Leave</button><button class="cbar-no" id="cbarNo" type="button">Stay</button></div>`;
  document.getElementById('charCount').after(bar);
  document.getElementById('cbarYes').onclick = onConfirm;
  document.getElementById('cbarNo').onclick = () => bar.remove();
}

function setTyping(name, active) {
  const el = document.getElementById('typingEl');
  if (!el) return;
  el.innerHTML = active
    ? `<div class="typing-bubble"><span></span><span></span><span></span></div><span class="typing-name">${escapeHtml(name || 'Someone')} is typing…</span>`
    : '';
}

const MAX_MSG_DOM = 200;
function appendMsg(text, who, label, mid) {
  const msgsEl = document.getElementById('msgs');
  if (!msgsEl) return;
  while (msgsEl.querySelectorAll('.msg-row:not(.system)').length >= MAX_MSG_DOM) {
    const oldest = msgsEl.querySelector('.msg-row:not(.system)');
    if (oldest) {
      const om = oldest.dataset.mid;
      if (om) { msgState.delete(om); rowByMid.delete(om); }
      oldest.remove();
    } else break;
  }
  if (who === 'them') setTyping('', false);
  const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 40;
  const safeWho = ['me', 'them', 'system'].includes(who) ? who : 'them';
  const row = document.createElement('div');
  row.className = 'msg-row ' + safeWho;
  if (mid) row.dataset.mid = mid;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const initials = label ? label.slice(0, 2).toUpperCase() : (pairPeerName ? pairPeerName.slice(0, 2).toUpperCase() : '??');
  const bubble = document.createElement('div');
  bubble.className = 'msg ' + safeWho;
  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = text;
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = (safeWho === 'them' && label ? label + ' · ' : '') + time;
  bubble.appendChild(textEl);
  bubble.appendChild(meta);
  if (mid) {
    if (!msgState.has(mid)) msgState.set(mid, { reactions: new Map() });
    const reactWrap = document.createElement('div');
    reactWrap.className = 'msg-reactions';
    const reactBtn = document.createElement('button');
    reactBtn.type = 'button';
    reactBtn.className = 'react-btn';
    reactBtn.textContent = '🙂';
    reactBtn.setAttribute('aria-label', 'Add reaction');
    reactBtn.onclick = (e) => { e.stopPropagation(); openReactTray(mid, reactBtn); };
    bubble.appendChild(reactWrap);
    bubble.appendChild(reactBtn);
    rowByMid.set(mid, row);
  }
  if (safeWho === 'them') {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = initials;
    row.appendChild(av);
  }
  row.appendChild(bubble);
  msgsEl.appendChild(row);
  if (atBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  if (who === 'them') flashUnread();
  if (mid) {
    const st = msgState.get(mid);
    if (st && st.reactions.size) renderReactions(mid);
  }
}

function renderReactions(mid) {
  const row = rowByMid.get(mid);
  if (!row) return;
  const wrap = row.querySelector('.msg-reactions');
  if (!wrap) return;
  wrap.innerHTML = '';
  const st = msgState.get(mid);
  if (!st) return;
  for (const [emoji, set] of st.reactions) {
    if (set.size === 0) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'reaction-chip' + (set.has(myId) ? ' mine' : '');
    chip.textContent = emoji + (set.size > 1 ? ' ' + set.size : '');
    chip.onclick = () => toggleReaction(mid, emoji);
    wrap.appendChild(chip);
  }
}

function toggleReaction(mid, emoji) {
  const st = msgState.get(mid);
  if (!st) return;
  const set = st.reactions.get(emoji);
  const has = set && set.has(myId);
  const add = !has;
  applyReaction(mid, emoji, myId, add);
  const chan = mode === 'hop' ? pairChan : channelChan;
  chan && chan.postMessage({ type: 'react', from: myId, emoji, mid, add });
}

function applyReaction(mid, emoji, fromId, add) {
  let st = msgState.get(mid);
  if (!st) { st = { reactions: new Map() }; msgState.set(mid, st); }
  let set = st.reactions.get(emoji);
  if (!set) { set = new Set(); st.reactions.set(emoji, set); }
  if (add) set.add(fromId); else set.delete(fromId);
  if (set.size === 0) st.reactions.delete(emoji);
  renderReactions(mid);
}

function openReactTray(mid, btn) {
  const old = document.getElementById('reactTray');
  if (old) { old.remove(); return; }
  const tray = document.createElement('div');
  tray.id = 'reactTray';
  tray.className = 'emoji-tray';
  REACTION_EMOJIS.forEach(em => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.onclick = (e) => { e.stopPropagation(); toggleReaction(mid, em); tray.remove(); };
    tray.appendChild(b);
  });
  btn.parentElement.appendChild(tray);
  setTimeout(() => {
    const close = () => { tray.remove(); document.removeEventListener('click', close, true); };
    document.addEventListener('click', close, true);
  }, 0);
}

function pushSystemMsg(text) {
  const msgsEl = document.getElementById('msgs');
  if (!msgsEl) return;
  const row = document.createElement('div'); row.className = 'msg-row system';
  const div = document.createElement('div'); div.className = 'msg system';
  div.textContent = text;
  row.appendChild(div); msgsEl.appendChild(row);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function disableComposer() {
  const inp = document.getElementById('msgInput');
  const btn = document.getElementById('sendBtn');
  if (inp) inp.disabled = true;
  if (btn) btn.disabled = true;
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function sanitizeName(s) {
  if (typeof s !== 'string') return 'Unknown';
  return s.replace(/[^\w .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Unknown';
}

window.addEventListener('beforeunload', () => {
  if (pairChan) pairChan.postMessage({ type: 'leave', from: myId });
  if (channelChan) channelChan.postMessage({ type: 'leave', from: myId, fromName: myName });
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}
