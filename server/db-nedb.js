const Datastore = require('@seald-io/nedb');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const logger = require('./logger');

function createNedbStore({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });

  const users = new Datastore({ filename: path.join(dataDir, 'users.db'), autoload: true });
  const rooms = new Datastore({ filename: path.join(dataDir, 'rooms.db'), autoload: true });
  const roomPlayers = new Datastore({ filename: path.join(dataDir, 'room_players.db'), autoload: true });
  const messages = new Datastore({ filename: path.join(dataDir, 'messages.db'), autoload: true });

  users.ensureIndex({ fieldName: 'username_lower' });
  roomPlayers.ensureIndex({ fieldName: 'roomId' });

  const store = {
    provider: 'nedb',
    users: {
      findByUsername: (username) => users.findOneAsync({ username_lower: username.toLowerCase() }),
      findById: (id) => users.findOneAsync({ _id: id }),
      findAll: () => users.findAsync({}).then(r => r.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))),
      create: async (username, passwordHash, options = {}) => {
        const doc = {
          username,
          username_lower: username.toLowerCase(),
          passwordHash,
          isAdmin: !!options.isAdmin,
          isActive: options.isActive ?? false,
          createdAt: options.createdAt || new Date().toISOString(),
          lastSeen: options.lastSeen ?? null,
        };
        if (options.id) doc._id = options.id;
        return users.insertAsync(doc);
      },
      setActive: (id, v) => users.updateAsync({ _id: id }, { $set: { isActive: v } }, {}),
      setAdmin: (id, v) => users.updateAsync({ _id: id }, { $set: { isAdmin: v } }, {}),
      setLastSeen: (id) => users.updateAsync({ _id: id }, { $set: { lastSeen: new Date().toISOString() } }, {}),
      setPasswordHash: (id, passwordHash) => users.updateAsync({ _id: id }, { $set: { passwordHash } }, {}),
      delete: (id) => users.removeAsync({ _id: id }, {}),
    },

    rooms: {
      findById: (id) => rooms.findOneAsync({ _id: id }),
      findAll: () => rooms.findAsync({}).then(r => r.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))),
      create: (id, name, ownerId, ownerName, options = {}) => rooms.insertAsync({
        _id: id,
        name,
        ownerId,
        ownerName,
        state: options.state || 'lobby',
        gameData: options.gameData ?? null,
        createdAt: options.createdAt || new Date().toISOString(),
      }),
      setState: (id, state, gameData) => rooms.updateAsync({ _id: id }, { $set: { state, gameData } }, {}),
      delete: (id) => rooms.removeAsync({ _id: id }, {}),
    },

    roomPlayers: {
      getPlayersInRoom: async (roomId) => {
        const rps = await roomPlayers.findAsync({ roomId });
        rps.sort((a, b) => (a.joinedAt > b.joinedAt ? 1 : -1));
        return rps;
      },
      getRoomsForUser: async (userId) => {
        const rps = await roomPlayers.findAsync({ userId });
        rps.sort((a, b) => (a.joinedAt > b.joinedAt ? -1 : 1));
        return rps;
      },
      isInRoom: (roomId, userId) => roomPlayers.findOneAsync({ roomId, userId }),
      add: async (roomId, userId, username, options = {}) => {
        const exists = await roomPlayers.findOneAsync({ roomId, userId });
        if (!exists) {
          await roomPlayers.insertAsync({
            roomId,
            userId,
            username,
            joinedAt: options.joinedAt || new Date().toISOString(),
          });
        }
      },
      remove: (roomId, userId) => roomPlayers.removeAsync({ roomId, userId }, {}),
      removeAll: (roomId) => roomPlayers.removeAsync({ roomId }, { multi: true }),
      countInRoom: (roomId) => roomPlayers.countAsync({ roomId }),
    },

    messages: {
      insert: (roomId, userId, username, message, type = 'chat', options = {}) => messages.insertAsync({
        roomId: roomId || null,
        userId,
        username,
        message,
        type,
        createdAt: options.createdAt || new Date().toISOString(),
      }),
      getRoom: (roomId) => messages.findAsync({ roomId }).then(r => r.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1)).slice(0, 100).reverse()),
      getGlobal: () => messages.findAsync({ roomId: null }).then(r => r.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1)).slice(0, 100).reverse()),
    },
  };

  store.ensureDefaultAdmin = async () => {
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
      logger.warn('security.default_admin_created', {
        username: 'admin',
        message: 'Created default admin account. Change password immediately.',
      });
    }
  };

  return store;
}

module.exports = { createNedbStore };
