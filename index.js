/**
 * Eagle zAPI - Baileys Backend
 */
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
const logger = pino({ level: "warn" });
const sessions = new Map();
// Dynamic import for Baileys (handles ESM/CJS interop)
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion;
async function loadBaileys() {
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  console.log("✅ Baileys loaded successfully");
  console.log("Baileys loaded");
}
async function eagleApi(method, endpoint, body = null) {
  if (!API_URL) return null;
  const url = `${API_URL}${endpoint}`;
  const opts = {
    method,
async function startSession(sessionId, phoneNumber = null) {
  if (sessions.has(sessionId)) {
    const old = sessions.get(sessionId);
    if (old.sock) try { old.sock.end(); } catch(e) {}
    if (old.sock) try { old.sock.end(); } catch (e) {}
  }
  const usePairingCode = !!phoneNumber;
    setTimeout(async () => {
      try {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
        console.log(`[${sessionId}] Requesting pairing code for ${cleanPhone}...`);
        const code = await sock.requestPairingCode(cleanPhone);
        console.log(`[${sessionId}] Pairing code: ${code}`);
        await eagleApi("PUT", `/session/${sessionId}/qr`, { pairing_code: code, status: "connecting" });
    const { connection, lastDisconnect, qr } = update;
    if (qr && !usePairingCode) {
      console.log(`[${sessionId}] QR generated`);
      try {
        const QRCode = (await import("qrcode")).default;
        const qrBase64 = await QRCode.toDataURL(qr, { width: 512, margin: 2 });
        await eagleApi("PUT", `/session/${sessionId}/qr`, { qr_code: qrBase64, status: "connecting" });
        console.log(`[${sessionId}] QR sent ✓`);
        console.log(`[${sessionId}] QR sent`);
      } catch (err) {
        console.error(`[${sessionId}] QR failed:`, err.message);
      }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sessionId}] Closed. Code: ${statusCode}`);
      if (statusCode === DisconnectReason.loggedOut) {
        fs.rmSync(authDir, { recursive: true, force: true });
        await eagleApi("PUT", `/session/${sessionId}/qr`, { qr_code: null, status: "offline" });
        sessions.delete(sessionId);
      } else {
        console.log(`[${sessionId}] Reconnecting in 3s...`);
        setTimeout(() => startSession(sessionId), 3000);
      }
    }
      const phone = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
      if (!text) continue;
      console.log(`[${sessionId}] From ${phone}: ${text}`);
      const result = await eagleApi("POST", "/chatbot/incoming", { session_id: sessionId, phone, message: text });
      if (result?.auto_reply) {
        await sock.sendMessage(msg.key.remoteJid, { text: result.auto_reply });
  return { success: true };
}
// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  let body = "";
  for await (const chunk of req) body += chunk;
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch(e) {}
  try { data = body ? JSON.parse(body) : {}; } catch (e) {}
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
    if (pathname.startsWith("/session/") && req.method === "DELETE") {
      const sessionId = pathname.split("/")[2];
      const session = sessions.get(sessionId);
      if (session?.sock) try { session.sock.end(); } catch(e) {}
      if (session?.sock) try { session.sock.end(); } catch (e) {}
      sessions.delete(sessionId);
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true }));
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("Error:", err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});
// ── Start ──
async function main() {
  try {
    await loadBaileys();
    server.listen(PORT, () => {
      console.log(`🦅 Eagle zAPI Backend running on port ${PORT}`);
      if (!API_URL || !API_KEY) console.warn("⚠️ EAGLE_API_URL and EAGLE_API_KEY must be set!");
      console.log(`Eagle zAPI Backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start:", err);
    console.error("Failed to start:", err);
    process.exit(1);
  }
}
main();
