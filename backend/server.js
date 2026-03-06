/**
 * Sochau Share — Signaling Server (multi-peer edition)
 *
 * Supports rooms of 2, 3, or 4 peers.
 * Capacity is set by the FIRST peer who joins a room (via join-room payload).
 * All subsequent peers inherit the room's capacity.
 *
 * Mesh topology: every peer creates an RTCPeerConnection to every other peer.
 * Signaling messages carry a `targetId` so the server can route them precisely.
 *
 * Room registry:
 *   rooms: Map<roomId, { capacity: number, peers: Set<socketId> }>
 *
 * FIX: Room IDs are normalized to lowercase on arrival so that
 *      "MyRoom", "myroom", and "MYROOM" all resolve to the same room.
 */

"use strict";

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const cors       = require("cors");

// ─── Environment ─────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

// ─── Validation ───────────────────────────────────────────────────────────────
// Only lowercase after normalization — no uppercase needed
const ROOM_ID_RE       = /^[a-z0-9\-]{6,64}$/;
const VALID_CAPACITIES = new Set([2, 3, 4]);

function normalizeRoomId(id) {
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}

function isValidRoomId(id) {
  return typeof id === "string" && ROOM_ID_RE.test(id);
}

// ─── Room registry ────────────────────────────────────────────────────────────
// Map<roomId, { capacity: number, peers: Set<socketId> }>
const rooms = new Map();

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function getRoomSize(roomId) {
  return rooms.has(roomId) ? rooms.get(roomId).peers.size : 0;
}

function createRoom(roomId, capacity) {
  rooms.set(roomId, { capacity, peers: new Set() });
}

function addToRoom(roomId, socketId) {
  rooms.get(roomId).peers.add(socketId);
}

function removeFromRoom(roomId, socketId) {
  if (!rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  room.peers.delete(socketId);
  if (room.peers.size === 0) rooms.delete(roomId); // auto-cleanup
}

/** Return all other socket IDs in the room */
function getPeers(roomId, selfId) {
  if (!rooms.has(roomId)) return [];
  return [...rooms.get(roomId).peers].filter(id => id !== selfId);
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: CLIENT_URL, methods: ["GET"] }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
}));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: rooms.size });
});

// Room probe — returns current peers, capacity, full status
app.get("/:roomId", (req, res) => {
  // FIX: normalize to lowercase before validation and lookup
  const roomId = normalizeRoomId(req.params.roomId);
  if (!isValidRoomId(roomId)) {
    return res.status(400).json({ error: "Invalid room ID." });
  }
  const room = getRoom(roomId);
  if (!room) {
    return res.json({ roomId, peers: 0, capacity: null, full: false });
  }
  res.json({
    roomId,
    peers:    room.peers.size,
    capacity: room.capacity,
    full:     room.peers.size >= room.capacity,
  });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors:              { origin: CLIENT_URL, methods: ["GET", "POST"] },
  perMessageDeflate: false,
  transports:        ["websocket"],
});

// ─── Per-socket rate limiter ──────────────────────────────────────────────────
const MAX_EVENTS = 120;   // higher limit for mesh (N-1 connections each)
const WINDOW_MS  = 10_000;

function makeRateLimiter() {
  const counters = new Map();
  return function isAllowed(socketId) {
    const now = Date.now();
    if (!counters.has(socketId) || counters.get(socketId).resetAt <= now) {
      counters.set(socketId, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    const entry = counters.get(socketId);
    entry.count++;
    return entry.count <= MAX_EVENTS;
  };
}

const socketRateLimit = makeRateLimiter();

// ─── Connection handler ───────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;

  function checkRate() {
    if (!socketRateLimit(socket.id)) {
      socket.emit("error", { message: "Rate limit exceeded." });
      return false;
    }
    return true;
  }

  // ── join-room ──────────────────────────────────────────────────────────────
  // Payload: { roomId: string, capacity?: 2|3|4 }
  // capacity is honoured only when creating a new room (first joiner sets it).
  socket.on("join-room", ({ roomId: rawRoomId, capacity } = {}) => {
    if (!checkRate()) return;

    // FIX: normalize to lowercase before any validation or lookup
    const roomId = normalizeRoomId(rawRoomId);

    if (!isValidRoomId(roomId)) {
      socket.emit("error", { message: "Invalid room ID." });
      return;
    }
    if (currentRoom) {
      socket.emit("error", { message: "Already in a room." });
      return;
    }

    // First peer creates the room with their chosen capacity (default 2)
    if (!rooms.has(roomId)) {
      const cap = VALID_CAPACITIES.has(capacity) ? capacity : 2;
      createRoom(roomId, cap);
    }

    const room = getRoom(roomId);

    if (room.peers.size >= room.capacity) {
      socket.emit("error", { message: `Room is full (max ${room.capacity} peers).` });
      return;
    }

    // Get existing peers BEFORE adding self (used to set up mesh)
    const existingPeers = getPeers(roomId, socket.id);

    currentRoom = roomId;
    addToRoom(roomId, socket.id);
    socket.join(roomId);

    // Tell this peer: your ID, room capacity, and who's already here
    socket.emit("joined", {
      socketId:     socket.id,
      roomId,
      capacity:     room.capacity,
      existingPeers,           // array of socketIds already in room
    });

    // Tell every existing peer that a new peer arrived
    existingPeers.forEach(peerId => {
      io.to(peerId).emit("peer-joined", { socketId: socket.id });
    });
  });

  // ── offer ──────────────────────────────────────────────────────────────────
  // Payload: { targetId: string, sdp: RTCSessionDescriptionInit }
  socket.on("offer", (payload) => {
    if (!checkRate()) return;
    if (!currentRoom || !payload?.targetId) return;
    // Relay only to the intended target — not broadcast
    io.to(payload.targetId).emit("offer", {
      senderId: socket.id,
      sdp:      payload.sdp,
    });
  });

  // ── answer ─────────────────────────────────────────────────────────────────
  // Payload: { targetId: string, sdp: RTCSessionDescriptionInit }
  socket.on("answer", (payload) => {
    if (!checkRate()) return;
    if (!currentRoom || !payload?.targetId) return;
    io.to(payload.targetId).emit("answer", {
      senderId: socket.id,
      sdp:      payload.sdp,
    });
  });

  // ── ice-candidate ──────────────────────────────────────────────────────────
  // Payload: { targetId: string, candidate: RTCIceCandidateInit }
  socket.on("ice-candidate", (payload) => {
    if (!checkRate()) return;
    if (!currentRoom || !payload?.targetId) return;
    io.to(payload.targetId).emit("ice-candidate", {
      senderId:  socket.id,
      candidate: payload.candidate,
    });
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    if (!currentRoom) return;

    const remainingPeers = getPeers(currentRoom, socket.id);
    removeFromRoom(currentRoom, socket.id);

    // Notify every remaining peer
    remainingPeers.forEach(peerId => {
      io.to(peerId).emit("peer-left", { socketId: socket.id });
    });

    currentRoom = null;
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
  console.log(`Accepting connections from: ${CLIENT_URL}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down…`);
  httpServer.close(() => { process.exit(0); });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));