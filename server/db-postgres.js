const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const logger = require('./logger');

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapUser(row) {
  if (!row) return null;
  return {
    _id: row.id,
    username: row.username,
    username_lower: row.username_lower,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin,
    isActive: row.is_active,
    createdAt: toIso(row.created_at),
    lastSeen: toIso(row.last_seen),
  };
}

function mapRoom(row) {
  if (!row) return null;
  return {
    _id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    state: row.state,
    gameData: row.game_data ? JSON.stringify(row.game_data) : null,
    createdAt: toIso(row.created_at),
  };
}

function mapRoomPlayer(row) {
  if (!row) return null;
  return {
    roomId: row.room_id,
    userId: row.user_id,
    username: row.username,
    joinedAt: toIso(row.joined_at),
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    roomId: row.room_id,
    userId: row.user_id,
    username: row.username,
    message: row.message,
    type: row.type,
    createdAt: toIso(row.created_at),
  };
}

function createPool(connectionString) {
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  return new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' || isLocal ? false : { rejectUnauthorized: false },
  });
}

async function createPostgresStore({ connectionString }) {
  const pool = createPool(connectionString);

  async function query(sql, params = []) {
    return pool.query(sql, params);
  }

  async function init() {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        username_lower TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL,
        last_seen TIMESTAMPTZ NULL
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        state TEXT NOT NULL,
        game_data JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_players (
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_id);
      CREATE INDEX IF NOT EXISTS idx_room_players_user ON room_players(user_id);

      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        room_id TEXT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_global_created ON messages(created_at DESC);
    `);
  }

  const store = {
    provider: 'postgres',
    pool,
    query,
    users: {
      async findByUsername(username) {
        const { rows } = await query('SELECT * FROM users WHERE username_lower = $1 LIMIT 1', [username.toLowerCase()]);
        return mapUser(rows[0]);
      },
      async findById(id) {
        const { rows } = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
        return mapUser(rows[0]);
      },
      async findAll() {
        const { rows } = await query('SELECT * FROM users ORDER BY created_at DESC');
        return rows.map(mapUser);
      },
      async create(username, passwordHash, options = {}) {
        const id = options.id || uuidv4();
        const { rows } = await query(`
          INSERT INTO users (id, username, username_lower, password_hash, is_admin, is_active, created_at, last_seen)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `, [
          id,
          username,
          username.toLowerCase(),
          passwordHash,
          !!options.isAdmin,
          options.isActive ?? false,
          options.createdAt || new Date().toISOString(),
          options.lastSeen || null,
        ]);
        return mapUser(rows[0]);
      },
      setActive: (id, v) => query('UPDATE users SET is_active = $2 WHERE id = $1', [id, v]),
      setAdmin: (id, v) => query('UPDATE users SET is_admin = $2 WHERE id = $1', [id, v]),
      setLastSeen: (id) => query('UPDATE users SET last_seen = NOW() WHERE id = $1', [id]),
      setPasswordHash: (id, passwordHash) => query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]),
      delete: async (id) => {
        await query('DELETE FROM users WHERE id = $1', [id]);
      },
    },

    rooms: {
      async findById(id) {
        const { rows } = await query('SELECT * FROM rooms WHERE id = $1 LIMIT 1', [id]);
        return mapRoom(rows[0]);
      },
      async findAll() {
        const { rows } = await query('SELECT * FROM rooms ORDER BY created_at DESC');
        return rows.map(mapRoom);
      },
      async create(id, name, ownerId, ownerName, options = {}) {
        const { rows } = await query(`
          INSERT INTO rooms (id, name, owner_id, owner_name, state, game_data, created_at)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
          RETURNING *
        `, [
          id,
          name,
          ownerId,
          ownerName,
          options.state || 'lobby',
          options.gameData || null,
          options.createdAt || new Date().toISOString(),
        ]);
        return mapRoom(rows[0]);
      },
      async setState(id, state, gameData) {
        await query('UPDATE rooms SET state = $2, game_data = $3::jsonb WHERE id = $1', [id, state, gameData || null]);
      },
      async delete(id) {
        await query('DELETE FROM rooms WHERE id = $1', [id]);
      },
    },

    roomPlayers: {
      async getPlayersInRoom(roomId) {
        const { rows } = await query('SELECT * FROM room_players WHERE room_id = $1 ORDER BY joined_at ASC', [roomId]);
        return rows.map(mapRoomPlayer);
      },
      async getRoomsForUser(userId) {
        const { rows } = await query('SELECT * FROM room_players WHERE user_id = $1 ORDER BY joined_at DESC', [userId]);
        return rows.map(mapRoomPlayer);
      },
      async isInRoom(roomId, userId) {
        const { rows } = await query('SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2 LIMIT 1', [roomId, userId]);
        return mapRoomPlayer(rows[0]);
      },
      async add(roomId, userId, username, options = {}) {
        await query(`
          INSERT INTO room_players (room_id, user_id, username, joined_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (room_id, user_id) DO NOTHING
        `, [roomId, userId, username, options.joinedAt || new Date().toISOString()]);
      },
      remove: (roomId, userId) => query('DELETE FROM room_players WHERE room_id = $1 AND user_id = $2', [roomId, userId]),
      removeAll: (roomId) => query('DELETE FROM room_players WHERE room_id = $1', [roomId]),
      async countInRoom(roomId) {
        const { rows } = await query('SELECT COUNT(*)::int AS count FROM room_players WHERE room_id = $1', [roomId]);
        return rows[0]?.count || 0;
      },
    },

    messages: {
      async insert(roomId, userId, username, message, type = 'chat', options = {}) {
        await query(`
          INSERT INTO messages (room_id, user_id, username, message, type, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [roomId || null, userId, username, message, type, options.createdAt || new Date().toISOString()]);
      },
      async getRoom(roomId) {
        const { rows } = await query(`
          SELECT room_id, user_id, username, message, type, created_at
          FROM messages
          WHERE room_id = $1
          ORDER BY created_at DESC
          LIMIT 100
        `, [roomId]);
        return rows.reverse().map(mapMessage);
      },
      async getGlobal() {
        const { rows } = await query(`
          SELECT room_id, user_id, username, message, type, created_at
          FROM messages
          WHERE room_id IS NULL
          ORDER BY created_at DESC
          LIMIT 100
        `);
        return rows.reverse().map(mapMessage);
      },
    },
  };

  store.ensureDefaultAdmin = async () => {
    const { rows } = await query('SELECT id FROM users WHERE is_admin = TRUE LIMIT 1');
    if (!rows.length) {
      const hash = bcrypt.hashSync('admin123', 10);
      await store.users.create('admin', hash, { isAdmin: true, isActive: true });
      logger.warn('security.default_admin_created', {
        username: 'admin',
        message: 'Created default admin account. Change password immediately.',
      });
    }
  };

  await init();
  return store;
}

module.exports = { createPostgresStore };
