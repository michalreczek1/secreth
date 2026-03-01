// server/game.js — pełna logika Secret Hitlera

const { randomUUID } = require('crypto');

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

function ensureDeckHasCards(deck, discard, count) {
  let d = [...deck];
  let dis = [...discard];
  if (d.length < count) {
    d = shuffle([...d, ...dis]);
    dis = [];
  }
  return { deck: d, discard: dis };
}

function nextAlive(players, from) {
  let idx = (from + 1) % players.length;
  for (let i = 0; i < players.length; i++) {
    if (!players[idx].dead) return idx;
    idx = (idx + 1) % players.length;
  }
  return from;
}

function getVotesSubmitted(state) {
  return Object.keys(state.votes || {}).length;
}

function allAlivePlayersVoted(state) {
  const alivePlayers = state.players.filter(p => !p.dead);
  return alivePlayers.every(p => state.votes?.[p.id] !== undefined);
}

function summarizePolicies(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return '';
  const liberalCount = cards.filter(card => card === 'L').length;
  const fascistCount = cards.length - liberalCount;
  return `${'L'.repeat(liberalCount)}${'F'.repeat(fascistCount)}`;
}

function createClaimSession(state) {
  const president = state.players[state.presidentIdx];
  const chancellor = state.chancellorIdx != null ? state.players[state.chancellorIdx] : null;
  if (!president || !chancellor) return null;
  return {
    sessionId: randomUUID(),
    presidentId: president.id,
    presidentName: president.username,
    presidentReady: false,
    presidentSubmitted: false,
    presidentActual: null,
    chancellorId: chancellor.id,
    chancellorName: chancellor.username,
    chancellorReady: false,
    chancellorSubmitted: false,
    chancellorActual: null,
  };
}

function getClaimSessions(state) {
  return Array.isArray(state.claimSessions) ? state.claimSessions : [];
}

function appendClaimSession(state, session) {
  return [...getClaimSessions(state), session].slice(-12);
}

function updateLatestClaimSession(state, updater) {
  const sessions = getClaimSessions(state);
  if (!sessions.length) return sessions;
  const updated = [...sessions];
  updated[updated.length - 1] = updater(updated[updated.length - 1]);
  return updated;
}

function appendVoteHistory(state, votes, passed) {
  const alivePlayers = state.players.filter(p => !p.dead);
  const president = state.players[state.presidentIdx];
  const chancellor = state.chancellorIdx != null ? state.players[state.chancellorIdx] : null;
  const entry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    presidentId: president?.id || null,
    presidentName: president?.username || '',
    chancellorId: chancellor?.id || null,
    chancellorName: chancellor?.username || '',
    passed: !!passed,
    votes: alivePlayers.map((player) => ({
      userId: player.id,
      username: player.username,
      vote: votes[player.id] || null,
    })),
  };
  return [entry, ...(state.voteHistory || [])].slice(0, 20);
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
    gameId: randomUUID(),
    players,
    deck: shuffle([...DECK]),
    discard: [],
    lib: 0,
    fas: 0,
    electionTracker: 0,
    presidentIdx: Math.floor(Math.random() * players.length),
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
    voteHistory: [],
    claimSessions: [],
  };
}

// ── POMOCNICZE MUTACJE STANU ──────────────────────────────────────────────────
function addLog(state, msg) {
  return { ...state, log: [{ text: msg, time: new Date().toISOString() }, ...state.log].slice(0, 100) };
}

function checkWin(state) {
  if (state.lib >= 5)
    return { ...state, phase: 'end', winner: 'Liberal', winReason: 'Uchwalono 5 Liberalnych Ustaw!', claimSessions: [] };
  if (state.fas >= 6)
    return { ...state, phase: 'end', winner: 'Fascist', winReason: 'Uchwalono 6 Faszystowskich Ustaw!', claimSessions: [] };
  return state;
}

