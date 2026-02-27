const path = require('path');
const { createNedbStore } = require('./db-nedb');
const { createPostgresStore } = require('./db-postgres');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

let activeStorePromise = null;

async function getStore() {
  if (!activeStorePromise) {
    activeStorePromise = (async () => {
      if (process.env.DATABASE_URL) {
        const pgStore = await createPostgresStore({ connectionString: process.env.DATABASE_URL });
        await pgStore.ensureDefaultAdmin();
        return pgStore;
      }

      const nedbStore = createNedbStore({ dataDir: DATA_DIR });
      await nedbStore.ensureDefaultAdmin();
      return nedbStore;
    })();
  }
  return activeStorePromise;
}

function wrapSection(sectionName) {
  return new Proxy({}, {
    get(_target, prop) {
      return async (...args) => {
        const store = await getStore();
        const section = store[sectionName];
        const fn = section[prop];
        if (typeof fn !== 'function') throw new Error(`Unknown db method: ${sectionName}.${String(prop)}`);
        return fn(...args);
      };
    },
  });
}

const db = {
  provider: async () => (await getStore()).provider,
  users: wrapSection('users'),
  rooms: wrapSection('rooms'),
  roomPlayers: wrapSection('roomPlayers'),
  messages: wrapSection('messages'),
  raw: getStore,
};

module.exports = { db, DATA_DIR, getStore };
