<!--
  Atlas Probe — persistent chat panel
  Always visible on the right. The $ textarea feeds into this chat.
  Uses the probe server (port 3001) for all communication.
  No external CDN dependencies.
-->

<style>
  /* ---- chat panel (right side, always visible) ---- */
  #probe-panel {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 998;
    width: 380px; background: var(--panel, #0a0a0a);
    border-left: 1px solid var(--hair, #262626);
    font: inherit; font-size: 13px; color: var(--fg, #e8e8e8);
    display: flex; flex-direction: column;
  }
  #probe-header {
    padding: 14px 14px 10px; border-bottom: 1px solid var(--hair, #262626);
    display: flex; align-items: center; gap: 8px;
  }
  #probe-header .title { color: var(--purple, #b48ad9); font-weight: 700; flex: 1; }
  #probe-status {
    width: 7px; height: 7px; border-radius: 50%; background: #555;
    flex-shrink: 0;
  }
  #probe-status.ok { background: #4a4; }
  #probe-status.err { background: #a44; }
  #probe-status .label { font-size: 11px; color: #666; margin-left: 6px; }

  #probe-messages {
    flex: 1; overflow-y: auto; padding: 14px; line-height: 1.6;
    scroll-behavior: smooth;
  }
  .probe-msg { margin-bottom: 12px; }
  .probe-msg.user { color: var(--fg, #e8e8e8); }
  .probe-msg.atlas { color: var(--purple, #b48ad9); }
  .probe-msg .label { font-weight: 700; margin-bottom: 2px; }
  .probe-msg .text { white-space: pre-wrap; word-wrap: break-word; }
  .probe-msg.system { color: #666; font-style: italic; font-size: 12px; }

  .probe-typing {
    color: #555; font-size: 12px; padding: 4px 14px;
    display: none;
  }
  .probe-typing.active { display: block; }

  #probe-input-row {
    display: flex; border-top: 1px solid var(--hair, #262626);
  }
  #probe-input {
    flex: 1; background: none; border: none; color: var(--fg, #e8e8e8);
    font: inherit; font-size: 13px; padding: 12px 14px; outline: none;
  }
  #probe-input::placeholder { color: #555; }
  #probe-send {
    background: none; border: none; border-left: 1px solid var(--hair, #262626);
    color: var(--purple, #b48ad9); font: inherit; font-size: 13px;
    padding: 12px 16px; cursor: pointer;
  }
  #probe-send:hover { color: #fff; }

  /* ---- overview card ---- */
  .probe-overview {
    border: 1px solid var(--hair, #262626); padding: 12px; margin-bottom: 14px;
    font-size: 12px; line-height: 1.6; color: #999;
  }
  .probe-overview b { color: var(--purple, #b48ad9); font-weight: 700; }
  .probe-overview .dismiss {
    display: block; margin-top: 8px; color: #555; cursor: pointer;
    font-size: 11px;
  }
  .probe-overview .dismiss:hover { color: var(--fg, #e8e8e8); }

  /* ---- main area adjustment ---- */
  body { margin-right: 380px; }
</style>

<div id="probe-panel">
  <div id="probe-header">
    <span class="title">atlas</span>
    <span id="probe-status">
      <span class="dot"></span><span class="label">connecting...</span>
    </span>
  </div>
  <div id="probe-messages"></div>
  <div class="probe-typing" id="probe-typing">atlas is listening...</div>
  <div id="probe-input-row">
    <input id="probe-input" placeholder="say how you feel..." />
    <button id="probe-send">send</button>
  </div>
</div>

<script>
(function() {
  var meta = document.querySelector('meta[name="atlas-backend"]');
  var PROBE_URL = meta ? meta.content : 'http://localhost:3001';
  var SESSION_KEY = 'atlas-session-id';
  var OVERVIEW_KEY = 'atlas-overview-seen';

  var sessionId = localStorage.getItem(SESSION_KEY) || null;
  var connected = false;
  var waitingReply = false;

  var messagesEl = document.getElementById('probe-messages');
  var inputEl = document.getElementById('probe-input');
  var sendBtn = document.getElementById('probe-send');
  var statusDot = document.querySelector('#probe-status .dot');
  var statusLabel = document.querySelector('#probe-status .label');
  var typingEl = document.getElementById('probe-typing');

  // ---- session ----

  function ensureSession() {
    if (!sessionId) {
      sessionId = 'probe-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(SESSION_KEY, sessionId);
    }
  }

  // ---- messages ----

  function addMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'probe-msg ' + role;
    var lbl = role === 'atlas' ? 'atlas' : role === 'user' ? 'you' : '';
    div.innerHTML = (lbl ? '<div class="label">' + lbl + ':</div>' : '') +
      '<div class="text">' + escapeHtml(text) + '</div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- status ----

  function setStatus(ok, text) {
    statusDot.className = 'dot' + (ok ? ' ok' : '');
    statusLabel.textContent = text;
  }

  function setTyping(on) {
    waitingReply = on;
    typingEl.classList.toggle('active', on);
    if (on) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---- overview ----

  function showOverview() {
    if (localStorage.getItem(OVERVIEW_KEY)) return;
    var div = document.createElement('div');
    div.className = 'probe-overview';
    div.innerHTML =
      '<b>what atlas does:</b><br>' +
      'tell atlas how you feel. atlas matches you to music from one of 37 emotional territories.<br><br>' +
      '<b>what you can ask for:</b><br>' +
      '&bull; "map this" &mdash; match a feeling to a song<br>' +
      '&bull; "something louder" / "more tender" &mdash; shift the vibe<br>' +
      '&bull; "what\'s the berlin scene" &mdash; explore a city<br>' +
      '&bull; "more from this artist" &mdash; go deeper<br>' +
      '&bull; or just talk. atlas listens.<br><br>' +
      '<b>explicit requests override everything.</b><br>' +
      'say what you want directly and atlas acts on it.<br><br>' +
      '<span class="dismiss" onclick="this.parentElement.remove();localStorage.setItem(\'' +
      OVERVIEW_KEY + '\',\'1\')">got it</span>';
    messagesEl.insertBefore(div, messagesEl.firstChild);
  }

  // ---- health check ----

  async function checkHealth() {
    try {
      var res = await fetch(PROBE_URL + '/health', { signal: AbortSignal.timeout(4000) });
      var data = await res.json();
      connected = (data.status === 'ok');
      setStatus(connected, connected ? 'connected' : 'offline');
    } catch {
      connected = false;
      setStatus(false, 'offline');
    }
  }

  // ---- send via fetch (probe server proxies to ElizaOS) ----

  async function send(text) {
    if (!text) {
      text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
    }
    if (waitingReply) return;

    addMessage('user', text);
    setTyping(true);
    ensureSession();

    try {
      var res = await fetch(PROBE_URL + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: sessionId }),
      });
      var data = await res.json();

      setTyping(false);

      if (data.reply) {
        sessionId = data.sessionId || sessionId;
        localStorage.setItem(SESSION_KEY, sessionId);
        addMessage('atlas', data.reply);
      } else if (data.error) {
        addMessage('atlas', '[ ' + (data.detail || data.error) + ' ]');
      }
    } catch (err) {
      setTyping(false);
      addMessage('atlas', '[ backend offline — is the server running? ]');
    }

    checkHealth();
  }

  // ---- probe panel input ----

  sendBtn.addEventListener('click', function() { send(); });
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ---- init ----

  showOverview();
  addMessage('atlas', "hey. what's the texture of today?");
  checkHealth();
  setInterval(checkHealth, 15000);

  window.atlasProbe = { send: send, sessionId: function() { return sessionId; } };
})();
</script>
