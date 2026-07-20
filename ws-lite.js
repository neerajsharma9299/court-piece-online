// Minimal RFC 6455 server implementation for browser WebSockets.
// It supports text frames (the only frames used by this game) and ping/pong.
const crypto = require("crypto");
const { EventEmitter } = require("events");

function acceptUpgrade(req, socket) {
  if (String(req.headers.upgrade || "").toLowerCase() !== "websocket" || !req.headers["sec-websocket-key"]) {
    socket.destroy(); return null;
  }
  const accept = crypto.createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  return new LiteSocket(socket);
}

class LiteSocket extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.alive = true; this.buffer = Buffer.alloc(0);
    socket.on("data", data => { this.buffer = Buffer.concat([this.buffer, data]); this.readFrames(); });
    socket.on("close", () => this.close()); socket.on("error", () => this.close());
  }
  close() { if (!this.alive) return; this.alive = false; this.emit("close"); }
  readFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1];
      let length = second & 127, pos = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); pos = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; const n = this.buffer.readBigUInt64BE(2); if (n > BigInt(Number.MAX_SAFE_INTEGER)) { this.socket.destroy(); return; } length = Number(n); pos = 10; }
      const masked = Boolean(second & 128); if (!masked || this.buffer.length < pos + 4 + length) return;
      const key = this.buffer.subarray(pos, pos + 4); pos += 4;
      const payload = Buffer.from(this.buffer.subarray(pos, pos + length)); this.buffer = this.buffer.subarray(pos + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
      const opcode = first & 15;
      if (opcode === 1) this.emit("message", payload.toString("utf8"));
      else if (opcode === 8) { this.socket.end(); this.close(); return; }
      else if (opcode === 9) this.frame(10, payload);
    }
  }
  frame(opcode, payload) {
    if (!this.alive) return; const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (data.length < 126) header = Buffer.from([128 | opcode, data.length]);
    else if (data.length <= 65535) { header = Buffer.alloc(4); header[0] = 128 | opcode; header[1] = 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 128 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    this.socket.write(Buffer.concat([header, data]));
  }
  send(text) { this.frame(1, String(text)); }
}

module.exports = { acceptUpgrade };
