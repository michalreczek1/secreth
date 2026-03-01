// public/js/socket.js — Socket.io wrapper
let sock = null;
let connectPromise = null;

function waitForConnect() {
  if (!sock) return Promise.reject(new Error('Socket niezainicjalizowany'));
  if (sock.connected) return Promise.resolve();
  if (connectPromise) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(err?.message || 'Błąd połączenia socket'));
    };
    const cleanup = () => {
      if (!sock) return;
      sock.off('connect', onConnect);
      sock.off('connect_error', onError);
      connectPromise = null;
    };

    sock.on('connect', onConnect);
    sock.on('connect_error', onError);
    sock.connect();
  });

  return connectPromise;
}

function ensureSocket() {
  if (sock) return;

  sock = io({
    withCredentials: true,
    autoConnect: false,
    transports: ['websocket'],
    timeout: 8000,
  });

  sock.on('connect', () => {
    console.log('🔌 Socket connected:', sock.id);
    App.onSocketConnect?.();
  });
  sock.on('disconnect', () => {
    console.log('❌ Socket disconnected');
    App.onSocketDisconnect?.();
  });
  sock.on('connect_error', (err) => {
    console.error('socket connect_error', err?.message || err);
  });
  sock.on('rooms:updated', () => App.onRoomsUpdated?.());
  sock.on('room:players', (players) => App.onRoomPlayers?.(players));
  sock.on('room:deleted', () => App.onRoomDeleted?.());
  sock.on('chat:message', (msg) => Chat.onMessage?.(msg));
  sock.on('chat:history', (msgs) => Chat.onHistory?.(msgs));
  sock.on('game:started', () => App.onGameStarted?.());
  sock.on('game:state', (state) => Game.onState?.(state));
  sock.on('game:peek', (cards) => Game.onPeek?.(cards));
  sock.on('game:investigateResult', (result) => Game.onInvestigate?.(result));
  sock.on('game:reset', () => App.onGameReset?.());
  sock.on('admin:userActivated', (data) => App.onUserActivated?.(data));
}

async function withSocketAck(executor) {
  ensureSocket();
  await waitForConnect();
  return executor();
}

const Socket = {
  connect() {
    ensureSocket();
    return waitForConnect();
  },

  disconnect() {
    if (!sock) return;
    sock.disconnect();
    sock = null;
    connectPromise = null;
  },

  emit(event, ...args) { sock?.emit(event, ...args); },

  joinRoom(roomId) {
    return withSocketAck(() => new Promise((resolve, reject) => {
      sock.emit('room:join', roomId, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  },

  leaveRoom() { sock?.emit('room:leave'); },

  sendChat(message, roomId = null) { sock?.emit('chat:send', { message, roomId }); },

  getChatHistory(roomId = null) { sock?.emit('chat:history', { roomId }); },

  startGame(roomId) {
    return withSocketAck(() => new Promise((resolve, reject) => {
      sock.emit('game:start', roomId, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  },

  gameAction(roomId, action, payload = {}) {
    return withSocketAck(() => new Promise((resolve, reject) => {
      sock.emit('game:action', { roomId, action, payload }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  },

  declareClaim(roomId, sessionId, summary, skipped = false) {
    return withSocketAck(() => new Promise((resolve, reject) => {
      sock.emit('game:declareClaim', { roomId, sessionId, summary, skipped }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  },

  disconnectDecision(roomId, choice) {
    return withSocketAck(() => new Promise((resolve, reject) => {
      sock.emit('game:disconnectDecision', { roomId, choice }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  },

  endGameVote(roomId, action, accept = false) {
    return withSocketAck(() => new Promise((resolve, reject) => {
      sock.emit('game:endVote', { roomId, action, accept }, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  },

  restartGame(roomId) {
    return withSocketAck(() => new Promise((resolve, reject) => {
      sock.emit('game:restart', roomId, (res) => {
        if (res?.error) reject(new Error(res.error));
        else resolve(res);
      });
    }));
  },
};
