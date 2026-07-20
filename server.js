// ============================================================
// Court Piece -- online multiplayer server
// Zero external dependencies: `node server.js` and you're running.
// Serves the static client from ./public and handles WebSocket
// connections for real 4-human rooms (empty seats auto-fill with
// bots, and any seat that disconnects mid-game is taken over by
// a bot so the room never gets stuck).
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const { acceptUpgrade } = require("./ws-lite.js");
const { Game, Rules, Bot, Deck, botPickTrumpSuit } = require("./engine.js");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");
const USERS_FILE = path.join(__dirname, "users.json");

const BOT_THINK_MS = 650;
const CHALLENGE_THINK_MS = 900;
const TRICK_HOLD_MS = 1000;
const ROUND_BANNER_MS = 2600;

// ---------------- Room management ----------------

const rooms = new Map(); // code -> Room
const onlinePlayers = new Map(); // player ID -> live WebSocket

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch (_) { return { users: {} }; }
}
function saveUsers(db) { fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2)); }
function cleanName(value, fallback = "Player") {
  return String(value || fallback).replace(/[<>]/g, "").trim().slice(0, 20) || fallback;
}
function makePlayerId(db) {
  let id;
  do { id = "CP-" + Math.random().toString(36).slice(2, 8).toUpperCase(); } while (db.users[id]);
  return id;
}
function sendWs(ws, message) {
  if (ws && ws.alive) { try { ws.send(JSON.stringify(message)); } catch (_) {} }
}
function sendFriends(ws) {
  if (!ws.playerId) return;
  const db = loadUsers(), me = db.users[ws.playerId];
  if (!me) return;
  const incoming = (me.incoming || []).map(id => ({ id, name: (db.users[id] || {}).name || "Player", status: "incoming", online: onlinePlayers.has(id) }));
  const accepted = (me.friends || []).map(id => ({ id, name: (db.users[id] || {}).name || "Player", status: "accepted", online: onlinePlayers.has(id) }));
  sendWs(ws, { type: "friends", friends: [...incoming, ...accepted] });
}
function refreshOnlineFriends() { for (const ws of onlinePlayers.values()) sendFriends(ws); }

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code) {
    this.code = code;
    this.game = new Game();
    this.sockets = [null, null, null, null];
    this.names = ["Player 1", "Player 2", "Player 3", "Player 4"];
    this.started = false;

    this.phase = "lobby"; // lobby, trump, challenge, trick, round_over, match_over
    this.turnPlayer = 0;
    this.trickNumber = 1;
    this.currentTrick = []; // { playerIndex, card }
    this.poolSeat = null;
    this.poolCount = 0;
    this.trumpChooserIndex = null;
    this.challengeStep = 0;
    this.challengePlayerIndex = null;
    this.lastTrickWinner = null;
  }

  isBotSeat(idx) {
    return this.sockets[idx] === null;
  }

  connectedCount() {
    return this.sockets.filter((s) => s !== null).length;
  }

  send(idx, msg) {
    const socket = this.sockets[idx];
    if (socket && socket.alive) {
      try {
        socket.send(JSON.stringify(msg));
      } catch (e) {
        // ignore
      }
    }
  }

  broadcastEvent(text) {
    for (let i = 0; i < 4; i++) this.send(i, { type: "event", text });
  }

  buildStateFor(seatIndex) {
    const g = this.game;

    return {
      type: "state",
      code: this.code,
      seat: seatIndex,
      players: g.players.map((p, i) => ({
        name: this.names[i],
        isBot: this.isBotSeat(i),
        handCount: p.hand.length,
        tricks: p.tricks
      })),
      hand: g.players[seatIndex].hand,
      dealer: g.dealer,
      roundNumber: g.roundNumber,
      trump: g.trump,
      trumpTeam: g.trumpTeam,
      trumpPlayerIndex: g.trumpPlayerIndex,
      team1Score: g.team1Score,
      team2Score: g.team2Score,
      challengeMode: g.challengeMode,
      challengeTeam: g.challengeTeam,
      phase: this.phase,
      turnPlayer: this.turnPlayer,
      trickNumber: this.trickNumber,
      currentTrick: this.currentTrick,
      poolSeat: this.poolSeat,
      poolCount: this.poolCount,
      trumpChooserIndex: this.trumpChooserIndex,
      challengePlayerIndex: this.challengePlayerIndex,
      lastTrickWinner: this.lastTrickWinner
    };
  }

  broadcastState() {
    for (let i = 0; i < 4; i++) this.send(i, this.buildStateFor(i));
  }
}

