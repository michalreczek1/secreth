// public/js/game.js — renderowanie gry po stronie klienta

const Game = {
  state: null,      // ostatni znany stan (widok gracza)
  roomId: null,
  myUserId: null,
  peekCards: null,
  investigateResult: null,
  revealedGameId: null,
  roleRevealTimer: null,
  disconnectTicker: null,
  eventModalQueue: [],
  eventModalPending: false,
  lastEventFingerprint: null,
  shownClaimKey: null,

  sameId(a, b) {
    return String(a) === String(b);
  },

  getDisplayedVote(state, playerId) {
    if (!state) return null;
    const votes = state.votes || {};
    if (Object.prototype.hasOwnProperty.call(votes, playerId)) return votes[playerId];
    if (this.sameId(playerId, this.myUserId) && state.myVote) return state.myVote;
    return null;
  },

  init(roomId, userId) {
    this.roomId = roomId;
    this.myUserId = userId;
    this.peekCards = null;
    this.investigateResult = null;

    // `game:state` can arrive before the DOM for the game view exists.
    // Preserve the pending state and render it once the view is mounted.
    if (this.state) {
      this.render();
      this.updateDisconnectTicker();
      this.maybeRevealRole();
    }
  },

  reset() {
    if (this.roleRevealTimer) clearTimeout(this.roleRevealTimer);
    if (this.disconnectTicker) clearInterval(this.disconnectTicker);
    this.state = null;
    this.roomId = null;
    this.myUserId = null;
    this.peekCards = null;
    this.investigateResult = null;
    this.roleRevealTimer = null;
    this.disconnectTicker = null;
    this.eventModalQueue = [];
    this.eventModalPending = false;
    this.lastEventFingerprint = null;
    this.shownClaimKey = null;
  },

  // ── SOCKET EVENTS ──────────────────────────────────────────────────────────
  onState(state) {
    const prevState = this.state;
    this.state = state;
    this.render();
    this.updateDisconnectTicker();
    this.handleStateEvents(prevState, state);
    this.maybeRevealRole();
    this.maybePromptPendingClaim();
  },

  onPeek(cards) {
    this.peekCards = cards;
    this.showPeekModal(cards);
  },

  onInvestigate(result) {
    this.investigateResult = result;
    this.showInvestigateModal(result);
  },

  // ── GŁÓWNY RENDER ──────────────────────────────────────────────────────────
  render() {
    const s = this.state;
    if (!s) return;

    const main = document.getElementById('game-main');
    if (!main) return;

    if (s.winner) {
      main.innerHTML = this.renderWin(s);
      return;
    }

    main.innerHTML = `
      <div class="game-layout">
        ${this.renderDisconnectControl(s)}
        ${this.renderBoards(s)}
        ${this.renderTracker(s)}
        <div class="game-columns">
          ${this.renderActionPanel(s)}
          ${this.renderPlayersSide(s)}
        </div>
        ${this.renderVoteHistory(s)}
        ${this.renderLog(s)}
      </div>
    `;

    this.renderSidebarPlayers(s);
  },

  updateDisconnectTicker() {
    const waiting = this.state?.disconnectControl?.phase === 'waiting';
    if (!waiting) {
      if (this.disconnectTicker) clearInterval(this.disconnectTicker);
      this.disconnectTicker = null;
      return;
    }
    if (this.disconnectTicker) return;
    this.disconnectTicker = setInterval(() => {
      if (!this.state?.disconnectControl || this.state.disconnectControl.phase !== 'waiting') {
        clearInterval(this.disconnectTicker);
        this.disconnectTicker = null;
        return;
      }
      const countdown = document.getElementById('disconnect-countdown');
      if (countdown) countdown.textContent = this.formatDisconnectCountdown(this.state.disconnectControl.expiresAt);
    }, 1000);
  },

  formatDisconnectCountdown(expiresAt) {
    if (!expiresAt) return '0s';
    const remainingMs = Math.max(0, Number(expiresAt) - Date.now());
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
  },

  renderDisconnectControl(s) {
    const control = s.disconnectControl;
    if (!control) return '';

    if (control.phase === 'waiting') {
      return `
        <div class="disconnect-panel disconnect-panel-waiting">
          <div class="disconnect-title">⏳ Gra Wstrzymana</div>
          <div class="disconnect-text">
            <strong>${UI.escapeHtml(control.targetUsername)}</strong> utracił łączność.
            Czekamy na powrót jeszcze <span id="disconnect-countdown">${this.formatDisconnectCountdown(control.expiresAt)}</span>.
          </div>
        </div>
      `;
    }

    const votes = control.votes || { wait: 0, takeover: 0, end: 0 };
    const myVoteLabel = control.myVote
      ? { wait: 'Czekamy', takeover: 'Bot przejmuje', end: 'Kończymy' }[control.myVote] || control.myVote
      : null;

    return `
      <div class="disconnect-panel disconnect-panel-vote">
        <div class="disconnect-title">🗳️ Decyzja Stołu</div>
        <div class="disconnect-text">
          <strong>${UI.escapeHtml(control.targetUsername)}</strong> nie wrócił na czas.
          Pozostali żywi gracze decydują co dalej.
        </div>
        <div class="disconnect-vote-summary">
          <span class="badge badge-vote-pending">Czekamy: ${votes.wait || 0}</span>
          <span class="badge badge-vote-ja">Bot: ${votes.takeover || 0}</span>
          <span class="badge badge-vote-nein">Koniec: ${votes.end || 0}</span>
        </div>
        ${control.canVote ? `
          <div class="disconnect-actions">
            <button class="btn btn-ghost btn-sm" onclick="Game.voteDisconnect('wait')">⌛ Czekamy</button>
            <button class="btn btn-blue btn-sm" onclick="Game.voteDisconnect('takeover')">🤖 Bot przejmuje</button>
            <button class="btn btn-red btn-sm" onclick="Game.voteDisconnect('end')">🛑 Kończymy</button>
          </div>
        ` : `
          <div class="disconnect-text disconnect-muted">
            ${myVoteLabel ? `Oddałeś głos: <strong>${UI.escapeHtml(myVoteLabel)}</strong>.` : `Czekamy na głosy (${control.eligibleCount || 0} uprawnionych).`}
          </div>
        `}
      </div>
    `;
  },

  maybeRevealRole() {
    const s = this.state;
    const main = document.getElementById('game-main');
    if (!s || !main || !s.myRole || !s.gameId || s.winner) return;
    if (this.revealedGameId === s.gameId || this.roleRevealTimer) return;

    this.roleRevealTimer = setTimeout(() => {
      this.roleRevealTimer = null;
      if (!this.state || this.state.gameId !== s.gameId || this.revealedGameId === s.gameId) return;
      this.revealedGameId = s.gameId;
      this.showRoleModal();
    }, 300);
  },

  renderBoards(s) {
    const libPowers = []; // nie potrzebujemy oznaczeń mocy dla lib
    const fasPowers = [null, null, null, null, null, null]; // uproszczenie

    let libSlots = '', fasSlots = '';
    for (let i = 0; i < 5; i++) libSlots += UI.policyTile(i < s.lib ? 'L' : null);
    for (let i = 0; i < 6; i++) fasSlots += UI.policyTile(i < s.fas ? 'F' : null);

    return `
      <div class="policy-boards">
        <div class="policy-board board-lib">
          <div class="board-title">🕊️ Liberalne Ustawy (${s.lib}/5)</div>
          <div class="policy-slots">${libSlots}</div>
        </div>
        <div class="policy-board board-fas">
          <div class="board-title">☠️ Faszystowskie Ustawy (${s.fas}/6)</div>
          <div class="policy-slots">${fasSlots}</div>
        </div>
      </div>
    `;
  },

  renderTracker(s) {
    const dots = [0,1,2].map(i =>
      `<div class="tracker-dot ${i < s.electionTracker ? 'filled' : ''}"></div>`
    ).join('');
    const vetoHint = s.canVeto
      ? '<span style="color:var(--fascist);font-size:11px;margin-left:8px">⚠️ VETO aktywne: tylko Kanclerz może je zaproponować w swojej turze</span>'
      : '';
    return `
      <div class="tracker-bar">
        <span class="tracker-label">Tor Wyborów</span>
        <div class="tracker-dots">${dots}</div>
        <span class="tracker-info">Talia: ${s.deckSize} | Odrzucone: ${s.discardSize}</span>
        ${vetoHint}
      </div>
    `;
  },

  renderActionPanel(s) {
    const me = s.players[s.myIdx];
    const president = s.players[s.presidentIdx];
    const chancellor = s.chancellorIdx != null ? s.players[s.chancellorIdx] : null;
    const iAmPresident = me && president && me.id === president.id;
    const iAmChancellor = me && chancellor && me.id === chancellor.id;
    const iAmDead = me?.dead;

    let content = '';

    if (iAmDead) {
      content = `<div class="action-desc text-center italic text-dim">Zostałeś wyeliminowany. Obserwuj grę w ciszy.</div>`;
    } else {
      switch (s.phase) {
        case 'nominate': content = this.renderNominate(s, iAmPresident, president); break;
        case 'vote': content = this.renderVote(s, me); break;
        case 'presidentDiscard': content = this.renderPresidentDiscard(s, iAmPresident); break;
        case 'chancellorDiscard': content = this.renderChancellorDiscard(s, iAmChancellor); break;
        case 'veto': content = this.renderVeto(s, iAmPresident, iAmChancellor); break;
        case 'executive': content = this.renderExecutive(s, iAmPresident); break;
        case 'executiveDone': content = this.renderExecutiveDone(s, iAmPresident); break;
        default: content = `<div class="action-desc text-dim italic">Oczekiwanie...</div>`;
      }
    }

    const isMyTurn = !iAmDead && (
      (s.phase === 'nominate' && iAmPresident) ||
      (s.phase === 'vote' && me && !me.dead) ||
      (s.phase === 'presidentDiscard' && iAmPresident) ||
      (s.phase === 'chancellorDiscard' && iAmChancellor) ||
      (s.phase === 'veto' && (iAmPresident || iAmChancellor)) ||
      (s.phase === 'executive' && iAmPresident) ||
      (s.phase === 'executiveDone' && iAmPresident)
    );

    return `
      <div class="action-panel ${isMyTurn ? 'my-turn' : ''}">
        <div class="action-title">
          ${this.phaseTitle(s.phase)}
        </div>
        ${this.renderPendingClaimNotice(s)}
        ${content}
      </div>
    `;
  },

  renderPendingClaimNotice(s) {
    if (!s.pendingClaim) return '';
    const roleLabel = s.pendingClaim.role === 'president' ? 'Prezydent' : 'Kanclerz';
    return `
      <div class="notice notice-info">
        Masz do złożenia publiczną deklarację kart jako <strong>${roleLabel}</strong>.
        <button class="btn btn-gold btn-sm" style="margin-top:8px" onclick="Game.openPendingClaimModal()">Złóż deklarację</button>
      </div>
    `;
  },

  phaseTitle(phase) {
    const titles = {
      nominate: '🏛️ Nominacja Kanclerza',
      vote: '🗳️ Głosowanie',
      presidentDiscard: '🤫 Sesja Prezydenta',
      chancellorDiscard: '📜 Sesja Kanclerza',
      veto: '🚫 Propozycja Veto',
      executive: '⚡ Działanie Wykonawcze',
      executiveDone: '✅ Zakończono Akcję',
    };
    return titles[phase] || phase;
  },

  renderNominate(s, iAmPresident, president) {
    if (!iAmPresident) {
      return `<div class="action-desc"><strong>${UI.escapeHtml(president?.username)}</strong> wybiera Kanclerza...</div>`;
    }
    const aliveCount = s.players.filter(p => !p.dead).length;
    const eligible = s.players.map((p, i) => ({ ...p, i })).filter((p) => {
      if (p.dead || p.i === s.presidentIdx) return false;
      if (aliveCount > 5) {
        if (p.i === s.prevPresidentIdx || p.i === s.prevChancellorIdx) return false;
      } else {
        if (p.i === s.prevChancellorIdx) return false;
      }
      return true;
    });

    const restrictions = [
      s.prevChancellorIdx != null && s.players[s.prevChancellorIdx]?.username,
      aliveCount > 5 && s.prevPresidentIdx != null && s.players[s.prevPresidentIdx]?.username,
    ].filter(Boolean);

    return `
      <div class="action-desc">
        Jesteś Prezydentem. Wybierz kandydata na Kanclerza.
        ${restrictions.length ? `<br><span class="text-dim" style="font-size:12px">Ograniczenia kadencji: ${restrictions.map(UI.escapeHtml).join(', ')}</span>` : ''}
      </div>
      <div class="target-list">
        ${eligible.map(p => `
          <div class="target-item" onclick="Game.action('nominate', {targetIdx: ${p.i}})">
            <span style="flex:1">${UI.escapeHtml(p.username)}</span>
            <span class="text-gold" style="font-size:12px">Mianuj →</span>
          </div>
        `).join('')}
        ${eligible.length === 0 ? '<div class="text-dim italic" style="font-size:13px">Brak uprawnionych kandydatów</div>' : ''}
      </div>
    `;
  },

  renderVote(s, me) {
    const president = s.players[s.presidentIdx];
    const chancellor = s.chancellorIdx != null ? s.players[s.chancellorIdx] : null;
    const myVote = s.myVote || null;
    const votedCount = Number(s.votesSubmitted || 0);
    const aliveCount = s.players.filter(p => !p.dead).length;

    if (myVote) {
      return `
        <div class="action-desc">
          Oddałeś głos: <strong style="color:${myVote === 'Ja' ? 'var(--liberal)' : 'var(--fascist)'}">${myVote}!</strong><br>
          Czekamy na pozostałych... (${votedCount}/${aliveCount})
        </div>
        <div class="notice notice-info" style="margin-top:12px">
          Prezydent: <strong>${UI.escapeHtml(president?.username)}</strong><br>
          Kanclerz: <strong>${UI.escapeHtml(chancellor?.username)}</strong>
        </div>
      `;
    }

    return `
      <div class="action-desc">
        Głosuj na proponowany rząd:<br>
        🎩 <strong>${UI.escapeHtml(president?.username)}</strong> (Prezydent)<br>
        🏛️ <strong>${UI.escapeHtml(chancellor?.username)}</strong> (Kanclerz)
      </div>
      <div class="vote-row">
        <button class="btn btn-blue vote-btn" onclick="Game.action('vote', {choice:'Ja'})">
          <span class="vote-btn-icon" aria-hidden="true">✅</span>
          <span class="vote-btn-label">JA!</span>
        </button>
        <button class="btn btn-red vote-btn" onclick="Game.action('vote', {choice:'Nein'})">
          <span class="vote-btn-icon" aria-hidden="true">❌</span>
          <span class="vote-btn-label">NEIN!</span>
        </button>
      </div>
      <div class="text-dim text-center" style="font-size:11px">Głos oddany: ${votedCount}/${aliveCount}</div>
    `;
  },

  renderPresidentDiscard(s, iAmPresident) {
    if (!iAmPresident) {
      return `<div class="action-desc text-dim italic">Prezydent wybiera kartę do odrzucenia...</div>`;
    }
    if (!s.presidentHand || s.presidentHand.length === 0) {
      return `<div class="action-desc text-dim italic">Ładowanie kart...</div>`;
    }
    return `
      <div class="action-desc">
        Odrzuć jedną kartę.<br>
        <span class="text-dim" style="font-size:12px">Kanclerz dostanie pozostałe 2. Nie komunikuj się z Kanclerzem!</span>
      </div>
      <div class="hand-cards">
        ${s.presidentHand.map((c, i) => `
          <div class="hand-card ${c}" onclick="Game.action('presidentDiscard', {cardIndex: ${i}})" title="Kliknij aby ODRZUCIĆ">${c}</div>
        `).join('')}
      </div>
      <div class="text-dim text-center" style="font-size:11px">Kliknij kartę aby ją odrzucić</div>
    `;
  },

  renderChancellorDiscard(s, iAmChancellor) {
    const president = s.players[s.presidentIdx];
    if (!iAmChancellor) {
      return `
        <div class="action-desc text-dim italic">
          Kanclerz wybiera ustawę do uchwalenia...
          ${s.canVeto ? '<br><span style="font-size:12px;color:var(--fascist)">Przy 5 ustawach faszystowskich tylko Kanclerz może zaproponować VETO. Prezydent odpowie dopiero po propozycji.</span>' : ''}
        </div>
      `;
    }
    if (!s.chancellorHand || s.chancellorHand.length === 0) {
      return `<div class="action-desc text-dim italic">Ładowanie kart...</div>`;
    }
    return `
      <div class="action-desc">
        Odrzuć jedną kartę, zagraj drugą.<br>
        <span class="text-dim" style="font-size:12px">Nie komunikuj się z Prezydentem!</span>
      </div>
      <div class="hand-cards">
        ${s.chancellorHand.map((c, i) => `
          <div class="hand-card ${c}" onclick="Game.action('chancellorDiscard', {cardIndex: ${i}})" title="Kliknij aby ODRZUCIĆ">${c}</div>
        `).join('')}
      </div>
      <div class="text-dim text-center" style="font-size:11px">Kliknij kartę aby ją odrzucić</div>
      ${s.canVeto ? `
        <hr class="divider" style="margin:16px 0">
        <div class="notice notice-warn" style="margin-bottom:10px">
          VETO odrzuca obie pozostałe ustawy tylko wtedy, gdy Prezydent je zaakceptuje.
        </div>
        <button class="btn btn-danger btn-full btn-sm" onclick="Game.action('proposeVeto')">
          🚫 Zaproponuj VETO (odrzuć obie karty)
        </button>
      ` : ''}
    `;
  },

  renderVeto(s, iAmPresident, iAmChancellor) {
    const president = s.players[s.presidentIdx];
    const chancellor = s.chancellorIdx != null ? s.players[s.chancellorIdx] : null;
    if (iAmPresident) {
      return `
        <div class="action-desc">
          <strong>${UI.escapeHtml(chancellor?.username)}</strong> proponuje VETO — odrzucenie obu kart.<br>
          Czy zgadzasz się?
        </div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn btn-red" style="flex:1" onclick="Game.action('respondVeto', {accept: true})">Zgadzam się na Veto</button>
          <button class="btn btn-ghost" style="flex:1" onclick="Game.action('respondVeto', {accept: false})">Odmawiam Veto</button>
        </div>
      `;
    }
    if (iAmChancellor) {
      return `<div class="action-desc">Zaproponowałeś VETO. Czekasz na decyzję Prezydenta <strong>${UI.escapeHtml(president?.username)}</strong>...</div>`;
    }
    return `<div class="action-desc text-dim italic">Trwa negocjacja VETO...</div>`;
  },

  renderExecutive(s, iAmPresident) {
    const president = s.players[s.presidentIdx];
    if (!iAmPresident) {
      const powerNames = { investigate: 'zbada przynależność gracza', specialElection: 'wywoła Specjalne Wybory', peekPolicies: 'podejrzy ustawy', execute: 'dokona egzekucji' };
      return `<div class="action-desc"><strong>${UI.escapeHtml(president?.username)}</strong> ${powerNames[s.execPower] || 'używa mocy'}...</div>`;
    }

    const others = s.players.map((p, i) => ({ ...p, i })).filter(p => !p.dead && p.i !== s.presidentIdx);

    switch (s.execPower) {
      case 'peekPolicies':
        return `
          <div class="action-desc">Podejrzyj 3 kolejne karty z talii.<br><span class="text-dim" style="font-size:12px">Nie zmieniaj ich kolejności. Możesz skłamać o tym co widziałeś.</span></div>
          <button class="btn btn-gold btn-full" style="margin-top:14px" onclick="Game.action('peekPolicies')">👁️ Podejrzyj ustawy</button>
        `;
      case 'investigate':
        const notInvestigated = others.filter(p => !s.investigated[p.id]);
        return `
          <div class="action-desc">Zbadaj kartę przynależności gracza.<br><span class="text-dim" style="font-size:12px">Każdy może być zbadany tylko raz. Zobaczysz czy jest Liberałem czy Faszystą (nie rolę!).</span></div>
          <div class="target-list" style="margin-top:12px">
            ${notInvestigated.map(p => `
              <div class="target-item" onclick="Game.action('investigate', {targetIdx: ${p.i}})">
                <span style="flex:1">${UI.escapeHtml(p.username)}</span>
                <span class="text-gold" style="font-size:12px">Zbadaj →</span>
              </div>
            `).join('')}
          </div>
        `;
      case 'specialElection':
        return `
          <div class="action-desc">Wybierz następnego Prezydenta (Specjalne Wybory).<br><span class="text-dim" style="font-size:12px">Możesz wybrać każdego, nawet ograniczonego kadencją. Rotacja wraca do normalnej kolejności po tej turze.</span></div>
          <div class="target-list" style="margin-top:12px">
            ${others.map(p => `
              <div class="target-item" onclick="Game.action('specialElection', {targetIdx: ${p.i}})">
                <span style="flex:1">${UI.escapeHtml(p.username)}</span>
                <span class="text-gold" style="font-size:12px">Mianuj →</span>
              </div>
            `).join('')}
          </div>
        `;
      case 'execute':
        return `
          <div class="action-desc" style="color:var(--fascist)">Skaż gracza na śmierć.<br><span class="text-dim" style="font-size:12px">Jeśli zabijesz Hitlera — Liberałowie natychmiast wygrywają! Rola zabitego pozostanie tajna.</span></div>
          <div class="target-list" style="margin-top:12px">
            ${others.map(p => `
              <div class="target-item danger" onclick="Game.confirmExecute(${p.i}, '${UI.escapeHtml(p.username)}')" style="border-color:var(--red)">
                <span style="flex:1">${UI.escapeHtml(p.username)}</span>
                <span style="color:var(--fascist);font-size:12px">💀 Skaż →</span>
              </div>
            `).join('')}
          </div>
        `;
      default:
        return `<div class="action-desc text-dim italic">Nieznana moc: ${s.execPower}</div>`;
    }
  },

  renderExecutiveDone(s, iAmPresident) {
    if (!iAmPresident) return `<div class="action-desc text-dim italic">Prezydent zakończył działanie...</div>`;
    return `
      <div class="action-desc">Działanie wykonawcze zakończone.<br><span class="text-dim" style="font-size:12px">Możesz teraz omówić wynik z innymi graczami albo blefować. Gra ruszy dopiero po potwierdzeniu.</span></div>
      <button class="btn btn-gold btn-full" style="margin-top:14px" onclick="Game.action('finishPeek')">Zamknij akcję i kontynuuj →</button>
    `;
  },

  renderPlayersSide(s) {
    const rows = s.players.map((p, i) => {
      const isMe = this.sameId(p.id, this.myUserId);
      const isBot = typeof p.id === 'string' && p.id.startsWith('bot:');
      const isBotControlled = !!p.botControlled;
      const isPres = i === s.presidentIdx;
      const isChan = i === s.chancellorIdx;
      const voteBadge = this.renderVoteBadge(s, p);
      let roleStr = '';
      if (p.role) {
        const colors = { Liberal: 'var(--liberal)', Fascist: 'var(--fascist)', Hitler: 'var(--fascist)' };
        roleStr = `<span style="font-size:10px;color:${colors[p.role]}">${p.role === 'Liberal' ? '🕊️' : p.role === 'Hitler' ? '💀' : '☠️'}</span>`;
      }
      return `
        <div class="player-item ${isPres ? 'is-president' : ''} ${isChan ? 'is-chancellor' : ''} ${p.dead ? 'is-dead' : ''} ${isMe ? 'is-me' : ''}">
          <div class="player-dot ${p.dead ? 'dead' : p.connected !== false ? 'online' : ''}"></div>
          <span class="player-name">${UI.escapeHtml(p.username)}${isMe ? ' (ty)' : ''}${isBot ? ' [BOT]' : isBotControlled ? ' [AUTO]' : ''}</span>
          ${voteBadge}
          ${roleStr}
          ${isPres ? '<span class="badge badge-pres">Prez.</span>' : ''}
          ${isChan ? '<span class="badge badge-chan">Kancl.</span>' : ''}
        </div>
      `;
    }).join('');

    return `
      <div style="background:rgba(0,0,0,.3);border:1px solid var(--border);padding:12px">
        <div class="section-title">Gracze</div>
        <div style="display:flex;flex-direction:column;gap:4px">${rows}</div>
      </div>
    `;
  },

  renderSidebarPlayers(s) {
    const el = document.getElementById('sidebar-players');
    if (!el || !s) return;
    el.innerHTML = s.players.map((p, i) => {
      const isMe = this.sameId(p.id, this.myUserId);
      const isBot = typeof p.id === 'string' && p.id.startsWith('bot:');
      const isBotControlled = !!p.botControlled;
      const isPres = i === s.presidentIdx;
      const isChan = i === s.chancellorIdx;
      const voteBadge = this.renderVoteBadge(s, p);
      return `
        <div class="player-item ${isPres ? 'is-president' : ''} ${isChan ? 'is-chancellor' : ''} ${p.dead ? 'is-dead' : ''} ${isMe ? 'is-me' : ''}">
          <div class="player-dot ${p.dead ? 'dead' : p.connected !== false ? 'online' : ''}"></div>
          <span class="player-name">${UI.escapeHtml(p.username)}${isMe ? ' (ty)' : ''}${isBot ? ' [BOT]' : isBotControlled ? ' [AUTO]' : ''}</span>
          ${voteBadge}
          ${isPres ? '<span class="badge badge-pres">P</span>' : ''}
          ${isChan ? '<span class="badge badge-chan">K</span>' : ''}
        </div>
      `;
    }).join('');
  },

  renderVoteBadge(s, player) {
    if (!s) return '';
    if (s.phase === 'vote') {
      if (this.sameId(player.id, this.myUserId) && s.myVote) return '<span class="badge badge-vote-ja">ODDANY</span>';
      if (!player.dead) return '<span class="badge badge-vote-pending">...</span>';
      return '';
    }
    if (!s.votes) return '';
    const vote = this.getDisplayedVote(s, player.id);
    if (vote === 'Ja') return '<span class="badge badge-vote-ja">JA</span>';
    if (vote === 'Nein') return '<span class="badge badge-vote-nein">NEIN</span>';
    return '';
  },

  renderLog(s) {
    const entries = (s.log || []).map(l =>
      `<div class="log-entry">${UI.escapeHtml(l.text || l)}</div>`
    ).join('');
    return `
      <div class="game-log-panel">
        <div class="section-title" style="font-size:10px;margin-bottom:6px">Dziennik Zdarzeń</div>
        <div class="game-log">${entries}</div>
      </div>
    `;
  },

  renderVoteHistory(s) {
    const entries = (s.voteHistory || []).map((entry) => {
      const votes = (entry.votes || []).map((vote) => `
        <div class="vote-history-player">
          <span class="vote-history-name">${UI.escapeHtml(vote.username)}</span>
          ${this.renderVoteHistoryChip(vote.vote)}
        </div>
      `).join('');
      return `
        <div class="vote-history-entry ${entry.passed ? 'passed' : 'failed'}">
          <div class="vote-history-head">
            <div class="vote-history-government">
              <span>Prezydent: <strong>${UI.escapeHtml(entry.presidentName || '—')}</strong></span>
              <span>Kanclerz: <strong>${UI.escapeHtml(entry.chancellorName || '—')}</strong></span>
            </div>
            <span class="badge ${entry.passed ? 'badge-vote-ja' : 'badge-vote-nein'}">${entry.passed ? 'PRZESZŁO' : 'ODRZUCONO'}</span>
          </div>
          <div class="vote-history-votes">${votes}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="vote-history-panel">
        <div class="section-title" style="font-size:10px;margin-bottom:6px">Historia Głosowań</div>
        <div class="vote-history-list">
          ${entries || '<div class="vote-history-empty">Brak zakończonych głosowań w tej partii.</div>'}
        </div>
      </div>
    `;
  },

  renderVoteHistoryChip(vote) {
    if (vote === 'Ja') return '<span class="vote-history-chip vote-history-chip-ja">🕊️ JA</span>';
    if (vote === 'Nein') return '<span class="vote-history-chip vote-history-chip-nein">☠️ NEIN</span>';
    return '<span class="vote-history-chip vote-history-chip-pending">—</span>';
  },

  renderWin(s) {
    const libWin = s.winner === 'Liberal';
    const roleRows = s.players.map(p => {
      const roleLabel = p.role === 'Liberal' ? '🕊️ Liberał' : p.role === 'Hitler' ? '💀 Hitler' : '☠️ Faszysta';
      const roleClass = p.role === 'Liberal' ? 'badge-liberal' : p.role === 'Hitler' ? 'badge-hitler' : 'badge-fascist';
      return `
        <div class="win-player">
          <span style="color:var(--cream);${p.dead ? 'text-decoration:line-through;opacity:.5' : ''}">${UI.escapeHtml(p.username)}${p.dead ? ' †' : ''}</span>
          <span class="badge ${roleClass}">${roleLabel}</span>
        </div>
      `;
    }).join('');

    const isOwner = App.currentUser?.id === App.currentRoomOwner;

    return `
      <div class="win-screen ${libWin ? 'win-liberal' : 'win-fascist'}">
        <div class="win-icon">${libWin ? '🕊️' : '💀'}</div>
        <div class="win-title">${libWin ? 'Liberałowie Wygrywają!' : 'Faszyści Wygrywają!'}</div>
        <div class="win-reason">${UI.escapeHtml(s.winReason)}</div>
        <div class="win-reveal">${roleRows}</div>
        ${isOwner ? `<button class="btn btn-gold" onclick="Game.restart()">🔄 Nowa Gra (ten sam pokój)</button>` : ''}
      </div>
    `;
  },

  // ── MODALS ─────────────────────────────────────────────────────────────────

  showRoleModal() {
    const s = this.state;
    if (!s?.myRole) return;
    const me = s.players[s.myIdx];
    if (!me) return;

    const isLib = s.myRole === 'Liberal', isHit = s.myRole === 'Hitler';
    const icon = isLib ? '🕊️' : isHit ? '💀' : '☠️';
    const color = isLib ? 'var(--liberal)' : 'var(--fascist)';
    const roleName = isLib ? 'Liberał' : isHit ? 'Hitler' : 'Faszysta';

    // Znajdź sojuszników
    const myFascists = s.players.filter(p => p.role === 'Fascist' && !this.sameId(p.id, this.myUserId)).map(p => p.username);
    const hitlerPlayer = s.players.find(p => p.role === 'Hitler');
    const n = s.players.length;

    let info = '';
    if (isLib) {
      info = `Uchwalcie 5 Liberalnych Ustaw lub zabijcie Hitlera!<br>Nie wiesz kto jest Faszystą ani Hitlerem.`;
    } else if (s.myRole === 'Fascist') {
      const others = myFascists.length > 0 ? `Twoi sojusznicy: <strong>${myFascists.map(UI.escapeHtml).join(', ')}</strong>` : 'Jesteś jedynym Faszystą (poza Hitlerem).';
      const hitlerInfo = hitlerPlayer ? `Hitler to: <strong>${UI.escapeHtml(hitlerPlayer.username)}</strong>` : '';
      const smallNote = n <= 6 ? 'Hitler zna ciebie (gra 5-6 os.).' : 'Hitler NIE zna ciebie (gra 7-10 os.).';
      info = `${others}<br>${hitlerInfo}<br>${smallNote}`;
    } else {
      // Hitler
      const knownFascists = s.players.filter(p => p.role === 'Fascist').map(p => p.username);
      if (n <= 6 && knownFascists.length > 0) {
        info = `Faszyści to: <strong>${knownFascists.map(UI.escapeHtml).join(', ')}</strong><br>Graj jak Liberał! Zdobądź zaufanie i zostań Kanclerzem.`;
      } else {
        info = `Nie znasz Faszystów (gra 7-10 os.).<br>Graj jak Liberał! Zdobądź zaufanie i zostań Kanclerzem.`;
      }
    }

    UI.showModal({
      title: 'Twoja Rola',
      content: `
        <div class="role-reveal">
          <div class="role-icon">${icon}</div>
          <div class="role-name" style="color:${color}">${roleName}</div>
          <div class="role-info">${info}</div>
        </div>
      `,
      actions: `<button class="btn btn-gold btn-full" onclick="UI.closeModal()">Rozumiem — grajmy!</button>`,
    });
  },

  showPeekModal(cards) {
    const cardHtml = cards.map(c => `<div class="hand-card ${c}" style="cursor:default">${c}</div>`).join('');
    UI.showModal({
      title: '👁️ Podgląd Ustaw',
      content: `
        <p class="text-gold mb-12">Oto 3 kolejne karty w talii:</p>
        <div class="hand-cards">${cardHtml}</div>
        <p class="text-dim italic" style="font-size:12px;margin-top:12px">Możesz powiedzieć reszcie co widziałeś (lub skłamać!).<br>Kolejność kart pozostaje tajna.</p>
      `,
      actions: `<button class="btn btn-gold btn-full" onclick="UI.closeModal(); Game.action('finishPeek')">Zamknij i kontynuuj</button>`,
    });
  },

  showInvestigateModal(result) {
    const isLib = result.party === 'Liberal';
    UI.showModal({
      title: '🔍 Wynik Śledztwa',
      content: `
        <p class="text-gold mb-12" style="text-align:center">Przynależność gracza <strong>${UI.escapeHtml(result.username)}</strong>:</p>
        <div class="notice ${isLib ? 'notice-info' : 'notice-error'}" style="font-size:20px;text-align:center;padding:20px">
          ${isLib ? '🕊️ LIBERAŁ' : '☠️ FASZYSTA'}
        </div>
        <p class="text-dim italic" style="font-size:12px;margin-top:12px">
          Możesz podzielić się odkryciem z innymi (lub skłamać!).<br>
          Pamiętaj: karta przynależności nie zdradza czy ktoś jest Hitlerem.
        </p>
      `,
      actions: `<button class="btn btn-gold btn-full" onclick="UI.closeModal()">Zamknij (tylko ty widziałeś)</button>`,
    });
  },

  handleStateEvents(prev, next) {
    if (!prev || !next || prev.winner || next.winner) return;

    if (prev.phase === 'vote' && next.phase !== 'vote' && Object.keys(prev.votes || {}).length > 0) {
      this.queueEventModal(this.buildVoteResultModal(prev, next));
    }

    if (prev.phase !== 'executive' && next.phase === 'executive' && next.execPower) {
      this.queueEventModal(this.buildExecutivePowerModal(next));
    }

    if (prev.phase !== 'veto' && next.phase === 'veto') {
      this.queueEventModal(this.buildVetoProposalModal(next));
    }

    for (const entry of this.getNewLogEntries(prev, next)) {
      const modal = this.buildLogEventModal(entry.text || '');
      if (modal) this.queueEventModal(modal);
    }
  },

  getNewLogEntries(prev, next) {
    if (!prev?.log?.length) return [];
    const prevKeys = new Set(prev.log.map(entry => `${entry.time || ''}|${entry.text || entry}`));
    return (next.log || [])
      .filter(entry => !prevKeys.has(`${entry.time || ''}|${entry.text || entry}`))
      .reverse();
  },

  buildVoteResultModal(prev, next) {
    const president = prev.players[prev.presidentIdx];
    const chancellor = prev.chancellorIdx != null ? prev.players[prev.chancellorIdx] : null;
    const votes = prev.players
      .filter(p => !p.dead)
      .map(p => {
        const vote = this.getDisplayedVote(next, p.id);
        const voteClass = vote === 'Ja' ? 'badge-vote-ja' : vote === 'Nein' ? 'badge-vote-nein' : 'badge-vote-pending';
        return `
        <div class="event-vote-row">
          <span>${UI.escapeHtml(p.username)}</span>
          <span class="badge ${voteClass}">${UI.escapeHtml(vote || '—')}</span>
        </div>
      `;
      })
      .join('');
    const passed = next.phase === 'presidentDiscard' || next.phase === 'executive' || next.phase === 'end';

    return {
      key: `vote:${prev.log?.[0]?.time || `${prev.presidentIdx}:${prev.chancellorIdx}`}`,
      title: passed ? '🗳️ Rząd Zatwierdzony' : '🗳️ Rząd Odrzucony',
      content: `
        <div class="event-modal-body">
          <div class="event-modal-lead">
            <strong>${UI.escapeHtml(president?.username || 'Prezydent')}</strong>
            i
            <strong>${UI.escapeHtml(chancellor?.username || 'Kanclerz')}</strong>
          </div>
          <div class="event-vote-list">${votes}</div>
        </div>
      `,
    };
  },

  buildExecutivePowerModal(state) {
    const president = state.players[state.presidentIdx];
    const powerNames = {
      investigate: 'Zbadaj Przynależność',
      specialElection: 'Specjalne Wybory',
      peekPolicies: 'Podgląd Ustaw',
      execute: 'Egzekucja',
    };
    const powerDesc = {
      investigate: 'Prezydent sprawdzi kartę przynależności wybranego gracza.',
      specialElection: 'Prezydent wybierze następnego Prezydenta poza normalną rotacją.',
      peekPolicies: 'Prezydent podejrzy trzy kolejne ustawy z talii.',
      execute: 'Prezydent wskaże gracza do egzekucji.',
    };

    return {
      key: `power:${state.log?.[0]?.time || `${state.presidentIdx}:${state.execPower}`}`,
      title: '⚡ Moc Prezydencka',
      content: `
        <div class="event-modal-body">
          <div class="event-modal-lead">
            Prezydent <strong>${UI.escapeHtml(president?.username || '—')}</strong> otrzymuje moc:
          </div>
          <div class="event-highlight">${UI.escapeHtml(powerNames[state.execPower] || state.execPower || 'Nieznana moc')}</div>
          <div class="event-modal-note">${UI.escapeHtml(powerDesc[state.execPower] || 'Trwa specjalna akcja władzy.')}</div>
        </div>
      `,
    };
  },

  buildVetoProposalModal(state) {
    const president = state.players[state.presidentIdx];
    const chancellor = state.chancellorIdx != null ? state.players[state.chancellorIdx] : null;
    return {
      key: `veto:${state.log?.[0]?.time || `${state.presidentIdx}:${state.chancellorIdx}`}`,
      title: '🚫 Propozycja Veto',
      content: `
        <div class="event-modal-body">
          <div class="event-modal-lead">
            <strong>${UI.escapeHtml(chancellor?.username || 'Kanclerz')}</strong> proponuje odrzucenie obu kart.
          </div>
          <div class="event-modal-note">
            Prezydent <strong>${UI.escapeHtml(president?.username || 'Prezydent')}</strong> musi teraz zaakceptować albo odrzucić veto.
          </div>
        </div>
      `,
    };
  },

  buildLogEventModal(text) {
    const safeText = UI.escapeHtml(text);

    if (text.includes('Specjalne Wybory!')) {
      return {
        key: `log:${text}`,
        title: '🗳️ Specjalne Wybory',
        content: `<div class="event-modal-body"><div class="event-highlight">${safeText}</div></div>`,
      };
    }

    if (text.includes('skazuje na śmierć')) {
      return {
        key: `log:${text}`,
        title: '💀 Egzekucja',
        content: `<div class="event-modal-body"><div class="event-highlight">${safeText}</div></div>`,
      };
    }

    if (text.includes('VETO zaakceptowane')) {
      return {
        key: `log:${text}`,
        title: '🚫 Veto Przyjęte',
        content: `<div class="event-modal-body"><div class="event-highlight">${safeText}</div></div>`,
      };
    }

    if (text.includes('odmawia VETO')) {
      return {
        key: `log:${text}`,
        title: '🚫 Veto Odrzucone',
        content: `<div class="event-modal-body"><div class="event-highlight">${safeText}</div></div>`,
      };
    }

    if (text.includes('CHAOS!')) {
      return {
        key: `log:${text}`,
        title: '🌪️ Chaos Wyborczy',
        content: `<div class="event-modal-body"><div class="event-highlight">${safeText}</div></div>`,
      };
    }

    return null;
  },

  queueEventModal(modal) {
    if (!modal?.title || !modal?.content) return;
    const fingerprint = `${modal.key || modal.title}|${modal.content}`;
    if (fingerprint === this.lastEventFingerprint) return;
    this.lastEventFingerprint = fingerprint;
    this.eventModalQueue.push({ ...modal, fingerprint });
    this.flushEventModalQueue();
  },

  flushEventModalQueue() {
    if (this.eventModalPending || this.eventModalQueue.length === 0) return;
    if (document.getElementById('modal-overlay')) {
      setTimeout(() => this.flushEventModalQueue(), 250);
      return;
    }

    const modal = this.eventModalQueue.shift();
    if (!modal) return;
    this.eventModalPending = true;

    UI.showModal({
      title: modal.title,
      content: modal.content,
      actions: `<button class="btn btn-gold btn-full" onclick="Game.closeEventModal()">Dalej</button>`,
      onClose: () => this.closeEventModal(),
    });
  },

  closeEventModal() {
    UI.closeModal();
    this.eventModalPending = false;
    setTimeout(() => this.flushEventModalQueue(), 50);
  },

  getPendingClaimKey(claim = this.state?.pendingClaim) {
    if (!claim) return null;
    return `${claim.sessionId}:${claim.role}`;
  },

  maybePromptPendingClaim() {
    const claim = this.state?.pendingClaim;
    const key = this.getPendingClaimKey(claim);
    if (!claim || !key || this.shownClaimKey === key || this.state?.winner) return;
    if (document.getElementById('modal-overlay')) {
      setTimeout(() => this.maybePromptPendingClaim(), 250);
      return;
    }
    this.shownClaimKey = key;
    this.showClaimModal(claim);
  },

  openPendingClaimModal() {
    const claim = this.state?.pendingClaim;
    if (!claim) return;
    this.shownClaimKey = this.getPendingClaimKey(claim);
    this.showClaimModal(claim);
  },

  showClaimModal(claim) {
    const isPresident = claim.role === 'president';
    const roleLabel = isPresident ? 'Prezydent' : 'Kanclerz';
    const options = isPresident ? ['LLL', 'LLF', 'LFF', 'FFF'] : ['LL', 'LF', 'FF'];
    const optionButtons = options.map((summary) => `
      <button class="btn ${summary.includes('F') ? 'btn-red' : 'btn-blue'} btn-full" onclick="Game.declareClaim('${summary}')">${summary}</button>
    `).join('');

    UI.showModal({
      title: `🎙️ Deklaracja ${roleLabel}`,
      content: `
        <div class="claim-modal-body">
          <div class="event-modal-lead">
            Wybierz, co publicznie deklarujesz pozostałym graczom jako <strong>${roleLabel}</strong>.
          </div>
          <div class="claim-modal-note">
            To jest twoja deklaracja dla stołu. System opublikuje ją na czacie pokojowym. Możesz powiedzieć prawdę albo blefować.
          </div>
          <div class="claim-option-grid">${optionButtons}</div>
        </div>
      `,
      actions: `
        <button class="btn btn-ghost" style="flex:1" onclick="UI.closeModal()">Później</button>
        <button class="btn btn-gold" style="flex:1" onclick="Game.declareClaim('', true)">Pomiń deklarację</button>
      `,
    });
  },

  // ── AKCJE ──────────────────────────────────────────────────────────────────

  async action(name, payload = {}) {
    if (!this.roomId) return;
    try {
      await Socket.gameAction(this.roomId, name, payload);
    } catch (e) {
      const el = document.getElementById('game-error');
      if (el) { el.textContent = e.message; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 3000); }
      else alert(e.message);
    }
  },

  async confirmExecute(idx, name) {
    const ok = await UI.confirm(`Czy na pewno chcesz skazać na śmierć <strong>${UI.escapeHtml(name)}</strong>?`);
    if (ok) this.action('execute', { targetIdx: idx });
  },

  async restart() {
    const ok = await UI.confirm('Zresetować pokój do lobby? Wszyscy gracze wrócą do oczekiwania.');
    if (ok) {
      try { await Socket.restartGame(this.roomId); }
      catch (e) { alert(e.message); }
    }
  },

  async voteDisconnect(choice) {
    if (!this.roomId) return;
    try {
      await Socket.disconnectDecision(this.roomId, choice);
    } catch (e) {
      alert(e.message);
    }
  },

  async declareClaim(summary, skipped = false) {
    if (!this.roomId) return;
    try {
      await Socket.declareClaim(this.roomId, summary, skipped);
      UI.closeModal();
    } catch (e) {
      alert(e.message);
    }
  },
};
