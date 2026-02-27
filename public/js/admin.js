// public/js/admin.js — panel administratora

const Admin = {
  users: [],

  async load() {
    try {
      this.users = await API.getUsers();
      this.render();
    } catch (e) {
      console.error('Admin load error:', e);
    }
  },

  render() {
    const el = document.getElementById('admin-content');
    if (!el) return;

    const pending = this.users.filter(u => !u.isActive);
    const active = this.users.filter(u => u.isActive);

    el.innerHTML = `
      ${pending.length > 0 ? `
        <div class="box box-gold" style="margin-bottom:16px">
          <div class="section-title" style="color:var(--gold)">⏳ Oczekujące Aktywacje (${pending.length})</div>
          <table class="admin-table">
            <thead><tr><th>Użytkownik</th><th>Rejestracja</th><th>Akcje</th></tr></thead>
            <tbody>
              ${pending.map(u => `
                <tr>
                  <td><strong>${UI.escapeHtml(u.username)}</strong></td>
                  <td class="text-dim">${UI.formatDate(u.createdAt)}</td>
                  <td>
                    <button class="btn btn-gold btn-sm" onclick='Admin.activate(${JSON.stringify(u.id)})'>✅ Aktywuj</button>
                    <button class="btn btn-danger btn-sm" style="margin-left:6px" onclick='Admin.deleteUser(${JSON.stringify(u.id)}, ${JSON.stringify(u.username)})'>🗑️ Usuń</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      <div class="section-title">👥 Wszyscy użytkownicy (${this.users.length})</div>
      <table class="admin-table">
        <thead>
          <tr>
            <th>Użytkownik</th>
            <th>Status</th>
            <th>Rola</th>
            <th>Ostatnio widziany</th>
            <th>Akcje</th>
          </tr>
        </thead>
        <tbody>
          ${active.map(u => `
            <tr>
              <td><strong>${UI.escapeHtml(u.username)}</strong></td>
              <td><span style="color:#4a8">✅ Aktywny</span></td>
              <td>${u.isAdmin ? '<span class="badge badge-hitler" style="font-size:9px">Admin</span>' : '<span class="text-dim">Gracz</span>'}</td>
              <td class="text-dim">${UI.formatDate(u.lastSeen)}</td>
              <td style="display:flex;gap:6px;flex-wrap:wrap">
                ${!u.isAdmin ? `<button class="btn btn-ghost btn-sm" onclick='Admin.deactivate(${JSON.stringify(u.id)}, ${JSON.stringify(u.username)})'>Deaktywuj</button>` : ''}
                <button class="btn btn-ghost btn-sm" onclick='Admin.toggleAdmin(${JSON.stringify(u.id)}, ${JSON.stringify(u.username)}, ${u.isAdmin})'>
                  ${u.isAdmin ? 'Zdejmij admina' : 'Zrób adminem'}
                </button>
                <button class="btn btn-danger btn-sm" onclick='Admin.deleteUser(${JSON.stringify(u.id)}, ${JSON.stringify(u.username)})'>🗑️</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  },

  async activate(id) {
    await API.activateUser(id);
    await this.load();
  },

  async deactivate(id, name) {
    const ok = await UI.confirm(`Deaktywować konto <strong>${UI.escapeHtml(name)}</strong>? Użytkownik nie będzie mógł się zalogować.`);
    if (!ok) return;
    await API.deactivateUser(id);
    await this.load();
  },

  async toggleAdmin(id, name, isAdmin) {
    const action = isAdmin ? `zabrać uprawnienia admina` : `nadać uprawnienia admina`;
    const ok = await UI.confirm(`Czy chcesz ${action} użytkownikowi <strong>${UI.escapeHtml(name)}</strong>?`);
    if (!ok) return;
    await API.toggleAdmin(id);
    await this.load();
  },

  async deleteUser(id, name) {
    const ok = await UI.confirm(`Trwale usunąć konto <strong>${UI.escapeHtml(name)}</strong>? Tej operacji nie można cofnąć.`);
    if (!ok) return;
    await API.deleteUser(id);
    await this.load();
  },
};
