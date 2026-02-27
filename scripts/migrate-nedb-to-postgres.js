const path = require('path');
const { createNedbStore } = require('../server/db-nedb');
const { createPostgresStore } = require('../server/db-postgres');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Brak DATABASE_URL. Ustaw połączenie do Postgresa przed migracją.');
  }

  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const source = createNedbStore({ dataDir });
  const target = await createPostgresStore({ connectionString: process.env.DATABASE_URL });

  const users = await source.users.findAll();
  const rooms = await source.rooms.findAll();
  const messagesByRoom = new Map();

  await target.query('BEGIN');
  try {
    await target.query('TRUNCATE TABLE messages, room_players, rooms, users');

    for (const user of users) {
      await target.query(`
        INSERT INTO users (id, username, username_lower, password_hash, is_admin, is_active, created_at, last_seen)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [user._id, user.username, user.username_lower, user.passwordHash, !!user.isAdmin, !!user.isActive, user.createdAt, user.lastSeen]);
    }

    for (const room of rooms) {
      await target.query(`
        INSERT INTO rooms (id, name, owner_id, owner_name, state, game_data, created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
      `, [room._id, room.name, room.ownerId, room.ownerName, room.state, room.gameData || null, room.createdAt]);

      const players = await source.roomPlayers.getPlayersInRoom(room._id);
      for (const player of players) {
        await target.query(`
          INSERT INTO room_players (room_id, user_id, username, joined_at)
          VALUES ($1,$2,$3,$4)
        `, [player.roomId, player.userId, player.username, player.joinedAt]);
      }

      const roomMessages = await source.messages.getRoom(room._id);
      messagesByRoom.set(room._id, roomMessages);
    }

    const globalMessages = await source.messages.getGlobal();
    for (const roomMessages of messagesByRoom.values()) {
      for (const message of roomMessages) {
        await target.query(`
          INSERT INTO messages (room_id, user_id, username, message, type, created_at)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [message.roomId, message.userId, message.username, message.message, message.type, message.createdAt]);
      }
    }

    for (const message of globalMessages) {
      await target.query(`
        INSERT INTO messages (room_id, user_id, username, message, type, created_at)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [message.roomId, message.userId, message.username, message.message, message.type, message.createdAt]);
    }

    await target.query('COMMIT');
    await target.ensureDefaultAdmin();
    console.log(`Migracja zakończona. Users=${users.length}, Rooms=${rooms.length}, GlobalMessages=${globalMessages.length}`);
  } catch (error) {
    await target.query('ROLLBACK');
    throw error;
  } finally {
    await target.pool.end();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
