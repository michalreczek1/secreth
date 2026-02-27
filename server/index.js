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

// Upewnij się że folder na sesje istnieje
const SESSION_DIR = path.join(__dirname, '..', 'data', 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
// roomId → { state: GameState, playerSockets: {userId: socketId} }
const activeGames  = new Map();
// socketId → { userId, username, roomId }
const socketUsers  = new Map();
// roomId → Set(botUserId)
const roomBots     = new Map();
// roomId → timeout
const roomBotTimers = new Map();

const BOT_NAMES = [
  'Otto', 'Greta', 'Erika', 'Walter', 'Bruno',
  'Ingrid', 'Helmut', 'Lotte', 'Fritz', 'Karl',
];

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

function clearRoomBotsMeta(roomId) {
  clearBotTimer(roomId);
  roomBots.delete(roomId);
}

function hasHumanInRoom(roomId) {
  for (const su of socketUsers.values()) {
    if (su.roomId === roomId && !isBotId(su.userId)) return true;
  }
  return false;
}

function getGameBotIds(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag?.state?.players) return new Set();
  return new Set(ag.state.players.filter(p => isBotId(p.id)).map(p => p.id));
}

function shouldBotsPlay(roomId) {
  const ag = activeGames.get(roomId);
  const bots = getGameBotIds(roomId);
  return bots.size > 0 && !!ag && ag.state.phase !== 'end' && hasHumanInRoom(roomId);
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

    const user = await db.users.findByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash))
      return res.status(401).json({ error: 'Błędna nazwa lub hasło' });
    if (!user.isActive)
      return res.status(403).json({ error: 'Konto czeka na aktywację przez administratora' });

    req.session.userId   = user._id;
    req.session.username = user.username;
    req.session.isAdmin  = !!user.isAdmin;
    await db.users.setLastSeen(user._id);
    const activeRoom = await getUserActiveRoom(user._id);

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
  req.session.destroy(() => res.json({ ok: true }));
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
        socket.leave(`room:${membership.roomId}`);
      }

      const players = await db.roomPlayers.getPlayersInRoom(roomId);
      const inRoom  = players.find(p => p.userId === userId);

      if (!inRoom) {
        if (room.state === 'playing') return callback?.({ error: 'Gra już trwa — nie możesz dołączyć' });
        if (players.length >= 10)   return callback?.({ error: 'Pokój pełny (max 10)' });
        await db.roomPlayers.add(roomId, userId, username);
      }

      socket.join(`room:${roomId}`);
      const su = socketUsers.get(socket.id);
      if (su) { su.roomId = roomId; socketUsers.set(socket.id, su); }

      // Reconnect do aktywnej gry
      const ag = activeGames.get(roomId);
      if (ag) {
        const p = ag.state.players.find(p => p.id === userId);
        if (p) {
          p.connected = true;
          if (!ag.playerSockets) ag.playerSockets = {};
          ag.playerSockets[userId] = socket.id;
          socket.emit('game:state', game.getPlayerView(ag.state, userId));
        }
      }

      await emitRoomPlayers(roomId);
      if (shouldBotsPlay(roomId)) scheduleBots(roomId, 700);

      // Historia czatu pokoju
      const history = await db.messages.getRoom(roomId);
      socket.emit('chat:history', history);

      callback?.({ ok: true });
    } catch (e) {
      console.error('room:join error', e);
      callback?.({ error: 'Błąd serwera' });
    }
  });

  socket.on('room:leave', async () => { await leaveRoom(socket); });

  // ── CZAT ────────────────────────────────────────────────────────────────────
  socket.on('chat:send', async ({ message, roomId: targetRoom }) => {
    if (!(await ensureSocketUserActive())) return;
    const msg = (message || '').trim().substring(0, 500);
    if (!msg) return;
    const rid = targetRoom || null;
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
      if (room.ownerId !== userId) return callback?.({ error: 'Tylko właściciel może zacząć' });
      if (room.state === 'playing') return callback?.({ error: 'Gra już trwa' });

      const players = await db.roomPlayers.getPlayersInRoom(roomId);
      if (players.length < 5)  return callback?.({ error: `Za mało graczy (${players.length}/5)` });
      if (players.length > 10) return callback?.({ error: 'Za dużo graczy (max 10)' });

      const playerList = players.map(p => ({ id: p.userId, username: p.username }));
      const state = game.createGame(playerList);

      const ag = { state, playerSockets: {} };
      for (const [sid, su] of socketUsers.entries()) {
        if (su.roomId === roomId) ag.playerSockets[su.userId] = sid;
      }
      activeGames.set(roomId, ag);
      await db.rooms.setState(roomId, 'playing', JSON.stringify(state));

      io.to(`room:${roomId}`).emit('game:started');
      broadcastGameState(roomId);
      io.emit('rooms:updated');

      await db.messages.insert(roomId, userId, 'System',
        `🎮 Gra rozpoczęta! Grają: ${playerList.map(p => p.username).join(', ')}`, 'system');
      io.to(`room:${roomId}`).emit('chat:message', {
        username: 'System',
        message: `🎮 Gra rozpoczęta! ${players.length} graczy.`,
        createdAt: new Date().toISOString(), type: 'system', roomId,
      });

      if (shouldBotsPlay(roomId)) scheduleBots(roomId, 900);

      callback?.({ ok: true });
    } catch (e) {
      console.error('game:start error', e);
      callback?.({ error: e.message });
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

  socket.on('game:restart', async (roomId, callback) => {
    try {
      if (!(await ensureSocketUserActive(callback))) return;
      const room = await db.rooms.findById(roomId);
      if (!room) return callback?.({ error: 'Pokój nie istnieje' });
      if (room.ownerId !== userId) return callback?.({ error: 'Tylko właściciel może zrestartować' });
      activeGames.delete(roomId);
      clearBotTimer(roomId);
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
      }

      const ag = activeGames.get(su.roomId);
      if (ag) {
        const p = ag.state.players.find(p => p.id === su.userId);
        if (p) { p.connected = false; broadcastGameState(su.roomId); }
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

function broadcastGameState(roomId) {
  const ag = activeGames.get(roomId);
  if (!ag) return;
  for (const player of ag.state.players) {
    const sid = ag.playerSockets[player.id];
    if (sid) io.to(sid).emit('game:state', game.getPlayerView(ag.state, player.id));
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
  if (ag.state.phase === 'end') throw new Error('Gra się skończyła');

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
    case 'finishPeek':      newState = game.finishPeekAction(ag.state); break;
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
  const isFinished = newState.phase === 'end';
  const newRoomState = isFinished ? 'lobby' : 'playing';
  await db.rooms.setState(roomId, newRoomState, isFinished ? null : JSON.stringify(newState));

  if (extra.peek) {
    const presPlayer = newState.players[newState.presidentIdx]
      || ag.state.players.find(p => p.id === userId);
    const presSid = ag.playerSockets[presPlayer?.id || userId];
    if (presSid) io.to(presSid).emit('game:peek', extra.peek);
  }

  if (extra.party) {
    const presSid = ag.playerSockets[userId];
    if (presSid) io.to(presSid).emit('game:investigateResult', {
      party: extra.party, username: extra.targetUsername,
    });
  }

  broadcastGameState(roomId);

  if (newState.winner) {
    io.emit('rooms:updated');
    await db.messages.insert(roomId, userId, 'System',
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
  const botIds = new Set(state.players.filter(p => isBotId(p.id)).map(p => p.id));

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
  }
  socket.leave(`room:${roomId}`);
  su.roomId = null;
  socketUsers.set(socket.id, su);
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
