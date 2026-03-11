import http from "http";

const PORT = parseInt(process.env.PORT || "3000");

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

  if (req.url === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "ok" }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
