// server/game.js — pełna logika Secret Hitlera

const DECK = [...Array(11).fill('F'), ...Array(6).fill('L')];

const CONFIGS = {
  5:  { liberals: 3, fascists: 1 },
  6:  { liberals: 4, fascists: 1 },
  7:  { liberals: 4, fascists: 2 },
  8:  { liberals: 5, fascists: 2 },
  9:  { liberals: 5, fascists: 3 },
  10: { liberals: 6, fascists: 3 },
};

// Moce: indeks = liczba faszystowskich ustaw - 1
const POWERS = {
  5:  [null,          null,          'peekPolicies',  'execute',         'execute',         null],
  6:  [null,          null,          'peekPolicies',  'execute',         'execute',         null],
  7:  [null,          'investigate', 'specialElection','execute',        'execute',         null],
  8:  [null,          'investigate', 'specialElection','execute',        'execute',         null],
  9:  ['investigate', 'investigate', 'specialElection','execute',        'execute',         null],
  10: ['investigate', 'investigate', 'specialElection','execute',        'execute',         null],
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getPower(n, fas) {
  const row = POWERS[Math.min(n, 10)] || POWERS[10];
  return row[fas - 1] || null;
}

function drawCards(deck, discard, count) {
  let d = [...deck], dis = [...discard];
  if (d.length < count) { d = shuffle([...d, ...dis]); dis = []; }
  const drawn = d.splice(0, count);
  return { drawn, deck: d, discard: dis };
}

function nextAlive(players, from) {
  let idx = (from + 1) % players.length;
  for (let i = 0; i < players.length; i++) {
    if (!players[idx].dead) return idx;
    idx = (idx + 1) % players.length;
  }
  return from;
}

// ── TWORZENIE GRY ─────────────────────────────────────────────────────────────
function createGame(playerList) {
  // playerList: [{id, username}]
  const n = playerList.length;
  const cfg = CONFIGS[n];
  if (!cfg) throw new Error(`Nieprawidłowa liczba graczy: ${n} (wymagane 5-10)`);

  const roles = shuffle([
    ...Array(cfg.liberals).fill('Liberal'),
    ...Array(cfg.fascists).fill('Fascist'),
    'Hitler',
  ]);

  const players = playerList.map((p, i) => ({
    id: p.id,
    username: p.username,
    role: roles[i],
    dead: false,
    connected: true,
  }));

  return {
    players,
    deck: shuffle([...DECK]),
    discard: [],
    lib: 0,
    fas: 0,
    electionTracker: 0,
    presidentIdx: 0,
    chancellorIdx: null,
    prevPresidentIdx: null,
    prevChancellorIdx: null,
    phase: 'nominate', // nominate | vote | presidentDiscard | chancellorDiscard | executive | end
    hand: [],          // karty w rękach (widoczne tylko dla danego gracza)
    presidentHand: [], // 3 karty dobrane przez prezydenta (zanim przekaże 2)
    votes: {},         // userId → 'Ja'|'Nein'
    investigated: {},  // userId → true (zbadany)
    spOrigin: null,    // indeks który wywołał specjalne wybory
    execPower: null,
    winner: null,
    winReason: '',
    log: [],
  };
}

// ── POMOCNICZE MUTACJE STANU ──────────────────────────────────────────────────
function addLog(state, msg) {
  return { ...state, log: [{ text: msg, time: new Date().toISOString() }, ...state.log].slice(0, 100) };
}

function checkWin(state) {
  if (state.lib >= 5)
    return { ...state, phase: 'end', winner: 'Liberal', winReason: 'Uchwalono 5 Liberalnych Ustaw!' };
  if (state.fas >= 6)
    return { ...state, phase: 'end', winner: 'Fascist', winReason: 'Uchwalono 6 Faszystowskich Ustaw!' };
  return state;
}

function advance(state, fromSpecial = false) {
  const from = (fromSpecial && state.spOrigin != null) ? state.spOrigin : state.presidentIdx;
  const nextIdx = nextAlive(state.players, from);
  return {
    ...state,
    presidentIdx: nextIdx,
    prevPresidentIdx: state.presidentIdx,
    prevChancellorIdx: state.chancellorIdx,
    chancellorIdx: null,
    phase: 'nominate',
    execPower: null,
    spOrigin: null,
    hand: [],
    presidentHand: [],
    votes: {},
  };
}

// Chaos: uchwal pierwszą kartę, BEZ mocy prezydenckich
function applyChaos(state) {
  const { drawn, deck, discard } = drawCards(state.deck, state.discard, 1);
  const policy = drawn[0];
  let s = addLog({ ...state, deck, discard, electionTracker: 0, prevPresidentIdx: null, prevChancellorIdx: null },
    `🌪️ CHAOS! Kraj przejmuje ustawę z talii (${policy === 'L' ? 'Liberalna' : 'Faszystowska'}) — bez mocy prezydenckiej!`);
  if (policy === 'L') s.lib++; else s.fas++;
  s = checkWin(s);
  if (s.winner) return s;
  // Chaos resetuje do normalnej rotacji
  return advance(s, false);
}

function enact(state, type) {
  let s = { ...state };
  if (type === 'L') { s.lib++; s = addLog(s, `📜 Liberalna Ustawa uchwalona! (${s.lib}/5)`); }
  else              { s.fas++; s = addLog(s, `🔴 Faszystowska Ustawa uchwalona! (${s.fas}/6)`); }
  s.electionTracker = 0;
  s = checkWin(s);
  if (s.winner) return s;

  if (type === 'F') {
    const pw = getPower(s.players.length, s.fas);
    if (pw) {
      const names = { investigate: 'Zbadaj Przynależność', specialElection: 'Specjalne Wybory', peekPolicies: 'Podgląd Ustaw', execute: 'Egzekucja' };
      s = addLog(s, `⚡ Prezydent ${s.players[s.presidentIdx].username} otrzymuje moc: ${names[pw]}`);
      return { ...s, phase: 'executive', execPower: pw };
    }
  }
  return advance(s, s.spOrigin != null);
}

// ── AKCJE GRACZA ─────────────────────────────────────────────────────────────

function nominate(state, presidentUserId, chancellorIdx) {
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== presidentUserId) throw new Error('Nie jesteś Prezydentem');
  if (state.phase !== 'nominate') throw new Error('Zła faza gry');
  const target = state.players[chancellorIdx];
  if (!target || target.dead) throw new Error('Nieprawidłowy kandydat');

  // Sprawdź ograniczenia kadencji
  const aliveCount = state.players.filter(p => !p.dead).length;
  if (chancellorIdx === state.presidentIdx) throw new Error('Nie możesz mianować siebie');
  if (aliveCount > 5) {
    if (chancellorIdx === state.prevPresidentIdx) throw new Error('Ten gracz jest ograniczony kadencją (poprzedni Prezydent)');
    if (chancellorIdx === state.prevChancellorIdx) throw new Error('Ten gracz jest ograniczony kadencją (poprzedni Kanclerz)');
  } else {
    if (chancellorIdx === state.prevChancellorIdx) throw new Error('Ten gracz jest ograniczony kadencją (poprzedni Kanclerz)');
  }

  let s = addLog({ ...state, chancellorIdx, phase: 'vote', votes: {} },
    `🏛️ ${presPlayer.username} nominuje ${target.username} na Kanclerza`);
  return s;
}

