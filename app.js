// Credentials are loaded from config.js (gitignored) — never hardcoded here.
// See config.example.js for the required shape.
const SUPABASE_URL = window.WAVELENGTH_CONFIG?.supabaseUrl ?? '';
function getAnonKey() { return window.WAVELENGTH_CONFIG?.supabaseAnonKey ?? ''; }

// DEV_MODE: true when running on localhost — bypasses relay, uses direct broadcast
// In production this is always false (relay is enforced)
const DEV_MODE = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const RELAY_URL = DEV_MODE
  ? null  // direct broadcast in dev
  : `${SUPABASE_URL}/functions/v1/relay`;

const configured = SUPABASE_URL.startsWith('https://') && getAnonKey().length > 20;
const sb = configured ? window.supabase.createClient(SUPABASE_URL, getAnonKey(), {
  realtime: { params: { eventsPerSecond: 10 } }
}) : null;

// ---------- connection status ----------
function updateStatus(ok, msg) {
  const dot = document.getElementById('connStatus');
  if (!dot) return;
  dot.title = msg;
  dot.style.background = ok ? 'var(--teal)' : 'var(--signal)';
  dot.style.boxShadow = ok ? '0 0 6px var(--teal)' : 'none';
}
if (sb) {
  const probe = sb.channel('wavelength-probe');
  probe.subscribe(status => {
    if (status === 'SUBSCRIBED') { updateStatus(true, 'Connected'); sb.removeChannel(probe); }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') updateStatus(false, 'Connection failed');
  });
}

// ---------- relay send ----------
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

// ---------- channel ----------
const CHANNEL_NAME_RE = /^[a-z0-9_-]{1,64}$/;
// self:true in DEV_MODE so each tab sees its own sends (no relay to echo them back)
// self:false in production — relay broadcasts server-side to all subscribers
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
        // Auto-reconnect once on failure
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

// ---------- identity ----------
const ADJ = ['Quiet','Faint','Static','Distant','Hollow','Loose','Idle','Pale','Drift','Low','Odd','Blank','Grey','Slow','Faded'];
const NOUN = ['Signal','Echo','Frequency','Ghost','Wire','Channel','Pulse','Radio','Wave','Node','Static','Relay','Beacon'];
function genCallsign() {
  return `${ADJ[Math.floor(Math.random()*ADJ.length)]}${NOUN[Math.floor(Math.random()*NOUN.length)]}-${Math.floor(Math.random()*90+10)}`;
}

const myId = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2,'0')).join('');
let myName = genCallsign();

// ---------- landing ----------
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

// ---------- client-side rate limiter (secondary guard — primary is Edge Function) ----------
const _sendTimes = [];
function isRateLimited() {
  const now = Date.now();
  while (_sendTimes.length && now - _sendTimes[0] > 3000) _sendTimes.shift();
  if (_sendTimes.length >= 5) return true;
  _sendTimes.push(now);
  return false;
}

// ---------- send sound (singleton AudioContext — no handle leak) ----------
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
  } catch(e) {}
}

function setNameLocked(_locked) { /* name is display-only */ }

// ---------- unread badge ----------
let unreadCount = 0;
const baseTitle = document.title;
function flashUnread() {
  if (document.hidden) { unreadCount++; document.title = `(${unreadCount}) ${baseTitle}`; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unreadCount = 0; document.title = baseTitle; }
});

// ---------- state ----------
let mode = 'hop';
let hopState = 'idle';
let queueChan = null, pairChan = null, pairPeerName = null, pairRoom = null;
let channelChan = null, currentChannelName = null;

const ROOMS = [
  { name: 'general',     tag: 'anything goes' },
  { name: 'late-night',  tag: 'for the sleepless' },
  { name: 'confessions', tag: 'say the quiet part' },
  { name: 'vent',        tag: 'get it out' },
  { name: 'study-hall',  tag: 'quiet company' },
];

const panel = document.getElementById('panel');

const VALID_MODES = new Set(['hop', 'channels']);
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    const m = t.dataset.mode;
    if (!VALID_MODES.has(m)) return;
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    mode = m;
    leaveEverything();
    render();
  };
});