function getRoom(code) {
  return rooms.get(code) || null;
}

// ---------------- Game flow (server-authoritative) ----------------
// Mirrors the same flow used in the single-player browser client,
// just driven by network messages instead of DOM events.

function maybeStart(room) {
  if (room.started) return;
  if (room.connectedCount() < 1) return; // need at least the creator
  room.started = true;

  room.game.jackToss();
  room.broadcastEvent(`${room.names[room.game.dealer]} is the dealer.`);
  startRound(room);
}

function startRound(room) {
  const g = room.game;
  if (g.roundNumber > 1) g.resetRound();

  // FIX: jackToss() already consumed 1+ cards from the deck it was
  // using -- reusing that same (depleted) deck here, only reshuffling
  // it, means the deck always comes up short by round's end and
  // deals out `null` cards. A fresh 52-card deck every round matches
  // what the Python original always did (`self.deck = Deck()`).
  g.deck = new Deck();
  g.deck.shuffle();
  g.dealFirstFive();

  room.trickNumber = 1;
  room.currentTrick = [];
  room.poolSeat = null;
  room.poolCount = 0;
  room.challengeStep = 0;

  const chooserIndex = g.initialTrumpChooserIndex();
  room.trumpChooserIndex = chooserIndex;
  room.phase = "trump";
  room.broadcastState();

  if (room.isBotSeat(chooserIndex)) {
    setTimeout(() => {
      const suit = botPickTrumpSuit(g.players[chooserIndex]);
      onTrumpChosen(room, suit, chooserIndex, false);
    }, BOT_THINK_MS);
  }
}

function onTrumpChosen(room, suit, chooserIndex, isChallenge) {
  const g = room.game;

  if (!isChallenge) {
    g.chooseTrump(suit, chooserIndex);
    g.dealRemainingCards();
    room.trumpChooserIndex = null;
    room.broadcastState();
    runChallengeStep(room, 0);
  } else {
    g.applyChallenge(chooserIndex);
    g.trump = suit;
    room.challengePlayerIndex = null;
    room.broadcastState();
    beginTrickPlay(room);
  }
}

function runChallengeStep(room, step) {
  const g = room.game;

  if (step >= 4) {
    beginTrickPlay(room);
    return;
  }

  room.challengeStep = step;
  const idx = g.challengeOrderIndexForStep(step);
  room.challengePlayerIndex = idx;
  room.phase = "challenge";
  room.broadcastState();

  if (room.isBotSeat(idx)) {
    setTimeout(() => {
      const saysYes = Math.random() < 0.08;
      if (saysYes) {
        const suit = botPickTrumpSuit(g.players[idx]);
        onTrumpChosen(room, suit, idx, true);
      } else {
        runChallengeStep(room, step + 1);
      }
    }, CHALLENGE_THINK_MS);
  }
}

function beginTrickPlay(room) {
  const g = room.game;
  room.turnPlayer = g.trumpPlayerIndex;
  g.currentPlayer = room.turnPlayer;
  room.phase = "trick";
  room.broadcastState();
  advanceTurn(room);
}

function advanceTurn(room) {
  if (room.isBotSeat(room.turnPlayer)) {
    setTimeout(() => botPlay(room), BOT_THINK_MS);
  }
  // Human turn: just wait for a "play_card" message.
}

function leadSuitOf(room) {
  return room.currentTrick.length === 0 ? null : room.currentTrick[0].card.suit;
}

function isValidCardForSeat(room, seatIndex, card) {
  const leadSuit = leadSuitOf(room);
  if (leadSuit === null) return true;
  const hasLead = room.game.players[seatIndex].hand.some((c) => c.suit === leadSuit);
  if (hasLead) return card.suit === leadSuit;
  return true;
}