function vote(state, userId, choice) {
  if (state.phase !== 'vote') throw new Error('Zła faza gry');
  const player = state.players.find(p => p.id === userId);
  if (!player || player.dead) throw new Error('Nie możesz głosować');
  if (state.votes[userId] !== undefined) throw new Error('Już zagłosowałeś');
  if (choice !== 'Ja' && choice !== 'Nein') throw new Error('Nieprawidłowy głos');

  const newVotes = { ...state.votes, [userId]: choice };
  const alivePlayers = state.players.filter(p => !p.dead);
  const allVoted = alivePlayers.every(p => newVotes[p.id] !== undefined);

  let s = { ...state, votes: newVotes };

  if (!allVoted) return s;

  // Policz głosy
  const ja = Object.values(newVotes).filter(v => v === 'Ja').length;
  const nein = Object.values(newVotes).filter(v => v === 'Nein').length;
  const passed = ja > nein;

  // Ujawnij głosy w logu
  const voteStr = alivePlayers.map(p => `${p.username}: ${newVotes[p.id]}`).join(', ');
  s = addLog(s, `🗳️ Głosy: ${voteStr}`);
  s = addLog(s, `🗳️ Wynik: ${ja} Ja / ${nein} Nein — ${passed ? 'PRZESZŁO ✅' : 'ODRZUCONO ❌'}`);

  if (!passed) {
    s.electionTracker = s.electionTracker + 1;
    if (s.electionTracker >= 3) return applyChaos(s);
    // Przesuń prezydenturę do następnego (bez resetowania ograniczeń kadencji)
    const nextIdx = nextAlive(s.players, s.presidentIdx);
    return { ...s, presidentIdx: nextIdx, prevPresidentIdx: s.presidentIdx, prevChancellorIdx: s.chancellorIdx, chancellorIdx: null, phase: 'nominate', votes: {} };
  }

  // Przeszło — sprawdź Hitler win
  const chan = s.players[s.chancellorIdx];
  if (s.fas >= 3 && chan.role === 'Hitler') {
    s = addLog(s, `💀 Hitler (${chan.username}) wybrany Kanclerzem po 3+ faszystowskich ustawach!`);
    return { ...s, phase: 'end', winner: 'Fascist', winReason: `Hitler (${chan.username}) wybrany Kanclerzem!` };
  }

  // Dobierz 3 karty dla Prezydenta
  const { drawn, deck, discard } = drawCards(s.deck, s.discard, 3);
  return addLog({ ...s, presidentHand: drawn, deck, discard, phase: 'presidentDiscard' },
    `✅ Rząd zatwierdzony! ${s.players[s.presidentIdx].username} dobiera karty.`);
}

