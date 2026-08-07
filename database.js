// ============================================================
// Court Piece -- user accounts database
// Just the username/password/player_id table that /register and
// /login (in server.js) read and write. Friends, names shown in
// rooms, etc. still live in users.json exactly as before -- this
// file only owns login credentials.
// ============================================================

const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_PATH = path.join(__dirname, "courtpiece.db");
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      player_id     TEXT UNIQUE NOT NULL,
      created_at    INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
});

module.exports = db;