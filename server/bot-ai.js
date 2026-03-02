const DIFFICULTIES = ['easy', 'medium', 'hard'];

const BOT_PROFILES = {
  easy: {
    suspicionWeight: 0.6,
    lieChanceFascist: 0.15,
    lieChanceHitler: 0.1,
    voteRandomness: 18,
    claimTrustWeight: 0.4,
    executiveWeight: 0.6,
  },
  medium: {
    suspicionWeight: 1,
    lieChanceFascist: 0.38,
    lieChanceHitler: 0.26,
    voteRandomness: 10,
    claimTrustWeight: 0.8,
    executiveWeight: 1,
  },
  hard: {
    suspicionWeight: 1.35,
    lieChanceFascist: 0.62,
    lieChanceHitler: 0.48,
    voteRandomness: 4,
    claimTrustWeight: 1.2,
    executiveWeight: 1.35,
  },
};

function normalizeDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : 'medium';
}

function getProfile(difficulty) {
  return BOT_PROFILES[normalizeDifficulty(difficulty)];
}

function isBotId(userId) {
  return typeof userId === 'string' && userId.startsWith('bot:');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function alivePlayers(state) {
  return state.players.filter((player) => !player.dead);
}

function makeBaseMemory(state, bot) {
  const suspicions = {};
  const knownTeam = {};
  for (const player of state.players) {
    suspicions[player.id] = 0;
    knownTeam[player.id] = null;
  }

  suspicions[bot.id] = bot.role === 'Liberal' ? -90 : 90;
  knownTeam[bot.id] = bot.role === 'Liberal' ? 'liberal' : bot.role === 'Hitler' ? 'hitler' : 'fascist';

  const fascists = state.players.filter((player) => player.role === 'Fascist');
  const hitler = state.players.find((player) => player.role === 'Hitler');
  if (bot.role === 'Fascist') {
    for (const player of fascists) {
      suspicions[player.id] = 95;
      knownTeam[player.id] = 'fascist';
    }
    if (hitler) {
      suspicions[hitler.id] = 85;
      knownTeam[hitler.id] = 'hitler';
    }
  } else if (bot.role === 'Hitler' && state.players.length <= 6) {
    for (const player of fascists) {
      suspicions[player.id] = 95;
      knownTeam[player.id] = 'fascist';
    }
  }

  return {
    suspicions,
    voteRecords: [],
    claimRecords: [],
    knownTeam,
    lastGovernmentEvaluation: null,
    lastUpdatedAt: new Date().toISOString(),
    processedVoteIds: [],
    processedClaimKeys: [],
    processedPolicyKeys: [],
    processedExecutiveKeys: [],
  };
}

function ensureBotMemoryState(state) {
  if (!state.botMemory || typeof state.botMemory !== 'object') state.botMemory = {};
  for (const bot of state.players.filter((player) => isBotId(player.id) || state.botControlled?.[player.id])) {
    if (!state.botMemory[bot.id]) state.botMemory[bot.id] = makeBaseMemory(state, bot);
    const memory = state.botMemory[bot.id];
    if (!memory.suspicions) memory.suspicions = {};
    if (!memory.knownTeam) memory.knownTeam = {};
    if (!Array.isArray(memory.voteRecords)) memory.voteRecords = [];
    if (!Array.isArray(memory.claimRecords)) memory.claimRecords = [];
    if (!Array.isArray(memory.processedVoteIds)) memory.processedVoteIds = [];
    if (!Array.isArray(memory.processedClaimKeys)) memory.processedClaimKeys = [];
    if (!Array.isArray(memory.processedPolicyKeys)) memory.processedPolicyKeys = [];
    if (!Array.isArray(memory.processedExecutiveKeys)) memory.processedExecutiveKeys = [];
    for (const player of state.players) {
      if (!Object.prototype.hasOwnProperty.call(memory.suspicions, player.id)) memory.suspicions[player.id] = 0;
      if (!Object.prototype.hasOwnProperty.call(memory.knownTeam, player.id)) memory.knownTeam[player.id] = null;
    }
  }
  return state;
}

function updateSuspicion(memory, playerId, delta) {
  if (!memory || !playerId || !Object.prototype.hasOwnProperty.call(memory.suspicions, playerId)) return;
  memory.suspicions[playerId] = clamp((memory.suspicions[playerId] || 0) + delta, -100, 100);
  memory.lastUpdatedAt = new Date().toISOString();
}

function getSuspicion(memory, playerId) {
  return memory?.suspicions?.[playerId] || 0;
}

function knownAlignment(memory, playerId) {
  return memory?.knownTeam?.[playerId] || null;
}

function rememberVoteHistory(state) {
  ensureBotMemoryState(state);
  const latest = Array.isArray(state.voteHistory) ? state.voteHistory[0] : null;
  if (!latest?.id) return state;
  const enactedFascist = state.log?.[0]?.text?.includes('Faszystowska Ustawa') || false;
  const enactedLiberal = state.log?.[0]?.text?.includes('Liberalna Ustawa') || false;

  for (const bot of state.players.filter((player) => isBotId(player.id))) {
    const memory = state.botMemory[bot.id];
    if (memory.processedVoteIds.includes(latest.id)) continue;
    memory.processedVoteIds.push(latest.id);
    memory.voteRecords.unshift({
      id: latest.id,
      createdAt: latest.createdAt,
      presidentId: latest.presidentId,
      chancellorId: latest.chancellorId,
      passed: latest.passed,
      votes: latest.votes,
    });
    memory.voteRecords = memory.voteRecords.slice(0, 30);

    if (latest.passed) {
      if (latest.presidentId) updateSuspicion(memory, latest.presidentId, latest.passed ? 2 : 0);
      if (latest.chancellorId) updateSuspicion(memory, latest.chancellorId, latest.passed ? 4 : 0);
    }

    for (const vote of latest.votes || []) {
      if (!vote.vote) continue;
      if (latest.passed && enactedFascist && vote.vote === 'Ja') updateSuspicion(memory, vote.userId, 8);
      if (latest.passed && enactedLiberal && vote.vote === 'Ja') updateSuspicion(memory, vote.userId, -4);
      if (latest.passed && enactedFascist && vote.vote === 'Nein') updateSuspicion(memory, vote.userId, -3);
      if (latest.passed && enactedLiberal && vote.vote === 'Nein') updateSuspicion(memory, vote.userId, 2);
    }
  }

  return state;
}

function rememberClaimHistory(state) {
  ensureBotMemoryState(state);
  const latest = Array.isArray(state.claimHistory) ? state.claimHistory[0] : null;
  if (!latest?.sessionId) return state;
  const claimKey = `${latest.sessionId}:${latest.presidentClaim || ''}:${latest.chancellorClaim || ''}:${latest.presidentSkipped ? 'p1' : 'p0'}:${latest.chancellorSkipped ? 'c1' : 'c0'}`;

  for (const bot of state.players.filter((player) => isBotId(player.id))) {
    const memory = state.botMemory[bot.id];
    if (memory.processedClaimKeys.includes(claimKey)) continue;
    memory.processedClaimKeys.push(claimKey);
    memory.claimRecords.unshift({
      key: claimKey,
      createdAt: latest.createdAt,
      presidentId: latest.presidentId,
      chancellorId: latest.chancellorId,
      presidentClaim: latest.presidentClaim,
      chancellorClaim: latest.chancellorClaim,
      presidentSkipped: !!latest.presidentSkipped,
      chancellorSkipped: !!latest.chancellorSkipped,
    });
    memory.claimRecords = memory.claimRecords.slice(0, 30);

    if (latest.presidentSkipped) updateSuspicion(memory, latest.presidentId, 4);
    if (latest.chancellorSkipped) updateSuspicion(memory, latest.chancellorId, 4);

    if (latest.presidentClaim && latest.chancellorClaim) {
      const presLib = latest.presidentClaim.split('').filter((card) => card === 'L').length;
      const chanLib = latest.chancellorClaim.split('').filter((card) => card === 'L').length;
      const gap = Math.abs(presLib - chanLib);
      if (gap >= 2) {
        updateSuspicion(memory, latest.presidentId, 8);
        updateSuspicion(memory, latest.chancellorId, 8);
      } else if (gap === 1) {
        updateSuspicion(memory, latest.presidentId, 2);
        updateSuspicion(memory, latest.chancellorId, 2);
      } else {
        updateSuspicion(memory, latest.presidentId, -2);
        updateSuspicion(memory, latest.chancellorId, -2);
      }
    }
  }

  return state;
}

function rememberPolicyAndExecutive(prevState, state, context = {}) {
  ensureBotMemoryState(state);
  const policyKey = `${state.gameId}:${state.lib}:${state.fas}`;
  const libChanged = prevState ? state.lib > prevState.lib : false;
  const fasChanged = prevState ? state.fas > prevState.fas : false;
  const executiveKey = context.action && ['investigate', 'specialElection', 'execute'].includes(context.action)
    ? `${state.gameId}:${context.action}:${context.userId}:${context.payload?.targetIdx ?? 'none'}`
    : null;

  for (const bot of state.players.filter((player) => isBotId(player.id))) {
    const memory = state.botMemory[bot.id];
    if ((libChanged || fasChanged) && !memory.processedPolicyKeys.includes(policyKey)) {
      memory.processedPolicyKeys.push(policyKey);
      const president = prevState?.players?.[prevState.presidentIdx];
      const chancellor = prevState?.chancellorIdx != null ? prevState.players[prevState.chancellorIdx] : null;
      if (fasChanged) {
        if (president) updateSuspicion(memory, president.id, 8);
        if (chancellor) updateSuspicion(memory, chancellor.id, 10);
      } else if (libChanged) {
        if (president) updateSuspicion(memory, president.id, -5);
        if (chancellor) updateSuspicion(memory, chancellor.id, -7);
      }
    }

    if (executiveKey && !memory.processedExecutiveKeys.includes(executiveKey)) {
      memory.processedExecutiveKeys.push(executiveKey);
      const targetPlayer = prevState?.players?.[context.payload?.targetIdx];
      if (context.action === 'execute' && targetPlayer) {
        if (targetPlayer.role === 'Liberal') updateSuspicion(memory, context.userId, 14);
        else updateSuspicion(memory, context.userId, -8);
      }
      if (context.action === 'specialElection' && targetPlayer) {
        updateSuspicion(memory, context.userId, getSuspicion(memory, targetPlayer.id) > 25 ? 5 : -2);
      }
    }
  }

  return state;
}

function updateMemoryFromTransition(prevState, state, context = {}) {
  ensureBotMemoryState(state);
  rememberVoteHistory(state);
  rememberClaimHistory(state);
  rememberPolicyAndExecutive(prevState, state, context);
  return state;
}

function sortCandidatesByScore(candidates, scorer) {
  return [...candidates]
    .map((candidate) => ({ candidate, score: scorer(candidate) }))
    .sort((a, b) => b.score - a.score);
}

function getEligibleChancellors(state) {
  const aliveCount = alivePlayers(state).length;
  return state.players
    .map((player, i) => ({ ...player, i }))
    .filter((player) => {
      if (player.dead || player.i === state.presidentIdx) return false;
      if (aliveCount > 5) {
        if (player.i === state.prevPresidentIdx || player.i === state.prevChancellorIdx) return false;
      } else if (player.i === state.prevChancellorIdx) {
        return false;
      }
      return true;
    });
}

function scoreChancellorCandidate(state, botId, candidateId, profile) {
  const bot = state.players.find((player) => player.id === botId);
  const memory = state.botMemory?.[botId];
  const candidate = state.players.find((player) => player.id === candidateId);
  if (!bot || !candidate || !memory) return -999;
  const suspicion = getSuspicion(memory, candidateId);
  const known = knownAlignment(memory, candidateId);
  let score = -suspicion * profile.suspicionWeight;

  if (bot.role === 'Liberal') {
    if (known === 'liberal') score += 25;
    if (known === 'fascist' || known === 'hitler') score -= 120;
  } else if (bot.role === 'Fascist') {
    if (known === 'fascist' || known === 'hitler') score += 120;
    else score += suspicion * 0.8;
  } else if (bot.role === 'Hitler') {
    if (state.fas >= 3) {
      score += suspicion < 20 ? 18 : -18;
    } else {
      score += suspicion < 10 ? 10 : -8;
    }
    if (known === 'fascist') score += state.players.length <= 6 ? 20 : 4;
  }

  score += Math.random() * profile.voteRandomness;
  return score;
}

function chooseChancellorCandidate(state, botId, difficulty) {
  const profile = getProfile(difficulty);
  const eligible = getEligibleChancellors(state);
  const ranked = sortCandidatesByScore(eligible, (candidate) => scoreChancellorCandidate(state, botId, candidate.id, profile));
  return ranked[0]?.candidate || null;
}

function chooseVote(state, botId, difficulty) {
  const profile = getProfile(difficulty);
  const bot = state.players.find((player) => player.id === botId);
  const memory = state.botMemory?.[botId];
  if (!bot || !memory) return 'Nein';
  if (state.players[state.presidentIdx]?.id === botId || state.players[state.chancellorIdx]?.id === botId) return 'Ja';

  const president = state.players[state.presidentIdx];
  const chancellor = state.players[state.chancellorIdx];
  const presSusp = president ? getSuspicion(memory, president.id) : 0;
  const chanSusp = chancellor ? getSuspicion(memory, chancellor.id) : 0;
  let score = -(presSusp + chanSusp * 1.2) * profile.suspicionWeight;

  if (bot.role === 'Liberal') {
    if (state.fas >= 3 && chancellor && chanSusp > 30) score -= 30;
    if (knownAlignment(memory, president?.id) === 'liberal') score += 12;
    if (knownAlignment(memory, chancellor?.id) === 'liberal') score += 15;
  } else if (bot.role === 'Fascist') {
    if (knownAlignment(memory, president?.id) === 'fascist') score += 35;
    if (knownAlignment(memory, chancellor?.id) === 'fascist' || knownAlignment(memory, chancellor?.id) === 'hitler') score += 45;
    score += (presSusp + chanSusp) * 0.4;
  } else if (bot.role === 'Hitler') {
    if (state.fas >= 3 && chancellor?.id === botId) score += 100;
    score += chanSusp < 15 ? 18 : -10;
    if (knownAlignment(memory, president?.id) === 'fascist') score += 10;
  }

  score += (Math.random() * profile.voteRandomness * 2) - profile.voteRandomness;
  return score >= 0 ? 'Ja' : 'Nein';
}

function chooseDiscard(cards, role, difficulty, context = {}) {
  if (!Array.isArray(cards) || !cards.length) return 0;
  const profile = getProfile(difficulty);
  const liberalCount = cards.filter((card) => card === 'L').length;
  const fascistCount = cards.length - liberalCount;

  if (role === 'Liberal') {
    const idx = cards.findIndex((card) => card === 'F');
    return idx >= 0 ? idx : 0;
  }

  if (role === 'Fascist' || role === 'Hitler') {
    if (context.phase === 'presidentDiscard' && liberalCount >= 2 && Math.random() < profile.lieChanceFascist * 0.35) {
      const idx = cards.findIndex((card) => card === 'L');
      return idx >= 0 ? idx : 0;
    }
    if (context.phase === 'chancellorDiscard' && liberalCount >= 1 && fascistCount >= 1) {
      const preferLiberal = role === 'Hitler' && context.fas < 3 && Math.random() < profile.lieChanceHitler * 0.4;
      if (preferLiberal) {
        const idx = cards.findIndex((card) => card === 'F');
        return idx >= 0 ? idx : 0;
      }
    }
    const idx = cards.findIndex((card) => card === 'L');
    return idx >= 0 ? idx : 0;
  }

  return 0;
}

function shouldProposeVeto(state, botId, difficulty) {
  const bot = state.players.find((player) => player.id === botId);
  if (!bot || !Array.isArray(state.hand) || state.hand.length !== 2 || state.fas < 5) return false;
  const profile = getProfile(difficulty);
  const liberalCount = state.hand.filter((card) => card === 'L').length;
  const fascistCount = state.hand.length - liberalCount;

  if (bot.role === 'Liberal') return fascistCount === 2;
  if (bot.role === 'Hitler') return liberalCount === 2 && Math.random() < profile.lieChanceHitler;
  return liberalCount === 2 && Math.random() < profile.lieChanceFascist;
}

function chooseExecutiveTarget(state, botId, mode, difficulty) {
  const bot = state.players.find((player) => player.id === botId);
  const memory = state.botMemory?.[botId];
  if (!bot || !memory) return null;
  const profile = getProfile(difficulty);
  const candidates = state.players
    .map((player, i) => ({ ...player, i }))
    .filter((player) => !player.dead && player.i !== state.presidentIdx);

  const ranked = sortCandidatesByScore(candidates, (candidate) => {
    const suspicion = getSuspicion(memory, candidate.id);
    const known = knownAlignment(memory, candidate.id);
    let score = suspicion * profile.executiveWeight;
    if (mode === 'investigate') score = Math.abs(suspicion) < 15 ? 30 - Math.abs(suspicion) : 10 - Math.abs(suspicion) * 0.1;
    if (bot.role === 'Liberal') {
      if (known === 'liberal') score -= 50;
      if (known === 'fascist' || known === 'hitler') score += 40;
    } else {
      if (known === 'fascist' || known === 'hitler') score -= 60;
      if (known === 'liberal') score += 30;
      else score -= suspicion * 0.3;
    }
    return score + Math.random() * profile.voteRandomness;
  });

  return ranked[0]?.candidate?.i ?? null;
}

function adjacentClaimOptions(actualSummary, role) {
  const presidentOptions = ['LLL', 'LLF', 'LFF', 'FFF'];
  const chancellorOptions = ['LL', 'LF', 'FF'];
  const options = role === 'president' ? presidentOptions : chancellorOptions;
  const idx = options.indexOf(actualSummary);
  if (idx < 0) return options;
  return [
    options[idx],
    options[Math.max(0, idx - 1)],
    options[Math.min(options.length - 1, idx + 1)],
  ].filter((value, index, array) => array.indexOf(value) === index);
}

function chooseClaim(state, botId, session, difficulty) {
  const bot = state.players.find((player) => player.id === botId);
  if (!bot || !session) return null;
  const profile = getProfile(difficulty);
  const isPresident = session.presidentId === botId;
  const actualSummary = isPresident ? session.presidentActual : session.chancellorActual;
  if (!actualSummary) return isPresident ? 'LLF' : 'LF';
  const lieChance = bot.role === 'Liberal' ? 0.02 : bot.role === 'Hitler' ? profile.lieChanceHitler : profile.lieChanceFascist;
  if (Math.random() >= lieChance) return actualSummary;

  const options = adjacentClaimOptions(actualSummary, isPresident ? 'president' : 'chancellor').filter((summary) => summary !== actualSummary);
  if (!options.length) return actualSummary;

  if (bot.role === 'Liberal') return actualSummary;

  if (isPresident) {
    return options.sort((a, b) => b.split('').filter((card) => card === 'L').length - a.split('').filter((card) => card === 'L').length)[0];
  }
  return options.sort((a, b) => a.split('').filter((card) => card === 'L').length - b.split('').filter((card) => card === 'L').length)[0];
}

module.exports = {
  BOT_PROFILES,
  normalizeDifficulty,
  getProfile,
  ensureBotMemoryState,
  updateMemoryFromTransition,
  chooseChancellorCandidate,
  chooseVote,
  chooseDiscard,
  shouldProposeVeto,
  chooseExecutiveTarget,
  chooseClaim,
};
