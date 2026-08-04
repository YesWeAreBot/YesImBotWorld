// Minimal RFB 3.8 test server for the remote-desktop smoke test.
//
// - listens on VNC_TEST_PORT (default 5911), password: tetris
// - serves an 800x600 32bpp desktop, responds to every framebuffer update
//   request with a full raw rect (simple gradient scene)
// - records pointer / key / clipboard events as JSONL into VNC_TEST_EVENTS
//   (default scripts/.vnc-events.jsonl)
// - prints "READY" to stderr once the handshake is complete
//
// Usage: node scripts/test-vnc-server.mjs
import net from "node:net";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const d3des = require("rfb2/d3des");

const PORT = Number(process.env.VNC_TEST_PORT ?? 5911);
const EVENTS =
  process.env.VNC_TEST_EVENTS ?? new URL("./.vnc-events.jsonl", import.meta.url).pathname;
const W = 800;
const H = 600;
const PASSWORD = "tetris";

fs.rmSync(EVENTS, { force: true });
const eventLog = fs.openSync(EVENTS, "a");
let seq = 0;
function record(kind, payload) {
  fs.writeSync(eventLog, JSON.stringify({ seq: ++seq, kind, ...payload }) + "\n");
}

// A subtle horizontal gradient so the PNG is non-trivial to encode.
const SCENE = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const r = Math.floor((x / W) * 200) + 20;
    const g = Math.floor((y / H) * 180) + 30;
    const b = 200 - Math.floor((x / W) * 120);
    SCENE.writeUInt32LE((r << 16) | (g << 8) | b, (y * W + x) * 4);
  }
}

function fail(conn, message) {
  console.error("TEST-SERVER FAIL:", message);
  conn.destroy();
}

// A streaming byte reader: get(n, cb) buffers until n bytes are available.
// Handles the case where the client sends multiple protocol messages in one
// TCP chunk (which is normal — RFB is a byte stream, not a packet protocol).
function makeReader(conn) {
  let buffer = Buffer.alloc(0);
  let pending = null;
  conn.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  function pump() {
    while (pending && buffer.length >= pending.need) {
      const payload = buffer.subarray(0, pending.need);
      buffer = buffer.subarray(pending.need);
      const { fn } = pending;
      pending = null;
      const next = fn(payload);
      if (next) pending = next;
    }
  }
  return {
    get(need, fn) {
      pending = { need, fn };
      pump();
    },
  };
}

net.createServer((conn) => {
  conn.on("error", () => {});
  const send = (buf) => conn.write(buf);
  const reader = makeReader(conn);

  // 1. server version
  send(Buffer.from("RFB 003.008\n"));
  // 2. client version (12 bytes)
  reader.get(12, () => {
    // 3. security types: 1 type = VNC
    send(Buffer.from([1, 2]));
    // 4. client chosen security type
    reader.get(1, (secType) => {
      if (secType[0] !== 2) return fail(conn, `unexpected security type ${secType[0]}`);
      // 5. VNC challenge
      const challenge = Buffer.from("1234567890abcdef", "ascii");
      send(challenge);
      // 6. challenge response
      reader.get(16, (resp) => {
        const expected = Buffer.from(
          d3des.response(challenge, PASSWORD).toString("binary"),
          "binary",
        );
        if (!resp.equals(expected)) return fail(conn, "bad password response");
        // 7. security result OK
        send(Buffer.from([0, 0, 0, 0]));
        // 8. client init (shared flag)
        reader.get(1, () => {
          // 9. server init
          const init = Buffer.alloc(28);
          let o = 0;
          init.writeUInt16BE(W, o); o += 2;
          init.writeUInt16BE(H, o); o += 2;
          init.writeUInt8(32, o++); // bpp
          init.writeUInt8(24, o++); // depth
          init.writeUInt8(0, o++);  // bigEndian
          init.writeUInt8(1, o++);  // trueColor
          init.writeUInt16BE(255, o); o += 2; // redMax
          init.writeUInt16BE(255, o); o += 2; // greenMax
          init.writeUInt16BE(255, o); o += 2; // blueMax
          init.writeUInt8(16, o++); // redShift
          init.writeUInt8(8, o++);  // greenShift
          init.writeUInt8(0, o++);  // blueShift
          o += 3;                   // padding
          init.writeUInt32BE(4, o); o += 4; // name length
          init.write("test", o, "ascii");
          send(init);
          console.error("READY");
          messageLoop(conn, reader);
        });
      });
    });
  });

  function messageLoop(conn, reader) {
    reader.get(1, (type) => {
      switch (type[0]) {
        case 0: // SetPixelFormat
          reader.get(19, () => messageLoop(conn, reader));
          return null;
        case 2: // SetEncodings
          reader.get(3, (h) => {
            const count = h.readUInt16BE(1);
            reader.get(count * 4, () => messageLoop(conn, reader));
            return null;
          });
          return null;
        case 3: // FramebufferUpdateRequest
          reader.get(9, () => {
            const head = Buffer.alloc(16);
            head.writeUInt8(0, 0);
            head.writeUInt8(0, 1);
            head.writeUInt16BE(1, 2);
            head.writeUInt16BE(0, 4);
            head.writeUInt16BE(0, 6);
            head.writeUInt16BE(W, 8);
            head.writeUInt16BE(H, 10);
            head.writeInt32BE(0, 12);
            conn.write(Buffer.concat([head, SCENE]));
            messageLoop(conn, reader);
            return null;
          });
          return null;
        case 4: // PointerEvent
          reader.get(5, (b) => {
            record("pointer", { buttons: b[0], x: b.readUInt16BE(1), y: b.readUInt16BE(3) });
            messageLoop(conn, reader);
            return null;
          });
          return null;
        case 5: // KeyEvent
          reader.get(7, (b) => {
            record("key", { down: b[0], keysym: b.readUInt32BE(3) });
            messageLoop(conn, reader);
            return null;
          });
          return null;
        case 6: // ClientCutText
          reader.get(7, (h) => {
            const len = h.readUInt32BE(3);
            reader.get(len, (text) => {
              record("cuttext", { text: text.toString("utf8") });
              messageLoop(conn, reader);
              return null;
            });
            return null;
          });
          return null;
        default:
          fail(conn, `unexpected message type ${type[0]}`);
          return null;
      }
    });
  }
}).listen(PORT, () => {
  console.error(`TEST-SERVER listening on ${PORT}`);
});
