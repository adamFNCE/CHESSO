import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { Chess } from 'chess.js';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createGameStore } from './store/gameStore.js';

const PORT = Number(process.env.PORT || 8080);
const DISCONNECT_FORFEIT_MS = Number(process.env.DISCONNECT_FORFEIT_MS || 60000);
const GAMESTORE_TYPE = process.env.GAMESTORE_TYPE || 'memory';
const REDIS_URL = process.env.REDIS_URL || '';
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'chesso:room:';
const CLOCK_INITIAL_MS = Number(process.env.CLOCK_INITIAL_MS || 300000);
const CLOCK_INCREMENT_MS = Number(process.env.CLOCK_INCREMENT_MS || 2000);
const MAX_CHAT_MESSAGES = 100;
const AI_LEVELS = new Set(['beginner', 'intermediate', 'hard', 'master']);

const activeRooms = new Map();

function createClockState() {
  return {
    whiteMs: CLOCK_INITIAL_MS,
    blackMs: CLOCK_INITIAL_MS,
    incrementMs: CLOCK_INCREMENT_MS,
    running: false,
    lastTickAt: null
  };
}

function createChatState() {
  return {
    members: {},
    messages: []
  };
}

function createAiState() {
  return {
    enabled: false,
    level: null,
    botAddress: null,
    thinking: false
  };
}

function normalizeChatMember(member, address = '') {
  if (!member) return null;
  if (typeof member === 'string') {
    return {
      username: member.trim().slice(0, 24),
      avatar: `https://api.dicebear.com/9.x/identicon/svg?seed=${address || member}`
    };
  }

  const username = String(member.username || '').trim().slice(0, 24);
  if (!username) return null;
  const avatar = String(member.avatar || '').trim().slice(0, 512);
  return {
    username,
    avatar: avatar || `https://api.dicebear.com/9.x/identicon/svg?seed=${address || username}`
  };
}

function normalizeChatState(chat) {
  const base = chat && typeof chat === 'object' ? chat : createChatState();
  const members = {};
  for (const [address, member] of Object.entries(base.members || {})) {
    const normalized = normalizeChatMember(member, address);
    if (normalized) members[address] = normalized;
  }

  const messages = Array.isArray(base.messages)
    ? base.messages
        .map((m) => ({
          id: m.id || randomUUID().slice(0, 8),
          at: Number(m.at) || Date.now(),
          address: String(m.address || '').toLowerCase(),
          username: String(m.username || '').trim().slice(0, 24) || 'Player',
          avatar: String(m.avatar || '').trim().slice(0, 512),
          text: String(m.text || '').trim().slice(0, 280)
        }))
        .filter((m) => m.text)
    : [];

  return { members, messages };
}

function pushChatMessage(room, { address, username, avatar, text }) {
  room.chat.messages.push({
    id: randomUUID().slice(0, 8),
    at: Date.now(),
    address,
    username,
    avatar,
    text
  });

  if (room.chat.messages.length > MAX_CHAT_MESSAGES) {
    room.chat.messages.splice(0, room.chat.messages.length - MAX_CHAT_MESSAGES);
  }
}

function toSnapshot(room) {
  return {
    id: room.id,
    fen: room.chess.fen(),
    players: room.players,
    forcedResult: room.forcedResult,
    drawOfferBy: room.drawOfferBy,
    rematchOffers: Array.from(room.rematchOffers),
    clock: room.clock,
    chat: room.chat,
    ai: room.ai,
    createdAt: room.createdAt,
    updatedAt: Date.now()
  };
}

function fromSnapshot(snapshot) {
  return {
    id: snapshot.id,
    chess: new Chess(snapshot.fen),
    players: snapshot.players,
    clients: new Set(),
    forcedResult: snapshot.forcedResult || null,
    drawOfferBy: snapshot.drawOfferBy || null,
    rematchOffers: new Set(snapshot.rematchOffers || []),
    clock: snapshot.clock || createClockState(),
    chat: normalizeChatState(snapshot.chat),
    ai: snapshot.ai || createAiState(),
    createdAt: snapshot.createdAt || Date.now(),
    forfeit: { color: null, deadlineAt: null, timer: null }
  };
}

