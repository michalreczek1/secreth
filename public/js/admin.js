// public/js/admin.js — panel administratora

const Admin = {
  users: [],
  tempPassword(length = 12) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  },

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
      <div class="box" style="margin-bottom:16px">
        <div class="section-title">🔐 Bezpieczeństwo</div>
        <div class="notice notice-info">Zmień swoje hasło administratora albo nadaj użytkownikowi nowe hasło tymczasowe.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-gold btn-sm" onclick="Admin.showChangeMyPassword()">Zmień moje hasło</button>
        </div>
      </div>

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
                ${u.id !== App.currentUser?.id ? `<button class="btn btn-ghost btn-sm" onclick='Admin.showResetPassword(${JSON.stringify(u.id)}, ${JSON.stringify(u.username)})'>Reset hasła</button>` : ''}
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

  showChangeMyPassword() {
    UI.showModal({
      title: '🔐 Zmiana Hasła Admina',
      content: `
        <div style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label>Aktualne hasło</label>
            <input type="password" id="admin-current-password" autocomplete="current-password" />
          </div>
          <div>
            <label>Nowe hasło</label>
            <input type="password" id="admin-new-password" autocomplete="new-password" />
          </div>
          <div>
            <label>Powtórz nowe hasło</label>
            <input type="password" id="admin-repeat-password" autocomplete="new-password" />
          </div>
          <div id="admin-password-notice"></div>
        </div>
      `,
      actions: `
        <button class="btn btn-gold" style="flex:1" onclick="Admin.changeMyPassword()">Zapisz</button>
        <button class="btn btn-ghost" style="flex:1" onclick="UI.closeModal()">Anuluj</button>
      `,
    });
  },

  async changeMyPassword() {
    const currentPassword = document.getElementById('admin-current-password')?.value || '';
    const newPassword = document.getElementById('admin-new-password')?.value || '';
    const repeatPassword = document.getElementById('admin-repeat-password')?.value || '';
    const notice = document.getElementById('admin-password-notice');

    if (!currentPassword || !newPassword || !repeatPassword) {
      if (notice) notice.innerHTML = UI.notice('Wypełnij wszystkie pola.', 'error');
      return;
    }
    if (newPassword !== repeatPassword) {
      if (notice) notice.innerHTML = UI.notice('Nowe hasła nie są takie same.', 'error');
      return;
    }

    const res = await API.changePassword(currentPassword, newPassword);
    if (res.error) {
      if (notice) notice.innerHTML = UI.notice(res.error, 'error');
      return;
    }

    UI.showModal({
      title: '✅ Hasło Zmienione',
      content: '<div class="notice notice-success">Hasło administratora zostało zmienione.</div>',
      actions: `<button class="btn btn-gold btn-full" onclick="UI.closeModal()">Zamknij</button>`,
    });
  },

  showResetPassword(id, username) {
    const suggested = this.tempPassword();
    UI.showModal({
      title: '♻️ Reset Hasła',
      content: `
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="notice notice-info">Ustaw nowe hasło dla użytkownika <strong>${UI.escapeHtml(username)}</strong>.</div>
          <div>
            <label>Nowe hasło tymczasowe</label>
            <input type="text" id="admin-reset-password" value="${UI.escapeHtml(suggested)}" />
          </div>
          <div id="admin-reset-notice"></div>
        </div>
      `,
      actions: `
        <button class="btn btn-gold" style="flex:1" onclick='Admin.resetPassword(${JSON.stringify(id)}, ${JSON.stringify(username)})'>Ustaw hasło</button>
        <button class="btn btn-ghost" style="flex:1" onclick="UI.closeModal()">Anuluj</button>
      `,
    });
  },

  async resetPassword(id, username) {
    const newPassword = document.getElementById('admin-reset-password')?.value || '';
    const notice = document.getElementById('admin-reset-notice');
    if (!newPassword) {
      if (notice) notice.innerHTML = UI.notice('Podaj nowe hasło.', 'error');
      return;
    }

    const res = await API.resetUserPassword(id, newPassword);
    if (res.error) {
      if (notice) notice.innerHTML = UI.notice(res.error, 'error');
      return;
    }

    UI.showModal({
      title: '✅ Hasło Zresetowane',
      content: `
        <div class="notice notice-success">
          Użytkownik <strong>${UI.escapeHtml(username)}</strong> ma nowe hasło:
        </div>
        <div class="event-highlight" style="font-size:18px">${UI.escapeHtml(newPassword)}</div>
      `,
      actions: `<button class="btn btn-gold btn-full" onclick="UI.closeModal()">Zamknij</button>`,
    });
  },
};