function presidentDiscard(state, userId, cardIndex) {
  if (state.phase !== 'presidentDiscard') throw new Error('Zła faza gry');
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');
  if (cardIndex < 0 || cardIndex >= state.presidentHand.length) throw new Error('Nieprawidłowy indeks karty');

  const discarded = state.presidentHand[cardIndex];
  const kept = state.presidentHand.filter((_, i) => i !== cardIndex);

  let s = addLog({ ...state, hand: kept, presidentHand: [], discard: [...state.discard, discarded], phase: 'chancellorDiscard' },
    `🤫 Prezydent ${presPlayer.username} odrzucił kartę`);
  return s;
}

function chancellorDiscard(state, userId, cardIndex) {
  if (state.phase !== 'chancellorDiscard') throw new Error('Zła faza gry');
  const chanPlayer = state.players[state.chancellorIdx];
  if (chanPlayer.id !== userId) throw new Error('Nie jesteś Kanclerzem');
  if (cardIndex < 0 || cardIndex >= state.hand.length) throw new Error('Nieprawidłowy indeks karty');

  const discarded = state.hand[cardIndex];
  const enacted = state.hand.find((_, i) => i !== cardIndex);

  let s = addLog({ ...state, hand: [], discard: [...state.discard, discarded] },
    `📜 Kanclerz ${chanPlayer.username} uchwala ustawę`);
  return enact(s, enacted);
}

function proposeVeto(state, userId) {
  if (state.phase !== 'chancellorDiscard') throw new Error('Zła faza');
  if (state.fas < 5) throw new Error('Veto niedostępne (potrzeba 5 faszystowskich ustaw)');
  const chanPlayer = state.players[state.chancellorIdx];
  if (chanPlayer.id !== userId) throw new Error('Nie jesteś Kanclerzem');
  let s = addLog({ ...state, phase: 'veto' }, `🚫 ${chanPlayer.username} proponuje VETO!`);
  return s;
}

function respondVeto(state, userId, accept) {
  if (state.phase !== 'veto') throw new Error('Zła faza');
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');

  if (!accept) {
    let s = addLog({ ...state, phase: 'chancellorDiscard' },
      `Prezydent ${presPlayer.username} odmawia VETO — Kanclerz musi uchwalić ustawę.`);
    return s;
  }

  let s = addLog({ ...state, hand: [], discard: [...state.discard, ...state.hand], electionTracker: state.electionTracker + 1 },
    `🚫 VETO zaakceptowane! Tor Wyborów: ${state.electionTracker + 1}/3`);
  if (s.electionTracker >= 3) return applyChaos(s);
  const nextIdx = nextAlive(s.players, s.presidentIdx);
  return { ...s, presidentIdx: nextIdx, prevPresidentIdx: s.presidentIdx, prevChancellorIdx: s.chancellorIdx, chancellorIdx: null, phase: 'nominate', votes: {} };
}

// ── MOCE WYKONAWCZE ───────────────────────────────────────────────────────────

function executePeek(state, userId) {
  if (state.phase !== 'executive' || state.execPower !== 'peekPolicies') throw new Error('Zła faza/moc');
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');
  // Zwracamy top 3 karty (widoczne tylko dla Prezydenta) — nie zmieniamy talii
  const top3 = state.deck.slice(0, 3).length < 3
    ? shuffle([...state.deck, ...state.discard]).slice(0, 3)
    : state.deck.slice(0, 3);
  let s = addLog({ ...state, phase: 'executiveDone', execPower: null },
    `👁️ ${presPlayer.username} podgląda 3 kolejne ustawy`);
  return { s, peek: top3 };
}

function executeInvestigate(state, userId, targetIdx) {
  if (state.phase !== 'executive' || state.execPower !== 'investigate') throw new Error('Zła faza/moc');
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');
  const target = state.players[targetIdx];
  if (!target || target.dead) throw new Error('Nieprawidłowy cel');
  if (state.investigated[target.id]) throw new Error('Ten gracz był już zbadany');
  if (targetIdx === state.presidentIdx) throw new Error('Nie możesz zbadać siebie');

  const party = target.role === 'Liberal' ? 'Liberal' : 'Fascist';
  let s = addLog({
    ...state,
    investigated: { ...state.investigated, [target.id]: true },
    phase: 'executiveDone',
    execPower: null,
  }, `🔍 ${presPlayer.username} bada przynależność ${target.username}`);
  return { s, party, targetUsername: target.username };
}

