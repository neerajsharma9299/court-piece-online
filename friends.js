// Attach this module to the SAME WebSocket server that handles create_room,
// join_room, play_card, etc. It persists player IDs and friendships in users.json.
const fs = require('node:fs');
const path = require('node:path');
const DB_FILE = path.join(__dirname, 'users.json');

function load() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { users: {} }; } }
function save(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function newId(db) { let id; do { id = 'CP-' + Math.random().toString(36).slice(2, 8).toUpperCase(); } while (db.users[id]); return id; }

function installFriends(wss) {
  const sessions = new Map(); // player ID -> live WebSocket
  const send = (ws, message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
  const snapshot = (ws) => {
    if (!ws.playerId) return;
    const db = load(), me = db.users[ws.playerId]; if (!me) return;
    send(ws, { type: 'friends', friends: (me.friends || []).map(id => {
      const f = db.users[id] || { name: 'Unknown' };
      return { id, name: f.name, status: (me.incoming || []).includes(id) ? 'incoming' : 'accepted', online: sessions.has(id) };
    }) });
  };

  // Call this at the top of your existing ws 'message' handler.
  // It returns true if it handled the message, otherwise let game logic handle it.
  function handleFriends(ws, msg) {
    const db = load();
    if (msg.type === 'identify') {
      let id = String(msg.playerId || '').toUpperCase();
      if (!db.users[id]) { id = newId(db); db.users[id] = { name: String(msg.name || 'Player').slice(0, 20), friends: [], incoming: [] }; }
      db.users[id].name = String(msg.name || db.users[id].name).slice(0, 20); save(db);
      ws.playerId = id; sessions.set(id, ws); send(ws, { type: 'identity', playerId: id }); snapshot(ws); return true;
    }
    if (!ws.playerId) return false;
    const me = db.users[ws.playerId];
    if (msg.type === 'add_friend') {
      const target = String(msg.playerId || '').toUpperCase(), other = db.users[target];
      if (!other || target === ws.playerId) return send(ws, { type: 'error', message: 'Player ID not found.' }), true;
      if (!(other.incoming || []).includes(ws.playerId) && !(other.friends || []).includes(ws.playerId)) other.incoming.push(ws.playerId);
      save(db); snapshot(ws); if (sessions.has(target)) snapshot(sessions.get(target)); return true;
    }
    if (msg.type === 'accept_friend') {
      const target = String(msg.playerId || '').toUpperCase(), other = db.users[target];
      if (!other || !me.incoming.includes(target)) return true;
      me.incoming = me.incoming.filter(id => id !== target); me.friends.push(target); other.friends = other.friends || []; if (!other.friends.includes(ws.playerId)) other.friends.push(ws.playerId);
      save(db); snapshot(ws); if (sessions.has(target)) snapshot(sessions.get(target)); return true;
    }
    if (msg.type === 'invite_friend') {
      const target = String(msg.playerId || '').toUpperCase();
      if (!me.friends.includes(target)) return true;
      const otherWs = sessions.get(target); if (otherWs) send(otherWs, { type: 'friend_invite', name: me.name, code: String(msg.code || '').toUpperCase() });
      return true;
    }
    return false;
  }
  wss.on('connection', ws => ws.on('close', () => { if (ws.playerId) { sessions.delete(ws.playerId); for (const peer of sessions.values()) snapshot(peer); } }));
  return { handleFriends };
}
module.exports = { installFriends };
