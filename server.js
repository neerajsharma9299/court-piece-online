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
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("./database");

const JWT_SECRET = "change_this_secret";
const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");
const USERS_FILE = path.join(__dirname, "users.json");

const BOT_THINK_MS = 650;
const CHALLENGE_THINK_MS = 900;
const TRICK_HOLD_MS = 2000;
const ROUND_BANNER_MS = 2600;
const RECONNECT_TIMEOUT_MS = 30000; // 30 seconds

// ---------------- Room management ----------------

const rooms = new Map(); // code -> Room
const onlinePlayers = new Map(); // player ID -> live WebSocket
// ---------------- Matchmaking ----------------

const quickMatchQueue = [];

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

function broadcastOnlineList() {
  const db = loadUsers();
  const players = Array.from(onlinePlayers.keys()).map(id => ({
    id,
    name: (db.users[id] || {}).name || "Player",
  }));
  for (const ws of onlinePlayers.values()) sendWs(ws, { type: "online_list", players });
}
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
    this.playerIds = [null, null, null, null];
    this.names = ["Player 1", "Player 2", "Player 3", "Player 4"];
    this.reconnectTimers = [null, null, null, null];
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
    this.giveUpPending = false; // true while a "give up?" request is awaiting the opposing team's answer
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
      lastTrickWinner: this.lastTrickWinner,
      giveUpPending: this.giveUpPending
    };
  }

  broadcastState() {
    for (let i = 0; i < 4; i++) this.send(i, this.buildStateFor(i));
  }
}
function removeFromQuickMatch(ws) {
  const index = quickMatchQueue.indexOf(ws);

  if (index !== -1) {
    quickMatchQueue.splice(index, 1);
  }
}

function sendQueueUpdate() {

  for (const player of quickMatchQueue) {

    sendWs(player, {
      type: "queue_status",
      playersWaiting: quickMatchQueue.length,
      needed: 4
    });

  }

}

