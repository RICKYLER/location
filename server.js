import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "5mb" }));

const isVercel = !!process.env.VERCEL;
let memoryData = { links: {}, events: [] };
const dataPath = isVercel
  ? path.join(process.env.TMPDIR || "/tmp", "data.json")
  : path.join(__dirname, "data.json");

function readData() {
  try {
    const raw = fs.readFileSync(dataPath, "utf-8");
    memoryData = JSON.parse(raw);
  } catch (e) {
    // fallback to memory
  }
  return memoryData;
}

function writeData(data) {
  memoryData = data;
  try {
    fs.writeFileSync(dataPath, JSON.stringify(data));
  } catch (e) {
    // ignore write errors on read-only fs
  }
}

const subscribers = new Map();
const uploadsDir = isVercel
  ? path.join(process.env.TMPDIR || "/tmp", "uploads")
  : path.join(__dirname, "public", "uploads");
try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch {}

function requireAdmin(req, res, next) {
  const u = (process.env.ADMIN_USER || "").trim();
  const p = (process.env.ADMIN_PASS || "").trim();
  const a = req.headers.authorization || "";
  if (!u || !p) return res.status(503).send("admin_not_configured");
  if (!a.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", "Basic realm=\"Admin\"");
    return res.status(401).end();
  }
  const decoded = Buffer.from(a.slice(6), "base64").toString();
  const i = decoded.indexOf(":");
  const user = (i === -1 ? decoded : decoded.slice(0, i)).trim();
  const pass = (i === -1 ? "" : decoded.slice(i + 1)).trim();
  if (user === u && pass === p) return next();
  res.setHeader("WWW-Authenticate", "Basic realm=\"Admin\"");
  return res.status(401).end();
}