function leaveEverything() {
  if (queueChan) { queueChan.close(); queueChan = null; }
  if (pairChan)  { pairChan.close();  pairChan = null; }
  if (channelChan) { channelChan.close(); channelChan = null; }
  hopState = 'idle'; pairPeerName = null; pairRoom = null; currentChannelName = null;
}

function render() {
  panel.innerHTML = '';
  if (!configured) {
    panel.innerHTML = `
      <div class="setup-gate">
        <h2><span class="status-dot bad"></span>Not connected yet</h2>
        <p>Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in app.js. Deploy the relay Edge Function. No tables needed — Realtime Broadcast only.</p>
      </div>`;
    return;
  }
  if (mode === 'hop') {
    if (hopState === 'idle')       renderHopIdle();
    else if (hopState === 'searching' || hopState === 'pairing') renderHopSearching();
    else if (hopState === 'matched')   renderChat({ peer: pairPeerName, onLeave: leaveHop });
  } else {
    if (currentChannelName) renderChat({ peer: '#' + currentChannelName, onLeave: leaveChannel, isChannel: true });
    else renderChannelList();
  }
}

// ---------- Frequency Hop ----------
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
      <button class="btn-primary" id="findBtn">Search for a signal</button>
    </div>`;
  document.getElementById('findBtn').onclick = startHopSearch;
}

function renderHopSearching() {
  panel.innerHTML = `
    <div class="hop-idle">
      <div class="searching-pulse"></div>
      <p>Scanning for another open frequency…</p>
      <button class="btn-ghost" id="cancelBtn">Cancel</button>
    </div>`;
  document.getElementById('cancelBtn').onclick = () => leaveHop();
}

function startHopSearch() {
  hopState = 'searching';
  render();
  queueChan = makeChannel('wavelength-queue');
  queueChan.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'looking' && msg.id !== myId && hopState === 'searching') {
      // Only the lower ID initiates — prevents both sides pairing simultaneously
      if (myId < msg.id) {
        hopState = 'pairing';
        pairRoom = 'wavelength-pair-' + [myId, msg.id].sort().join('-');
        queueChan.postMessage({ type: 'pair', to: msg.id, from: myId, fromName: myName, room: pairRoom });
      }
    }
    if (msg.type === 'pair' && msg.to === myId && hopState === 'searching') {
      if (typeof msg.room !== 'string' || !CHANNEL_NAME_RE.test(msg.room)) return;
      hopState = 'pairing';
      pairRoom = msg.room;
      pairPeerName = sanitizeName(msg.fromName);
      // Close queue before ack so we stop receiving new 'looking' messages
      const q = queueChan; queueChan = null;
      q.postMessage({ type: 'pair-ack', to: msg.from, from: myId, fromName: myName });
      q.close();
      connectPair();
    }
    if (msg.type === 'pair-ack' && msg.to === myId && hopState === 'pairing') {
      pairPeerName = sanitizeName(msg.fromName);
      connectPair();
    }
  };
  queueChan.postMessage({ type: 'looking', id: myId });
  const iv = setInterval(() => {
    if (hopState !== 'searching') { clearInterval(iv); return; }
    queueChan && queueChan.postMessage({ type: 'looking', id: myId });
  }, 700);
}

function connectPair() {
  hopState = 'matched';
  if (queueChan) { queueChan.close(); queueChan = null; }
  pairChan = makeChannel(pairRoom);
  render();
  pushSystemMsg(`Connected to ${pairPeerName}.`);
  pairChan.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'msg' && msg.from !== myId && typeof msg.text === 'string')
      appendMsg(msg.text.slice(0, 500), 'them');
    if (msg.type === 'typing' && msg.from !== myId)
      setTyping(pairPeerName, msg.state === true);
    if (msg.type === 'leave' && msg.from !== myId) {
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
  if (queueChan) { queueChan.close(); queueChan = null; }
  hopState = 'idle'; pairPeerName = null;
  render();
}

// ---------- Channels ----------
function renderChannelList() {
  panel.innerHTML = `<div class="channel-list">${ROOMS.map(r => `
    <div class="channel-item" data-room="${r.name}">
      <div>
        <div class="name">#${r.name}</div>
        <div class="tag">${r.tag}</div>
      </div>
      <span class="active-dot" style="opacity:0"></span>
    </div>`).join('')}</div>`;
  panel.querySelectorAll('.channel-item').forEach(el => {
    el.onclick = () => joinChannel(el.dataset.room);
  });
}

function joinChannel(name) {
  if (!ROOMS.some(r => r.name === name)) return;
  currentChannelName = name;
  channelChan = makeChannel('wavelength-room-' + name);
  if (!channelChan) return;
  render();
  pushSystemMsg(`You joined #${escapeHtml(name)} as ${escapeHtml(myName)}.`);
  channelChan.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'msg' && msg.from !== myId && typeof msg.text === 'string')
      appendMsg(msg.text.slice(0, 500), 'them', sanitizeName(msg.fromName));
    if (msg.type === 'typing' && msg.from !== myId)
      setTyping(sanitizeName(msg.fromName), msg.state === true);
    if (msg.type === 'join' && msg.from !== myId)
      pushSystemMsg(`${sanitizeName(msg.fromName)} joined.`);
    if (msg.type === 'leave' && msg.from !== myId) {
      setTyping(sanitizeName(msg.fromName), false);
      pushSystemMsg(`${sanitizeName(msg.fromName)} left.`);
    }
  };
  channelChan.postMessage({ type: 'join', from: myId, fromName: myName });
}