// Pulls the first 4 *currently connected* players off the queue and
// drops them straight into a brand-new room -- all 4 seats are real
// sockets, so isBotSeat() is false for every seat and no bot ever
// gets added. Anyone who disconnected or cancelled between joining
// the queue and this running has already been removed by
// removeFromQuickMatch() (called on both "close" and
// "cancel_quick_match"), so a player who left is never swept into a
// match they didn't ask to play.
function tryStartQuickMatch() {
  if (quickMatchQueue.length < 4) return;

  const group = quickMatchQueue.splice(0, 4).filter((ws) => ws && ws.alive);

  if (group.length < 4) {
    // Someone in the group went stale between queueing and matching --
    // put whoever is still connected back at the front of the line
    // and wait for the queue to refill instead of matching with a bot.
    for (let i = group.length - 1; i >= 0; i--) quickMatchQueue.unshift(group[i]);
    sendQueueUpdate();
    return;
  }

  const usersDb = loadUsers();
  const code = makeRoomCode();
  const room = new Room(code);
  rooms.set(code, room);

  group.forEach((ws, seat) => {
    room.sockets[seat] = ws;
    room.playerIds[seat] = ws.playerId || null;
    room.names[seat] = (usersDb.users[ws.playerId] || {}).name || ws.playerName || `Player ${seat + 1}`;

    if (typeof ws._enterRoom === "function") ws._enterRoom(room, seat);

    sendWs(ws, { type: "joined", code: room.code, seat, quickMatch: true });
  });

  room.broadcastState();
  maybeStart(room); // all 4 seats are real sockets -- no bots involved
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

  room.giveUpPending = false;

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

  const idx = player.hand.findIndex(
    (c) => c.rank === card.rank && c.suit === card.suit
  );

  if (idx === -1) return false;

  player.hand.splice(idx, 1);
  room.currentTrick.push({ playerIndex: seatIndex, card });

  if (room.currentTrick.length === 4) {
    // Keep all four cards visible for 2 seconds.
    room.turnPlayer = null;
    room.broadcastState();

    setTimeout(() => finishTrick(room), 2000);
  } else {
    // Pause 1 second before the next player's turn.
    room.turnPlayer = null;
    room.broadcastState();

    setTimeout(() => {
      if (room.phase !== "trick" || room.currentTrick.length === 4) return;

      room.turnPlayer = (seatIndex + 1) % 4;
      room.broadcastState();
      advanceTurn(room);
    }, 1000);
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
    // A won Court challenge is treated like a natural 13-trick sweep
    // for dealer rotation -- deal jumps to the partner (dealer + 2),
    // not "stays with the same dealer" like a normal successful round.
    g.dealer = (g.dealer + 2) % 4;
  } else if (team1 === 13 || team2 === 13) {
    // Natural court -- one side swept all 13 tricks without anyone
    // ever declaring a challenge. One point only (not a court bonus
    // stacked on top of a separate "won the round" point -- that
    // double-count was the bug), and it always hands the deal to the
    // dealer's own partner, same as a failed challenge from the
    // dealer's own team would, regardless of which team held trump.
    const courtTeam = team1 === 13 ? 1 : 2;
    if (courtTeam === 1) g.team1Score += 1; else g.team2Score += 1;

    room.broadcastEvent(`Team ${courtTeam} made a court!`);
    g.dealer = (g.dealer + 2) % 4;
  } else {
    let msg = "";
    const trumpSucceeded = g.trumpTeam === 1 ? team1 >= 8 : team2 >= 8;

    if (g.trumpTeam === 1) {
      msg = trumpSucceeded ? "Team 1 won the round!" : "Team 1 failed -- Team 2 wins the round!";
      if (trumpSucceeded) g.team1Score += 1; else g.team2Score += 1;
    } else {
      msg = trumpSucceeded ? "Team 2 won the round!" : "Team 2 failed -- Team 1 wins the round!";
      if (trumpSucceeded) g.team2Score += 1; else g.team1Score += 1;
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

// Re-starts the SAME room (same sockets, seats, and names) with a
// brand-new Game -- used by the "Play Again" button on the
// match-over popup. Only the room creator (seat 0) may trigger this.
function restartMatch(room) {
  room.game = new Game();
  room.started = true;
  room.game.jackToss();
  room.broadcastEvent(`${room.names[room.game.dealer]} is the dealer.`);
  startRound(room);
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
    case "play_again": {
      // Only the room creator can start a fresh match, and only once
      // the current one has actually ended.
      if (seatIndex === 0 && room.phase === "match_over") {
        restartMatch(room);
      }
      break;
    }
    case "ask_give_up": {
      // Only the player who actually declared Court (the trump
      // chooser on the challenging team) can ask -- and only while a
      // Court/13-trick challenge is genuinely in progress, and only
      // one outstanding request at a time.
      if (
        room.phase !== "trick" ||
        !g.challengeMode ||
        g.challengePlayerIndex !== seatIndex ||
        room.giveUpPending
      ) break;

      room.giveUpPending = true;
      const askerName = room.names[seatIndex];
      const opposingTeam = g.challengeTeam === 1 ? 2 : 1;
      for (let i = 0; i < 4; i++) {
        if (g.teamOf(i) === opposingTeam) {
          room.send(i, { type: "give_up_request", askerName });
        }
      }
      room.broadcastEvent(`${askerName} asked the other team to give up.`);
      break;
    }
    case "give_up_response": {
      if (!room.giveUpPending || room.phase !== "trick") break;
      const opposingTeam = g.challengeTeam === 1 ? 2 : 1;
      if (g.teamOf(seatIndex) !== opposingTeam) break; // only the challenged team may answer

      room.giveUpPending = false;

      if (msg.decision === "accept") {
        resolveGivenUpRound(room);
      } else {
        room.broadcastEvent(`Team ${opposingTeam} declined to give up. Game continues.`);
        room.broadcastState();
      }
      break;
    }
    default:
      break;
  }
}

// The opposing team conceded a Court/13-trick challenge mid-round --
// awards the point exactly like a normal successful challenge
// (resolveRoundEnd's challengeMode branch) and moves straight to
// afterRoundEnds, without waiting for the 13th trick.
function resolveGivenUpRound(room) {
  const g = room.game;
  const winningTeam = g.challengeTeam;
  if (winningTeam === 1) g.team1Score += 1; else g.team2Score += 1;
  // Same as a fully-played-out successful challenge -- deal jumps to
  // the partner (dealer + 2), not "stays with the same dealer".
  g.dealer = (g.dealer + 2) % 4;
  room.broadcastEvent(`Team ${winningTeam === 1 ? 2 : 1} gave up! Team ${winningTeam} wins the round.`);

  room.currentTrick = [];
  room.phase = "round_over";
  room.broadcastState();

  setTimeout(() => {
    afterRoundEnds(room);
  }, TRICK_HOLD_MS);
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

const server = http.createServer((req, res) => {

  // ---------- CORS ----------
  // The Android app loads this page from a different origin
  // (https://appassets.androidplatform.net) than this server
  // (https://court-piece-online1.onrender.com), so /register and
  // /login are cross-origin fetch() calls. WebSocket connections
  // (used for everything else -- create/join room, gameplay) aren't
  // subject to this same browser restriction, which is why Create
  // Room already worked while login/register silently failed with a
  // generic "couldn't reach the server" on the client. Without these
  // headers the browser blocks the response before JS ever sees it.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    // Preflight request the browser sends before the real POST -- no
    // body needed, just the CORS headers above plus a 204.
    res.writeHead(204);
    res.end();
    return;
  }

  // ---------- REGISTER ----------
  if (req.method === "POST" && req.url === "/register") {

    let body = "";

    req.on("data", chunk => body += chunk);

    req.on("end", async () => {

      try {
        const { username, password } = JSON.parse(body || "{}");
        const cleanUsername = String(username || "").trim();

        // Username: 6+ characters, letters/numbers/underscore only --
        // no phone number or email, just a unique handle.
        if (cleanUsername.length < 6) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Username must be at least 6 characters." }));
          return;
        }
        if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Username can only contain letters, numbers, and underscores." }));
          return;
        }
        if (!password || String(password).length < 6) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Password must be at least 6 characters." }));
          return;
        }

        const playerId =
          "CP-" + Math.random().toString(36).substring(2, 8).toUpperCase();

        const hash = await bcrypt.hash(password, 10);

        db.run(
          `INSERT INTO users (username, password_hash, player_id)
           VALUES (?, ?, ?)`,
          [cleanUsername, hash, playerId],
          function (err) {

            if (err) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: "Username already exists"
              }));
              return;
            }

            // Mirror the account into users.json too -- that's the
            // store the friends/online-list system already reads
            // from, so a brand-new account shows up with the right
            // display name right away instead of "Player".
            const udb = loadUsers();
            udb.users[playerId] = { name: cleanUsername, friends: [], incoming: [] };
            saveUsers(udb);

            const token = jwt.sign(
              { playerId, username: cleanUsername },
              JWT_SECRET,
              { expiresIn: "30d" }
            );

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              success: true,
              token,
              username: cleanUsername,
              playerId
            }));
          }
        );

      } catch (e) {
        console.error("REGISTER ERROR:", e);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });

    return;
  }

  // ---------- LOGIN ----------
  if (req.method === "POST" && req.url === "/login") {

    let body = "";

    req.on("data", chunk => body += chunk);

    req.on("end", () => {

      try {
        const { username, password } = JSON.parse(body);

        db.get(
          `SELECT * FROM users WHERE username = ?`,
          [username],
          async (err, user) => {

            if (!user) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: "Invalid username or password"
              }));
              return;
            }

            const ok = await bcrypt.compare(password, user.password_hash);

            if (!ok) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: "Invalid username or password"
              }));
              return;
            }

            // Make sure users.json (friends/online-list storage) has
            // an entry for this account -- covers accounts created
            // before this sync existed.
            const udb = loadUsers();
            if (!udb.users[user.player_id]) {
              udb.users[user.player_id] = { name: user.username, friends: [], incoming: [] };
              saveUsers(udb);
            }

            const token = jwt.sign(
              {
                userId: user.id,
                username: user.username,
                playerId: user.player_id
              },
              JWT_SECRET,
              { expiresIn: "30d" }
            );

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              token,
              username: user.username,
              playerId: user.player_id
            }));
          }
        );

      } catch (e) {
        res.writeHead(400);
        res.end("Invalid request");
      }
    });

    return;
  }

  // ---------- STATIC FILES ----------
  serveStatic(req, res);
});

