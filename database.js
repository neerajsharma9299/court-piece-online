const sqlite3 = require("sqlite3").verbose();

// Create or open database file
const db = new sqlite3.Database("./courtpiece.db");

db.serialize(() => {

  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      player_id TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

});

console.log("Database initialized");

module.exports = db;