function leaveChannel() {
  if (channelChan) {
    channelChan.postMessage({ type: 'leave', from: myId, fromName: myName });
    channelChan.close(); channelChan = null;
  }
  currentChannelName = null;
  render();
}

// ---------- shared chat UI ----------
function renderChat({ peer, onLeave, isChannel }) {
  const safePeer = escapeHtml(peer);
  panel.innerHTML = `
    <div class="chat-header">
      <span class="who"><span class="online-dot"></span>${safePeer}</span>
    </div>
    <div class="msgs" id="msgs"></div>
    <button class="scroll-btn" id="scrollBtn">↓</button>
    <div class="typing-indicator" id="typingEl"></div>
    <div class="composer">
      <button class="btn-leave" id="leaveBtn">Leave</button>
      <input id="msgInput" type="text" placeholder="Say something…" maxlength="500" autocomplete="off">
      <button class="btn-send" id="sendBtn" disabled>Send</button>
    </div>
    <div class="char-count" id="charCount"></div>`;

  document.getElementById('leaveBtn').onclick = () => showConfirmBar(onLeave);

  const input   = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const charCount = document.getElementById('charCount');
  const msgsEl  = document.getElementById('msgs');

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
      if (hasText && !iAmTyping)       { iAmTyping = true;  sendTypingState(true); }
      else if (!hasText && iAmTyping)  { iAmTyping = false; sendTypingState(false); }
    }, 500);
  };

  // emoji picker
  const EMOJIS = ['😂','❤️','😭','🔥','👀','💀','😍','🤣','😊','🥺','✨','😅','🙏','😩','😤','🤔','💯','🎉','👏','🫡'];
  const emojiBtn = document.createElement('button');
  emojiBtn.className = 'emoji-btn'; emojiBtn.textContent = '😊'; emojiBtn.title = 'Emoji'; emojiBtn.type = 'button';
  const composer = panel.querySelector('.composer');
  composer.style.position = 'relative';
  composer.insertBefore(emojiBtn, input);
  let tray = null;
  emojiBtn.onclick = (e) => {
    e.stopPropagation();
    if (tray) { tray.remove(); tray = null; return; }
    tray = document.createElement('div'); tray.className = 'emoji-tray';
    EMOJIS.forEach(em => {
      const s = document.createElement('span'); s.textContent = em;
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
    appendMsg(text, 'me');
    let result;
    if (mode === 'hop' && pairChan)
      result = await pairChan.postMessage({ type: 'msg', from: myId, text });
    else if (mode === 'channels' && channelChan)
      result = await channelChan.postMessage({ type: 'msg', from: myId, fromName: myName, text });
    // If server rate-limited, show feedback and undo the optimistic append
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
  const bar = document.createElement('div');
  bar.className = 'disconnected-bar';
  bar.innerHTML = `<span>Signal lost.</span><div class="dbar-btns"><button class="dbar-next" id="dbarNext">Find new</button><button class="dbar-menu" id="dbarMenu">Main menu</button></div>`;
  const charCount = document.getElementById('charCount');
  if (charCount) charCount.after(bar);
  document.getElementById('dbarNext').onclick = () => { leaveHop(); startHopSearch(); };
  document.getElementById('dbarMenu').onclick = () => leaveHop();
  const dot = document.querySelector('.online-dot');
  if (dot) { dot.style.background = 'var(--text-dim)'; dot.style.boxShadow = 'none'; }
}

function showConfirmBar(onConfirm) {
  const existing = document.getElementById('confirmBar');
  if (existing) { existing.remove(); return; }
  const bar = document.createElement('div');
  bar.className = 'confirm-bar'; bar.id = 'confirmBar';
  bar.innerHTML = `<span>Leave this chat?</span><div class="cbar-btns"><button class="cbar-yes" id="cbarYes">Leave</button><button class="cbar-no" id="cbarNo">Stay</button></div>`;
  document.getElementById('charCount').after(bar);
  document.getElementById('cbarYes').onclick = onConfirm;
  document.getElementById('cbarNo').onclick = () => bar.remove();
}

function setTyping(name, active) {
  const el = document.getElementById('typingEl');
  if (!el) return;
  el.innerHTML = active ? `<div class="typing-bubble"><span></span><span></span><span></span></div>` : '';
}

const MAX_MSG_DOM = 200;
function appendMsg(text, who, label) {
  const msgsEl = document.getElementById('msgs');
  if (!msgsEl) return;
  while (msgsEl.querySelectorAll('.msg-row:not(.system)').length >= MAX_MSG_DOM) {
    const oldest = msgsEl.querySelector('.msg-row:not(.system)');
    if (oldest) oldest.remove(); else break;
  }
  if (who === 'them') setTyping('', false);
  const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 40;
  const row = document.createElement('div');
  const safeWho = ['me','them','system'].includes(who) ? who : 'them';
  row.className = 'msg-row ' + safeWho;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const initials = label ? label.slice(0,2).toUpperCase() : (pairPeerName ? pairPeerName.slice(0,2).toUpperCase() : '??');
  const bubble = `<div class="msg ${safeWho}">${escapeHtml(text)}<div class="msg-meta">${safeWho === 'them' && label ? escapeHtml(label) + ' · ' : ''}${time}</div></div>`;
  row.innerHTML = safeWho === 'them' ? `<div class="avatar">${initials}</div>${bubble}` : bubble;
  msgsEl.appendChild(row);
  if (atBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  if (who === 'them') flashUnread();

  const QUICK_REACTIONS = ['❤️','😂','👍','🔥','😮'];
  row.addEventListener('dblclick', () => {
    let reactBar = row.querySelector('.msg-reactions');
    if (!reactBar) { reactBar = document.createElement('div'); reactBar.className = 'msg-reactions'; row.querySelector('.msg').appendChild(reactBar); }
    const pick = QUICK_REACTIONS[Math.floor(Math.random() * QUICK_REACTIONS.length)];
    let chip = [...reactBar.querySelectorAll('.reaction-chip')].find(c => c.dataset.em === pick);
    if (chip) {
      chip.dataset.count = +chip.dataset.count + 1;
      chip.querySelector('span').textContent = pick + ' ' + chip.dataset.count;
      chip.classList.add('mine');
    } else {
      chip = document.createElement('div');
      chip.className = 'reaction-chip mine'; chip.dataset.em = pick; chip.dataset.count = 1;
      chip.innerHTML = `<span>${pick} 1</span>`;
      reactBar.appendChild(chip);
    }
  });
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
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

function sanitizeName(s) {
  if (typeof s !== 'string') return 'Unknown';
  return s.replace(/[<>"'`]/g,'').trim().slice(0, 24) || 'Unknown';
}

window.addEventListener('beforeunload', () => {
  if (pairChan)    pairChan.postMessage({ type: 'leave', from: myId });
  if (channelChan) channelChan.postMessage({ type: 'leave', from: myId, fromName: myName });
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}
