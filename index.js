/**
 * Eagle zAPI - Baileys Backend
 * 
 * Este servidor Node.js conecta ao WhatsApp via Baileys e se integra
 * com o painel Eagle zAPI para gerenciar sessões, enviar/receber mensagens.
 * 
 * Variáveis de ambiente necessárias:
 *   EAGLE_API_URL  - URL base do Eagle zAPI (ex: https://nndaevxeulnkuajwqgvp.supabase.co/functions/v1/api-gateway)
 *   EAGLE_API_KEY  - Sua API key do Eagle zAPI (formato: zap_xxx)
 *   PORT           - Porta do servidor (padrão: 3000)
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const http = require("http");
const fs = require("fs");
const path = require("path");

const API_URL = process.env.EAGLE_API_URL || "";
const API_KEY = process.env.EAGLE_API_KEY || "";
const PORT = parseInt(process.env.PORT || "3000");

const logger = pino({ level: "warn" });

// Store active sessions
const sessions = new Map();

// ── Helper: call Eagle zAPI ──
async function eagleApi(method, endpoint, body = null) {
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
    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`[Eagle API] ${method} ${endpoint} failed:`, err.message);
    return null;
  }
}

// ── Start WhatsApp session ──
async function startSession(sessionId, phoneNumber = null) {
  if (sessions.has(sessionId)) {
    console.log(`[${sessionId}] Session already active, closing old one...`);
    const old = sessions.get(sessionId);
    if (old.sock) old.sock.end();
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

  // Request pairing code if phone number provided
  if (usePairingCode) {
    // Wait for socket to be ready before requesting pairing code
    setTimeout(async () => {
      try {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
        console.log(`[${sessionId}] Requesting pairing code for ${cleanPhone}...`);
        const code = await sock.requestPairingCode(cleanPhone);
        console.log(`[${sessionId}] Pairing code: ${code}`);
        
        // Send pairing code to Eagle zAPI
        await eagleApi("PUT", `/session/${sessionId}/qr`, {
          pairing_code: code,
          status: "connecting",
        });
        console.log(`[${sessionId}] Pairing code sent to Eagle zAPI ✓`);
      } catch (err) {
        console.error(`[${sessionId}] Failed to get pairing code:`, err.message);
        await eagleApi("PUT", `/session/${sessionId}/qr`, {
          status: "error",
        });
      }
    }, 3000);
  }

  // Handle connection updates
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      console.log(`[${sessionId}] QR code generated, sending to Eagle zAPI...`);
      try {
        // Convert QR to base64 image
        const qrBase64 = await QRCode.toDataURL(qr, { width: 512, margin: 2 });
        
        // Send to Eagle zAPI
        await eagleApi("PUT", `/session/${sessionId}/qr`, {
          qr_code: qrBase64,
          status: "connecting",
        });
        console.log(`[${sessionId}] QR code sent to Eagle zAPI ✓`);
      } catch (err) {
        console.error(`[${sessionId}] Failed to send QR:`, err.message);
      }
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[${sessionId}] Connection closed. Reason: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        // Clean auth and notify Eagle
        fs.rmSync(authDir, { recursive: true, force: true });
        await eagleApi("PUT", `/session/${sessionId}/qr`, {
          qr_code: null,
          status: "offline",
        });
        sessions.delete(sessionId);
      } else {
        // Try to reconnect
        console.log(`[${sessionId}] Reconnecting...`);
        setTimeout(() => startSession(sessionId), 3000);
      }
    }

    if (connection === "open") {
      const phoneNumber = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || "unknown";
      console.log(`[${sessionId}] Connected! Phone: ${phoneNumber}`);
      sessions.set(sessionId, { sock, status: "online", phone: phoneNumber });

      // Update Eagle zAPI with online status
      await eagleApi("PUT", `/session/${sessionId}/qr`, {
        status: "online",
        phone_number: phoneNumber,
      });
    }
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;

    for (const msg of msgs) {
      if (msg.key.fromMe) continue;

      const phone = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
                   msg.message?.imageMessage?.caption ||
                   "";

      if (!text) continue;

      console.log(`[${sessionId}] Message from ${phone}: ${text}`);

      // Forward to Eagle zAPI chatbot handler
      const result = await eagleApi("POST", "/chatbot/incoming", {
        session_id: sessionId,
        phone,
        message: text,
      });

      // If chatbot has an auto-reply, send it
      if (result?.auto_reply) {
        console.log(`[${sessionId}] Sending auto-reply to ${phone}`);
        await sock.sendMessage(msg.key.remoteJid, { text: result.auto_reply });
      }
    }
  });

  return sock;
}

// ── Send message via session ──
async function sendMessage(sessionId, phone, message, mediaUrl = null) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "online") {
    throw new Error("Session not online");
  }

  const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;

  if (mediaUrl) {
    // Send media
    const response = await fetch(mediaUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") || "image/jpeg";

    if (mimeType.startsWith("image/")) {
      await session.sock.sendMessage(jid, { image: buffer, caption: message || "" });
    } else if (mimeType.startsWith("video/")) {
      await session.sock.sendMessage(jid, { video: buffer, caption: message || "" });
    } else {
      await session.sock.sendMessage(jid, { document: buffer, mimetype: mimeType, fileName: "file" });
    }
  } else {
    await session.sock.sendMessage(jid, { text: message });
  }

  return { success: true };
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  // Parse body
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = body ? JSON.parse(body) : {};

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // POST /session/start - Start a WhatsApp session
    if (pathname === "/session/start" && req.method === "POST") {
      const { session_id, phone_number } = data;
      if (!session_id) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: "session_id required" }));
      }
      await startSession(session_id, phone_number || null);
      const mode = phone_number ? "pairing code" : "QR code";
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, message: `Session starting via ${mode}, will be sent to Eagle zAPI` }));
    }

    // POST /message/send - Send a message
    if (pathname === "/message/send" && req.method === "POST") {
      const { session_id, phone, message, media_url } = data;
      const result = await sendMessage(session_id, phone, message, media_url);
      res.writeHead(200);
      return res.end(JSON.stringify(result));
    }

    // GET /sessions - List active sessions
    if (pathname === "/sessions" && req.method === "GET") {
      const list = [];
      for (const [id, s] of sessions) {
        list.push({ session_id: id, status: s.status, phone: s.phone || null });
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ sessions: list }));
    }

    // DELETE /session/:id - Stop a session
    if (pathname.startsWith("/session/") && req.method === "DELETE") {
      const sessionId = pathname.split("/")[2];
      const session = sessions.get(sessionId);
      if (session?.sock) session.sock.end();
      sessions.delete(sessionId);
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true }));
    }

    // GET /health
    if (pathname === "/health") {
      res.writeHead(200);
      return res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("Error:", err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║      Eagle zAPI - Baileys Backend v1.0         ║
╠════════════════════════════════════════════════╣
║  Server running on port ${PORT}                    ║
║  API URL: ${API_URL || "NOT SET"}
║  API Key: ${API_KEY ? API_KEY.slice(0, 8) + "..." : "NOT SET"}
╚════════════════════════════════════════════════╝

Endpoints:
  POST /session/start   { session_id }
  POST /message/send    { session_id, phone, message, media_url? }
  GET  /sessions
  DELETE /session/:id
  GET  /health
  `);

  if (!API_URL || !API_KEY) {
    console.warn("⚠️  EAGLE_API_URL and EAGLE_API_KEY must be set!");
    console.warn("   Set them as environment variables before starting.");
  }
});