function getGameResult(room) {
  if (room.forcedResult) return room.forcedResult;

  const chess = room.chess;
  if (!chess.isGameOver()) return null;
  if (chess.isCheckmate()) return chess.turn() === 'w' ? 'black_wins' : 'white_wins';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient_material';
  if (chess.isThreefoldRepetition()) return 'threefold_repetition';
  if (chess.isDraw()) return 'draw';
  return 'game_over';
}

function isFinished(room) {
  return Boolean(room.forcedResult) || room.chess.isGameOver();
}

function currentTurnColor(room) {
  return room.chess.turn() === 'w' ? 'white' : 'black';
}

function getOpponentColor(color) {
  return color === 'white' ? 'black' : 'white';
}

function isAiAddress(address) {
  return typeof address === 'string' && address.startsWith('ai:');
}

function evaluatePositionForBlack(chess) {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? 100000 : -100000;
  if (chess.isDraw() || chess.isStalemate() || chess.isInsufficientMaterial()) return 0;

  const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  let score = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = values[piece.type] || 0;
      score += piece.color === 'b' ? value : -value;
    }
  }
  return score;
}

function minimaxForBlack(chess, depth, isBlackTurn, alpha, beta) {
  if (depth === 0 || chess.isGameOver()) return evaluatePositionForBlack(chess);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return evaluatePositionForBlack(chess);

  if (isBlackTurn) {
    let best = -Infinity;
    for (const move of moves) {
      const next = new Chess(chess.fen());
      next.move(move);
      const score = minimaxForBlack(next, depth - 1, false, alpha, beta);
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Infinity;
  for (const move of moves) {
    const next = new Chess(chess.fen());
    next.move(move);
    const score = minimaxForBlack(next, depth - 1, true, alpha, beta);
    best = Math.min(best, score);
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

function pickAiMove(chess, level) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const normalized = String(level || 'beginner').toLowerCase();

  if (normalized === 'beginner') {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  if (normalized === 'intermediate') {
    const weighted = moves.map((move) => {
      let score = 0;
      if (move.captured) score += 120;
      if (move.promotion) score += 80;
      if (move.san.includes('+')) score += 70;
      if (move.san.includes('#')) score += 5000;
      score += Math.random() * 10;
      return { move, score };
    });
    weighted.sort((a, b) => b.score - a.score);
    return weighted[0].move;
  }

  if (normalized === 'hard') {
    let best = null;
    let bestScore = -Infinity;
    for (const move of moves) {
      const next = new Chess(chess.fen());
      next.move(move);
      const score = evaluatePositionForBlack(next);
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }
    return best || moves[0];
  }

  let best = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    const next = new Chess(chess.fen());
    next.move(move);
    const score = minimaxForBlack(next, 2, false, -Infinity, Infinity);
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best || moves[0];
}

function applyClockDecay(room, now = Date.now()) {
  if (!room.clock.running || isFinished(room)) return;

  const activeColor = currentTurnColor(room);
  if (!room.clock.lastTickAt) {
    room.clock.lastTickAt = now;
    return;
  }

  const elapsed = now - room.clock.lastTickAt;
  if (elapsed <= 0) return;

  if (activeColor === 'white') {
    room.clock.whiteMs = Math.max(0, room.clock.whiteMs - elapsed);
  } else {
    room.clock.blackMs = Math.max(0, room.clock.blackMs - elapsed);
  }
  room.clock.lastTickAt = now;

  if (room.clock.whiteMs === 0) room.forcedResult = 'black_wins_by_timeout';
  if (room.clock.blackMs === 0) room.forcedResult = 'white_wins_by_timeout';

  if (room.forcedResult) {
    room.clock.running = false;
    room.drawOfferBy = null;
    room.rematchOffers.clear();
  }
}

function startClockIfReady(room) {
  if (isFinished(room)) {
    room.clock.running = false;
    room.clock.lastTickAt = null;
    return;
  }

  if (!room.players.white || !room.players.black) {
    room.clock.running = false;
    room.clock.lastTickAt = null;
    return;
  }

  room.clock.running = true;
  room.clock.lastTickAt = Date.now();
}

function resetGameForRematch(room) {
  room.chess = new Chess();
  room.forcedResult = null;
  room.drawOfferBy = null;
  room.rematchOffers.clear();
  if (room.ai?.enabled && room.ai.botAddress) {
    room.players.black = room.ai.botAddress;
  }
  room.clock = createClockState();
  startClockIfReady(room);
}

function getPlayerColor(room, address) {
  if (!address) return null;
  if (room.players.white === address) return 'white';
  if (room.players.black === address) return 'black';
  return null;
}

function getConnectedCount(room, color) {
  const player = room.players[color];
  if (!player) return 0;

  let count = 0;
  for (const client of room.clients) {
    if (client.readyState === 1 && client.playerAddress === player) count += 1;
  }
  return count;
}

function isPlayerOnline(room, color) {
  if (isAiAddress(room.players[color])) return true;
  return getConnectedCount(room, color) > 0;
}

function serializeGame(room) {
  const moveHistory = room.chess.history({ verbose: true }).map((m, idx) => ({
    ply: idx + 1,
    color: m.color,
    from: m.from,
    to: m.to,
    san: m.san
  }));

  return {
    id: room.id,
    fen: room.chess.fen(),
    turn: room.chess.turn(),
    players: room.players,
    finished: isFinished(room),
    result: getGameResult(room),
    drawOfferBy: room.drawOfferBy,
    rematchOffers: Array.from(room.rematchOffers),
    moveHistory,
    clock: {
      whiteMs: room.clock.whiteMs,
      blackMs: room.clock.blackMs,
      running: room.clock.running,
      incrementMs: room.clock.incrementMs
    },
    chat: room.chat,
    connection: {
      whiteOnline: isPlayerOnline(room, 'white'),
      blackOnline: isPlayerOnline(room, 'black'),
      forfeitColor: room.forfeit.color,
      forfeitDeadlineAt: room.forfeit.deadlineAt
    },
    ai: {
      enabled: Boolean(room.ai?.enabled),
      level: room.ai?.level || null,
      thinking: Boolean(room.ai?.thinking)
    }
  };
}

function wsSend(ws, type, payload = {}, message) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type, payload, message }));
}