function applyCardPlay(room, seatIndex, card) {
  const g = room.game;
  const player = g.players[seatIndex];
  const idx = player.hand.findIndex((c) => c.rank === card.rank && c.suit === card.suit);
  if (idx === -1) return false;

  player.hand.splice(idx, 1);
  room.currentTrick.push({ playerIndex: seatIndex, card });

  if (room.currentTrick.length === 4) {
    // FIX: don't optimistically advance turnPlayer here. Doing so
    // broadcasts a "someone's turn" state during the ~400ms window
    // before finishTrick() actually resolves the trick -- a fast
    // client (or a bot timer) could sneak in a 5th card during that
    // gap, since the turn/phase check would still pass. Setting
    // turnPlayer to null means no seatIndex can match it until
    // finishTrick() assigns the real next player.
    room.turnPlayer = null;
    room.broadcastState();
    setTimeout(() => finishTrick(room), 400);
  } else {
    room.turnPlayer = (seatIndex + 1) % 4;
    room.broadcastState();
    advanceTurn(room);
  }
  return true;
}

function botPlay(room) {
  const g = room.game;
  const idx = room.turnPlayer;

  // Defensive: a stale timer (e.g. scheduled just before the trick
  // resolved, or the room already moved to a different phase) should
  // not act. turnPlayer is null during the brief trick-resolution
  // window and advanceTurn() is only ever called with a fresh value,
  // so this should normally never trigger -- but it's a cheap guard.
  if (idx === null || room.phase !== "trick" || !room.isBotSeat(idx)) return;

  const player = g.players[idx];
  const leadSuit = leadSuitOf(room);
  const playedPairs = room.currentTrick.map((e) => [e.playerIndex, e.card]);

  const card = Bot.chooseCard(idx, player.hand, leadSuit, playedPairs, g.trump);
  applyCardPlay(room, idx, card);
}

function finishTrick(room) {
  try {
    const playedPairs = room.currentTrick.map((e) => [e.playerIndex, e.card]);
    const winnerIndex = Rules.determineWinner(playedPairs, room.game.trump);
    room.lastTrickWinner = winnerIndex;

    const g = room.game;
    const capture = g.updateScore(winnerIndex, room.trickNumber);

  if (capture) {
    room.poolSeat = null;
    room.poolCount = 0;
    room.broadcastEvent(
      `${room.names[capture.capturedIndex]} captured ${capture.capturedCount} trick${capture.capturedCount !== 1 ? "s" : ""}!`
    );
  } else {
    room.poolSeat = winnerIndex;
    room.poolCount = g.unclaimedTricks;
  }

  let challengeFailed = false;

  if (g.challengeMode && capture) {
    const capturingTeam = g.teamOf(capture.capturedIndex);
    if (capturingTeam !== g.challengeTeam) {
      challengeFailed = true;
      const losingTeam = g.challengeTeam;
      if (capturingTeam === 1) g.team1Score += 1; else g.team2Score += 1;
      g.rotateDealer(false);
      room.broadcastEvent(`Team ${losingTeam} failed the challenge! Team ${capturingTeam} scores.`);
    }
  }

  room.currentTrick = [];
  room.phase = challengeFailed || room.trickNumber === 13 ? "round_over" : "trick";
  room.broadcastState();

  setTimeout(() => {
    try {
      if (challengeFailed) {
        afterRoundEnds(room);
        return;
      }

      if (room.trickNumber === 13) {
        resolveRoundEnd(room);
        afterRoundEnds(room);
        return;
      }

      room.trickNumber += 1;
      room.turnPlayer = winnerIndex;
      g.currentPlayer = winnerIndex;
      room.phase = "trick";
      room.broadcastState();
      advanceTurn(room);
    } catch (err) {
      console.log("[ERROR] finishTrick (delayed) threw:", err.stack);
    }
  }, TRICK_HOLD_MS);
  } catch (err) {
    console.log("[ERROR] finishTrick threw:", err.stack);
  }
}

