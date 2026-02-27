// server/db.js — NeDB (pure JavaScript, działa na Windows bez Visual Studio)
const Datastore = require('@seald-io/nedb');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── KOLEKCJE ──────────────────────────────────────────────────────────────────
const users      = new Datastore({ filename: path.join(DATA_DIR, 'users.db'),       autoload: true });
const rooms      = new Datastore({ filename: path.join(DATA_DIR, 'rooms.db'),       autoload: true });
const roomPlayers= new Datastore({ filename: path.join(DATA_DIR, 'room_players.db'),autoload: true });
const messages   = new Datastore({ filename: path.join(DATA_DIR, 'messages.db'),    autoload: true });

// Indeksy
users.ensureIndex({ fieldName: 'username_lower' });
roomPlayers.ensureIndex({ fieldName: 'roomId' });

// ── WRAPPER z async/await ─────────────────────────────────────────────────────
const db = {
  users: {
    findByUsername: (username) => users.findOneAsync({ username_lower: username.toLowerCase() }),
    findById:       (id)       => users.findOneAsync({ _id: id }),
    findAll:        ()         => users.findAsync({}).then(r => r.sort((a,b) => a.createdAt > b.createdAt ? -1 : 1)),
    create:  async (username, passwordHash) => {
      return users.insertAsync({
        username,
        username_lower: username.toLowerCase(),
        passwordHash,
        isAdmin: false,
        isActive: false,
        createdAt: new Date().toISOString(),
        lastSeen: null,
      });
    },
    setActive:   (id, v) => users.updateAsync({ _id: id }, { $set: { isActive: v } }, {}),
    setAdmin:    (id, v) => users.updateAsync({ _id: id }, { $set: { isAdmin: v } }, {}),
    setLastSeen: (id)    => users.updateAsync({ _id: id }, { $set: { lastSeen: new Date().toISOString() } }, {}),
    delete:      (id)    => users.removeAsync({ _id: id }, {}),
  },

  rooms: {
    findById:  (id) => rooms.findOneAsync({ _id: id }),
    findAll:   ()   => rooms.findAsync({}).then(r => r.sort((a,b) => a.createdAt > b.createdAt ? -1 : 1)),
    create: (id, name, ownerId, ownerName) => rooms.insertAsync({
      _id: id, name, ownerId, ownerName,
      state: 'lobby',
      gameData: null,
      createdAt: new Date().toISOString(),
    }),
    setState:  (id, state, gameData) => rooms.updateAsync({ _id: id }, { $set: { state, gameData } }, {}),
    delete:    (id) => rooms.removeAsync({ _id: id }, {}),
  },

  roomPlayers: {
    getPlayersInRoom: async (roomId) => {
      const rps = await roomPlayers.findAsync({ roomId });
      rps.sort((a,b) => a.joinedAt > b.joinedAt ? 1 : -1);
      return rps;
    },
    getRoomsForUser: async (userId) => {
      const rps = await roomPlayers.findAsync({ userId });
      rps.sort((a,b) => a.joinedAt > b.joinedAt ? -1 : 1);
      return rps;
    },
    isInRoom:  (roomId, userId) => roomPlayers.findOneAsync({ roomId, userId }),
    add:  async (roomId, userId, username) => {
      const exists = await roomPlayers.findOneAsync({ roomId, userId });
      if (!exists) await roomPlayers.insertAsync({ roomId, userId, username, joinedAt: new Date().toISOString() });
    },
    remove:       (roomId, userId) => roomPlayers.removeAsync({ roomId, userId }, {}),
    removeAll:    (roomId)         => roomPlayers.removeAsync({ roomId }, { multi: true }),
    countInRoom:  (roomId)         => roomPlayers.countAsync({ roomId }),
  },

  messages: {
    insert: (roomId, userId, username, message, type = 'chat') =>
      messages.insertAsync({ roomId: roomId || null, userId, username, message, type, createdAt: new Date().toISOString() }),
    getRoom:   (roomId) => messages.findAsync({ roomId }).then(r => r.sort((a,b) => a.createdAt > b.createdAt ? -1 : 1).slice(0,100).reverse()),
    getGlobal: ()       => messages.findAsync({ roomId: null }).then(r => r.sort((a,b) => a.createdAt > b.createdAt ? -1 : 1).slice(0,100).reverse()),
  },
};

// ── BOOTSTRAP: domyślny admin ─────────────────────────────────────────────────
(async () => {
  const admin = await users.findOneAsync({ isAdmin: true });
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await users.insertAsync({
      username: 'admin',
      username_lower: 'admin',
      passwordHash: hash,
      isAdmin: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      lastSeen: null,
    });
    console.log('✅ Domyślny admin: admin / admin123');
  }
})();

module.exports = { db };
