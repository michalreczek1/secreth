// server/index.js
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const FileStore  = require('session-file-store')(session);
const bcrypt     = require('bcryptjs');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const fs         = require('fs');

const { db }   = require('./db');
const game     = require('./game');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Upewnij się że folder na sesje istnieje
const SESSION_DIR = path.join(__dirname, '..', 'data', 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'secreth-online',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

const sessionMiddleware = session({
  store: new FileStore({
    path: SESSION_DIR,
    ttl: 7 * 24 * 60 * 60, // 7 dni
    retries: 1,
    logFn: () => {},
  }),
  secret: process.env.SESSION_SECRET || 'secret-hitler-key-2024-xK9mP',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ── PAMIĘĆ OPERACYJNA ─────────────────────────────────────────────────────────
// roomId → { state: GameState, playerSockets: {userId: socketId[]} }
const activeGames  = new Map();
// socketId → { userId, username, roomId }
const socketUsers  = new Map();
// roomId → Set(botUserId)
const roomBots     = new Map();
// roomId → timeout
const roomBotTimers = new Map();
// roomId → timeout
const roomDisconnectTimers = new Map();
// roomId -> start confirmation control
const roomStartConfirmations = new Map();

const DISCONNECT_GRACE_MS = 90 * 1000;
const DISCONNECT_WAIT_EXTENSION_MS = 60 * 1000;
const DISCONNECT_CHOICES = new Set(['wait', 'takeover', 'end']);
const ROOM_START_CONFIRM_MS = 90 * 1000;
const SYSTEM_USER_ID = '__system__';
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_IP_MAX_ATTEMPTS = 25;
const LOGIN_USERNAME_MAX_ATTEMPTS = 8;

const loginIpBuckets = new Map();
const loginUsernameBuckets = new Map();

const BOT_NAMES = [
  'Otto', 'Greta', 'Erika', 'Walter', 'Bruno',
  'Ingrid', 'Helmut', 'Lotte', 'Fritz', 'Karl',
];

function normalizeUsernameKey(username) {
  return String(username || '').trim().toLowerCase();
}

function nowMs() {
  return Date.now();
}

function cleanupLoginBucket(map, key, currentTime = nowMs()) {
  const bucket = map.get(key);
  if (!bucket) return null;
  bucket.attempts = bucket.attempts.filter((ts) => currentTime - ts <= LOGIN_WINDOW_MS);
  if (bucket.blockedUntil && bucket.blockedUntil <= currentTime) bucket.blockedUntil = 0;
  if (!bucket.attempts.length && !bucket.blockedUntil) {
    map.delete(key);
    return null;
  }
  return bucket;
}

function ensureLoginBucket(map, key, currentTime = nowMs()) {
  const existing = cleanupLoginBucket(map, key, currentTime);
  if (existing) return existing;
  const bucket = { attempts: [], blockedUntil: 0 };
  map.set(key, bucket);
  return bucket;
}

function getLoginThrottleState(ipKey, usernameKey, currentTime = nowMs()) {
  const ipBucket = ipKey ? cleanupLoginBucket(loginIpBuckets, ipKey, currentTime) : null;
  const usernameBucket = usernameKey ? cleanupLoginBucket(loginUsernameBuckets, usernameKey, currentTime) : null;

  const blockedUntil = Math.max(ipBucket?.blockedUntil || 0, usernameBucket?.blockedUntil || 0);
  if (blockedUntil > currentTime) {
    return { blocked: true, retryAfterMs: blockedUntil - currentTime };
  }
  return { blocked: false, retryAfterMs: 0 };
}

function registerFailedLogin(ipKey, usernameKey, currentTime = nowMs()) {
  if (ipKey) {
    const ipBucket = ensureLoginBucket(loginIpBuckets, ipKey, currentTime);
    ipBucket.attempts.push(currentTime);
    if (ipBucket.attempts.length >= LOGIN_IP_MAX_ATTEMPTS) {
      ipBucket.blockedUntil = currentTime + LOGIN_LOCK_MS;
      ipBucket.attempts = [];
    }
  }

  if (usernameKey) {
    const usernameBucket = ensureLoginBucket(loginUsernameBuckets, usernameKey, currentTime);
    usernameBucket.attempts.push(currentTime);
    if (usernameBucket.attempts.length >= LOGIN_USERNAME_MAX_ATTEMPTS) {
      usernameBucket.blockedUntil = currentTime + LOGIN_LOCK_MS;
      usernameBucket.attempts = [];
    }
  }
}

function clearLoginThrottle(ipKey, usernameKey) {
  if (ipKey) loginIpBuckets.delete(ipKey);
  if (usernameKey) loginUsernameBuckets.delete(usernameKey);
}

function getLoginRetryMessage(retryAfterMs) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `Zbyt wiele nieudanych prób logowania. Spróbuj ponownie za ${minutes} min.`;
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
async function destroySession(req) {
  if (!req.session) return;
  await new Promise(resolve => req.session.destroy(() => resolve()));
}

async function getSessionUser(req) {
  if (req.authUser) return req.authUser;
  const userId = req.session?.userId;
  if (!userId) return null;
  const user = await db.users.findById(userId);
  if (!user || !user.isActive) return null;
  req.authUser = user;
  // Synchronizuj sesję z aktualnym stanem użytkownika
  req.session.username = user.username;
  req.session.isAdmin = !!user.isAdmin;
  return user;
}

const requireAuth  = async (req, res, next) => {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      await destroySession(req);
      return res.status(401).json({ error: 'Niezalogowany' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
};

const requireAdmin = async (req, res, next) => {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      await destroySession(req);
      return res.status(401).json({ error: 'Niezalogowany' });
    }
    if (!user.isAdmin) return res.status(403).json({ error: 'Brak uprawnień' });
    next();
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
};

function isBotId(userId) {
  return typeof userId === 'string' && userId.startsWith('bot:');
}

function getRoomBots(roomId) {
  return roomBots.get(roomId) || new Set();
}

function registerBot(roomId, botId) {
  if (!roomBots.has(roomId)) roomBots.set(roomId, new Set());
  roomBots.get(roomId).add(botId);
}

function unregisterBot(roomId, botId) {
  const bots = roomBots.get(roomId);
  if (!bots) return;
  bots.delete(botId);
  if (bots.size === 0) roomBots.delete(roomId);
}

function clearBotTimer(roomId) {
  const timer = roomBotTimers.get(roomId);
  if (timer) clearTimeout(timer);
  roomBotTimers.delete(roomId);
}

function clearDisconnectTimer(roomId) {
  const timer = roomDisconnectTimers.get(roomId);
  if (timer) clearTimeout(timer);
  roomDisconnectTimers.delete(roomId);
}

function clearRoomBotsMeta(roomId) {
  clearBotTimer(roomId);
  clearDisconnectTimer(roomId);
  roomBots.delete(roomId);
}

function clearRoomStartConfirmation(roomId, { emit = true } = {}) {
  const control = roomStartConfirmations.get(roomId);
  if (control?.timer) clearTimeout(control.timer);
  roomStartConfirmations.delete(roomId);
  if (emit) io.to(`room:${roomId}`).emit('room:startConfirmation', null);
}

function serializeRoomStartConfirmation(control) {
  if (!control) return null;
  return {
    roomId: control.roomId,
    requestedBy: control.requestedBy,
    requestedByName: control.requestedByName,
    expiresAt: control.expiresAt,
    participants: control.participants.map((participant) => ({
      userId: participant.userId,
      username: participant.username,
      confirmed: !!participant.confirmedAt,
      confirmedAt: participant.confirmedAt || null,
    })),
  };
}

function emitRoomStartConfirmation(roomId) {
  io.to(`room:${roomId}`).emit('room:startConfirmation', serializeRoomStartConfirmation(roomStartConfirmations.get(roomId)));
}

async function removeUserFromLobbyRoom(roomId, userId, reason = null) {
  await db.roomPlayers.remove(roomId, userId);
  for (const [socketId, su] of socketUsers.entries()) {
    if (su.userId !== userId || su.roomId !== roomId) continue;
    const socket = io.sockets.sockets.get(socketId);
    socket?.leave(`room:${roomId}`);
    su.roomId = null;
    socketUsers.set(socketId, su);
    if (reason) io.to(socketId).emit('room:removed', { roomId, message: reason });
  }
}

async function startGameForRoom(roomId, initiatedByUsername = 'System') {
  const room = await db.rooms.findById(roomId);
  if (!room) throw new Error('Pokój nie istnieje');
  if (room.state === 'playing') throw new Error('Gra już trwa');

  const players = await db.roomPlayers.getPlayersInRoom(roomId);
  if (players.length < 5) throw new Error(`Za mało graczy (${players.length}/5)`);
  if (players.length > 10) throw new Error('Za dużo graczy (max 10)');

  clearRoomStartConfirmation(roomId);

  const playerList = players.map((p) => ({ id: p.userId, username: p.username }));
  const state = ensureGameMetaState(game.createGame(playerList));

  const ag = { state, playerSockets: {} };
  for (const [sid, su] of socketUsers.entries()) {
    if (su.roomId === roomId) addPlayerSocket(ag, su.userId, sid);
  }
  activeGames.set(roomId, ag);
  await db.rooms.setState(roomId, 'playing', JSON.stringify(state));

  io.to(`room:${roomId}`).emit('game:started');
  broadcastGameState(roomId);
  io.emit('rooms:updated');

  await db.messages.insert(
    roomId,
    SYSTEM_USER_ID,
    'System',
    `🎮 Gra rozpoczęta! Grają: ${playerList.map((p) => p.username).join(', ')}. Start zainicjował: ${initiatedByUsername}.`,
    'system'
  );
  io.to(`room:${roomId}`).emit('chat:message', {
    username: 'System',
    message: `🎮 Gra rozpoczęta! ${players.length} graczy.`,
    createdAt: new Date().toISOString(),
    type: 'system',
    roomId,
  });

  if (shouldBotsPlay(roomId)) scheduleBots(roomId, 900);
}

async function syncRoomStartConfirmation(roomId) {
  const control = roomStartConfirmations.get(roomId);
  if (!control) return null;

  const room = await db.rooms.findById(roomId);
  if (!room || room.state !== 'lobby') {
    clearRoomStartConfirmation(roomId);
    return null;
  }

  const players = await db.roomPlayers.getPlayersInRoom(roomId);
  const humanPlayers = players.filter((player) => !isBotId(player.userId));
  const playerMap = new Map(humanPlayers.map((player) => [player.userId, player]));

  control.participants = control.participants
    .filter((participant) => playerMap.has(participant.userId))
    .map((participant) => ({
      ...participant,
      username: playerMap.get(participant.userId)?.username || participant.username,
    }));

  if (control.participants.length < 5) {
    clearRoomStartConfirmation(roomId);
    return null;
  }

  return control;
}

async function maybeCompleteRoomStartConfirmation(roomId) {
  const control = await syncRoomStartConfirmation(roomId);
  if (!control) return false;
  if (!control.participants.every((participant) => participant.confirmedAt)) {
    emitRoomStartConfirmation(roomId);
    return false;
  }
  await startGameForRoom(roomId, control.requestedByName);
  return true;
}

async function finalizeRoomStartConfirmation(roomId) {
  const control = await syncRoomStartConfirmation(roomId);
  if (!control) return;

  const unconfirmed = control.participants.filter((participant) => !participant.confirmedAt);
  for (const participant of unconfirmed) {
    await removeUserFromLobbyRoom(
      roomId,
      participant.userId,
      'Nie potwierdziłeś startu gry na czas i zostałeś usunięty z pokoju.'
    );
  }

  const removedNames = unconfirmed.map((participant) => participant.username);
  control.participants = control.participants.filter((participant) => participant.confirmedAt);

  const updatedPlayers = await emitRoomPlayers(roomId);
  if (removedNames.length) {
    await emitSystemRoomMessage(
      roomId,
      `⌛ Z pokoju usunięto niepotwierdzonych graczy: ${removedNames.join(', ')}.`
    );
  }

  clearRoomStartConfirmation(roomId);
  if (updatedPlayers.length >= 5) {
    await emitSystemRoomMessage(roomId, '⏹️ Start nie został uruchomiony automatycznie po timeoutcie. Jeśli chcecie grać w nowym składzie, kliknijcie ponownie „Rozpocznij Grę”.');
    return;
  }

  await emitSystemRoomMessage(roomId, '❌ Start anulowany. Po usunięciu niepotwierdzonych graczy zostało mniej niż 5 osób.');
}

function hasConnectedHumanInGame(roomId) {
  const state = activeGames.get(roomId)?.state;
  if (!state?.players) return false;
  return state.players.some((player) => !isBotId(player.id) && player.connected !== false && !state.botControlled?.[player.id]);
}

function getGameBotIds(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state?.players) return new Set();
  return new Set(ag.state.players.filter(p => isBotId(p.id)).map(p => p.id));
}

function ensurePlayerSocketMap(ag) {
  if (!ag.playerSockets || typeof ag.playerSockets !== 'object') ag.playerSockets = {};
  return ag.playerSockets;
}

function getPlayerSocketIds(ag, userId) {
  const sockets = ensurePlayerSocketMap(ag)[userId];
  if (!sockets) return [];
  return Array.isArray(sockets) ? sockets : [sockets];
}

function addPlayerSocket(ag, userId, socketId) {
  const sockets = getPlayerSocketIds(ag, userId).filter(Boolean);
  if (!sockets.includes(socketId)) sockets.push(socketId);
  ensurePlayerSocketMap(ag)[userId] = sockets;
}

function removePlayerSocket(ag, userId, socketId) {
  const sockets = getPlayerSocketIds(ag, userId).filter((sid) => sid && sid !== socketId);
  if (sockets.length) {
    ensurePlayerSocketMap(ag)[userId] = sockets;
    return sockets;
  }
  delete ensurePlayerSocketMap(ag)[userId];
  return [];
}

function emitToPlayerSockets(ag, userId, eventName, payload) {
  for (const sid of getPlayerSocketIds(ag, userId)) {
    io.to(sid).emit(eventName, payload);
  }
}

function ensureGameMetaState(state) {
  if (!state.botControlled || typeof state.botControlled !== 'object') state.botControlled = {};
  if (!Object.prototype.hasOwnProperty.call(state, 'disconnectControl')) state.disconnectControl = null;
  if (!Object.prototype.hasOwnProperty.call(state, 'endVoteControl')) state.endVoteControl = null;
  return state;
}

function getAutomatedPlayerIds(roomId) {
  const ids = getGameBotIds(roomId);
  const state = activeGames.get(roomId)?.state;
  const botControlled = state?.botControlled || {};
  for (const [userId, controlled] of Object.entries(botControlled)) {
    if (controlled) ids.add(userId);
  }
  return ids;
}

function isDisconnectPauseActive(state) {
  return !!state?.disconnectControl && (state.disconnectControl.phase === 'waiting' || state.disconnectControl.phase === 'decision');
}

function isEndVoteActive(state) {
  return !!state?.endVoteControl;
}

function isGamePauseActive(state) {
  return isDisconnectPauseActive(state) || isEndVoteActive(state);
}

function shouldBotsPlay(roomId) {
  const ag = activeGames.get(roomId);
  const bots = getAutomatedPlayerIds(roomId);
  return bots.size > 0 && !!ag && ag.state.phase !== 'end' && !isGamePauseActive(ag.state) && hasConnectedHumanInGame(roomId);
}

function pickBotName(existingNames) {
  for (const base of BOT_NAMES) {
    const candidate = `BOT ${base}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  let idx = 1;
  while (existingNames.has(`BOT ${idx}`)) idx++;
  return `BOT ${idx}`;
}

async function getUserActiveRoom(userId) {
  const memberships = await db.roomPlayers.getRoomsForUser(userId);
  if (!memberships.length) return null;

  const rooms = [];
  for (const membership of memberships) {
    const room = await db.rooms.findById(membership.roomId);
    if (!room) {
      await db.roomPlayers.remove(membership.roomId, userId);
      continue;
    }
    if (room.state === 'finished') {
      await db.rooms.setState(room._id, 'lobby', null);
      room.state = 'lobby';
      room.gameData = null;
    }
    rooms.push(room);
  }

  if (!rooms.length) return null;

  rooms.sort((a, b) => {
    const rank = (room) => room.state === 'playing' ? 2 : room.state === 'lobby' ? 1 : 0;
    const diff = rank(b) - rank(a);
    if (diff !== 0) return diff;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });

  const room = rooms[0];
  return {
    id: room._id,
    name: room.name,
    ownerId: room.ownerId,
    ownerName: room.ownerName,
    state: room.state,
  };
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Podaj nazwę i hasło' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Nazwa 2-20 znaków' });
    if (password.length < 4) return res.status(400).json({ error: 'Hasło min. 4 znaki' });
    if (!/^[a-zA-Z0-9_\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+$/.test(username))
      return res.status(400).json({ error: 'Tylko litery, cyfry, _ i -' });

    const existing = await db.users.findByUsername(username);
    if (existing) return res.status(409).json({ error: 'Nazwa zajęta' });

    const hash = bcrypt.hashSync(password, 10);
    await db.users.create(username, hash);
    res.json({ ok: true, message: 'Konto utworzone! Czekaj na aktywację przez admina.' });
  } catch (e) {
    console.error('register error', e);
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Podaj dane' });

    const ipKey = req.ip || req.socket?.remoteAddress || 'unknown';
    const usernameKey = normalizeUsernameKey(username);
    const throttle = getLoginThrottleState(ipKey, usernameKey);
    if (throttle.blocked) {
      return res.status(429).json({ error: getLoginRetryMessage(throttle.retryAfterMs) });
    }

    const user = await db.users.findByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      registerFailedLogin(ipKey, usernameKey);
      return res.status(401).json({ error: 'Błędna nazwa lub hasło' });
    }
    if (!user.isActive) {
      registerFailedLogin(ipKey, usernameKey);
      return res.status(403).json({ error: 'Konto czeka na aktywację przez administratora' });
    }

    req.session.userId   = user._id;
    req.session.username = user.username;
    req.session.isAdmin  = !!user.isAdmin;
    await db.users.setLastSeen(user._id);
    const activeRoom = await getUserActiveRoom(user._id);
    clearLoginThrottle(ipKey, usernameKey);

    res.json({
      ok: true,
      user: { id: user._id, username: user.username, isAdmin: !!user.isAdmin },
      activeRoom,
    });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.post('/api/logout', (req, res) => {
  const userId = req.session?.userId;
  (async () => {
    if (userId) await forceLogoutUser(userId);
    await destroySession(req);
    res.json({ ok: true });
  })().catch((e) => {
    console.error('logout error', e);
    res.status(500).json({ error: 'Błąd serwera' });
  });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await getSessionUser(req);
  if (!user) {
    await destroySession(req);
    return res.json({ user: null });
  }
  const activeRoom = await getUserActiveRoom(user._id);
  res.json({
    user: { id: user._id, username: user.username, isAdmin: !!user.isAdmin },
    activeRoom,
  });
});

app.post('/api/account/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Podaj aktualne i nowe hasło' });
    if (String(newPassword).length < 4) return res.status(400).json({ error: 'Nowe hasło musi mieć min. 4 znaki' });

    const user = await db.users.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Użytkownik nie istnieje' });
    if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: 'Aktualne hasło jest nieprawidłowe' });
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    await db.users.setPasswordHash(user._id, hash);
    res.json({ ok: true });
  } catch (e) {
    console.error('change password error', e);
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const all = await db.users.findAll();
  res.json(all.map(u => ({
    id: u._id, username: u.username, isAdmin: !!u.isAdmin,
    isActive: !!u.isActive, createdAt: u.createdAt, lastSeen: u.lastSeen,
  })));
});

app.post('/api/admin/users/:id/activate', requireAuth, requireAdmin, async (req, res) => {
  await db.users.setActive(req.params.id, true);
  io.emit('admin:userActivated', { userId: req.params.id });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/deactivate', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Nie możesz deaktywować siebie' });
  await db.users.setActive(req.params.id, false);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/toggle-admin', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Nie możesz zmienić własnych uprawnień' });
  const user = await db.users.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Nie znaleziono' });
  await db.users.setAdmin(req.params.id, !user.isAdmin);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword) return res.status(400).json({ error: 'Podaj nowe hasło' });
    if (String(newPassword).length < 4) return res.status(400).json({ error: 'Hasło musi mieć min. 4 znaki' });
    if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Użyj opcji zmiany własnego hasła' });

    const user = await db.users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Nie znaleziono' });

    const hash = bcrypt.hashSync(newPassword, 10);
    await db.users.setPasswordHash(req.params.id, hash);
    res.json({ ok: true });
  } catch (e) {
    console.error('reset password error', e);
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Nie możesz usunąć siebie' });
  await db.users.delete(req.params.id);
  res.json({ ok: true });
});

// ── ROOM ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/rooms', requireAuth, async (req, res) => {
  try {
    const allRooms = await db.rooms.findAll();
    const result = await Promise.all(allRooms.map(async r => {
      const count = await db.roomPlayers.countInRoom(r._id);
      return { id: r._id, name: r.name, ownerName: r.ownerName, ownerId: r.ownerId, state: r.state, playerCount: count, createdAt: r.createdAt };
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Nazwa 2-40 znaków' });
    const id = uuidv4().substring(0, 8).toUpperCase();
    await db.rooms.create(id, name, req.session.userId, req.session.username);
    await db.roomPlayers.add(id, req.session.userId, req.session.username);
    const room = await db.rooms.findById(id);
    io.emit('rooms:updated');
    res.json({ ok: true, room: { id: room._id, name: room.name } });
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.delete('/api/rooms/:id', requireAuth, async (req, res) => {
  try {
    const room = await db.rooms.findById(req.params.id);
    if (!room) return res.status(404).json({ error: 'Pokój nie istnieje' });
    if (room.ownerId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Brak uprawnień' });
    clearRoomStartConfirmation(req.params.id);
    await db.rooms.delete(req.params.id);
    await db.roomPlayers.removeAll(req.params.id);
    activeGames.delete(req.params.id);
    clearRoomBotsMeta(req.params.id);
    io.to(`room:${req.params.id}`).emit('room:deleted');
    io.emit('rooms:updated');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.post('/api/rooms/:id/bots', requireAuth, async (req, res) => {
  try {
    const room = await db.rooms.findById(req.params.id);
    if (!room) return res.status(404).json({ error: 'Pokój nie istnieje' });
    if (room.state !== 'lobby') return res.status(400).json({ error: 'Boty można dodawać tylko w lobby' });
    if (roomStartConfirmations.has(req.params.id)) return res.status(400).json({ error: 'Trwa potwierdzanie startu gry' });
    if (room.ownerId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Brak uprawnień' });

    const players = await db.roomPlayers.getPlayersInRoom(req.params.id);
    if (players.length >= 10) return res.status(400).json({ error: 'Pokój pełny (max 10)' });

    const availableSlots = Math.max(0, 10 - players.length);
    const requestedFillTo = Number(req.body?.fillTo);
    const requestedCount = Number(req.body?.count ?? 1);
    const count = Math.max(1, Math.min(10, Number.isFinite(requestedCount) ? requestedCount : 1));
    const desiredTotal = Number.isFinite(requestedFillTo) ? Math.max(1, Math.min(10, requestedFillTo)) : null;
    const requestedAdd = desiredTotal != null ? Math.max(0, desiredTotal - players.length) : count;
    const toAdd = Math.min(requestedAdd, availableSlots);
    if (toAdd <= 0) return res.status(400).json({ error: 'Brak wolnych miejsc na boty' });

    const existingNames = new Set(players.map(p => p.username));
    for (let i = 0; i < toAdd; i++) {
      const botId = `bot:${uuidv4()}`;
      const botName = pickBotName(existingNames);
      existingNames.add(botName);
      registerBot(req.params.id, botId);
      await db.roomPlayers.add(req.params.id, botId, botName);
    }

    await emitRoomPlayers(req.params.id);
    res.json({ ok: true, added: toAdd });
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

app.delete('/api/rooms/:id/bots', requireAuth, async (req, res) => {
  try {
    const room = await db.rooms.findById(req.params.id);
    if (!room) return res.status(404).json({ error: 'Pokój nie istnieje' });
    if (room.state !== 'lobby') return res.status(400).json({ error: 'Boty można usuwać tylko w lobby' });
    if (roomStartConfirmations.has(req.params.id)) return res.status(400).json({ error: 'Trwa potwierdzanie startu gry' });
    if (room.ownerId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Brak uprawnień' });

    const players = await db.roomPlayers.getPlayersInRoom(req.params.id);
    const bots = players.filter(p => isBotId(p.userId));
    for (const bot of bots) {
      await db.roomPlayers.remove(req.params.id, bot.userId);
      unregisterBot(req.params.id, bot.userId);
    }

    await emitRoomPlayers(req.params.id);
    res.json({ ok: true, removed: bots.length });
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  const sess = socket.request.session;
  if (!sess?.userId) { socket.disconnect(); return; }

  const user = await db.users.findById(sess.userId);
  if (!user || !user.isActive) { socket.disconnect(); return; }

  const userId = user._id;
  let username = user.username;
  sess.username = user.username;
  sess.isAdmin = !!user.isAdmin;
  sess.save(() => {});
  socketUsers.set(socket.id, { userId, username, roomId: null });
  db.users.setLastSeen(userId);
  console.log(`🔌 ${username} połączony`);

  async function ensureSocketUserActive(callback) {
    try {
      const fresh = await db.users.findById(userId);
      if (!fresh || !fresh.isActive) {
        callback?.({ error: 'Konto nie jest aktywne' });
        socket.disconnect();
        return null;
      }
      username = fresh.username;
      return fresh;
    } catch (e) {
      callback?.({ error: 'Błąd serwera' });
      return null;
    }
  }

  // ── POKOJE ──────────────────────────────────────────────────────────────────
  socket.on('room:join', async (roomId, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      const room = await db.rooms.findById(roomId);
      if (!room) return callback?.({ error: 'Pokój nie istnieje' });
      if (room.state === 'finished') {
        await db.rooms.setState(roomId, 'lobby', null);
        room.state = 'lobby';
        room.gameData = null;
      }

      const otherMemberships = (await db.roomPlayers.getRoomsForUser(userId))
        .filter(p => p.roomId !== roomId);
      for (const membership of otherMemberships) {
        const otherRoom = await db.rooms.findById(membership.roomId);
        if (!otherRoom) {
          await db.roomPlayers.remove(membership.roomId, userId);
          continue;
        }
        if (otherRoom.state === 'playing') {
          return callback?.({ error: `Masz aktywną grę w pokoju ${otherRoom.name}. Wróć do niej.` });
        }
        await db.roomPlayers.remove(membership.roomId, userId);
        await emitRoomPlayers(membership.roomId);
        if (!(await maybeCompleteRoomStartConfirmation(membership.roomId))) emitRoomStartConfirmation(membership.roomId);
        socket.leave(`room:${membership.roomId}`);
      }

      const players = await db.roomPlayers.getPlayersInRoom(roomId);
      const inRoom  = players.find(p => p.userId === userId);

      if (!inRoom) {
        if (room.state === 'playing') return callback?.({ error: 'Gra już trwa — nie możesz dołączyć' });
        if (roomStartConfirmations.has(roomId)) return callback?.({ error: 'Trwa potwierdzanie startu gry. Poczekaj na koniec odliczania.' });
        if (players.length >= 10)   return callback?.({ error: 'Pokój pełny (max 10)' });
        await db.roomPlayers.add(roomId, userId, username);
      }

      socket.join(`room:${roomId}`);
      const su = socketUsers.get(socket.id);
      if (su) { su.roomId = roomId; socketUsers.set(socket.id, su); }

      // Reconnect do aktywnej gry
      const ag = activeGames.get(roomId);
      if (ag) {
        ensureGameMetaState(ag.state);
        const p = ag.state.players.find(p => p.id === userId);
        if (p) {
          const hadBotControl = !!ag.state.botControlled?.[userId];
          const wasTarget = ag.state.disconnectControl?.targetUserId === userId;
          p.connected = true;
          if (hadBotControl) delete ag.state.botControlled[userId];
          if (wasTarget) {
            ag.state.disconnectControl = null;
            clearDisconnectTimer(roomId);
          }
          if (hadBotControl || wasTarget) {
            ag.state = game.addLog(ag.state,
              hadBotControl
                ? `🔌 ${username} wrócił i odzyskuje kontrolę nad swoją rolą.`
                : `🔌 ${username} wrócił do gry.`);
            await persistActiveGameState(roomId);
            await emitSystemRoomMessage(roomId,
              hadBotControl
                ? `🔌 ${username} wrócił i odzyskuje kontrolę nad swoją rolą.`
                : `🔌 ${username} wrócił do gry.`);
          } else {
            await persistActiveGameState(roomId);
          }
          addPlayerSocket(ag, userId, socket.id);
          await reconcileEndVoteControl(roomId);
          broadcastGameState(roomId);
          await ensureDisconnectWorkflow(roomId);
        }
      }

      const updatedPlayers = await emitRoomPlayers(roomId);
      emitRoomStartConfirmation(roomId);
      if (shouldBotsPlay(roomId)) scheduleBots(roomId, 700);

      // Historia czatu pokoju
      const history = await db.messages.getRoom(roomId);
      socket.emit('chat:history', history);

      callback?.({
        ok: true,
        players: updatedPlayers.map((p) => ({ id: p.userId, username: p.username })),
      });
    } catch (e) {
      console.error('room:join error', e);
      callback?.({ error: 'Błąd serwera' });
    }
  });

  socket.on('room:leave', async (callback) => {
    try {
      await leaveRoom(socket);
      callback?.({ ok: true });
    } catch (e) {
      callback?.({ error: e.message || 'Błąd opuszczania pokoju' });
    }
  });

  // ── CZAT ────────────────────────────────────────────────────────────────────
  socket.on('chat:send', async ({ message, roomId: targetRoom }) => {
    if (!(await ensureSocketUserActive())) return;
    const msg = (message || '').trim().substring(0, 500);
    if (!msg) return;
    const rid = targetRoom || null;
    if (getDeadPlayerInActiveGame(userId, rid)) {
      socket.emit('chat:message', {
        username: 'System',
        message: 'Zostałeś wyeliminowany z gry i nie możesz już pisać.',
        createdAt: new Date().toISOString(),
        type: 'system',
        global: !rid,
        roomId: rid,
      });
      return;
    }
    const createdAt = new Date().toISOString();
    await db.messages.insert(rid, userId, username, msg, 'chat');
    const payload = { username, message: msg, createdAt, type: 'chat', global: !rid, roomId: rid };
    if (rid) io.to(`room:${rid}`).emit('chat:message', payload);
    else io.emit('chat:message', payload);
  });

  socket.on('chat:history', async ({ roomId: targetRoom }) => {
    if (!(await ensureSocketUserActive())) return;
    const msgs = targetRoom
      ? await db.messages.getRoom(targetRoom)
      : await db.messages.getGlobal();
    socket.emit('chat:history', msgs);
  });

  // ── GRA ─────────────────────────────────────────────────────────────────────
  socket.on('game:start', async (roomId, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      const room = await db.rooms.findById(roomId);
      if (!room) return callback?.({ error: 'Pokój nie istnieje' });
      if (room.state === 'playing') return callback?.({ error: 'Gra już trwa' });
      const membership = await db.roomPlayers.isInRoom(roomId, userId);
      if (!membership) return callback?.({ error: 'Nie jesteś w tym pokoju' });
      if (isBotId(userId)) return callback?.({ error: 'Bot nie może rozpocząć gry' });

      const players = await db.roomPlayers.getPlayersInRoom(roomId);
      if (players.length < 5)  return callback?.({ error: `Za mało graczy (${players.length}/5)` });
      if (players.length > 10) return callback?.({ error: 'Za dużo graczy (max 10)' });
      const hasBots = players.some((player) => isBotId(player.userId));
      if (hasBots) {
        await startGameForRoom(roomId, username);
        return callback?.({ ok: true, started: true });
      }

      let control = roomStartConfirmations.get(roomId);
      if (!control) {
        control = {
          roomId,
          requestedBy: userId,
          requestedByName: username,
          expiresAt: new Date(Date.now() + ROOM_START_CONFIRM_MS).toISOString(),
          participants: players
            .filter((player) => !isBotId(player.userId))
            .map((player) => ({
              userId: player.userId,
              username: player.username,
              confirmedAt: player.userId === userId ? new Date().toISOString() : null,
            })),
          timer: null,
        };
        control.timer = setTimeout(() => {
          finalizeRoomStartConfirmation(roomId).catch((e) => console.error('room:start finalize error', e));
        }, ROOM_START_CONFIRM_MS);
        roomStartConfirmations.set(roomId, control);
        await emitSystemRoomMessage(roomId, `🗳️ ${username} chce rozpocząć grę. Wszyscy gracze muszą potwierdzić start w ciągu 90 sekund.`);
      } else {
        const participant = control.participants.find((entry) => entry.userId === userId);
        if (participant && !participant.confirmedAt) {
          participant.confirmedAt = new Date().toISOString();
        }
      }

      const started = await maybeCompleteRoomStartConfirmation(roomId);
      if (!started) emitRoomStartConfirmation(roomId);
      callback?.({ ok: true, pending: !started, started });
    } catch (e) {
      console.error('game:start error', e);
      callback?.({ error: e.message });
    }
  });

  socket.on('room:startConfirm', async (roomId, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      const control = roomStartConfirmations.get(roomId);
      if (!control) return callback?.({ error: 'Brak aktywnego potwierdzenia startu' });
      const participant = control.participants.find((entry) => entry.userId === userId);
      if (!participant) return callback?.({ error: 'Nie bierzesz udziału w tym starcie' });
      if (!participant.confirmedAt) {
        participant.confirmedAt = new Date().toISOString();
        await emitSystemRoomMessage(roomId, `✅ ${username} potwierdza gotowość do startu gry.`);
      }
      const started = await maybeCompleteRoomStartConfirmation(roomId);
      if (!started) emitRoomStartConfirmation(roomId);
      callback?.({ ok: true, started });
    } catch (e) {
      callback?.({ error: e.message || 'Błąd potwierdzania startu' });
    }
  });

  socket.on('game:action', async ({ roomId, action, payload }, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      await processGameAction(roomId, userId, action, payload);
      if (shouldBotsPlay(roomId)) scheduleBots(roomId, 700);
      callback?.({ ok: true });
    } catch (e) {
      console.error('game:action error', e);
      callback?.({ error: e.message });
    }
  });

  socket.on('game:declareClaim', async ({ roomId, sessionId, summary, skipped }, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      await submitLegislativeClaim(roomId, userId, sessionId, summary, !!skipped);
      callback?.({ ok: true });
    } catch (e) {
      callback?.({ error: e.message });
    }
  });

  socket.on('game:disconnectDecision', async ({ roomId, choice }, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      await castDisconnectVote(roomId, userId, choice);
      callback?.({ ok: true });
    } catch (e) {
      callback?.({ error: e.message });
    }
  });

  socket.on('game:endVote', async ({ roomId, action, accept }, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      if (action === 'request') await requestEndGameVote(roomId, userId);
      else if (action === 'respond') await respondEndGameVote(roomId, userId, !!accept);
      else throw new Error('Nieznana akcja zakończenia gry');
      callback?.({ ok: true });
    } catch (e) {
      callback?.({ error: e.message });
    }
  });

  socket.on('game:restart', async (roomId, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      const room = await db.rooms.findById(roomId);
      if (!room) return callback?.({ error: 'Pokój nie istnieje' });
      if (room.ownerId !== userId) return callback?.({ error: 'Tylko właściciel może zrestartować' });
      activeGames.delete(roomId);
      clearBotTimer(roomId);
      clearDisconnectTimer(roomId);
      clearRoomStartConfirmation(roomId);
      await db.rooms.setState(roomId, 'lobby', null);
      io.to(`room:${roomId}`).emit('game:reset');
      io.emit('rooms:updated');
      callback?.({ ok: true });
    } catch (e) {
      callback?.({ error: e.message });
    }
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const su = socketUsers.get(socket.id);
    if (su?.roomId) {
      const room = await db.rooms.findById(su.roomId);
      if (room && room.state === 'lobby') {
        await db.roomPlayers.remove(su.roomId, su.userId);
        await emitRoomPlayers(su.roomId);
        if (!(await maybeCompleteRoomStartConfirmation(su.roomId))) emitRoomStartConfirmation(su.roomId);
      }

      const ag = activeGames.get(su.roomId);
      if (ag) {
        ensureGameMetaState(ag.state);
        const p = ag.state.players.find(p => p.id === su.userId);
        if (p) {
          const remainingSockets = removePlayerSocket(ag, su.userId, socket.id);
          if (remainingSockets.length === 0) {
            p.connected = false;
            const endVoteFinished = await reconcileEndVoteControl(su.roomId);
            if (endVoteFinished) {
              socketUsers.delete(socket.id);
              console.log(`❌ ${username} rozłączony`);
              return;
            }
            await ensureDisconnectWorkflow(su.roomId);
          }
          await persistActiveGameState(su.roomId);
          broadcastGameState(su.roomId);
        }
      }
    }
    socketUsers.delete(socket.id);
    console.log(`❌ ${username} rozłączony`);
  });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function emitRoomPlayers(roomId) {
  const players = await db.roomPlayers.getPlayersInRoom(roomId);
  io.to(`room:${roomId}`).emit('room:players', players.map(p => ({ id: p.userId, username: p.username })));
  io.emit('rooms:updated');
  return players;
}

function getDeadPlayerInActiveGame(userId, roomId = null) {
  const games = roomId ? [[roomId, activeGames.get(roomId)]] : [...activeGames.entries()];
  for (const [, ag] of games) {
    if (!ag?.state?.players) continue;
    const player = ag.state.players.find(p => p.id === userId);
    if (player?.dead) return player;
  }
  return null;
}

async function emitSystemRoomMessage(roomId, message) {
  const createdAt = new Date().toISOString();
  await db.messages.insert(roomId, SYSTEM_USER_ID, 'System', message, 'system');
  io.to(`room:${roomId}`).emit('chat:message', {
    username: 'System',
    message,
    createdAt,
    type: 'system',
    roomId,
  });
}

async function emitPlayerRoomMessage(roomId, userId, username, message) {
  const createdAt = new Date().toISOString();
  await db.messages.insert(roomId, userId, username, message, 'chat');
  io.to(`room:${roomId}`).emit('chat:message', {
    username,
    message,
    createdAt,
    type: 'chat',
    roomId,
  });
}

function formatClaimSummary(summary) {
  if (!summary) return '';
  const normalized = String(summary).replace(/[^LF]/g, '');
  return normalized ? `[CLAIM:${normalized}]` : '';
}

async function persistActiveGameState(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) return;
  await db.rooms.setState(roomId, ag.state.phase === 'end' ? 'lobby' : 'playing',
    ag.state.phase === 'end' ? null : JSON.stringify(ag.state));
}

function getDisconnectedHumanCandidate(state) {
  ensureGameMetaState(state);
  return state.players.find((p) =>
    !p.dead &&
    !isBotId(p.id) &&
    p.connected === false &&
    !state.botControlled[p.id]
  ) || null;
}

function getDisconnectEligibleVoters(state, targetUserId) {
  return state.players
    .filter((p) => !p.dead && p.id !== targetUserId && !isBotId(p.id) && p.connected !== false)
    .map((p) => p.id);
}

function summarizeDisconnectVotes(control) {
  const summary = { wait: 0, takeover: 0, end: 0 };
  for (const choice of Object.values(control?.votes || {})) {
    if (summary[choice] !== undefined) summary[choice] += 1;
  }
  return summary;
}

function buildDisconnectView(state, userId) {
  const control = state.disconnectControl;
  if (!control) return null;
  const votes = summarizeDisconnectVotes(control);
  return {
    phase: control.phase,
    targetUserId: control.targetUserId,
    targetUsername: control.targetUsername,
    expiresAt: control.expiresAt || null,
    myVote: control.votes?.[userId] || null,
    canVote: control.phase === 'decision' && control.eligibleVoterIds?.includes(userId),
    eligibleCount: control.eligibleVoterIds?.length || 0,
    votes,
  };
}

function getEndVoteEligibleVoters(state) {
  ensureGameMetaState(state);
  return state.players
    .filter((p) => !isBotId(p.id) && p.connected !== false && !state.botControlled?.[p.id])
    .map((p) => p.id);
}

function buildEndVoteView(state, userId) {
  const control = state.endVoteControl;
  if (!control) return null;
  const confirmedCount = Object.values(control.votes || {}).filter((vote) => vote === 'yes').length;
  return {
    initiatedByUsername: control.initiatedByUsername,
    myVote: control.votes?.[userId] || null,
    canVote: control.eligibleVoterIds?.includes(userId) && !control.votes?.[userId],
    eligibleCount: control.eligibleVoterIds?.length || 0,
    confirmedCount,
  };
}

function buildGameView(roomId, userId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) return null;
  const state = ensureGameMetaState(ag.state);
  const view = game.getPlayerView(state, userId);
  view.players = view.players.map((p) => ({
    ...p,
    botControlled: !!state.botControlled?.[p.id],
  }));
  view.disconnectControl = buildDisconnectView(state, userId);
  view.endVoteControl = buildEndVoteView(state, userId);
  return view;
}

async function finishGameByConsensus(roomId, initiatedByUsername = 'Gracze') {
  const ag = activeGames.get(roomId);
  if (!ag?.state) throw new Error('Brak aktywnej gry');

  clearBotTimer(roomId);
  clearDisconnectTimer(roomId);
  activeGames.delete(roomId);
  await db.rooms.setState(roomId, 'lobby', null);
  io.to(`room:${roomId}`).emit('game:reset');
  io.emit('rooms:updated');
  await emitSystemRoomMessage(roomId, `🛑 Gra została zakończona na zgodny wniosek graczy. Inicjator: ${initiatedByUsername}.`);
}

async function requestEndGameVote(roomId, userId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) throw new Error('Brak aktywnej gry');
  const state = ensureGameMetaState(ag.state);
  if (state.phase === 'end') throw new Error('Gra już się zakończyła');
  if (isDisconnectPauseActive(state)) throw new Error('Nie można kończyć gry podczas obsługi rozłączenia gracza');
  if (state.endVoteControl) throw new Error('Głosowanie o zakończenie gry już trwa');

  const player = state.players.find((p) => p.id === userId);
  if (!player || isBotId(player.id) || player.connected === false || state.botControlled?.[userId]) {
    throw new Error('Nie możesz rozpocząć głosowania o zakończenie gry');
  }

  const eligibleVoterIds = getEndVoteEligibleVoters(state);
  if (!eligibleVoterIds.includes(userId)) throw new Error('Nie możesz rozpocząć tego głosowania');
  if (eligibleVoterIds.length <= 1) {
    await finishGameByConsensus(roomId, player.username);
    return;
  }

  state.endVoteControl = {
    initiatedByUserId: userId,
    initiatedByUsername: player.username,
    eligibleVoterIds,
    votes: { [userId]: 'yes' },
  };
  ag.state = state;
  await persistActiveGameState(roomId);
  broadcastGameState(roomId);
  await emitSystemRoomMessage(roomId, `🛑 ${player.username} proponuje zakończenie gry. Potrzebna jest zgoda wszystkich ludzkich graczy.`);
}

async function reconcileEndVoteControl(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) return false;
  const state = ensureGameMetaState(ag.state);
  const control = state.endVoteControl;
  if (!control) return false;

  const eligibleVoterIds = getEndVoteEligibleVoters(state);
  const votes = Object.fromEntries(
    Object.entries(control.votes || {}).filter(([userId, vote]) => eligibleVoterIds.includes(userId) && vote === 'yes')
  );

  state.endVoteControl = {
    ...control,
    eligibleVoterIds,
    votes,
  };
  ag.state = state;

  if (eligibleVoterIds.length === 0) {
    state.endVoteControl = null;
    await persistActiveGameState(roomId);
    broadcastGameState(roomId);
    return true;
  }

  const confirmedCount = Object.keys(votes).length;
  if (confirmedCount >= eligibleVoterIds.length) {
    await finishGameByConsensus(roomId, control.initiatedByUsername);
    return true;
  }

  await persistActiveGameState(roomId);
  broadcastGameState(roomId);
  return false;
}

async function respondEndGameVote(roomId, userId, accept) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) throw new Error('Brak aktywnej gry');
  const state = ensureGameMetaState(ag.state);
  const control = state.endVoteControl;
  if (!control) throw new Error('Brak aktywnego głosowania o zakończenie gry');
  if (!control.eligibleVoterIds.includes(userId)) throw new Error('Nie możesz głosować w tej decyzji');
  if (control.votes?.[userId]) throw new Error('Już odpowiedziałeś');

  const player = state.players.find((p) => p.id === userId);
  if (!player) throw new Error('Nie jesteś graczem tej partii');

  if (!accept) {
    state.endVoteControl = null;
    ag.state = state;
    await persistActiveGameState(roomId);
    broadcastGameState(roomId);
    await emitSystemRoomMessage(roomId, `▶️ ${player.username} odrzucił zakończenie gry. Partia trwa dalej.`);
    if (shouldBotsPlay(roomId)) scheduleBots(roomId, 700);
    return;
  }

  control.votes = { ...(control.votes || {}), [userId]: 'yes' };
  state.endVoteControl = control;
  ag.state = state;

  const confirmedCount = Object.values(control.votes).filter((vote) => vote === 'yes').length;
  if (confirmedCount >= control.eligibleVoterIds.length) {
    await finishGameByConsensus(roomId, control.initiatedByUsername);
    return;
  }

  await persistActiveGameState(roomId);
  broadcastGameState(roomId);
  await emitSystemRoomMessage(roomId, `✅ ${player.username} potwierdził zakończenie gry (${confirmedCount}/${control.eligibleVoterIds.length}).`);
}

async function submitLegislativeClaim(roomId, userId, sessionId, summary, skipped = false) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) throw new Error('Brak aktywnej gry');

  const player = ag.state.players.find((p) => p.id === userId);
  if (!player) throw new Error('Nie jesteś graczem tej partii');

  const result = game.submitClaim(ag.state, userId, sessionId, summary, skipped);
  ag.state = result.state;
  ensureGameMetaState(ag.state);

  await persistActiveGameState(roomId);
  broadcastGameState(roomId);

  const roleLabel = result.claim.role === 'president' ? 'Prezydent' : 'Kanclerz';
  const text = result.claim.skipped
    ? `nie składa deklaracji jako ${roleLabel}.`
    : `deklaruje jako ${roleLabel}: ${formatClaimSummary(result.claim.summary)}`;
  await emitPlayerRoomMessage(roomId, userId, result.claim.username, text);
}

async function resolveReadyBotClaims(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state || ag.state.phase === 'end') return;

  const automated = getAutomatedPlayerIds(roomId);
  const sessions = Array.isArray(ag.state.claimSessions) ? ag.state.claimSessions : [];
  const pending = [];

  for (const session of sessions) {
    if (session.presidentReady && !session.presidentSubmitted && automated.has(session.presidentId)) {
      pending.push({ sessionId: session.sessionId, userId: session.presidentId, summary: session.presidentActual || 'LLF' });
    }
    if (session.chancellorReady && !session.chancellorSubmitted && automated.has(session.chancellorId)) {
      pending.push({ sessionId: session.sessionId, userId: session.chancellorId, summary: session.chancellorActual || 'LF' });
    }
  }

  for (const item of pending) {
    await submitLegislativeClaim(roomId, item.userId, item.sessionId, item.summary, false);
  }
}

async function beginDisconnectWait(roomId, targetUserId, durationMs, logMessage = null) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) return;
  const state = ensureGameMetaState(ag.state);
  const player = state.players.find(p => p.id === targetUserId);
  if (!player || player.dead || player.connected !== false || state.botControlled[targetUserId]) return;

  clearDisconnectTimer(roomId);
  state.disconnectControl = {
    phase: 'waiting',
    targetUserId,
    targetUsername: player.username,
    expiresAt: Date.now() + durationMs,
    votes: {},
    eligibleVoterIds: [],
  };
  if (logMessage) ag.state = game.addLog(state, logMessage);
  await persistActiveGameState(roomId);
  broadcastGameState(roomId);
  roomDisconnectTimers.set(roomId, setTimeout(() => {
    openDisconnectDecision(roomId, targetUserId).catch((e) => console.error('disconnect decision error', e));
  }, durationMs));
}

async function ensureDisconnectWorkflow(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state || ag.state.phase === 'end') return;
  ensureGameMetaState(ag.state);
  if (ag.state.disconnectControl) return;
  const target = getDisconnectedHumanCandidate(ag.state);
  if (!target) return;
  await beginDisconnectWait(roomId, target.id, DISCONNECT_GRACE_MS,
    `⏳ ${target.username} utracił łączność. Gra wstrzymana na 90 sekund.`);
  await emitSystemRoomMessage(roomId, `⏳ ${target.username} utracił łączność. Czekamy 90 sekund na powrót.`);
}

async function resolveDisconnectChoice(roomId, choice, context = {}) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) return;
  const state = ensureGameMetaState(ag.state);
  const control = state.disconnectControl;
  const targetUserId = context.targetUserId || control?.targetUserId;
  const targetUsername = context.targetUsername || control?.targetUsername || 'Gracz';

  clearDisconnectTimer(roomId);

  if (choice === 'wait') {
    state.disconnectControl = null;
    await beginDisconnectWait(roomId, targetUserId, DISCONNECT_WAIT_EXTENSION_MS,
      `⌛ Gracze postanowili jeszcze poczekać na ${targetUsername}.`);
    await emitSystemRoomMessage(roomId, `⌛ Gracze postanowili jeszcze 60 sekund poczekać na ${targetUsername}.`);
    return;
  }

  if (choice === 'takeover') {
    state.botControlled[targetUserId] = true;
    state.disconnectControl = null;
    ag.state = game.addLog(state, `🤖 Bot przejmuje turę gracza ${targetUsername}.`);
    await persistActiveGameState(roomId);
    broadcastGameState(roomId);
    await emitSystemRoomMessage(roomId, `🤖 Bot przejmuje kontrolę nad graczem ${targetUsername}.`);
    if (shouldBotsPlay(roomId)) scheduleBots(roomId, 700);
    return;
  }

  if (choice === 'end') {
    state.disconnectControl = null;
    await emitSystemRoomMessage(roomId, `🛑 Gra została zakończona z powodu braku powrotu gracza ${targetUsername}.`);
    activeGames.delete(roomId);
    clearBotTimer(roomId);
    clearDisconnectTimer(roomId);
    await db.rooms.setState(roomId, 'lobby', null);
    io.to(`room:${roomId}`).emit('game:reset');
    io.emit('rooms:updated');
  }
}

async function maybeResolveDisconnectVote(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state?.disconnectControl || ag.state.disconnectControl.phase !== 'decision') return;
  const control = ag.state.disconnectControl;
  const summary = summarizeDisconnectVotes(control);
  const majority = Math.floor((control.eligibleVoterIds?.length || 0) / 2) + 1;
  for (const choice of ['takeover', 'end', 'wait']) {
    if (summary[choice] >= majority) {
      await resolveDisconnectChoice(roomId, choice);
      return;
    }
  }

  const voteCount = Object.keys(control.votes || {}).length;
  const eligibleCount = control.eligibleVoterIds?.length || 0;
  if (voteCount < eligibleCount) return;

  const ranked = Object.entries(summary).sort((a, b) => b[1] - a[1]);
  const [bestChoice, bestCount] = ranked[0];
  const secondCount = ranked[1]?.[1] || 0;
  await resolveDisconnectChoice(roomId, bestCount > secondCount ? bestChoice : 'wait');
}

async function openDisconnectDecision(roomId, targetUserId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state) return;
  const state = ensureGameMetaState(ag.state);
  const player = state.players.find(p => p.id === targetUserId);
  if (!player || player.dead || player.connected !== false || state.botControlled[targetUserId]) {
    state.disconnectControl = null;
    await persistActiveGameState(roomId);
    broadcastGameState(roomId);
    return;
  }

  const eligibleVoterIds = getDisconnectEligibleVoters(state, targetUserId);
  if (!eligibleVoterIds.length) {
    await resolveDisconnectChoice(roomId, 'end', { targetUserId, targetUsername: player.username });
    return;
  }

  state.disconnectControl = {
    phase: 'decision',
    targetUserId,
    targetUsername: player.username,
    expiresAt: null,
    votes: {},
    eligibleVoterIds,
  };
  ag.state = game.addLog(state, `🗳️ ${player.username} nie wrócił na czas. Pozostali gracze decydują co dalej.`);
  await persistActiveGameState(roomId);
  broadcastGameState(roomId);
  await emitSystemRoomMessage(roomId, `🗳️ ${player.username} nie wrócił na czas. Pozostali żywi gracze głosują: czekać, bot albo zakończyć grę.`);
}

async function castDisconnectVote(roomId, userId, choice) {
  if (!DISCONNECT_CHOICES.has(choice)) throw new Error('Nieprawidłowa decyzja');
  const ag = activeGames.get(roomId);
  if (!ag?.state) throw new Error('Brak aktywnej gry');
  const state = ensureGameMetaState(ag.state);
  const control = state.disconnectControl;
  if (!control || control.phase !== 'decision') throw new Error('Brak aktywnej decyzji o rozłączeniu');
  if (!control.eligibleVoterIds.includes(userId)) throw new Error('Nie możesz głosować w tej decyzji');
  if (control.votes?.[userId]) throw new Error('Już zagłosowałeś');

  control.votes = { ...(control.votes || {}), [userId]: choice };
  state.disconnectControl = control;
  await persistActiveGameState(roomId);
  broadcastGameState(roomId);
  await maybeResolveDisconnectVote(roomId);
}

function broadcastGameState(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag) return;
  for (const player of ag.state.players) {
    emitToPlayerSockets(ag, player.id, 'game:state', buildGameView(roomId, player.id));
  }
  if (shouldBotsPlay(roomId)) scheduleBots(roomId, 500);
}

function getEligibleBotChancellors(state) {
  const aliveCount = state.players.filter(p => !p.dead).length;
  return state.players
    .map((p, i) => ({ ...p, i }))
    .filter((p) => {
      if (p.dead || p.i === state.presidentIdx) return false;
      if (aliveCount > 5) {
        if (p.i === state.prevPresidentIdx || p.i === state.prevChancellorIdx) return false;
      } else if (p.i === state.prevChancellorIdx) {
        return false;
      }
      return true;
    });
}

function randomItem(items) {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function chooseBotVote(state, botId) {
  const bot = state.players.find(p => p.id === botId);
  if (!bot) return 'Nein';
  if (state.players[state.presidentIdx]?.id === botId || state.players[state.chancellorIdx]?.id === botId) return 'Ja';

  const government = [state.players[state.presidentIdx], state.players[state.chancellorIdx]].filter(Boolean);
  const trusted = government.some(p => p.id === botId);
  if (trusted) return 'Ja';

  return Math.random() < 0.62 ? 'Ja' : 'Nein';
}

function chooseBotDiscard(cards, role, discardForLiberal) {
  if (!cards?.length) return 0;
  const preferred = discardForLiberal
    ? cards.findIndex(c => c === 'F')
    : cards.findIndex(c => c === 'L');
  return preferred >= 0 ? preferred : 0;
}

function shouldBotProposeVeto(state, chancellor) {
  if (!state?.canVeto && state?.fas < 5) return false;
  if (!Array.isArray(state.hand) || state.hand.length !== 2 || !chancellor) return false;

  const liberalCount = state.hand.filter(c => c === 'L').length;
  const fascistCount = state.hand.filter(c => c === 'F').length;

  if (chancellor.role === 'Liberal') return fascistCount === 2;
  if (chancellor.role === 'Hitler') return liberalCount === 2 && Math.random() < 0.35;
  return liberalCount === 2 && Math.random() < 0.6;
}

function chooseBotExecutiveTarget(state, mode) {
  const candidates = state.players
    .map((p, i) => ({ ...p, i }))
    .filter(p => !p.dead && p.i !== state.presidentIdx);

  if (mode === 'investigate') {
    return randomItem(candidates.filter(p => !state.investigated[p.id]))?.i ?? null;
  }

  return randomItem(candidates)?.i ?? null;
}

async function processGameAction(roomId, userId, action, payload = {}) {
  const ag = activeGames.get(roomId);
  if (!ag) throw new Error('Brak aktywnej gry');
  ensureGameMetaState(ag.state);
  if (ag.state.phase === 'end') throw new Error('Gra się skończyła');
  if (isGamePauseActive(ag.state)) throw new Error('Gra jest tymczasowo wstrzymana');

  let newState;
  let extra = {};

  switch (action) {
    case 'nominate':        newState = game.nominate(ag.state, userId, payload.targetIdx); break;
    case 'vote':            newState = game.vote(ag.state, userId, payload.choice); break;
    case 'presidentDiscard':newState = game.presidentDiscard(ag.state, userId, payload.cardIndex); break;
    case 'chancellorDiscard':newState = game.chancellorDiscard(ag.state, userId, payload.cardIndex); break;
    case 'proposeVeto':     newState = game.proposeVeto(ag.state, userId); break;
    case 'respondVeto':     newState = game.respondVeto(ag.state, userId, payload.accept); break;
    case 'peekPolicies': {
      const r = game.executePeek(ag.state, userId);
      newState = r.s; extra.peek = r.peek;
      break;
    }
    case 'finishPeek':      newState = game.finishPeekAction(ag.state, userId); break;
    case 'investigate': {
      const r = game.executeInvestigate(ag.state, userId, payload.targetIdx);
      newState = r.s; extra.party = r.party; extra.targetUsername = r.targetUsername;
      break;
    }
    case 'specialElection': newState = game.executeSpecialElection(ag.state, userId, payload.targetIdx); break;
    case 'execute':         newState = game.executeKill(ag.state, userId, payload.targetIdx); break;
    default: throw new Error(`Nieznana akcja: ${action}`);
  }

  ag.state = newState;
  ensureGameMetaState(ag.state);
  const isFinished = newState.phase === 'end';
  const newRoomState = isFinished ? 'lobby' : 'playing';
  await db.rooms.setState(roomId, newRoomState, isFinished ? null : JSON.stringify(newState));

  if (extra.peek) {
    const presPlayer = newState.players[newState.presidentIdx]
      || ag.state.players.find(p => p.id === userId);
    emitToPlayerSockets(ag, presPlayer?.id || userId, 'game:peek', extra.peek);
  }

  if (extra.party) {
    emitToPlayerSockets(ag, userId, 'game:investigateResult', {
      party: extra.party, username: extra.targetUsername,
    });
  }

  broadcastGameState(roomId);
  await resolveReadyBotClaims(roomId);

  if (newState.winner) {
    io.emit('rooms:updated');
    await db.messages.insert(roomId, SYSTEM_USER_ID, 'System',
      `🏁 Koniec gry: ${newState.winner === 'Liberal' ? 'Liberałowie wygrywają!' : 'Faszyści wygrywają!'} (${newState.winReason})`,
      'system');
    io.to(`room:${roomId}`).emit('chat:message', {
      username: 'System',
      message: `🏁 ${newState.winner === 'Liberal' ? '🕊️ Liberałowie wygrywają!' : '💀 Faszyści wygrywają!'} ${newState.winReason}`,
      createdAt: new Date().toISOString(), type: 'system', roomId,
    });
  }

  return { ok: true };
}

function scheduleBots(roomId, delay = 600) {
  if (!shouldBotsPlay(roomId)) return;
  clearBotTimer(roomId);
  roomBotTimers.set(roomId, setTimeout(() => {
    runBotTurn(roomId).catch((e) => console.error('bot turn error', e));
  }, delay));
}

async function runBotTurn(roomId) {
  clearBotTimer(roomId);
  if (!shouldBotsPlay(roomId)) return;

  let state = activeGames.get(roomId)?.state;
  if (!state) return;
  ensureGameMetaState(state);
  const botIds = getAutomatedPlayerIds(roomId);

  switch (state.phase) {
    case 'nominate': {
      const president = state.players[state.presidentIdx];
      if (president && botIds.has(president.id)) {
        const target = randomItem(getEligibleBotChancellors(state));
        if (target) await processGameAction(roomId, president.id, 'nominate', { targetIdx: target.i });
      }
      break;
    }
    case 'vote': {
      for (;;) {
        state = activeGames.get(roomId)?.state;
        if (!state || state.phase !== 'vote') break;
        const pendingBot = state.players.find(p => !p.dead && botIds.has(p.id) && state.votes[p.id] === undefined);
        if (!pendingBot) break;
        await processGameAction(roomId, pendingBot.id, 'vote', { choice: chooseBotVote(state, pendingBot.id) });
      }
      break;
    }
    case 'presidentDiscard': {
      const president = state.players[state.presidentIdx];
      if (president && botIds.has(president.id)) {
        const discardIdx = chooseBotDiscard(state.presidentHand, president.role, president.role === 'Liberal');
        await processGameAction(roomId, president.id, 'presidentDiscard', { cardIndex: discardIdx });
      }
      break;
    }
    case 'chancellorDiscard': {
      const chancellor = state.players[state.chancellorIdx];
      if (chancellor && botIds.has(chancellor.id)) {
        if (state.fas >= 5 && shouldBotProposeVeto(state, chancellor)) {
          await processGameAction(roomId, chancellor.id, 'proposeVeto', {});
          break;
        }
        const discardIdx = chooseBotDiscard(state.hand, chancellor.role, chancellor.role === 'Liberal');
        await processGameAction(roomId, chancellor.id, 'chancellorDiscard', { cardIndex: discardIdx });
      }
      break;
    }
    case 'veto': {
      const president = state.players[state.presidentIdx];
      if (president && botIds.has(president.id)) {
        await processGameAction(roomId, president.id, 'respondVeto', { accept: Math.random() < 0.35 });
      }
      break;
    }
    case 'executive': {
      const president = state.players[state.presidentIdx];
      if (president && botIds.has(president.id)) {
        if (state.execPower === 'peekPolicies') {
          await processGameAction(roomId, president.id, 'peekPolicies', {});
        } else if (state.execPower === 'investigate') {
          const targetIdx = chooseBotExecutiveTarget(state, 'investigate');
          if (targetIdx != null) await processGameAction(roomId, president.id, 'investigate', { targetIdx });
        } else if (state.execPower === 'specialElection') {
          const targetIdx = chooseBotExecutiveTarget(state, 'specialElection');
          if (targetIdx != null) await processGameAction(roomId, president.id, 'specialElection', { targetIdx });
        } else if (state.execPower === 'execute') {
          const targetIdx = chooseBotExecutiveTarget(state, 'execute');
          if (targetIdx != null) await processGameAction(roomId, president.id, 'execute', { targetIdx });
        }
      }
      break;
    }
    case 'executiveDone': {
      const president = state.players[state.presidentIdx];
      if (president && botIds.has(president.id)) {
        await processGameAction(roomId, president.id, 'finishPeek', {});
      }
      break;
    }
    default:
      break;
  }

  if (shouldBotsPlay(roomId)) scheduleBots(roomId, 500);
}

async function restoreActiveGames() {
  let restored = 0;
  let resetToLobby = 0;

  const rooms = await db.rooms.findAll();
  for (const room of rooms) {
    if (room.state === 'finished') {
      await db.rooms.setState(room._id, 'lobby', null);
      resetToLobby++;
      continue;
    }

    const playersInRoom = await db.roomPlayers.getPlayersInRoom(room._id);
    for (const player of playersInRoom) {
      if (isBotId(player.userId)) registerBot(room._id, player.userId);
    }

    if (room.state !== 'playing') continue;

    if (!room.gameData) {
      await db.rooms.setState(room._id, 'lobby', null);
      resetToLobby++;
      continue;
    }

    try {
      const state = JSON.parse(room.gameData);
      if (!state || !Array.isArray(state.players)) throw new Error('Invalid state');
      ensureGameMetaState(state);
      state.disconnectControl = null;
      state.players = state.players.map(p => ({ ...p, connected: false }));
      for (const player of state.players) {
        if (isBotId(player.id)) registerBot(room._id, player.id);
      }
      activeGames.set(room._id, { state, playerSockets: {} });
      restored++;
    } catch (e) {
      await db.rooms.setState(room._id, 'lobby', null);
      resetToLobby++;
    }
  }

  return { restored, resetToLobby };
}

async function leaveRoom(socket) {
  const su = socketUsers.get(socket.id);
  if (!su?.roomId) return;
  const roomId = su.roomId;
  const room = await db.rooms.findById(roomId);
  if (room && room.state === 'lobby') {
    await db.roomPlayers.remove(roomId, su.userId);
    await emitRoomPlayers(roomId);
    if (!(await maybeCompleteRoomStartConfirmation(roomId))) emitRoomStartConfirmation(roomId);
    su.roomId = null;
    socketUsers.set(socket.id, su);
  }
  socket.leave(`room:${roomId}`);
}

async function forceLogoutUser(userId) {
  const socketIds = [...socketUsers.entries()]
    .filter(([, su]) => su.userId === userId)
    .map(([socketId]) => socketId);

  for (const [roomId, ag] of activeGames.entries()) {
    if (!ag?.state?.players) continue;
    ensureGameMetaState(ag.state);
    const player = ag.state.players.find((p) => p.id === userId);
    if (!player) continue;

    for (const socketId of socketIds) removePlayerSocket(ag, userId, socketId);

    if (getPlayerSocketIds(ag, userId).length === 0 && player.connected !== false) {
      player.connected = false;
      const endVoteFinished = await reconcileEndVoteControl(roomId);
      if (!endVoteFinished) {
        await ensureDisconnectWorkflow(roomId);
        await persistActiveGameState(roomId);
        broadcastGameState(roomId);
      }
    }
  }

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) socket.disconnect(true);
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🎮 Secret Hitler Online → http://localhost:${PORT}`);
  console.log(`👤 Admin: admin / admin123`);
  try {
    const stats = await restoreActiveGames();
    console.log(`♻️ Przywrócono gier: ${stats.restored}, zresetowano do lobby: ${stats.resetToLobby}`);
  } catch (e) {
    console.error('restoreActiveGames error', e);
  }
  console.log(`📁 Dane: data/\n`);
});
