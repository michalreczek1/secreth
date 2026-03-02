const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3330;
const DATA_DIR = path.join(process.cwd(), 'data_bot_balance_test');
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const GAMES_PER_DIFFICULTY = 4;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timeout')), 15000);
    const onData = (buf) => {
      const text = buf.toString();
      if (text.includes('server.started') || text.includes('Secret Hitler Online')) {
        clearTimeout(timer);
        resolve(server);
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });
}

function stopServer(server) {
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = {};
          if (text) {
            try {
              json = JSON.parse(text);
            } catch {
              json = { raw: text };
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function socketAck(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    socket.emit(event, ...args, (res) => {
      if (res?.error) reject(new Error(res.error));
      else resolve(res);
    });
  });
}

function firstEligibleNominee(state) {
  const aliveCount = state.players.filter((player) => !player.dead).length;
  return state.players
    .map((player, i) => ({ ...player, i }))
    .find((player) => {
      if (player.dead || player.i === state.presidentIdx) return false;
      if (aliveCount > 5) {
        return player.i !== state.prevPresidentIdx && player.i !== state.prevChancellorIdx;
      }
      return player.i !== state.prevChancellorIdx;
    });
}

function firstExecutiveTarget(state) {
  return state.players
    .map((player, i) => ({ ...player, i }))
    .find((player) => !player.dead && player.i !== state.presidentIdx);
}

function chooseDiscardIndex(cards) {
  const fascistIdx = cards.findIndex((card) => card === 'F');
  return fascistIdx >= 0 ? fascistIdx : 0;
}

async function playOneGame(cookie, difficulty, round) {
  const roomName = `Balance-${difficulty}-${round}`;
  const created = await request('POST', '/api/rooms', { name: roomName }, { Cookie: cookie });
  if (created.status !== 200 || !created.body?.room?.id) {
    throw new Error(`create room failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const roomId = created.body.room.id;

  const diffRes = await request(
    'POST',
    `/api/rooms/${roomId}/bot-difficulty`,
    { difficulty },
    { Cookie: cookie }
  );
  if (diffRes.status !== 200) throw new Error(`set difficulty failed: ${diffRes.status}`);

  const botsRes = await request('POST', `/api/rooms/${roomId}/bots`, { count: 4 }, { Cookie: cookie });
  if (botsRes.status !== 200 || botsRes.body?.added !== 4) {
    throw new Error(`add bots failed: ${botsRes.status} ${JSON.stringify(botsRes.body)}`);
  }

  const socket = io(BASE_URL, {
    transports: ['polling', 'websocket'],
    extraHeaders: { Cookie: cookie },
    forceNew: true,
  });

  let state = null;
  let actionInFlight = false;
  let lastActionKey = null;
  let winnerResolved = false;

  const winnerPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`game timeout for ${difficulty}/${round}`)), 120000);

    const maybeAct = async () => {
      if (!state || state.winner || actionInFlight) return;
      const me = state.players?.[state.myIdx];
      if (!me) return;

      let action = null;
      let payload = {};
      let claim = null;

      if (state.pendingClaim) {
        claim = {
          sessionId: state.pendingClaim.sessionId,
          summary: state.pendingClaim.actualSummary,
          skipped: false,
        };
      } else if (state.phase === 'nominate' && state.players[state.presidentIdx]?.id === me.id && !me.dead) {
        const target = firstEligibleNominee(state);
        if (target) {
          action = 'nominate';
          payload = { targetIdx: target.i };
        }
      } else if (state.phase === 'vote' && !me.dead && !state.myVote) {
        action = 'vote';
        payload = { choice: 'Ja' };
      } else if (state.phase === 'presidentDiscard' && state.players[state.presidentIdx]?.id === me.id) {
        action = 'presidentDiscard';
        payload = { cardIndex: chooseDiscardIndex(state.presidentHand || []) };
      } else if (state.phase === 'chancellorDiscard' && state.players[state.chancellorIdx]?.id === me.id) {
        action = 'chancellorDiscard';
        payload = { cardIndex: chooseDiscardIndex(state.chancellorHand || []) };
      } else if (state.phase === 'veto' && state.players[state.presidentIdx]?.id === me.id) {
        action = 'respondVeto';
        payload = { accept: false };
      } else if (state.phase === 'executive' && state.players[state.presidentIdx]?.id === me.id) {
        if (state.execPower === 'peekPolicies') {
          action = 'peekPolicies';
        } else {
          const target = firstExecutiveTarget(state);
          if (target) {
            action = state.execPower;
            payload = { targetIdx: target.i };
          }
        }
      } else if (state.phase === 'executiveDone' && state.players[state.presidentIdx]?.id === me.id) {
        action = 'finishPeek';
      }

      const contextKey = action === 'vote'
        ? `${state.presidentIdx}:${state.chancellorIdx}:${state.votesSubmitted}:${me.id}`
        : action === 'nominate'
          ? `${state.presidentIdx}:${state.prevPresidentIdx}:${state.prevChancellorIdx}`
          : action === 'presidentDiscard'
            ? `${state.presidentIdx}:${(state.presidentHand || []).join('')}`
            : action === 'chancellorDiscard'
              ? `${state.chancellorIdx}:${(state.chancellorHand || []).join('')}:${state.canVeto}`
              : action === 'respondVeto'
                ? `${state.presidentIdx}:${state.chancellorIdx}:${state.fas}`
                : action === 'peekPolicies'
                  ? `${state.execPower}:${state.deckSize}:${state.discardSize}`
                  : action === 'investigate' || action === 'specialElection' || action === 'execute'
                    ? `${state.execPower}:${payload.targetIdx}`
                    : action === 'finishPeek'
                      ? `${state.execPower}:${state.presidentIdx}:${state.phase}`
                      : '';
      const actionKey = claim
        ? `claim:${claim.sessionId}:${claim.summary}:${claim.skipped}`
        : action
          ? `${state.gameId}:${state.phase}:${action}:${contextKey}`
          : null;
      if (!actionKey || actionKey === lastActionKey) return;

      actionInFlight = true;
      lastActionKey = actionKey;
      try {
        if (claim) {
          await socketAck(socket, 'game:declareClaim', { roomId, sessionId: claim.sessionId, summary: claim.summary, skipped: claim.skipped });
        } else {
          await socketAck(socket, 'game:action', { roomId, action, payload });
        }
      } finally {
        actionInFlight = false;
      }
    };

    socket.on('connect_error', (err) => reject(err));
    socket.on('game:state', (next) => {
      state = next;
      if (next.winner && !winnerResolved) {
        winnerResolved = true;
        clearTimeout(timeout);
        resolve({
          difficulty,
          winner: next.winner,
          winReason: next.winReason,
          voteHistoryCount: next.voteHistory?.length || 0,
          claimHistoryCount: next.claimHistory?.length || 0,
          fascistPolicies: next.fas,
          liberalPolicies: next.lib,
        });
        return;
      }
      setTimeout(() => {
        maybeAct().catch((e) => reject(e));
      }, 25);
    });
  });

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  await socketAck(socket, 'room:join', roomId);
  await socketAck(socket, 'game:start', roomId);

  const result = await winnerPromise.finally(() => socket.disconnect());
  return result;
}

async function main() {
  const server = await startServer();
  try {
    const login = await request('POST', '/api/login', { username: 'admin', password: 'admin123' });
    const cookie = login.headers['set-cookie']?.[0]?.split(';')?.[0];
    if (!cookie) throw new Error('Missing login cookie');

    const results = [];
    for (const difficulty of DIFFICULTIES) {
      for (let round = 1; round <= GAMES_PER_DIFFICULTY; round++) {
        results.push(await playOneGame(cookie, difficulty, round));
        await wait(50);
      }
    }

    const summary = Object.fromEntries(
      DIFFICULTIES.map((difficulty) => {
        const games = results.filter((result) => result.difficulty === difficulty);
        return [difficulty, {
          games: games.length,
          liberalWins: games.filter((game) => game.winner === 'Liberal').length,
          fascistWins: games.filter((game) => game.winner === 'Fascist').length,
          avgVoteHistory: Number((games.reduce((sum, game) => sum + game.voteHistoryCount, 0) / games.length).toFixed(2)),
          avgClaimHistory: Number((games.reduce((sum, game) => sum + game.claimHistoryCount, 0) / games.length).toFixed(2)),
        }];
      })
    );

    console.log('BOT_BALANCE_LONG_TEST_OK');
    console.log(JSON.stringify({ results, summary }, null, 2));
  } finally {
    stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