async function saveRoom(gameStore, room) {
  await gameStore.saveRoom(toSnapshot(room));
}

async function loadRoom(gameStore, roomId) {
  const active = activeRooms.get(roomId);
  if (active) return active;

  const snapshot = await gameStore.getRoom(roomId);
  if (!snapshot) return null;

  const room = fromSnapshot(snapshot);
  activeRooms.set(room.id, room);
  return room;
}

async function broadcastRoom(gameStore, room) {
  applyClockDecay(room);
  await saveRoom(gameStore, room);

  const state = serializeGame(room);
  for (const client of room.clients) {
    wsSend(client, 'game_state', state);
  }
}

function clearForfeitTimer(room) {
  if (room.forfeit.timer) clearTimeout(room.forfeit.timer);
  room.forfeit.timer = null;
  room.forfeit.color = null;
  room.forfeit.deadlineAt = null;
}

function maybeStartForfeitTimer(gameStore, room, disconnectedColor) {
  if (isFinished(room)) return;

  const opponentColor = getOpponentColor(disconnectedColor);
  if (!room.players[opponentColor]) return;
  if (isPlayerOnline(room, disconnectedColor)) return;
  if (!isPlayerOnline(room, opponentColor)) return;

  clearForfeitTimer(room);

  room.forfeit.color = disconnectedColor;
  room.forfeit.deadlineAt = Date.now() + DISCONNECT_FORFEIT_MS;
  room.forfeit.timer = setTimeout(async () => {
    if (isFinished(room)) {
      clearForfeitTimer(room);
      await broadcastRoom(gameStore, room);
      return;
    }

    if (isPlayerOnline(room, disconnectedColor)) {
      clearForfeitTimer(room);
      await broadcastRoom(gameStore, room);
      return;
    }

    if (!isPlayerOnline(room, opponentColor)) {
      clearForfeitTimer(room);
      await broadcastRoom(gameStore, room);
      return;
    }

    room.forcedResult = opponentColor === 'white' ? 'white_wins_by_forfeit' : 'black_wins_by_forfeit';
    room.drawOfferBy = null;
    room.rematchOffers.clear();
    room.clock.running = false;
    clearForfeitTimer(room);
    await broadcastRoom(gameStore, room);
  }, DISCONNECT_FORFEIT_MS);

  void broadcastRoom(gameStore, room);
}