function advance(state, fromSpecial = false, options = {}) {
  const { recordGovernment = true, resetTermLimits = false } = options;
  const from = (fromSpecial && state.spOrigin != null) ? state.spOrigin : state.presidentIdx;
  const nextIdx = nextAlive(state.players, from);
  return {
    ...state,
    presidentIdx: nextIdx,
    prevPresidentIdx: resetTermLimits ? null : (recordGovernment ? state.presidentIdx : state.prevPresidentIdx),
    prevChancellorIdx: resetTermLimits ? null : (recordGovernment ? state.chancellorIdx : state.prevChancellorIdx),
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
  return advance(s, s.spOrigin != null, { recordGovernment: false, resetTermLimits: true });
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
  return advance(s, s.spOrigin != null, { recordGovernment: true });
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
  s = { ...s, voteHistory: appendVoteHistory(s, newVotes, passed) };
  s = addLog(s, `🗳️ Głosy: ${voteStr}`);
  s = addLog(s, `🗳️ Wynik: ${ja} Ja / ${nein} Nein — ${passed ? 'PRZESZŁO ✅' : 'ODRZUCONO ❌'}`);

  if (!passed) {
    s.electionTracker = s.electionTracker + 1;
    if (s.electionTracker >= 3) return applyChaos(s);
    // Przesuń prezydenturę do następnego (bez resetowania ograniczeń kadencji)
    return advance(s, s.spOrigin != null, { recordGovernment: false });
  }

  // Przeszło — sprawdź Hitler win
  const chan = s.players[s.chancellorIdx];
  if (s.fas >= 3 && chan.role === 'Hitler') {
    s = addLog(s, `💀 Hitler (${chan.username}) wybrany Kanclerzem po 3+ faszystowskich ustawach!`);
    return { ...s, phase: 'end', winner: 'Fascist', winReason: `Hitler (${chan.username}) wybrany Kanclerzem!`, claimSessions: [] };
  }

  // Dobierz 3 karty dla Prezydenta
  const { drawn, deck, discard } = drawCards(s.deck, s.discard, 3);
  return addLog({ ...s, presidentHand: drawn, deck, discard, phase: 'presidentDiscard', claimSessions: appendClaimSession(s, createClaimSession(s)) },
    `✅ Rząd zatwierdzony! ${s.players[s.presidentIdx].username} dobiera karty.`);
}

function presidentDiscard(state, userId, cardIndex) {
  if (state.phase !== 'presidentDiscard') throw new Error('Zła faza gry');
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');
  if (cardIndex < 0 || cardIndex >= state.presidentHand.length) throw new Error('Nieprawidłowy indeks karty');

  const discarded = state.presidentHand[cardIndex];
  const kept = state.presidentHand.filter((_, i) => i !== cardIndex);
  const claimSessions = updateLatestClaimSession(state, (session) => ({
    ...session,
    presidentReady: true,
    presidentActual: summarizePolicies(state.presidentHand),
  }));

  let s = addLog({ ...state, hand: kept, presidentHand: [], discard: [...state.discard, discarded], phase: 'chancellorDiscard', claimSessions },
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
  const claimSessions = updateLatestClaimSession(state, (session) => ({
    ...session,
    chancellorReady: true,
    chancellorActual: summarizePolicies(state.hand),
  }));

  let s = addLog({ ...state, hand: [], discard: [...state.discard, discarded], claimSessions },
    `📜 Kanclerz ${chanPlayer.username} uchwala ustawę`);
  return enact(s, enacted);
}

function proposeVeto(state, userId) {
  if (state.phase !== 'chancellorDiscard') throw new Error('Zła faza');
  if (state.fas < 5) throw new Error('Veto niedostępne (potrzeba 5 faszystowskich ustaw)');
  const chanPlayer = state.players[state.chancellorIdx];
  if (chanPlayer.id !== userId) throw new Error('Nie jesteś Kanclerzem');
  const claimSessions = updateLatestClaimSession(state, (session) => ({
    ...session,
    chancellorReady: true,
    chancellorActual: summarizePolicies(state.hand),
  }));
  let s = addLog({ ...state, phase: 'veto', claimSessions }, `🚫 ${chanPlayer.username} proponuje VETO!`);
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
  return advance(s, s.spOrigin != null, { recordGovernment: false });
}

// ── MOCE WYKONAWCZE ───────────────────────────────────────────────────────────

function executePeek(state, userId) {
  if (state.phase !== 'executive' || state.execPower !== 'peekPolicies') throw new Error('Zła faza/moc');
  const presPlayer = state.players[state.presidentIdx];
  if (presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');
  const { deck, discard } = ensureDeckHasCards(state.deck, state.discard, 3);
  const top3 = deck.slice(0, 3);
  let s = addLog({ ...state, deck, discard, phase: 'executiveDone', execPower: null },
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
    return { ...s, phase: 'end', winner: 'Liberal', winReason: `Hitler (${target.username}) został zamordowany!`, claimSessions: [] };
  }
  // Rola zabitego pozostaje tajna!
  return advance(s, s.spOrigin != null, { recordGovernment: true });
}

// Po peek — przesuń kadencję
function finishPeekAction(state, userId) {
  if (state.phase !== 'executiveDone') throw new Error('Zła faza gry');
  const presPlayer = state.players[state.presidentIdx];
  if (!presPlayer || presPlayer.id !== userId) throw new Error('Nie jesteś Prezydentem');
  return advance(state, state.spOrigin != null, { recordGovernment: true });
}

function submitClaim(state, userId, sessionId, summary, skipped = false) {
  const sessions = getClaimSessions(state);
  if (!sessions.length) throw new Error('Brak aktywnej deklaracji');

  let sessionIndex = sessions.findIndex((session) => session.sessionId === sessionId);
  if (sessionIndex < 0) {
    sessionIndex = sessions.findIndex((session) =>
      (session.presidentId === userId && session.presidentReady && !session.presidentSubmitted) ||
      (session.chancellorId === userId && session.chancellorReady && !session.chancellorSubmitted)
    );
  }
  if (sessionIndex < 0) throw new Error('Deklaracja nie jest już dostępna');

  const session = { ...sessions[sessionIndex] };
  const isPresident = session.presidentId === userId;
  const isChancellor = session.chancellorId === userId;
  if (!isPresident && !isChancellor) throw new Error('Ta deklaracja nie należy do ciebie');

  const role = isPresident ? 'president' : 'chancellor';
  const readyKey = isPresident ? 'presidentReady' : 'chancellorReady';
  const submittedKey = isPresident ? 'presidentSubmitted' : 'chancellorSubmitted';
  const actualKey = isPresident ? 'presidentActual' : 'chancellorActual';
  const expectedOptions = isPresident ? ['LLL', 'LLF', 'LFF', 'FFF'] : ['LL', 'LF', 'FF'];
  if (!session[readyKey]) throw new Error('Twoja deklaracja nie jest jeszcze gotowa');
  if (session[submittedKey]) throw new Error('Deklaracja została już wysłana');
  if (!skipped && !expectedOptions.includes(summary)) throw new Error('Nieprawidłowa deklaracja');

  session[submittedKey] = true;
  const nextSessions = [...sessions];
  nextSessions[sessionIndex] = session;
  const cleanedSessions = nextSessions.filter((item) => !(item.presidentSubmitted && item.chancellorSubmitted));
  const nextState = { ...state, claimSessions: cleanedSessions };

  return {
    state: nextState,
    claim: {
      sessionId: session.sessionId,
      role,
      userId,
      username: isPresident ? session.presidentName : session.chancellorName,
      summary: skipped ? null : summary,
      skipped: !!skipped,
      actualSummary: session[actualKey] || null,
    },
  };
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
  let pendingClaim = null;
  for (const session of getClaimSessions(state)) {
    if (session.presidentId === userId && session.presidentReady && !session.presidentSubmitted) {
      pendingClaim = {
        sessionId: session.sessionId,
        role: 'president',
        username: session.presidentName,
        optionCount: 3,
        actualSummary: session.presidentActual || null,
      };
      break;
    }
    if (session.chancellorId === userId && session.chancellorReady && !session.chancellorSubmitted) {
      pendingClaim = {
        sessionId: session.sessionId,
        role: 'chancellor',
        username: session.chancellorName,
        optionCount: 2,
        actualSummary: session.chancellorActual || null,
      };
      break;
    }
  }

  return {
    gameId: state.gameId,
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
    voteHistory: state.voteHistory || [],
    votes: state.phase === 'vote' && !allAlivePlayersVoted(state) ? {} : state.votes,
    votesSubmitted: getVotesSubmitted(state),
    myVote: me ? state.votes?.[me.id] || null : null,
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
    pendingClaim,
  };
}

module.exports = {
  createGame, addLog, checkWin, advance,
  nominate, vote, presidentDiscard, chancellorDiscard,
  proposeVeto, respondVeto,
  executePeek, executeInvestigate, executeSpecialElection, executeKill,
  finishPeekAction, submitClaim, getPlayerView,
  CONFIGS,
};
