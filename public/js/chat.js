// public/js/chat.js — zarządzanie chatem
// (dołączony inline w app.js dla uproszczenia)

const Chat = {
  activeTab: 'global', // 'global' | 'room'
  currentRoomId: null,

  init() {
    this.renderTabs();
  },

  renderTabs() {
    const tabsEl = document.getElementById('chat-tabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = `
      <button class="chat-tab ${this.activeTab === 'global' ? 'active' : ''}" 
              onclick="Chat.switchTab('global')">Globalny</button>
      <button class="chat-tab ${this.activeTab === 'room' && this.currentRoomId ? 'active' : ''}"
              onclick="Chat.switchTab('room')"
              ${!this.currentRoomId ? 'disabled style="opacity:.4"' : ''}>Pokój</button>
    `;
  },

  switchTab(tab) {
    if (tab === 'room' && !this.currentRoomId) return;
    this.activeTab = tab;
    this.renderTabs();
    const roomId = tab === 'room' ? this.currentRoomId : null;
    Socket.getChatHistory(roomId);
    document.getElementById('chat-messages').innerHTML = '';
  },

  setRoom(roomId) {
    this.currentRoomId = roomId;
    this.renderTabs();
    if (roomId) this.switchTab('room');
    else this.switchTab('global');
  },

  onMessage(msg) {
    const isGlobal = !msg.roomId && !msg.global === false;
    const msgIsGlobal = msg.global || !this.currentRoomId;
    
    // Sprawdź czy wiadomość należy do aktywnego taba
    if (this.activeTab === 'global' && this.currentRoomId && !msg.global) return;
    if (this.activeTab === 'room' && msg.global) return;

    this.appendMessage(msg);
  },

  onHistory(msgs) {
    const el = document.getElementById('chat-messages');
    if (!el) return;
    el.innerHTML = '';
    msgs.forEach(m => this.appendMessage(m, false));
    el.scrollTop = el.scrollHeight;
  },

  appendMessage(msg, scroll = true) {
    const el = document.getElementById('chat-messages');
    if (!el) return;

    const time = UI.formatTime(msg.createdAt || msg.created_at || msg.time || new Date().toISOString());
    const isSystem = msg.type === 'system';
    const userClass = isSystem ? 'system' : '';
    const username = UI.escapeHtml(msg.username || 'System');
    const message = UI.escapeHtml(msg.message || '');

    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<span class="msg-user ${userClass}">${username}:</span> <span class="msg-text">${message}</span><span class="msg-time">${time}</span>`;
    el.appendChild(div);

    if (scroll) el.scrollTop = el.scrollHeight;
  },

  send() {
    const input = document.getElementById('chat-input');
    const msg = (input?.value || '').trim();
    if (!msg) return;
    const roomId = this.activeTab === 'room' ? this.currentRoomId : null;
    Socket.sendChat(msg, roomId);
    input.value = '';
  },
};