async function maybeClearForfeitOnReconnect(gameStore, room, reconnectedColor) {
  if (room.forfeit.color === reconnectedColor && isPlayerOnline(room, reconnectedColor)) {
    clearForfeitTimer(room);
    await broadcastRoom(gameStore, room);
  }
}

async function maybeRunAiTurn(gameStore, room) {
  if (!room.ai?.enabled) return false;
  if (isFinished(room)) return false;
  if (currentTurnColor(room) !== 'black') return false;
  if (room.ai.thinking) return false;

  room.ai.thinking = true;
  await broadcastRoom(gameStore, room);
  await new Promise((resolve) => setTimeout(resolve, 400));

  try {
    applyClockDecay(room);
    if (isFinished(room)) {
      room.clock.running = false;
      room.clock.lastTickAt = null;
      return true;
    }

    const move = pickAiMove(room.chess, room.ai.level);
    if (!move) {
      room.clock.running = false;
      room.clock.lastTickAt = null;
      return true;
    }

    room.chess.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
    room.drawOfferBy = null;
    room.rematchOffers.clear();
    clearForfeitTimer(room);
    room.clock.blackMs += room.clock.incrementMs;

    if (isFinished(room)) {
      room.clock.running = false;
      room.clock.lastTickAt = null;
    } else {
      room.clock.running = true;
      room.clock.lastTickAt = Date.now();
    }
  } finally {
    room.ai.thinking = false;
  }

  await broadcastRoom(gameStore, room);
  return true;
}

async function attachClientToRoom(gameStore, ws, room, address) {
  if (ws.roomId && ws.roomId !== room.id) {
    const previousRoom = activeRooms.get(ws.roomId);
    if (previousRoom) previousRoom.clients.delete(ws);
  }

  ws.playerAddress = address;
  ws.roomId = room.id;
  room.clients.add(ws);

  activeRooms.set(room.id, room);

  const color = getPlayerColor(room, address);
  if (color) await maybeClearForfeitOnReconnect(gameStore, room, color);
}

async function resolveRoomAndPlayer(gameStore, payload, ws, label) {
  const room = await loadRoom(gameStore, payload?.roomId);
  if (!room) {
    wsSend(ws, 'error', {}, 'Room not found');
    return null;
  }

  const address = payload?.address?.toLowerCase();
  const color = getPlayerColor(room, address);
  if (!address || !color) {
    wsSend(ws, 'error', {}, `Invalid ${label} player`);
    return null;
  }

  return { room, address, color };
}

async function removeClient(gameStore, ws) {
  if (!ws.roomId) return;

  const room = activeRooms.get(ws.roomId) || (await loadRoom(gameStore, ws.roomId));
  if (!room) return;

  room.clients.delete(ws);

  const color = getPlayerColor(room, ws.playerAddress);
  if (color && !isFinished(room) && !isPlayerOnline(room, color)) {
    maybeStartForfeitTimer(gameStore, room, color);
    return;
  }

  const shouldDeleteEmptyUnstartedRoom =
    room.clients.size === 0 && !room.players.black && room.chess.history().length === 0;

  if (shouldDeleteEmptyUnstartedRoom) {
    clearForfeitTimer(room);
    activeRooms.delete(room.id);
    await gameStore.deleteRoom(room.id);
    return;
  }

  await broadcastRoom(gameStore, room);

  if (room.clients.size === 0) {
    activeRooms.delete(room.id);
  }
}

