// public/js/ui.js — DOM helpers

const UI = {
  el: (id) => document.getElementById(id),
  qs: (sel, parent = document) => parent.querySelector(sel),
  qsa: (sel, parent = document) => [...parent.querySelectorAll(sel)],

  html: (el, html) => { if (el) el.innerHTML = html; },

  show(el) { if (el) el.classList.remove('hidden'); },
  hide(el) { if (el) el.classList.add('hidden'); },
  toggle(el, show) { el?.classList.toggle('hidden', !show); },

  cls(el, ...classes) { if (el) el.className = classes.join(' '); },

  notice(msg, type = 'info') {
    return `<div class="notice notice-${type}">${msg}</div>`;
  },

  badge(text, type) {
    return `<span class="badge badge-${type}">${text}</span>`;
  },

  btn(text, cls, onclick, extra = '') {
    return `<button class="btn ${cls}" onclick="${onclick}" ${extra}>${text}</button>`;
  },

  formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString('pl', { hour: '2-digit', minute: '2-digit' });
  },

  formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pl');
  },

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  // Pokaż modal z treścią
  showModal({ title, content, actions = '', onClose }) {
    const existing = document.getElementById('modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" id="modal-box">
        <div class="modal-title">${title}</div>
        <div class="modal-content">${content}</div>
        ${actions ? `<div class="modal-actions">${actions}</div>` : ''}
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); onClose?.(); }
    });
    document.body.appendChild(overlay);
    return overlay;
  },

  closeModal() {
    document.getElementById('modal-overlay')?.remove();
  },

  // Policy tile
  policyTile(type, hasPower = false) {
    const cls = type === 'L' ? 'L' : type === 'F' ? 'F' : 'empty';
    const powerClass = hasPower ? ' power' : '';
    const label = type === 'L' ? 'L' : type === 'F' ? 'F' : '';
    return `<div class="policy-tile ${cls}${powerClass}">${label}</div>`;
  },

  // Render policy board (lib or fas)
  renderPolicyBoard(count, max, type, powers = []) {
    let slots = '';
    for (let i = 0; i < max; i++) {
      const filled = i < count;
      const hasPower = powers[i] && !filled;
      if (filled) slots += UI.policyTile(type, false);
      else slots += UI.policyTile(null, hasPower);
    }
    return slots;
  },

  // Confirm dialog
  confirm(message) {
    return new Promise((resolve) => {
      const overlay = UI.showModal({
        title: 'Potwierdzenie',
        content: `<p>${message}</p>`,
        actions: `
          <button class="btn btn-danger" id="confirm-yes" style="flex:1">Tak</button>
          <button class="btn btn-ghost" id="confirm-no" style="flex:1">Nie</button>
        `,
      });
      document.getElementById('confirm-yes').onclick = () => { overlay.remove(); resolve(true); };
      document.getElementById('confirm-no').onclick = () => { overlay.remove(); resolve(false); };
    });
  },
};
