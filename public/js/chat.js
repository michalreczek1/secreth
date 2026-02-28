// public/js/chat.js — zarządzanie chatem
// (dołączony inline w app.js dla uproszczenia)

const Chat = {
  activeTab: 'global', // 'global' | 'room'
  currentRoomId: null,
  unreadCount: 0,
  mobileOpen: false,

  init() {
    this.renderTabs();
    this.updateMobileBadge();
  },

  isCompactLayout() {
    return window.matchMedia('(max-width: 900px)').matches;
  },

  getTabsEl() {
    if (this.mobileOpen) return document.getElementById('mobile-chat-tabs');
    return document.getElementById('chat-tabs');
  },

  getMessagesEl() {
    if (this.mobileOpen) return document.getElementById('mobile-chat-messages');
    return document.getElementById('chat-messages');
  },

  getInputEl() {
    if (this.mobileOpen) return document.getElementById('mobile-chat-input');
    return document.getElementById('chat-input');
  },

  updateMobileBadge() {
    const badge = document.getElementById('mobile-chat-badge');
    if (!badge) return;
    badge.textContent = String(this.unreadCount);
    badge.classList.toggle('hidden', this.unreadCount <= 0);
  },

  openMobileChat() {
    if (!this.isCompactLayout()) return;
    this.mobileOpen = true;
    this.unreadCount = 0;
    this.updateMobileBadge();

    document.getElementById('mobile-chat-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'mobile-chat-overlay';
    overlay.className = 'mobile-chat-overlay';
    overlay.innerHTML = `
      <div class="mobile-chat-panel">
        <div class="mobile-chat-header">
          <div class="mobile-chat-title">CZAT</div>
          <button class="mobile-chat-close" onclick="Chat.closeMobileChat()">✕</button>
        </div>
        <div class="chat-tabs" id="mobile-chat-tabs"></div>
        <div class="chat-messages mobile-chat-messages" id="mobile-chat-messages"></div>
        <div class="chat-input-row">
          <input type="text" id="mobile-chat-input" placeholder="Wiadomość..." maxlength="500"
            onkeydown="if(event.key==='Enter')Chat.send()" />
          <button class="btn btn-gold" onclick="Chat.send()">↑</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeMobileChat();
    });
    document.body.appendChild(overlay);
    this.renderTabs();
    const roomId = this.activeTab === 'room' ? this.currentRoomId : null;
    Socket.getChatHistory(roomId);
  },

  closeMobileChat() {
    this.mobileOpen = false;
    document.getElementById('mobile-chat-overlay')?.remove();
  },

  renderTabs() {
    const tabsEl = this.getTabsEl();
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
    const messagesEl = this.getMessagesEl();
    if (messagesEl) messagesEl.innerHTML = '';
  },

  setRoom(roomId) {
    this.currentRoomId = roomId;
    this.renderTabs();
    if (roomId) this.switchTab('room');
    else this.switchTab('global');
  },

  isRelevantToActiveTab(msg) {
    if (this.activeTab === 'global') return !(msg.global === false && msg.roomId);
    if (this.activeTab === 'room') return !(msg.global || !msg.roomId);
    return true;
  },

  onMessage(msg) {
    if (!this.isRelevantToActiveTab(msg)) return;

    if (this.isCompactLayout() && !this.mobileOpen) {
      this.unreadCount += 1;
      this.updateMobileBadge();
      return;
    }

    this.appendMessage(msg);
  },

  onHistory(msgs) {
    const el = this.getMessagesEl();
    if (!el) return;
    el.innerHTML = '';
    msgs.forEach(m => this.appendMessage(m, false));
    el.scrollTop = el.scrollHeight;
  },

  renderClaimSummary(summary) {
    return String(summary || '')
      .split('')
      .map((card) => `
        <span class="chat-claim-card ${card === 'L' ? 'chat-claim-card-l' : 'chat-claim-card-f'}">${card}</span>
      `)
      .join('');
  },

  renderMessageText(message) {
    const text = String(message || '');
    const normalized = text
      .replace(/🟦/g, '[CLAIM_CARD:L]')
      .replace(/🟥/g, '[CLAIM_CARD:F]');
    const claimPattern = /\[CLAIM:([LF]{2,3})\]|\[CLAIM_CARD:([LF])\](?:\s*\[CLAIM_CARD:([LF])\])?(?:\s*\[CLAIM_CARD:([LF])\])?/g;
    let html = '';
    let lastIndex = 0;
    let match;

    while ((match = claimPattern.exec(normalized)) !== null) {
      html += UI.escapeHtml(normalized.slice(lastIndex, match.index));
      const summary = match[1] || [match[2], match[3], match[4]].filter(Boolean).join('');
      html += `<span class="chat-claim-cards">${this.renderClaimSummary(summary)}</span>`;
      lastIndex = match.index + match[0].length;
    }

    html += UI.escapeHtml(normalized.slice(lastIndex));
    return html;
  },

  appendMessage(msg, scroll = true) {
    const el = this.getMessagesEl();
    if (!el) return;

    const time = UI.formatTime(msg.createdAt || msg.created_at || msg.time || new Date().toISOString());
    const isSystem = msg.type === 'system';
    const userClass = isSystem ? 'system' : '';
    const username = UI.escapeHtml(msg.username || 'System');
    const message = this.renderMessageText(msg.message || '');

    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<span class="msg-user ${userClass}">${username}:</span> <span class="msg-text">${message}</span><span class="msg-time">${time}</span>`;
    el.appendChild(div);

    if (scroll) el.scrollTop = el.scrollHeight;
  },

  send() {
    const input = this.getInputEl();
    const msg = (input?.value || '').trim();
    if (!msg) return;
    const roomId = this.activeTab === 'room' ? this.currentRoomId : null;
    Socket.sendChat(msg, roomId);
    input.value = '';
  },
};