function executeSpecialElection(state, userId, targetIdx) {
  if (state.phase !== 'executive' || state.execPower !== 'specialElection') throw new Error('Zła faza/moc');
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');
  const target = state.players[targetIdx];
  if (!target || target.dead) throw new Error('Nieprawidłowy cel');
  if (targetIdx === state.presidentIdx) throw new Error('Nie możesz wybrać siebie');

  let s = addLog({
    ...state,
    spOrigin: state.presidentIdx,
    prevPresidentIdx: state.presidentIdx,
    prevChancellorIdx: state.chancellorIdx,
    presidentIdx: targetIdx,
    chancellorIdx: null,
    phase: 'nominate',
    execPower: null,
    votes: {},
  }, `🗳️ Specjalne Wybory! ${target.username} zostaje tymczasowym Prezydentem.`);
  return s;
}

function executeKill(state, userId, targetIdx) {
  if (state.phase !== 'executive' || state.execPower !== 'execute') throw new Error('Zła faza/moc');
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');
  const target = state.players[targetIdx];
  if (!target || target.dead) throw new Error('Nieprawidłowy cel');
  if (targetIdx === state.presidentIdx) throw new Error('Nie możesz zabić siebie');

  const newPlayers = state.players.map((p, i) => i === targetIdx ? { ...p, dead: true } : p);
  let s = addLog({ ...state, players: newPlayers }, `💀 ${presPlayer.username} skazuje na śmierć ${target.username}!`);

  if (target.role === 'Hitler') {
    return { ...s, phase: 'end', winner: 'Liberal', winReason: `Hitler (${target.username}) został zamordowany!` };
  }
  // Rola zabitego pozostaje tajna!
  return advance(s, s.spOrigin != null);
}

// Po peek — przesuń kadencję
function finishPeekAction(state) {
  if (state.phase !== 'executiveDone') return state;
  return advance(state, state.spOrigin != null);
}

// ── WIDOK DLA GRACZA (ukrywa role innych) ─────────────────────────────────────
function getPlayerView(state, userId) {
  const myIdx = state.players.findIndex(p => p.id === userId);
  const me = myIdx >= 0 ? state.players[myIdx] : null;

  const players = state.players.map((p, i) => {
    // Ujawnij role: swoją zawsze; faszystom — innych faszystów i hitlera (gra ≤6); hitlerowi — faszystów (gra ≤6)
    const n = state.players.length;
    let revealRole = false;
    if (p.id === userId) revealRole = true; // zawsze widzisz swoją rolę
    if (me && me.role === 'Fascist' && (p.role === 'Fascist' || p.role === 'Hitler')) revealRole = true;
    if (me && me.role === 'Hitler' && n <= 6 && p.role === 'Fascist') revealRole = true;
    if (state.phase === 'end') revealRole = true; // koniec gry — ujawnij wszystko

    return {
      id: p.id,
      username: p.username,
      dead: p.dead,
      role: revealRole ? p.role : null,
      connected: p.connected,
    };
  });

  // Karty widoczne tylko dla właściwego gracza
  const isPresident = me && state.players[state.presidentIdx]?.id === userId;
  const isChancellor = me && state.chancellorIdx !== null && state.players[state.chancellorIdx]?.id === userId;

  return {
    players,
    lib: state.lib,
    fas: state.fas,
    electionTracker: state.electionTracker,
    presidentIdx: state.presidentIdx,
    chancellorIdx: state.chancellorIdx,
    prevPresidentIdx: state.prevPresidentIdx,
    prevChancellorIdx: state.prevChancellorIdx,
    phase: state.phase,
    execPower: state.execPower,
    winner: state.winner,
    winReason: state.winReason,
    log: state.log,
    votes: state.votes, // ujawniane po zebraniu wszystkich
    investigated: state.investigated,
    spOrigin: state.spOrigin,
    // Karty tylko dla danej roli
    presidentHand: isPresident && state.phase === 'presidentDiscard' ? state.presidentHand : null,
    chancellorHand: isChancellor && state.phase === 'chancellorDiscard' ? state.hand : null,
    canVeto: state.fas >= 5,
    myIdx,
    myRole: me ? me.role : null,
    deckSize: state.deck.length,
    discardSize: state.discard.length,
  };
}

module.exports = {
  createGame, addLog, checkWin, advance,
  nominate, vote, presidentDiscard, chancellorDiscard,
  proposeVeto, respondVeto,
  executePeek, executeInvestigate, executeSpecialElection, executeKill,
  finishPeekAction, getPlayerView,
  CONFIGS,
};
