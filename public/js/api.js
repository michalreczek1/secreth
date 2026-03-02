// public/js/api.js — REST API helper
const API = {
  async parseResponse(r) {
    const text = await r.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    if (!r.ok && !data.error) data.error = `HTTP ${r.status}`;
    return data;
  },

  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), credentials: 'include',
    });
    return API.parseResponse(r);
  },
  async get(url) {
    const r = await fetch(url, { credentials: 'include' });
    return API.parseResponse(r);
  },
  async delete(url) {
    const r = await fetch(url, { method: 'DELETE', credentials: 'include' });
    return API.parseResponse(r);
  },

  register: (username, password) => API.post('/api/register', { username, password }),
  login: (username, password) => API.post('/api/login', { username, password }),
  logout: () => API.post('/api/logout', {}),
  changePassword: (currentPassword, newPassword) => API.post('/api/account/change-password', { currentPassword, newPassword }),
  me: () => API.get('/api/me'),
  getRooms: () => API.get('/api/rooms'),
  createRoom: (name) => API.post('/api/rooms', { name }),
  deleteRoom: (id) => API.delete(`/api/rooms/${id}`),
  setRoomBotDifficulty: (id, difficulty) => API.post(`/api/rooms/${id}/bot-difficulty`, { difficulty }),
  addRoomBots: (id, count = 1) => API.post(`/api/rooms/${id}/bots`, { count }),
  fillRoomBots: (id, fillTo = 5) => API.post(`/api/rooms/${id}/bots`, { fillTo }),
  removeRoomBots: (id) => API.delete(`/api/rooms/${id}/bots`),

  // Admin
  getUsers: () => API.get('/api/admin/users'),
  activateUser: (id) => API.post(`/api/admin/users/${id}/activate`, {}),
  deactivateUser: (id) => API.post(`/api/admin/users/${id}/deactivate`, {}),
  toggleAdmin: (id) => API.post(`/api/admin/users/${id}/toggle-admin`, {}),
  resetUserPassword: (id, newPassword) => API.post(`/api/admin/users/${id}/reset-password`, { newPassword }),
  deleteUser: (id) => API.delete(`/api/admin/users/${id}`),
};