function publishEvent(event) {
  const a = subscribers.get(event.linkId);
  if (a) {
    for (const res of a) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
  const all = subscribers.get("*");
  if (all) {
    for (const res of all) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
}

app.get("/dashboard.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/index.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/", requireAdmin, (req, res) => {
  res.redirect("/dashboard.html");
});

app.use(express.static(path.join(__dirname, "public")));
// Serve uploads from tmp when on Vercel
app.use("/uploads", express.static(uploadsDir));

app.post("/api/link", requireAdmin, (req, res) => {
  const { name, redirectUrl, trackingWindow } = req.body;
  if (!redirectUrl || !/^https?:\/\//.test(redirectUrl)) return res.status(400).json({ error: "invalid_redirect" });
  const id = crypto.randomUUID();
  const data = readData();
  data.links[id] = { 
    id, 
    name: name || "", 
    redirectUrl, 
    trackingWindow: trackingWindow || 600000, // Default 10 minutes
    createdAt: Date.now() 
  };
  writeData(data);
  const origin = req.headers.origin || `${req.protocol}://${req.get("host")}`;
  res.json({ id, url: `${origin}/l/${id}`, trackingWindow: data.links[id].trackingWindow });
});

app.get("/api/links", requireAdmin, (req, res) => {
  const data = readData();
  res.json(Object.values(data.links));
});

app.get("/api/link/:id", (req, res) => {
  const data = readData();
  const link = data.links[req.params.id];
  if (!link) return res.status(404).json({ error: "not_found" });
  res.json(link);
});

app.get("/l/:id", (req, res) => {
  const p = path.join(__dirname, "public", "consent.html");
  res.sendFile(p);
});

app.get("/api/events/stream", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const { linkId } = req.query;
  const key = linkId || "*";
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  const set = subscribers.get(key);
  set.add(res);
  req.on("close", () => {
    set.delete(res);
  });
  res.write(":ok\n\n");
});

app.post("/api/report", (req, res) => {
  const { linkId, lat, lng, accuracy, status, imageData, clientId, speed, heading, altitude } = req.body;
  const data = readData();
  const link = data.links[linkId];
  if (!link) return res.status(404).json({ error: "not_found" });
  const id = crypto.randomUUID();
  let image = null;
  if (typeof imageData === "string" && imageData.startsWith("data:image/")) {
    const m = imageData.match(/^data:(image\/(png|jpeg));base64,(.+)$/);
    if (m) {
      const ext = m[2] === "jpeg" ? "jpg" : "png";
      const fname = `${id}.${ext}`;
      const filePath = path.join(uploadsDir, fname);
      const buf = Buffer.from(m[3], "base64");
      try { fs.writeFileSync(filePath, buf); image = `/uploads/${fname}`; } catch {}
    }
  }
  const ip = (req.headers["x-forwarded-for"] && String(req.headers["x-forwarded-for"]).split(",")[0].trim()) || req.headers["x-real-ip"] || req.headers["cf-connecting-ip"] || req.socket.remoteAddress || req.ip;
  const ua = req.headers["user-agent"] || "";
  const item = {
    id,
    linkId,
    clientId: clientId || null,
    lat: typeof lat === "number" ? lat : null,
    lng: typeof lng === "number" ? lng : null,
    accuracy: typeof accuracy === "number" ? accuracy : null,
    speed: typeof speed === "number" ? speed : null,
    heading: typeof heading === "number" ? heading : null,
    altitude: typeof altitude === "number" ? altitude : null,
    status: status || (typeof lat === "number" && typeof lng === "number" ? "shared" : "unknown"),
    image,
    ip,
    ua,
    timestamp: Date.now()
  };
  data.events.push(item);
  writeData(data);
  publishEvent(item);
  res.json(item);
});

app.get("/api/events", requireAdmin, (req, res) => {
  const data = readData();
  const { linkId } = req.query;
  const list = linkId ? data.events.filter((e) => e.linkId === linkId) : data.events;
  res.json(list);
});

app.delete("/api/event/:id", requireAdmin, (req, res) => {
  const data = readData();
  const idx = data.events.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not_found" });
  const removed = data.events.splice(idx, 1)[0];
  if (removed && removed.image) {
    const rel = removed.image.startsWith("/") ? removed.image.slice(1) : removed.image;
    const fp = path.join(__dirname, "public", rel);
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
  }
  writeData(data);
  res.json(removed);
});

app.delete("/api/link/:id", requireAdmin, (req, res) => {
  const data = readData();
  const linkId = req.params.id;
  if (!data.links[linkId]) return res.status(404).json({ error: "not_found" });
  
  // Delete all events associated with this link
  const eventsToDelete = data.events.filter((e) => e.linkId === linkId);
  for (const event of eventsToDelete) {
    if (event && event.image) {
      const rel = event.image.startsWith("/") ? event.image.slice(1) : event.image;
      const fp = path.join(__dirname, "public", rel);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
    }
  }
  
  // Remove events and link
  data.events = data.events.filter((e) => e.linkId !== linkId);
  delete data.links[linkId];
  
  writeData(data);
  res.json({ deleted: true, eventsDeleted: eventsToDelete.length });
});

app.get("/api/export/csv", requireAdmin, (req, res) => {
  const data = readData();
  const { linkId } = req.query;
  
  let events = linkId ? data.events.filter((e) => e.linkId === linkId) : data.events;
  
  // CSV header
  let csv = "ID,Link ID,Client ID,Latitude,Longitude,Accuracy,Speed,Heading,Altitude,Status,IP,User Agent,Timestamp,Image\n";
  
  // CSV rows
  for (const event of events) {
    const row = [
      `"${event.id}"`,
      `"${event.linkId}"`,
      `"${event.clientId || ''}"`,
      event.lat !== null ? event.lat : '',
      event.lng !== null ? event.lng : '',
      event.accuracy !== null ? event.accuracy : '',
      event.speed !== null ? event.speed : '',
      event.heading !== null ? event.heading : '',
      event.altitude !== null ? event.altitude : '',
      `"${event.status || ''}"`,
      `"${event.ip || ''}"`,
      `"${(event.ua || '').replace(/"/g, '""')}"`,
      event.timestamp,
      `"${event.image || ''}"`
    ].join(',');
    csv += row + '\n';
  }
  
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="events_${linkId || 'all'}_${Date.now()}.csv"`);
  res.send(csv);
});

const port = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
  });
}

export default app;