function resolveRoundEnd(room) {
  const g = room.game;
  const { team1, team2 } = g.teamTricks();

  if (g.challengeMode) {
    const winningTeam = g.challengeTeam;
    if (winningTeam === 1) g.team1Score += 1; else g.team2Score += 1;
    room.broadcastEvent(`Team ${winningTeam} swept the round! Challenge successful.`);
    g.rotateDealer(true);
  } else {
    let msg = "";
    if (team1 === 13) { g.team1Score += 1; msg = "Team 1 made a court! "; }
    else if (team2 === 13) { g.team2Score += 1; msg = "Team 2 made a court! "; }

    const trumpSucceeded = g.trumpTeam === 1 ? team1 >= 8 : team2 >= 8;

    if (g.trumpTeam === 1) {
      msg += trumpSucceeded ? "Team 1 won the round!" : "Team 1 failed -- Team 2 wins the round!";
      if (!trumpSucceeded) g.team2Score += 1;
    } else {
      msg += trumpSucceeded ? "Team 2 won the round!" : "Team 2 failed -- Team 1 wins the round!";
      if (!trumpSucceeded) g.team1Score += 1;
    }

    room.broadcastEvent(msg);
    g.rotateDealer(trumpSucceeded);
  }

  room.broadcastState();
}

function afterRoundEnds(room) {
  const g = room.game;

  if (g.matchOver()) {
    room.phase = "match_over";
    const winner = g.team1Score >= 5 ? 1 : 2;
    room.broadcastEvent(`TEAM ${winner} WINS THE MATCH!`);
    room.broadcastState();
    return;
  }

  setTimeout(() => {
    g.roundNumber += 1;
    startRound(room);
  }, ROUND_BANNER_MS);
}

// ---------------- Message handling ----------------

function handleMessage(room, seatIndex, msg) {
  const g = room.game;

  switch (msg.type) {
    case "choose_trump": {
      if (room.phase === "trump" && room.trumpChooserIndex === seatIndex) {
        onTrumpChosen(room, msg.suit, seatIndex, false);
      } else if (room.phase === "challenge" && room.challengePlayerIndex === seatIndex && msg.afterYes) {
        onTrumpChosen(room, msg.suit, seatIndex, true);
      }
      break;
    }
    case "challenge_decision": {
      if (room.phase !== "challenge" || room.challengePlayerIndex !== seatIndex) break;
      if (msg.decision === "yes") {
        room.send(seatIndex, { type: "await_trump_pick" });
      } else {
        runChallengeStep(room, room.challengeStep + 1);
      }
      break;
    }
    case "play_card": {
      if (room.phase !== "trick" || room.turnPlayer !== seatIndex) break;
      const card = { rank: msg.rank, suit: msg.suit };
      if (!isValidCardForSeat(room, seatIndex, card)) {
        room.send(seatIndex, { type: "error", message: "You must follow the suit!" });
        break;
      }
      applyCardPlay(room, seatIndex, card);
      break;
    }
    default:
      break;
  }
}

// ---------------- HTTP + WebSocket server ----------------

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".json": "application/json"
};

function serveStatic(req, res) {
  let filePath = decodeURIComponent(req.url.split("?")[0]);
  if (filePath === "/") filePath = "/index.html";

  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };

    if (filePath.startsWith("/assets/")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }

    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

