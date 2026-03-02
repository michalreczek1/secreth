// public/js/app.js — główny kontroler aplikacji

const App = {
  currentUser: null,
  currentView: null,   // 'lobby' | 'room' | 'admin'
  currentRoomId: null,
  currentRoomOwner: null,
  currentRoomName: null,
  currentRoomState: null,
  currentRoomPlayerCount: 0,
  roomPlayers: [],
  roomStartConfirmation: null,
  roomStartTicker: null,
  roomStartModalKey: null,
  rooms: [],
  deferredInstallPrompt: null,
  pwaSetupDone: false,
  viewportSetupDone: false,

  // ── INIT ─────────────────────────────────────────────────────────────────────
  async init() {
    this.setupViewport();
    this.setupPwa();
    const { user, activeRoom } = await API.me();
    if (user) {
      this.currentUser = user;
      this.setActiveRoom(activeRoom);
      this.showMainLayout();
      await Socket.connect();
      if (this.currentRoomId) {
        await this.resumeActiveRoom(true);
      } else {
        await this.showLobby();
      }
    } else {
      this.showAuth('login');
    }
  },

  setActiveRoom(room) {
    this.currentRoomId = room?.id || null;
    this.currentRoomOwner = room?.ownerId || null;
    this.currentRoomName = room?.name || null;
    this.currentRoomState = room?.state || null;
    this.currentRoomPlayerCount = typeof room?.playerCount === 'number' ? room.playerCount : 0;
    this.updateHeaderRoomAction();
  },

  clearActiveRoom() {
    this.setActiveRoom(null);
    this.roomPlayers = [];
    this.roomStartModalKey = null;
    this.setRoomStartConfirmation(null);
    Chat.setRoom(null);
    Game.reset();
  },

  setRoomStartConfirmation(control) {
    this.roomStartConfirmation = control || null;
    if (this.roomStartTicker) {
      clearInterval(this.roomStartTicker);
      this.roomStartTicker = null;
    }
    if (this.roomStartConfirmation?.expiresAt) {
      this.roomStartTicker = setInterval(() => this.updateRoomStartCountdown(), 1000);
    }
    this.renderRoomStartPanel();
    this.updateRoomStartCountdown();
    this.maybePromptRoomStartConfirmation();
  },

  formatRoomStartCountdown(expiresAt) {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const totalSeconds = Math.ceil(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return mins > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
  },

  updateRoomStartCountdown() {
    const el = document.getElementById('room-start-countdown');
    const modalEl = document.getElementById('room-start-modal-countdown');
    if (!this.roomStartConfirmation?.expiresAt) return;
    const text = this.formatRoomStartCountdown(this.roomStartConfirmation.expiresAt);
    if (el) el.textContent = text;
    if (modalEl) modalEl.textContent = text;
  },

  getRoomStartModalKey(control = this.roomStartConfirmation) {
    if (!control?.roomId || !control?.expiresAt) return null;
    return `${control.roomId}:${control.expiresAt}`;
  },

  maybePromptRoomStartConfirmation() {
    const control = this.roomStartConfirmation;
    if (!control || this.currentView !== 'room' || this.currentRoomState === 'playing') return;
    const participant = control.participants.find((entry) => entry.userId === this.currentUser?.id);
    if (!participant) return;

    const modalKey = this.getRoomStartModalKey(control);
    const hasOpenModal = !!document.getElementById('modal-overlay');
    if (!participant.confirmed && modalKey && this.roomStartModalKey !== modalKey && !hasOpenModal) {
      this.roomStartModalKey = modalKey;
      this.showRoomStartConfirmationModal();
      return;
    }

    if (participant.confirmed && document.getElementById('room-start-confirm-btn')) {
      this.showRoomStartConfirmationModal();
    }
  },

  showRoomStartConfirmationModal() {
    const control = this.roomStartConfirmation;
    if (!control) return;
    const participant = control.participants.find((entry) => entry.userId === this.currentUser?.id);
    if (!participant) return;

    const confirmedCount = control.participants.filter((entry) => entry.confirmed).length;
    const rows = control.participants.map((entry) => `
      <div class="player-item" style="padding:6px 10px">
        <div class="player-dot ${entry.confirmed ? 'online' : ''}"></div>
        <span class="player-name">${UI.escapeHtml(entry.username)}${entry.userId === this.currentUser.id ? ' (ty)' : ''}</span>
        <span class="status-pill" style="margin-left:auto;font-size:11px;color:${entry.confirmed ? '#4a8' : 'var(--muted)'}">${entry.confirmed ? 'Potwierdzone' : 'Czeka'}</span>
      </div>
    `).join('');

    UI.showModal({
      title: '🗳️ Potwierdzenie Startu Gry',
      content: `
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="notice notice-info">
            <strong>${UI.escapeHtml(control.requestedByName)}</strong> chce rozpocząć grę.
            Czas na odpowiedź: <strong id="room-start-modal-countdown">${this.formatRoomStartCountdown(control.expiresAt)}</strong>
          </div>
          <div class="text-dim" style="font-size:12px">Potwierdzenia: <strong>${confirmedCount}/${control.participants.length}</strong></div>
          <div class="box" style="padding:0">${rows}</div>
          <div class="text-dim" style="font-size:12px">Brak potwierdzenia w czasie usuwa gracza z pokoju.</div>
        </div>
      `,
      actions: participant.confirmed
        ? `<button class="btn btn-ghost btn-full" onclick="UI.closeModal()">Zamknij</button>`
        : `
          <button class="btn btn-gold" id="room-start-confirm-btn" style="flex:1" onclick="App.confirmStartGame(true)">Potwierdzam</button>
          <button class="btn btn-ghost" style="flex:1" onclick="UI.closeModal()">Później</button>
        `,
    });
  },

  setupPwa() {
    if (this.pwaSetupDone) return;
    this.pwaSetupDone = true;

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((e) => {
          console.error('service worker registration failed', e);
        });
      }, { once: true });
    }

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.deferredInstallPrompt = event;
      this.updateInstallButton();
    });

    window.addEventListener('appinstalled', () => {
      this.deferredInstallPrompt = null;
      this.updateInstallButton();
    });
  },

  setupViewport() {
    if (this.viewportSetupDone) return;
    this.viewportSetupDone = true;

    const update = () => {
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      document.documentElement.style.setProperty('--viewport-h', `${Math.round(viewportHeight)}px`);
      document.documentElement.style.setProperty('--viewport-w', `${Math.round(viewportWidth)}px`);
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
  },

  isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  },

  isIos() {
    return /iPad|iPhone|iPod/.test(window.navigator.userAgent) && !window.MSStream;
  },

  updateInstallButton() {
    const btn = document.getElementById('install-app-btn');
    if (!btn) return;
    const supported = !!this.deferredInstallPrompt || (this.isIos() && !this.isStandalone());
    btn.classList.toggle('hidden', !supported || this.isStandalone());
  },

  async promptInstall() {
    if (this.deferredInstallPrompt) {
      const prompt = this.deferredInstallPrompt;
      prompt.prompt();
      try {
        await prompt.userChoice;
      } finally {
        this.deferredInstallPrompt = null;
        this.updateInstallButton();
      }
      return;
    }

    if (this.isIos() && !this.isStandalone()) {
      UI.showModal({
        title: '💀 Zainstaluj Na Telefonie',
        content: `
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>Na iPhone/iPad otwórz menu <strong>Udostępnij</strong> w Safari.</div>
            <div>Następnie wybierz <strong>Do ekranu początkowego</strong>.</div>
            <div class="notice notice-info">Po instalacji aplikacja uruchomi się z własną ikoną trupiej czaszki.</div>
          </div>
        `,
        actions: `<button class="btn btn-gold btn-full" onclick="UI.closeModal()">Rozumiem</button>`,
      });
      return;
    }

    alert('Instalacja aplikacji nie jest teraz dostępna na tym urządzeniu/przeglądarce.');
  },

  updateHeaderRoomAction() {
    const el = document.getElementById('nav-room-actions');
    const endGameBtn = document.getElementById('end-game-btn');
    if (endGameBtn) endGameBtn.classList.toggle('hidden', !(this.currentRoomId && this.currentRoomState === 'playing'));
    if (!el) return;
    if (!this.currentRoomId) {
      el.innerHTML = '';
      return;
    }
    const icon = this.currentRoomState === 'playing' ? '🎮' : '↩';
    const label = this.currentRoomState === 'playing' ? 'Gra' : 'Pokój';
    const title = this.currentRoomName ? UI.escapeHtml(this.currentRoomName) : this.currentRoomId;
    el.innerHTML = `
      <button class="btn btn-ghost btn-sm header-btn room-nav-btn" onclick="App.resumeActiveRoom()" title="${title}">
        <span class="header-btn-emoji">${icon}</span>
        <span class="header-btn-label">${label}</span>
      </button>
    `;
  },

  // ── SOCKET EVENTS ─────────────────────────────────────────────────────────────
  onSocketConnect() {
    const el = document.getElementById('conn-status');
    if (el) { el.textContent = '🟢 Online'; el.style.color = '#4a8'; }
    if (this.currentRoomId) {
      Socket.joinRoom(this.currentRoomId)
        .then((res) => {
          if (Array.isArray(res?.players)) this.onRoomPlayers(res.players);
        })
        .catch(() => {});
    }
  },
  onSocketDisconnect() {
    const el = document.getElementById('conn-status');
    if (el) { el.textContent = '🔴 Rozłączono'; el.style.color = 'var(--fascist)'; }
  },
  onRoomsUpdated() { if (this.currentView === 'lobby') this.loadRooms(); },
  onRoomPlayers(players) {
    this.roomPlayers = Array.isArray(players) ? players : [];
    this.currentRoomPlayerCount = this.roomPlayers.length;
    if (this.currentView === 'room') {
      this.renderRoomPlayers(this.roomPlayers);
      this.renderRoomStartPanel();
    }
  },
  onRoomStartConfirmation(control) {
    this.setRoomStartConfirmation(control);
  },
  onRoomRemoved(payload) {
    if (!payload || payload.roomId !== this.currentRoomId) return;
    this.clearActiveRoom();
    this.showLobby();
    alert(payload.message || 'Zostałeś usunięty z pokoju.');
  },
  onRoomDeleted() {
    this.clearActiveRoom();
    this.showLobby();
    alert('Pokój został usunięty.');
  },
  onGameStarted() {
    this.currentRoomState = 'playing';
    this.roomStartModalKey = null;
    this.setRoomStartConfirmation(null);
    this.updateHeaderRoomAction();
    if (this.currentRoomId) this.showRoom(this.currentRoomId);
  },
  onGameReset() {
    this.currentRoomState = 'lobby';
    this.roomStartModalKey = null;
    this.setRoomStartConfirmation(null);
    Game.reset();
    this.updateHeaderRoomAction();
    this.showRoom(this.currentRoomId, true);
  },
  onUserActivated({ userId }) { if (this.currentView === 'admin') Admin.load(); },

  // ── AUTH ──────────────────────────────────────────────────────────────────────
  showAuth(mode = 'login') {
    document.getElementById('app').innerHTML = `
      <div class="auth-screen">
        <div class="auth-box">
          <div class="auth-logo">SECRET HITLER</div>
          <div class="auth-sub">Przedwojenne Niemcy • 1932</div>
          <div id="auth-notice"></div>
          ${mode === 'login' ? this.renderLogin() : this.renderRegister()}
        </div>
      </div>
    `;
  },

  renderLogin() {
    return `
      <div class="auth-form">
        <div>
          <label>Nazwa użytkownika</label>
          <input type="text" id="auth-username" placeholder="Twoja nazwa..." autocomplete="username" />
        </div>
        <div>
          <label>Hasło</label>
          <input type="password" id="auth-password" placeholder="Hasło..." autocomplete="current-password"
            onkeydown="if(event.key==='Enter')App.login()" />
        </div>
        <button class="btn btn-gold btn-full" onclick="App.login()">Zaloguj się</button>
        <div class="auth-switch">Nie masz konta? <a onclick="App.showAuth('register')">Zarejestruj się</a></div>
      </div>
    `;
  },

  renderRegister() {
    return `
      <div class="auth-form">
        <div>
          <label>Nazwa użytkownika (2-20 znaków)</label>
          <input type="text" id="auth-username" placeholder="Wybierz nazwę..." autocomplete="username" maxlength="20" />
        </div>
        <div>
          <label>Hasło (min. 4 znaki)</label>
          <input type="password" id="auth-password" placeholder="Hasło..." autocomplete="new-password"
            onkeydown="if(event.key==='Enter')App.register()" />
        </div>
        <button class="btn btn-gold btn-full" onclick="App.register()">Zarejestruj się</button>
        <div class="auth-switch">Masz już konto? <a onclick="App.showAuth('login')">Zaloguj się</a></div>
      </div>
    `;
  },

  async login() {
    const username = document.getElementById('auth-username')?.value?.trim();
    const password = document.getElementById('auth-password')?.value;
    if (!username || !password) return this.authNotice('Wypełnij wszystkie pola', 'error');
    const res = await API.login(username, password);
    if (res.error) return this.authNotice(res.error, 'error');
    this.currentUser = res.user;
    this.setActiveRoom(res.activeRoom);
    this.showMainLayout();
    await Socket.connect();
    if (this.currentRoomId) {
      await this.resumeActiveRoom(true);
    } else {
      await this.showLobby();
    }
  },

  async register() {
    const username = document.getElementById('auth-username')?.value?.trim();
    const password = document.getElementById('auth-password')?.value;
    if (!username || !password) return this.authNotice('Wypełnij wszystkie pola', 'error');
    const res = await API.register(username, password);
    if (res.error) return this.authNotice(res.error, 'error');
    this.authNotice('Konto utworzone! Czekaj na aktywację przez administratora.', 'success');
    setTimeout(() => this.showAuth('login'), 2500);
  },

  authNotice(msg, type) {
    const el = document.getElementById('auth-notice');
    if (el) el.innerHTML = UI.notice(msg, type);
  },

  async logout() {
    await API.logout();
    Socket.disconnect();
    this.currentUser = null;
    Chat.closeMobileChat();
    this.clearActiveRoom();
    document.getElementById('app').innerHTML = '';
    this.showAuth('login');
  },

  async goLobby() {
    if (this.currentView === 'room' && this.currentRoomId && this.currentRoomState !== 'playing') {
      try {
        await Socket.leaveRoom();
      } catch (e) {
        alert(e.message);
        return;
      }
      this.clearActiveRoom();
    }
    await this.showLobby();
  },

  // ── MAIN LAYOUT ───────────────────────────────────────────────────────────────
  showMainLayout() {
    document.getElementById('app').innerHTML = `
      <div class="main-layout">
        <!-- HEADER -->
        <header class="site-header">
          <div class="site-logo">SECRET HITLER</div>
          <nav class="site-nav">
            <button class="btn btn-ghost btn-sm nav-btn-lobby header-btn" onclick="App.goLobby()"><span class="header-btn-emoji">🏠</span><span class="header-btn-label">Lobby</span></button>
            <span id="nav-room-actions"></span>
            ${this.currentUser?.isAdmin ? `<button class="btn btn-ghost btn-sm nav-btn-admin header-btn" onclick="App.showAdmin()"><span class="header-btn-emoji">⚙️</span><span class="header-btn-label">Admin</span></button>` : ''}
          </nav>
          <div class="site-user">
            <button class="btn btn-ghost btn-sm hidden user-btn-install header-btn" id="install-app-btn" onclick="App.promptInstall()"><span class="header-btn-emoji">💀</span><span class="header-btn-label">Instaluj</span></button>
            <button class="btn btn-danger btn-sm hidden user-btn-end header-btn" id="end-game-btn" onclick="Game.openEndGameModal()"><span class="header-btn-emoji">🛑</span><span class="header-btn-label">Zakończ</span></button>
            <button class="btn btn-ghost btn-sm user-btn-password header-btn" onclick="App.showChangePassword()"><span class="header-btn-emoji">🔐</span><span class="header-btn-label">Hasło</span></button>
            <button class="btn btn-ghost btn-sm mobile-chat-toggle user-btn-chat header-btn" onclick="Chat.openMobileChat()" id="mobile-chat-toggle">
              <span class="header-btn-emoji">💬</span>
              <span class="header-btn-label">Chat</span>
              <span class="mobile-chat-badge hidden" id="mobile-chat-badge">0</span>
            </button>
            <span id="conn-status" class="status-pill" style="font-size:11px;color:#4a8">🟢 Online</span>
            <span class="user-badge user-pill">${UI.escapeHtml(this.currentUser.username)}</span>
            ${this.currentUser.isAdmin ? '<span class="admin-badge user-admin-pill">Admin</span>' : ''}
            <button class="btn btn-ghost btn-sm user-btn-logout header-btn" onclick="App.logout()"><span class="header-btn-emoji">↪</span><span class="header-btn-label">Wyloguj</span></button>
          </div>
        </header>

        <!-- LEWA KOLUMNA: gracze / info -->
        <div class="panel-left" id="panel-left">
          <div class="panel-header" id="left-panel-title">GRACZE</div>
          <div class="player-list" id="sidebar-players">
            <div class="text-dim italic" style="font-size:12px;padding:8px">Dołącz do pokoju...</div>
          </div>
        </div>

        <!-- ŚRODEK: główna zawartość -->
        <main class="panel-main" id="panel-main">
          <div id="loading-rooms" style="text-align:center;padding:40px;color:var(--text-dim)">Ładowanie...</div>
        </main>

        <!-- PRAWA KOLUMNA: chat -->
        <div class="panel-chat" id="panel-chat">
          <div class="panel-header">CZAT</div>
          <div class="chat-tabs" id="chat-tabs"></div>
          <div class="chat-messages" id="chat-messages"></div>
          <div class="chat-input-row">
            <input type="text" id="chat-input" placeholder="Wiadomość..." maxlength="500"
              onkeydown="if(event.key==='Enter')Chat.send()" />
            <button class="btn btn-gold" onclick="Chat.send()">↑</button>
          </div>
        </div>
      </div>
    `;

    Chat.init();
    Socket.getChatHistory(null);
    this.updateHeaderRoomAction();
    this.updateInstallButton();
  },

  // ── LOBBY ─────────────────────────────────────────────────────────────────────
  async showLobby() {
    this.currentView = 'lobby';
    Chat.setRoom(null);
    Game.reset();
    this.setRoomStartConfirmation(null);

    const el = document.getElementById('panel-main');
    if (!el) return;

    el.innerHTML = `
      <div class="page-shell page-shell-lobby">
        <div class="page-head">
          <h2 class="font-title" style="font-size:20px;letter-spacing:3px;color:var(--gold)">LOBBY</h2>
          <button class="btn btn-gold" onclick="App.showCreateRoom()">+ Utwórz pokój</button>
        </div>
        ${this.currentRoomId ? `
          <div class="notice notice-info" style="margin-bottom:14px">
            ${this.currentRoomState === 'playing' ? 'Masz aktywną grę.' : 'Masz aktywny pokój.'}
            <button class="btn btn-ghost btn-sm" style="margin-left:10px" onclick="App.resumeActiveRoom()">
              ${this.currentRoomState === 'playing' ? 'Wróć do gry' : 'Wróć do pokoju'}
            </button>
          </div>
        ` : ''}
        <div id="rooms-notice"></div>
        <div id="rooms-container">
          <div class="text-dim italic">Ładowanie pokoi...</div>
        </div>
      </div>
    `;

    document.getElementById('sidebar-players').innerHTML =
      '<div class="text-dim italic" style="font-size:12px;padding:8px">Dołącz do pokoju...</div>';
    document.getElementById('left-panel-title').textContent = 'LOBBY';

    await this.loadRooms();
  },

  async loadRooms() {
    this.rooms = await API.getRooms();
    if (this.currentRoomId) {
      const activeRoom = this.rooms.find(r => r.id === this.currentRoomId);
      if (activeRoom) this.setActiveRoom(activeRoom);
      else this.clearActiveRoom();
    }
    this.renderRooms();
  },

  renderRooms() {
    const el = document.getElementById('rooms-container');
    if (!el) return;

    if (this.rooms.length === 0) {
      el.innerHTML = '<div class="text-dim italic text-center" style="padding:40px">Brak pokoi. Utwórz pierwszy!</div>';
      return;
    }

    el.innerHTML = `
      <div class="rooms-list">
        ${this.rooms.map(r => {
          const stateLabel = r.state === 'lobby' ? 'lobby' : r.state === 'playing' ? 'w grze' : 'po grze';
          const stateClass = `state-${r.state === 'lobby' ? 'lobby' : r.state === 'playing' ? 'playing' : 'finished'}`;
          const canJoin = r.state !== 'playing' && r.playerCount < 10;
          return `
            <div class="room-card">
              <div>
                <div class="room-name">${UI.escapeHtml(r.name)}</div>
                <div class="room-meta">Właściciel: ${UI.escapeHtml(r.ownerName)} · ${r.playerCount} graczy</div>
              </div>
              <span class="room-state ${stateClass}">${stateLabel}</span>
              ${canJoin
                ? `<button class="btn btn-gold btn-sm" onclick="App.joinRoom('${r.id}')">Dołącz</button>`
                : r.state !== 'playing'
                  ? `<span class="text-dim" style="font-size:12px">Pełny</span>`
                  : `<span class="text-dim" style="font-size:12px">W trakcie gry</span>`
              }
              ${this.currentUser?.isAdmin || r.ownerName === this.currentUser?.username
                ? `<button class="btn btn-danger btn-sm" onclick="App.deleteRoom('${r.id}')">🗑️</button>`
                : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  },

  showCreateRoom() {
    UI.showModal({
      title: '✨ Nowy Pokój',
      content: `
        <div style="margin-bottom:14px">
          <label>Nazwa pokoju</label>
          <input type="text" id="room-name-input" placeholder="np. Berlińska Rada..." maxlength="40"
            onkeydown="if(event.key==='Enter')App.createRoom()" />
        </div>
        <div id="create-room-notice"></div>
      `,
      actions: `
        <button class="btn btn-gold" style="flex:1" onclick="App.createRoom()">Utwórz</button>
        <button class="btn btn-ghost" style="flex:1" onclick="UI.closeModal()">Anuluj</button>
      `,
    });
    setTimeout(() => document.getElementById('room-name-input')?.focus(), 100);
  },

  async createRoom() {
    const name = document.getElementById('room-name-input')?.value?.trim();
    if (!name) return;
    const res = await API.createRoom(name);
    if (res.error) {
      document.getElementById('create-room-notice').innerHTML = UI.notice(res.error, 'error');
      return;
    }
    UI.closeModal();
    await this.joinRoom(res.room.id);
  },

  async deleteRoom(id) {
    const ok = await UI.confirm('Usunąć pokój? Wszystkie dane zostaną utracone.');
    if (!ok) return;
    await API.deleteRoom(id);
    if (this.currentRoomId === id) this.showLobby();
    else this.loadRooms();
  },

  // ── ROOM ──────────────────────────────────────────────────────────────────────
  async joinRoom(roomId, skipSocket = false) {
    if (this.currentRoomId && this.currentRoomId !== roomId && this.currentRoomState === 'playing') {
      alert('Masz aktywną grę. Wróć najpierw do swojego pokoju.');
      return;
    }
    if (this.currentRoomId && this.currentRoomId !== roomId && this.currentRoomState !== 'playing') {
      await Socket.leaveRoom();
      this.roomPlayers = [];
      this.setRoomStartConfirmation(null);
      Game.reset();
    }
    if (!skipSocket) {
      try {
        const res = await Socket.joinRoom(roomId);
        if (Array.isArray(res?.players)) this.roomPlayers = res.players;
      } catch (e) {
        alert(e.message);
        return;
      }
    }
    const room = this.rooms.find(r => r.id === roomId);
    this.setActiveRoom(room || { id: roomId, state: this.currentRoomState || 'lobby' });
    this.currentView = 'room';
    Chat.setRoom(roomId);
    await this.showRoom(roomId);
  },

  async resumeActiveRoom(skipSocket = false) {
    if (!this.currentRoomId) {
      await this.showLobby();
      return;
    }
    await this.joinRoom(this.currentRoomId, skipSocket);
  },

  async showRoom(roomId, resetToLobby = false) {
    const rooms = await API.getRooms();
    const room = rooms.find(r => r.id === roomId);
    if (!room) {
      this.clearActiveRoom();
      this.showLobby();
      return;
    }
    this.setActiveRoom(room);

    const el = document.getElementById('panel-main');
    if (!el) return;
    document.getElementById('left-panel-title').textContent = 'GRACZE W POKOJU';

    if (room.state === 'playing' && !resetToLobby) {
      // Gra trwa — pokaż widok gry
      el.innerHTML = `
        <div class="page-shell page-shell-game">
          <div class="page-head page-head-tight">
            <button class="btn btn-ghost btn-sm" onclick="App.goLobby()">← Lobby</button>
            <h2 class="font-title" style="font-size:16px;letter-spacing:2px;color:var(--gold)">${UI.escapeHtml(room.name)}</h2>
            <span class="room-state state-playing" style="font-size:10px">W GRZE</span>
          </div>
          <div id="game-error" class="notice notice-error" style="display:none;margin-bottom:10px"></div>
          <div id="game-main"></div>
        </div>
      `;
      Game.init(roomId, this.currentUser.id);
      // State zostanie odebrane przez socket
      return;
    }

    Game.reset();

    // Lobby view
    this.currentRoomPlayerCount = typeof room.playerCount === 'number' ? room.playerCount : this.currentRoomPlayerCount;
    const players = await this.getRoomPlayers(roomId);
    const effectiveCount = this.getEffectiveRoomPlayerCount(players);
    const botCount = players.filter(p => typeof p.id === 'string' && p.id.startsWith('bot:')).length;
    const isOwner = room.ownerId === this.currentUser.id;
    const canManageBots = room.state === 'lobby' && (isOwner || this.currentUser?.isAdmin);

    el.innerHTML = `
      <div class="page-shell page-shell-room">
        <div class="page-head page-head-tight">
          <button class="btn btn-ghost btn-sm" onclick="App.goLobby()">← Lobby</button>
          <h2 class="font-title" style="font-size:18px;letter-spacing:3px;color:var(--gold)">${UI.escapeHtml(room.name)}</h2>
          <span class="room-state state-lobby">LOBBY</span>
        </div>

        <div class="box box-gold">
          <div class="section-title">Gracze w pokoju</div>
          <div id="room-players-list"></div>
          <div class="text-dim" style="font-size:12px;margin-top:10px">
            Wymagane: 5-10 graczy. Aktualnie: <strong id="player-count-display">${effectiveCount}</strong>
          </div>
        </div>

        <div class="box" style="margin-top:12px">
          <div class="section-title">Start Gry</div>
          <div id="room-start-panel"></div>
        </div>

        ${canManageBots ? `
          <div class="box" style="margin-top:12px">
            <div class="section-title">Boty Testowe</div>
            <div class="text-dim" style="font-size:12px">
              Boty w pokoju: <strong id="bot-count-display">${players.length > 0 ? botCount : effectiveCount === 0 ? 0 : '...'}</strong> · Łącznie graczy: <strong id="room-total-count-display">${effectiveCount}</strong>/10
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
              <button id="room-add-bot-btn" class="btn btn-ghost btn-sm" ${effectiveCount >= 10 ? 'disabled' : ''} onclick="App.addBots(1)">+ 1 bot</button>
              <button id="room-fill-bots-btn" class="btn btn-ghost btn-sm" ${effectiveCount >= 5 || effectiveCount >= 10 ? 'disabled' : ''} onclick="App.fillBotsToMinimum()">Uzupełnij do 5</button>
              <button id="room-remove-bots-btn" class="btn btn-danger btn-sm" ${players.length > 0 && botCount === 0 ? 'disabled' : ''} onclick="App.removeBots()">Usuń boty</button>
            </div>
            <div class="text-dim" style="font-size:12px;margin-top:10px">
              Boty działają tylko w lobby i po starcie wykonują ruchy automatycznie.
            </div>
          </div>
        ` : ''}

        <div class="notice notice-info" style="margin-top:12px;font-size:12px">
          <strong>Kod pokoju:</strong> ${roomId}<br>
          Udostępnij znajomym aby dołączyli przez Lobby.
        </div>
      </div>
    `;

    this.renderRoomPlayers(players);
    this.renderRoomStartPanel();
  },

  async getRoomPlayers(roomId) {
    if (roomId !== this.currentRoomId) return [];
    if (Array.isArray(this.roomPlayers) && this.roomPlayers.length > 0) return this.roomPlayers;
    return [];
  },

  getEffectiveRoomPlayerCount(players = []) {
    if (Array.isArray(players) && players.length > 0) return players.length;
    return this.currentRoomPlayerCount || 0;
  },

  renderRoomPlayers(players) {
    const el = document.getElementById('room-players-list');
    const sideEl = document.getElementById('sidebar-players');
    const countEl = document.getElementById('player-count-display');
    const effectiveCount = this.getEffectiveRoomPlayerCount(players);
    const hasActualPlayers = Array.isArray(players) && players.length > 0;
    const displayPlayers = hasActualPlayers
      ? players
      : Array.from({ length: this.currentRoomPlayerCount || 0 }, (_, i) => ({ id: `placeholder:${i}`, username: 'Ładowanie...' }));

    if (countEl) countEl.textContent = String(effectiveCount);

    const rows = displayPlayers.map(p => {
      const isPlaceholder = typeof p.id === 'string' && p.id.startsWith('placeholder:');
      const isMe = p.id === this.currentUser.id;
      const isBot = typeof p.id === 'string' && p.id.startsWith('bot:');
      return `<div class="player-item ${isMe ? 'is-me' : ''}">
        <div class="player-dot ${isPlaceholder ? '' : 'online'}"></div>
        <span class="player-name">${UI.escapeHtml(p.username)}${isPlaceholder ? '' : isMe ? ' (ty)' : ''}${isBot ? ' [BOT]' : ''}</span>
      </div>`;
    }).join('');

    if (el) el.innerHTML = rows || '<div class="text-dim italic" style="font-size:13px">Brak graczy</div>';
    if (sideEl) sideEl.innerHTML = rows || '<div class="text-dim italic" style="font-size:12px;padding:8px">Brak graczy</div>';

    const botCount = hasActualPlayers
      ? players.filter(p => typeof p.id === 'string' && p.id.startsWith('bot:')).length
      : null;
    const botCountEl = document.getElementById('bot-count-display');
    if (botCountEl) botCountEl.textContent = botCount == null ? '...' : String(botCount);
    const totalCountEl = document.getElementById('room-total-count-display');
    if (totalCountEl) totalCountEl.textContent = String(effectiveCount);

    const addBotBtn = document.getElementById('room-add-bot-btn');
    if (addBotBtn) addBotBtn.disabled = effectiveCount >= 10;
    const fillBotsBtn = document.getElementById('room-fill-bots-btn');
    if (fillBotsBtn) fillBotsBtn.disabled = effectiveCount >= 5 || effectiveCount >= 10;
    const removeBotsBtn = document.getElementById('room-remove-bots-btn');
    if (removeBotsBtn) removeBotsBtn.disabled = botCount == null ? true : botCount === 0;
  },

  renderRoomStartPanel() {
    const panel = document.getElementById('room-start-panel');
    if (!panel || this.currentView !== 'room' || !this.currentRoomId || this.currentRoomState === 'playing') return;

    const players = Array.isArray(this.roomPlayers) ? this.roomPlayers : [];
    const effectiveCount = this.getEffectiveRoomPlayerCount(players);
    const hasActualPlayers = players.length > 0;
    const botCount = hasActualPlayers ? players.filter((player) => typeof player.id === 'string' && player.id.startsWith('bot:')).length : 0;
    const hasBots = botCount > 0;
    const canStart = effectiveCount >= 5 && effectiveCount <= 10;
    const control = this.roomStartConfirmation;

    if (control) {
      const myEntry = control.participants.find((participant) => participant.userId === this.currentUser.id);
      const confirmedCount = control.participants.filter((participant) => participant.confirmed).length;
      const rows = control.participants.map((participant) => `
        <div class="player-item" style="padding:6px 10px">
          <div class="player-dot ${participant.confirmed ? 'online' : ''}"></div>
          <span class="player-name">${UI.escapeHtml(participant.username)}${participant.userId === this.currentUser.id ? ' (ty)' : ''}</span>
          <span class="status-pill" style="margin-left:auto;font-size:11px;color:${participant.confirmed ? '#4a8' : 'var(--muted)'}">${participant.confirmed ? 'Potwierdzone' : 'Czeka'}</span>
        </div>
      `).join('');

      panel.innerHTML = `
        <div class="notice notice-info" style="margin-bottom:10px">
          <strong>${UI.escapeHtml(control.requestedByName)}</strong> chce rozpocząć grę. Potwierdź w ciągu <strong id="room-start-countdown">${this.formatRoomStartCountdown(control.expiresAt)}</strong>.
          Niepotwierdzeni gracze zostaną usunięci z pokoju.
        </div>
        <div class="text-dim" style="font-size:12px;margin-bottom:10px">Potwierdzenia: <strong>${confirmedCount}/${control.participants.length}</strong></div>
        <div class="box" style="padding:0;margin-bottom:12px">${rows}</div>
        ${myEntry?.confirmed ? `
          <div class="notice notice-success">Potwierdziłeś gotowość. Czekamy na pozostałych graczy.</div>
        ` : `
          <button class="btn btn-gold btn-full" onclick="App.confirmStartGame()">✅ Potwierdzam Start</button>
        `}
      `;
      return;
    }

    panel.innerHTML = `
      <div class="text-dim" style="font-size:12px;margin-bottom:10px">
        ${hasBots
          ? 'W pokoju są boty. Start jest natychmiastowy po kliknięciu przez dowolnego gracza.'
          : 'Po kliknięciu wszyscy zalogowani gracze w pokoju muszą potwierdzić start w ciągu 90 sekund.'}
      </div>
      <div class="notice notice-warn" style="${canStart ? 'display:none' : 'margin-bottom:10px'}">
        Potrzeba min. 5 graczy. Aktualnie: ${effectiveCount}
      </div>
      <button id="room-start-btn" class="btn btn-gold btn-full" ${!canStart ? 'disabled' : ''} onclick="App.startGame()">
        🎮 Rozpocznij Grę
      </button>
    `;
  },

  async startGame() {
    try {
      const res = await Socket.startGame(this.currentRoomId);
      if (res?.started) return;
      if (res?.pending) this.renderRoomStartPanel();
    } catch (e) {
      alert(e.message);
    }
  },

  async confirmStartGame(closeModal = false) {
    try {
      await Socket.confirmRoomStart(this.currentRoomId);
      if (closeModal) UI.closeModal();
      this.renderRoomStartPanel();
    } catch (e) {
      alert(e.message);
    }
  },

  async addBots(count = 1) {
    if (!this.currentRoomId) return;
    const res = await API.addRoomBots(this.currentRoomId, count);
    if (res.error) return alert(res.error);
    await this.showRoom(this.currentRoomId);
  },

  async fillBotsToMinimum(minPlayers = 5) {
    if (!this.currentRoomId) return;
    const res = await API.fillRoomBots(this.currentRoomId, minPlayers);
    if (res.error) return alert(res.error);
    await this.showRoom(this.currentRoomId);
  },

  async removeBots() {
    if (!this.currentRoomId) return;
    const ok = await UI.confirm('Usunąć wszystkie boty testowe z pokoju?');
    if (!ok) return;
    const res = await API.removeRoomBots(this.currentRoomId);
    if (res.error) return alert(res.error);
    await this.showRoom(this.currentRoomId);
  },

  // ── ADMIN ─────────────────────────────────────────────────────────────────────
  showAdmin() {
    if (!this.currentUser?.isAdmin) return;
    this.currentView = 'admin';
    Chat.setRoom(null);
    Game.reset();
    const el = document.getElementById('panel-main');
    if (!el) return;

    el.innerHTML = `
      <div class="page-shell page-shell-admin">
        <h2 class="font-title" style="font-size:20px;letter-spacing:3px;color:var(--gold);margin-bottom:20px">
          ⚙️ PANEL ADMINISTRATORA
        </h2>
        <div id="admin-content">Ładowanie...</div>
      </div>
    `;

    Admin.load();
  },

  showChangePassword() {
    UI.showModal({
      title: '🔐 Zmiana Hasła',
      content: `
        <div style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label>Aktualne hasło</label>
            <input type="password" id="account-current-password" autocomplete="current-password" />
          </div>
          <div>
            <label>Nowe hasło</label>
            <input type="password" id="account-new-password" autocomplete="new-password" />
          </div>
          <div>
            <label>Powtórz nowe hasło</label>
            <input type="password" id="account-repeat-password" autocomplete="new-password" />
          </div>
          <div id="account-password-notice"></div>
        </div>
      `,
      actions: `
        <button class="btn btn-gold" style="flex:1" onclick="App.changePassword()">Zapisz</button>
        <button class="btn btn-ghost" style="flex:1" onclick="UI.closeModal()">Anuluj</button>
      `,
    });
  },

  async changePassword() {
    const currentPassword = document.getElementById('account-current-password')?.value || '';
    const newPassword = document.getElementById('account-new-password')?.value || '';
    const repeatPassword = document.getElementById('account-repeat-password')?.value || '';
    const notice = document.getElementById('account-password-notice');

    if (!currentPassword || !newPassword || !repeatPassword) {
      if (notice) notice.innerHTML = UI.notice('Wypełnij wszystkie pola.', 'error');
      return;
    }
    if (newPassword !== repeatPassword) {
      if (notice) notice.innerHTML = UI.notice('Nowe hasła nie są takie same.', 'error');
      return;
    }

    const res = await API.changePassword(currentPassword, newPassword);
    if (res.error) {
      if (notice) notice.innerHTML = UI.notice(UI.escapeHtml(res.error), 'error');
      return;
    }

    UI.showModal({
      title: '✅ Hasło Zmienione',
      content: '<div class="notice notice-success">Twoje hasło zostało zmienione.</div>',
      actions: `<button class="btn btn-gold btn-full" onclick="UI.closeModal()">Zamknij</button>`,
    });
  },
};

// ── START ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => App.init());
