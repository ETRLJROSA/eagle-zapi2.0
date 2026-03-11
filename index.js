import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import http from "http";
import pino from "pino";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_URL = process.env.EAGLE_API_URL || "";
const API_KEY = process.env.EAGLE_API_KEY || "";
const PORT = parseInt(process.env.PORT || "3000");
const logger = pino({ level: "warn" });
const sessions = new Map();

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion;

async function loadBaileys() {
  const baileys = await import("@whiskeysockets/baileys");
  makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  console.log("Baileys loaded");
}

async function eagleApi(method, endpoint, body = null) {
  if (!API_URL) return null;
  const url = `${API_URL}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return await res.json();
  } catch (err) {
    console.error(`[Eagle API] ${method} ${endpoint} failed:`, err.message);
    return null;
  }
}

async function startSession(sessionId, phoneNumber = null) {
  if (sessions.has(sessionId)) {
    const old = sessions.get(sessionId);
    if (old.sock) try { old.sock.end(); } catch (e) {}
  }

  const usePairingCode = !!phoneNumber;
  const authDir = path.join(__dirname, "auth_sessions", sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: !usePairingCode,
    browser: ["Eagle zAPI", "Chrome", "1.0.0"],
  });

  sessions.set(sessionId, { sock, status: "connecting" });

  if (usePairingCode) {
    setTimeout(async () => {
      try {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
        const code = await sock.requestPairingCode(cleanPhone);
        console.log(`[${sessionId}] Pairing code: ${code}`);
        await eagleApi("PUT", `/session/${sessionId}/qr`, { pairing_code: code, status: "connecting" });
      } catch (err) {
        console.error(`[${sessionId}] Pairing code failed:`, err.message);
        await eagleApi("PUT", `/session/${sessionId}/qr`, { status: "error" });
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      try {
        const QRCode = (await import("qrcode")).default;
        const qrBase64 = await QRCode.toDataURL(qr, { width: 512, margin: 2 });
        await eagleApi("PUT", `/session/${sessionId}/qr`, { qr_code: qrBase64, status: "connecting" });
        console.log(`[${sessionId}] QR sent`);
      } catch (err) {
        console.error(`[${sessionId}] QR failed:`, err.message);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        fs.rmSync(authDir, { recursive: true, force: true });
        await eagleApi("PUT", `/session/${sessionId}/qr`, { qr_code: null, status: "offline" });
        sessions.delete(sessionId);
      } else {
        setTimeout(() => startSession(sessionId), 3000);
      }
    }

    if (connection === "open") {
      const phone = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || "unknown";
      console.log(`[${sessionId}] Connected! Phone: ${phone}`);
      sessions.set(sessionId, { sock, status: "online", phone });
      await eagleApi("PUT", `/session/${sessionId}/qr`, { status: "online", phone_number: phone });
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;
    for (const msg of msgs) {
      if (msg.key.fromMe) continue;
      const phone = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
      if (!text) continue;
      const result = await eagleApi("POST", "/chatbot/incoming", { session_id: sessionId, phone, message: text });
      if (result?.auto_reply) {
        await sock.sendMessage(msg.key.remoteJid, { text: result.auto_reply });
      }
    }
  });

  return sock;
}

async function sendMessage(sessionId, phone, message, mediaUrl = null) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "online") throw new Error("Session not online");
  const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;

  if (mediaUrl) {
    const response = await fetch(mediaUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") || "image/jpeg";
    if (mimeType.startsWith("image/")) await session.sock.sendMessage(jid, { image: buffer, caption: message || "" });
    else if (mimeType.startsWith("video/")) await session.sock.sendMessage(jid, { video: buffer, caption: message || "" });
    else await session.sock.sendMessage(jid, { document: buffer, mimetype: mimeType, fileName: "file" });
  } else {
    await session.sock.sendMessage(jid, { text: message });
  }
  return { success: true };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

  let body = "";
  for await (const chunk of req) body += chunk;
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch (e) {}

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/health") {
      res.writeHead(200);
      return res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
    }
    if (pathname === "/session/start" && req.method === "POST") {
      const { session_id, phone_number } = data;
      if (!session_id) { res.writeHead(400); return res.end(JSON.stringify({ error: "session_id required" })); }
      await startSession(session_id, phone_number || null);
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true }));
    }
    if (pathname === "/message/send" && req.method === "POST") {
      const { session_id, phone, message, media_url } = data;
      const result = await sendMessage(session_id, phone, message, media_url);
      res.writeHead(200);
      return res.end(JSON.stringify(result));
    }
    if (pathname === "/sessions" && req.method === "GET") {
      const list = [];
      for (const [id, s] of sessions) list.push({ session_id: id, status: s.status, phone: s.phone || null });
      res.writeHead(200);
      return res.end(JSON.stringify({ sessions: list }));
    }
    if (pathname.startsWith("/session/") && req.method === "DELETE") {
      const sessionId = pathname.split("/")[2];
      const session = sessions.get(sessionId);
      if (session?.sock) try { session.sock.end(); } catch (e) {}
      sessions.delete(sessionId);
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

async function main() {
  try {
    await loadBaileys();
    server.listen(PORT, () => {
      console.log(`Eagle zAPI Backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

main();