server.on("upgrade", (req, socket) => {
  const ws = acceptUpgrade(req, socket);
  if (!ws) return;

  let joinedRoom = null;
  let seatIndex = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === "create_room") {
      const code = makeRoomCode();
      const room = new Room(code);
      rooms.set(code, room);

      seatIndex = 0;
      room.sockets[0] = ws;
      room.names[0] = cleanName(msg.name, "Player 1");
      joinedRoom = room;

      ws.send(JSON.stringify({ type: "joined", code, seat: 0 }));
      room.broadcastState();
      return;
    }

    if (msg.type === "join_room") {
      const room = getRoom((msg.code || "").toUpperCase());
      if (!room) {
        ws.send(JSON.stringify({ type: "error", message: "Room not found." }));
        return;
      }
      const freeSeat = room.sockets.findIndex((s) => s === null);
      if (freeSeat === -1 || room.started) {
        ws.send(JSON.stringify({ type: "error", message: "Room is full or already started." }));
        return;
      }

      seatIndex = freeSeat;
      room.sockets[freeSeat] = ws;
      room.names[freeSeat] = cleanName(msg.name, `Player ${freeSeat + 1}`);
      joinedRoom = room;

      ws.send(JSON.stringify({ type: "joined", code: room.code, seat: freeSeat }));
      room.broadcastState();

      if (room.connectedCount() === 4) maybeStart(room);
      return;
    }

    if (msg.type === "start_now") {
      if (joinedRoom && seatIndex === 0) maybeStart(joinedRoom);
      return;
    }

    // -------- Player identity, friends, and room invitations --------
    // These messages work before a player enters a room, so the lobby can
    // show friends immediately after connecting.
    if (msg.type === "identify") {
      const db = loadUsers();
      let id = String(msg.playerId || "").toUpperCase();
      if (!db.users[id]) {
        id = makePlayerId(db);
        db.users[id] = { name: cleanName(msg.name), friends: [], incoming: [] };
      }
      db.users[id].name = cleanName(msg.name, db.users[id].name);
      saveUsers(db);
      ws.playerId = id;
      onlinePlayers.set(id, ws);
      sendWs(ws, { type: "identity", playerId: id });
      refreshOnlineFriends();
      return;
    }

    if (msg.type === "add_friend") {
      const db = loadUsers(), me = db.users[ws.playerId];
      const targetId = String(msg.playerId || "").toUpperCase(), target = db.users[targetId];
      if (!me || !target || targetId === ws.playerId) { sendWs(ws, { type: "error", message: "Player ID not found." }); return; }
      if (!(target.incoming || []).includes(ws.playerId) && !(target.friends || []).includes(ws.playerId)) target.incoming.push(ws.playerId);
      saveUsers(db); refreshOnlineFriends();
      return;
    }

    if (msg.type === "accept_friend") {
      const db = loadUsers(), me = db.users[ws.playerId];
      const targetId = String(msg.playerId || "").toUpperCase(), target = db.users[targetId];
      if (!me || !target || !(me.incoming || []).includes(targetId)) return;
      me.incoming = me.incoming.filter(id => id !== targetId);
      me.friends = me.friends || []; target.friends = target.friends || [];
      if (!me.friends.includes(targetId)) me.friends.push(targetId);
      if (!target.friends.includes(ws.playerId)) target.friends.push(ws.playerId);
      saveUsers(db); refreshOnlineFriends();
      return;
    }

    if (msg.type === "invite_friend") {
      const db = loadUsers(), me = db.users[ws.playerId];
      const targetId = String(msg.playerId || "").toUpperCase();
      if (!me || !me.friends.includes(targetId) || !joinedRoom || seatIndex !== 0 || msg.code !== joinedRoom.code) return;
      sendWs(onlinePlayers.get(targetId), { type: "friend_invite", name: me.name, code: joinedRoom.code });
      return;
    }

    if (joinedRoom && seatIndex !== null) {
      handleMessage(joinedRoom, seatIndex, msg);
    }
  });

  ws.on("close", () => {
    if (ws.playerId && onlinePlayers.get(ws.playerId) === ws) {
      onlinePlayers.delete(ws.playerId);
      refreshOnlineFriends();
    }
    if (joinedRoom && seatIndex !== null) {
      joinedRoom.sockets[seatIndex] = null;
      // Seat automatically becomes bot-controlled (isBotSeat checks
      // for a null socket) -- the room keeps going.
      joinedRoom.broadcastEvent(`${joinedRoom.names[seatIndex]} disconnected -- a bot will take over.`);
      joinedRoom.broadcastState();

      if (joinedRoom.started && joinedRoom.phase === "trick" && joinedRoom.turnPlayer === seatIndex) {
        setTimeout(() => botPlay(joinedRoom), BOT_THINK_MS);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Court Piece server running at http://localhost:${PORT}`);
});

module.exports = { Room, rooms };