server.on("upgrade", (req, socket) => {
  const ws = acceptUpgrade(req, socket);
  if (!ws) return;

  let joinedRoom = null;
  let seatIndex = null;

  // Lets code outside this closure (the quick-match matchmaker, which
  // matches players across different connections at once) attach this
  // socket to a room exactly the way create_room/join_room do above.
  ws._enterRoom = (room, seat) => {
    joinedRoom = room;
    seatIndex = seat;
  };

  // Permanently vacates whatever room/seat this connection currently
  // holds -- unlike a plain disconnect (which starts a 30s reconnect
  // window and leaves the seat claimed by this playerId forever),
  // this clears playerIds[seat] too, so identify's reconnect scan can
  // never auto-attach a future connection back into this room. Used
  // both for an explicit "leave_room" request and as a safety net at
  // the start of "quick_match", so Quick Match can never drop someone
  // back into a room they already walked away from.
  function leaveRoomInternal() {
    if (!joinedRoom || seatIndex === null) return;
    const room = joinedRoom;
    const seat = seatIndex;

    if (room.reconnectTimers[seat]) {
      clearTimeout(room.reconnectTimers[seat]);
      room.reconnectTimers[seat] = null;
    }

    room.sockets[seat] = null;
    room.playerIds[seat] = null;

    room.broadcastEvent(`${room.names[seat]} left the room.`);
    room.broadcastState();

    joinedRoom = null;
    seatIndex = null;
  }

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
      room.playerIds[0] = ws.playerId || null;
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
      room.playerIds[freeSeat] = ws.playerId || null;
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

    if (msg.type === "leave_room") {
      leaveRoomInternal();
      return;
    }

    // -------- Quick Match (real players only, never bots) --------
    if (msg.type === "quick_match") {
      if (!ws.playerId) {
        sendWs(ws, { type: "error", message: "Please connect first." });
        return;
      }

      // Quick Match always starts from a clean slate -- if this
      // connection had been auto-reattached (by identify's reconnect
      // scan) to a room it previously left, walk away from that room
      // for good before queueing. Fixes Quick Match ever dropping a
      // player back into an old room, bots and all.
      leaveRoomInternal();

      if (quickMatchQueue.includes(ws)) return; // already queued, ignore duplicate

      // Need at least 4 people connected to the app right now, or
      // there is no way to fill the room with real players -- fail
      // fast instead of leaving the player waiting forever or, worse,
      // padding the room with bots.
      if (onlinePlayers.size < 4) {
        sendWs(ws, {
          type: "queue_status",
          insufficient: true,
          online: onlinePlayers.size,
          needed: 4
        });
        return;
      }

      quickMatchQueue.push(ws);
      sendQueueUpdate();
      tryStartQuickMatch();
      return;
    }

    if (msg.type === "cancel_quick_match") {
      removeFromQuickMatch(ws);
      sendWs(ws, { type: "queue_status", playersWaiting: 0, cancelled: true, needed: 4 });
      sendQueueUpdate();
      return;
    }

    // -------- Player identity, friends, and room invitations --------
    // These messages work before a player enters a room, so the lobby can
    // show friends immediately after connecting.
    if (msg.type === "identify") {
      const db = loadUsers();
      let id = null;
      let name = null;

      // Logged-in players (username + password, via /register or
      // /login) send the JWT they were issued. That token is the
      // source of truth for who they are -- it always wins over a
      // guest playerId/name pair so a logged-in identity can't be
      // spoofed by passing a different playerId.
      if (msg.token) {
        try {
          const payload = jwt.verify(msg.token, JWT_SECRET);
          id = payload.playerId;
          name = payload.username;
        } catch (e) {
          sendWs(ws, { type: "auth_error", message: "Your session expired -- please log in again." });
        }
      }

      if (!id) {
        // Guest fallback -- keeps "Play vs Bots" and anonymous online
        // play working without requiring an account.
        id = String(msg.playerId || "").toUpperCase();
        if (!id || !db.users[id]) id = makePlayerId(db);
        name = cleanName(msg.name, (db.users[id] || {}).name);
      }

      if (!db.users[id]) {
        db.users[id] = { name: cleanName(name), friends: [], incoming: [] };
      } else if (name) {
        db.users[id].name = cleanName(name, db.users[id].name);
      }

      saveUsers(db);
      ws.playerId = id;
      ws.playerName = db.users[id].name;
      // ==========================
      // Reconnect to existing room
      // ==========================

      for (const room of rooms.values()) {

        const seat = room.playerIds.indexOf(id);

        if (seat !== -1 && room.sockets[seat] === null) {

          room.sockets[seat] = ws;

          if (room.reconnectTimers[seat]) {
            clearTimeout(room.reconnectTimers[seat]);
            room.reconnectTimers[seat] = null;
          }

          joinedRoom = room;
          seatIndex = seat;

          sendWs(ws, {
            type: "joined",
            code: room.code,
            seat
          });

          room.broadcastEvent(
            `${room.names[seat]} reconnected.`
          );

          room.broadcastState();

          break;
        }
      }
      onlinePlayers.set(id, ws);
      sendWs(ws, { type: "identity", playerId: id, name: db.users[id].name });
      refreshOnlineFriends();
      broadcastOnlineList();
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
      if (!me || !onlinePlayers.has(targetId) || !joinedRoom || seatIndex !== 0 || msg.code !== joinedRoom.code) return;
      sendWs(onlinePlayers.get(targetId), { type: "friend_invite", name: me.name, code: joinedRoom.code });
      return;
    }

    // -------- WebRTC voice-chat signaling relay --------
    // The client handles all the actual peer-connection logic; the
    // server's only job is to forward an offer/answer/ICE-candidate
    // payload to the right seat in the same room. `to` is the target
    // seat index; the recipient is told which seat it came `from`.
    if (msg.type === "voice_signal") {
      if (joinedRoom && seatIndex !== null && typeof msg.to === "number") {
        const targetWs = joinedRoom.sockets[msg.to];
        sendWs(targetWs, { type: "voice_signal", from: seatIndex, data: msg.data });
      }
      return;
    }

    if (joinedRoom && seatIndex !== null) {
      handleMessage(joinedRoom, seatIndex, msg);
    }
  });

  ws.on("close", () => {
    removeFromQuickMatch(ws);
    sendQueueUpdate();
    if (ws.playerId && onlinePlayers.get(ws.playerId) === ws) {
      onlinePlayers.delete(ws.playerId);
      refreshOnlineFriends();
      broadcastOnlineList();
    }
    if (joinedRoom && seatIndex !== null) {
      joinedRoom.sockets[seatIndex] = null;

      joinedRoom.broadcastEvent(
        `${joinedRoom.names[seatIndex]} disconnected. Waiting 30 seconds for reconnect...`
      );

      joinedRoom.broadcastState();

      joinedRoom.reconnectTimers[seatIndex] = setTimeout(() => {

          joinedRoom.broadcastEvent(
            `${joinedRoom.names[seatIndex]} did not reconnect. Bot takes over.`
          );

          if (
              joinedRoom.started &&
              joinedRoom.phase === "trick" &&
              joinedRoom.turnPlayer === seatIndex
          ) {
              botPlay(joinedRoom);
          }

      }, RECONNECT_TIMEOUT_MS);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Court Piece server running at http://localhost:${PORT}`);
});

module.exports = { Room, rooms };