async function start() {
  const gameStore = await createGameStore({
    type: GAMESTORE_TYPE,
    redisUrl: REDIS_URL,
    keyPrefix: REDIS_KEY_PREFIX,
    logger: console
  });

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.get('/health', (_, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const ticker = setInterval(() => {
    for (const room of activeRooms.values()) {
      if (!room.clients.size || isFinished(room) || !room.clock.running) continue;
      void broadcastRoom(gameStore, room);
    }
  }, 1000);
  ticker.unref();

  wss.on('connection', (ws) => {
    ws.on('message', async (rawData) => {
      let data;
      try {
        data = JSON.parse(rawData.toString());
      } catch {
        wsSend(ws, 'error', {}, 'Invalid JSON');
        return;
      }

      const { type, payload } = data;

      if (type === 'create_room') {
        const address = payload?.address?.toLowerCase();
        if (!address) return wsSend(ws, 'error', {}, 'Missing address');

        const id = randomUUID().slice(0, 8);
        const room = {
          id,
          chess: new Chess(),
          players: { white: address, black: null },
          clients: new Set(),
          forcedResult: null,
          drawOfferBy: null,
          rematchOffers: new Set(),
          clock: createClockState(),
          chat: createChatState(),
          ai: createAiState(),
          createdAt: Date.now(),
          forfeit: { color: null, deadlineAt: null, timer: null }
        };

        activeRooms.set(id, room);
        await gameStore.createRoom(toSnapshot(room));
        await attachClientToRoom(gameStore, ws, room, address);
        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'join_room') {
        const address = payload?.address?.toLowerCase();
        const roomId = payload?.roomId;
        const room = await loadRoom(gameStore, roomId);

        if (!address || !roomId) return wsSend(ws, 'error', {}, 'Missing join payload');
        if (!room) return wsSend(ws, 'error', {}, 'Room not found');
        if (room.ai?.enabled && room.players.white !== address) {
          return wsSend(ws, 'error', {}, 'AI room is private to the owner');
        }

        if (!room.players.black && room.players.white !== address) {
          room.players.black = address;
          startClockIfReady(room);
        }

        if (room.players.white !== address && room.players.black !== address) {
          return wsSend(ws, 'error', {}, 'Room is full');
        }

        await attachClientToRoom(gameStore, ws, room, address);
        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'set_ai_level') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'ai setup');
        if (!resolved) return;
        const { room, color, address } = resolved;
        if (color !== 'white') return wsSend(ws, 'error', {}, 'Only white can enable AI mode');
        if (room.chess.history().length > 0) return wsSend(ws, 'error', {}, 'Enable AI before first move');

        const level = String(payload?.level || '').toLowerCase();
        if (!AI_LEVELS.has(level)) return wsSend(ws, 'error', {}, 'Invalid AI level');

        if (room.players.black && !isAiAddress(room.players.black) && room.players.black !== address) {
          return wsSend(ws, 'error', {}, 'Cannot enable AI after human opponent joined');
        }

        const botAddress = `ai:${level}`;
        room.ai = {
          enabled: true,
          level,
          botAddress,
          thinking: false
        };
        room.players.black = botAddress;
        clearForfeitTimer(room);
        startClockIfReady(room);
        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'resume_room') {
        const address = payload?.address?.toLowerCase();
        const roomId = payload?.roomId;
        const room = await loadRoom(gameStore, roomId);

        if (!address || !roomId) return wsSend(ws, 'error', {}, 'Missing resume payload');
        if (!room) return wsSend(ws, 'error', {}, 'Room not found');

        if (room.players.white !== address && room.players.black !== address) {
          return wsSend(ws, 'error', {}, 'Only existing players can resume');
        }

        await attachClientToRoom(gameStore, ws, room, address);
        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'make_move') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'move');
        if (!resolved) return;
        const { room, color } = resolved;

        if (isFinished(room)) return wsSend(ws, 'error', {}, 'Game already over');

        const sideToMove = currentTurnColor(room);
        if (sideToMove !== color) return wsSend(ws, 'error', {}, 'Not your turn');

        applyClockDecay(room);
        if (isFinished(room)) {
          await broadcastRoom(gameStore, room);
          return;
        }

        try {
          room.chess.move({ from: payload.from, to: payload.to, promotion: 'q' });
          room.drawOfferBy = null;
          room.rematchOffers.clear();
          clearForfeitTimer(room);

          if (color === 'white') {
            room.clock.whiteMs += room.clock.incrementMs;
          } else {
            room.clock.blackMs += room.clock.incrementMs;
          }

          room.clock.lastTickAt = Date.now();
          room.clock.running = true;

          if (!isFinished(room)) {
            const nextToMoveColor = currentTurnColor(room);
            if (room.ai?.enabled && nextToMoveColor === 'black') {
              await maybeRunAiTurn(gameStore, room);
              return;
            }
            if (!isPlayerOnline(room, nextToMoveColor)) {
              maybeStartForfeitTimer(gameStore, room, nextToMoveColor);
              return;
            }
          } else {
            room.clock.running = false;
          }

          await broadcastRoom(gameStore, room);
        } catch {
          wsSend(ws, 'error', {}, 'Illegal move');
        }
        return;
      }

      if (type === 'resign') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'resign');
        if (!resolved) return;
        const { room, color } = resolved;

        if (isFinished(room)) return wsSend(ws, 'error', {}, 'Game already over');

        const winnerColor = getOpponentColor(color);
        room.forcedResult = winnerColor === 'white' ? 'white_wins_by_resign' : 'black_wins_by_resign';
        room.drawOfferBy = null;
        room.rematchOffers.clear();
        room.clock.running = false;
        clearForfeitTimer(room);
        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'offer_draw') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'draw offer');
        if (!resolved) return;
        const { room, color } = resolved;

        if (isFinished(room)) return wsSend(ws, 'error', {}, 'Game already over');
        if (!room.players.white || !room.players.black) return wsSend(ws, 'error', {}, 'Both players not joined');
        if (room.drawOfferBy === color) return wsSend(ws, 'error', {}, 'Draw already offered');

        room.drawOfferBy = color;
        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'accept_draw') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'draw accept');
        if (!resolved) return;
        const { room, color } = resolved;

        if (isFinished(room)) return wsSend(ws, 'error', {}, 'Game already over');
        if (!room.drawOfferBy) return wsSend(ws, 'error', {}, 'No draw offer to accept');
        if (room.drawOfferBy === color) return wsSend(ws, 'error', {}, 'Cannot accept your own draw offer');

        room.forcedResult = 'draw_agreed';
        room.drawOfferBy = null;
        room.rematchOffers.clear();
        room.clock.running = false;
        clearForfeitTimer(room);
        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'offer_rematch') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'rematch offer');
        if (!resolved) return;
        const { room, color } = resolved;

        if (!isFinished(room)) return wsSend(ws, 'error', {}, 'Rematch only after game ends');

        room.rematchOffers.add(color);
        if (room.rematchOffers.size === 2) {
          resetGameForRematch(room);
        }

        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'escrow_log') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'escrow log');
        if (!resolved) return;
        const { room, address, color } = resolved;

        const logEntry = {
          event: 'escrow_action',
          roomId: room.id,
          address,
          color,
          action: payload?.action || 'unknown',
          assetType: payload?.assetType || null,
          stakeAmount: payload?.stakeAmount || null,
          txHash: payload?.txHash || null,
          transferTxHash: payload?.transferTxHash || null,
          at: payload?.at || Date.now()
        };

        console.log('[ESCROW_LOG]', JSON.stringify(logEntry));
        return;
      }

      if (type === 'enter_chat') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'chat enter');
        if (!resolved) return;
        const { room, address } = resolved;

        const username = String(payload?.username || '').trim();
        const avatar = String(payload?.avatar || '').trim();
        if (username.length < 2 || username.length > 24) {
          return wsSend(ws, 'error', {}, 'Username must be 2-24 chars');
        }

        room.chat.members[address] = normalizeChatMember({ username, avatar }, address);
        await broadcastRoom(gameStore, room);
        return;
      }

      if (type === 'send_chat') {
        const resolved = await resolveRoomAndPlayer(gameStore, payload, ws, 'chat message');
        if (!resolved) return;
        const { room, address } = resolved;

        let member = normalizeChatMember(room.chat.members[address], address);
        if (!member) {
          member = normalizeChatMember(
            {
              username: payload?.username || `Player-${address.slice(2, 6)}`,
              avatar: payload?.avatar || ''
            },
            address
          );
          if (!member) {
            member = {
              username: `Player-${address.slice(2, 6)}`,
              avatar: `https://api.dicebear.com/9.x/identicon/svg?seed=${address}`
            };
          }
          room.chat.members[address] = member;
        }

        const text = String(payload?.text || '').trim();
        if (!text || text.length > 280) {
          return wsSend(ws, 'error', {}, 'Chat message must be 1-280 chars');
        }

        pushChatMessage(room, { address, username: member.username, avatar: member.avatar, text });
        await broadcastRoom(gameStore, room);
      }
    });

    ws.on('close', () => {
      void removeClient(gameStore, ws);
    });
  });

  server.listen(PORT, () => {
    console.log(`Chesso server running on http://localhost:${PORT}`);
    console.log(`GameStore type: ${GAMESTORE_TYPE}`);
    console.log(`Clock: ${CLOCK_INITIAL_MS}ms + ${CLOCK_INCREMENT_MS}ms`);
  });
}

start().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
