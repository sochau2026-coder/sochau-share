# Sochau Share

> **Peer-to-peer encrypted file transfer. No relay. No storage. Files travel directly between browsers via WebRTC DataChannel.**

---

## How it works

```
Browser A ──── Socket.IO (signaling only) ────▶ Node.js server
Browser A ◀──────────── WebRTC DataChannel ────▶ Browser B
                         (files travel here)
```

1. Both peers open the same room URL (e.g. `https://share.sochau.cloud/sale1`).
2. The signaling server exchanges SDP offer/answer and ICE candidates.
3. A direct WebRTC DataChannel opens between the two browsers.
4. Files are chunked (64 KB), streamed through the DataChannel, and reassembled on the other side.
5. The signaling server **never sees file data** — it only passes ~200 byte JSON messages.

---

## Project structure

```
sochau-share/
├── backend/
│   ├── server.js        Node.js + Express + Socket.IO signaling server
│   ├── package.json
│   ├── Dockerfile       Multi-stage build (Node 20 Alpine, non-root)
│   └── .env             Environment variables (never commit real secrets)
│
├── frontend/
│   ├── index.html       Single-page app shell
│   ├── style.css        Dark glassmorphism UI (Syne + JetBrains Mono)
│   ├── app.js           Full WebRTC engine — 9 pure modules, no framework
│   └── assets/          Static assets (icons, favicons)
│
├── nginx/
│   └── default.conf     Reverse proxy + TLS + CSP + WebSocket upgrade
│
├── docker-compose.yml   Full stack: backend + frontend + optional Certbot
└── README.md
```

---

## Quick start (local development)

### Prerequisites

- Node.js ≥ 18
- Docker + Docker Compose (for containerised run)

### 1 — Run backend locally

```bash
cd backend
cp .env .env.local          # edit if needed
npm install
npm run dev                  # node --watch server.js
```

Backend listens on `http://localhost:3000`.

### 2 — Serve frontend locally

Any static server works:

```bash
cd frontend
npx serve .
# or
python3 -m http.server 5173
```

Open two tabs at `http://localhost:5173/testroom` — they will connect to each other.

> **Note:** WebRTC requires either `localhost` or an HTTPS origin. Plain HTTP on a remote IP will fail ICE negotiation.

---

## Production deployment (Docker)

### 1 — Clone and configure

```bash
git clone https://github.com/yourorg/sochau-share.git
cd sochau-share

# Fill in your real domain and origin
cp backend/.env backend/.env
nano backend/.env
```

**`backend/.env`**

```env
PORT=3000
CLIENT_URL=https://share.sochau.cloud
```

### 2 — Provision TLS certificates

**Option A — Certbot (recommended)**

```bash
mkdir -p certs/letsencrypt certs/certbot

# Temporarily serve HTTP on port 80 for the ACME challenge
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d share.sochau.cloud \
  --email you@example.com \
  --agree-tos --no-eff-email

# Enable auto-renewal sidecar
docker compose --profile certbot up -d certbot
```

**Option B — Bring your own certs**

```bash
mkdir -p certs/letsencrypt/live/share.sochau.cloud
cp fullchain.pem certs/letsencrypt/live/share.sochau.cloud/
cp privkey.pem   certs/letsencrypt/live/share.sochau.cloud/
```

### 3 — Build and start

```bash
docker compose up -d --build
```

```
✔ backend    healthy   (port 3000, internal only)
✔ frontend   healthy   (ports 80 → 443 public)
```

### 4 — Verify

```bash
# Health check
curl https://share.sochau.cloud/health

# Check logs
docker compose logs -f backend
docker compose logs -f frontend
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the Node.js server listens on |
| `CLIENT_URL` | `http://localhost:5173` | Allowed CORS origin (your frontend domain) |
| `NODE_ENV` | `production` | Node environment |

---

## Architecture deep-dive

### Signaling server (`backend/server.js`)

| Concern | Implementation |
|---|---|
| Security headers | `helmet()` middleware |
| CORS | Locked to `CLIENT_URL` — single origin |
| HTTP rate limiting | 100 req / 15 min per IP (`express-rate-limit`) |
| Socket rate limiting | 60 events / 10 s per socket (custom rolling window) |
| Room ID validation | `/^[a-zA-Z0-9]{6,64}$/` — enforced before any room op |
| Max peers per room | 2 — enforced atomically before `addToRoom()` |
| Auto-cleanup | Room `Map` entry deleted when last peer leaves |
| Payload inspection | **Never** — offer/answer/ICE are relayed opaque |
| Graceful shutdown | `SIGTERM`/`SIGINT` drain the HTTP server |

**Signaling event flow:**

```
Client A                   Server                  Client B
   │─── join-room ────────▶│                          │
   │◀── joined(initiator)  │                          │
   │                       │◀──── join-room ──────────│
   │◀── peer-joined        │──── joined(responder) ──▶│
   │─── offer ────────────▶│──────────────────────────▶│
   │                       │◀──── answer ─────────────│
   │◀─────────────────────▶│──── ice-candidate ───────▶│
   │      (DataChannel opens — signaling server is done)
   │◀══════════════ files via WebRTC DataChannel ══════▶│
```

### Frontend (`frontend/app.js`) — 9 modules

| Module | Lines | Responsibility |
|---|---|---|
| `Config` | ~20 | Frozen constants — STUN, chunk size, thresholds |
| `State` | ~15 | Single mutable object — no globals |
| `FileUtils` | ~45 | Pure helpers — format, ID, icon, XSS escape |
| `UI` | ~100 | DOM-only updates — zero business logic |
| `Signaling` | ~70 | Socket.IO wrapper — join/offer/answer/ICE |
| `PeerConnection` | ~110 | RTCPeerConnection lifecycle + DataChannel setup |
| `Sender` | ~110 | Chunked outbound with back-pressure + cancellation |
| `Receiver` | ~90 | Inbound reassembly, progress, auto-download |
| `App` | ~110 | URL parsing, event wiring, folder traversal |

### File transfer protocol

```
Sender → Receiver:

  JSON  { type:'meta',  fileId, name, size, total }
  JSON  { type:'chunk', fileId, index:0 }
  BINARY  <ArrayBuffer 64KB>
  JSON  { type:'chunk', fileId, index:1 }
  BINARY  <ArrayBuffer 64KB>
  ...
  JSON  { type:'done',  fileId }          ← triggers auto-download

  (on cancel)
  JSON  { type:'cancel', fileId }         ← receiver cleans up
```

**Back-pressure:** Sender checks `dc.bufferedAmount > 8 MB` before each chunk and awaits `onbufferedamountlow` if needed — prevents DataChannel buffer overflow on large files.

**Reassembly:** Receiver stores chunks in a pre-allocated array by index, then calls `new Blob(chunks)` once — O(1) memory, no concatenation loops.

**Auto-download:** `URL.createObjectURL(blob)` + synthetic `<a>` click. Object URL revoked after 10 s.

### Nginx (`nginx/default.conf`)

| Feature | Detail |
|---|---|
| HTTP → HTTPS | 301 redirect (ACME challenge exempted) |
| TLS | TLS 1.2/1.3 only, OCSP stapling, session caching |
| Security headers | HSTS, CSP, X-Frame-Options, Referrer-Policy |
| WebSocket proxy | `Upgrade` + `Connection` headers, 3600 s timeout, buffering off |
| Static assets | `Cache-Control: public, immutable`, 1-year expiry |
| SPA routing | `try_files $uri /index.html` → room URLs work on reload |
| Rate limiting | 3 zones: `api` (30/min), `static` (300/min), `conn` (20 concurrent) |
| Hidden files | `.git`, `.env` etc. blocked with `deny all` |

---

## Security considerations

- **End-to-end encryption:** WebRTC DataChannels are encrypted with DTLS-SRTP by default. No additional application-layer encryption is needed.
- **No file persistence:** The server has no disk write access, no database, no blob storage.
- **No payload logging:** The signaling server only logs structural events (join/leave) — never message contents.
- **Room ID entropy:** A 10-character alphanumeric room ID has ~60 bits of entropy — sufficient for casual use. For high-security transfers, use a longer ID.
- **CORS:** The backend rejects all WebSocket connections from origins other than `CLIENT_URL`.
- **Rate limiting:** Both HTTP (Nginx + Express) and Socket.IO event rates are limited per IP.

---

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| ICE connection fails | Both peers behind symmetric NAT | Add TURN server to `Config.ICE_SERVERS` |
| `Cannot reach signaling server` | Backend down or CORS mismatch | Check `CLIENT_URL` in `.env` matches frontend origin |
| Room full error | A third browser tab joined | Use a fresh room ID |
| File not downloading | Browser blocked pop-up | Allow pop-ups for the domain, or check `blob:` in CSP |
| Transfer stalls | Large file, slow DataChannel buffer | Increase `BUFFER_THRESHOLD` in `Config` |

### Adding a TURN server

For users behind restrictive NAT/firewalls, add TURN to `frontend/app.js`:

```javascript
ICE_SERVERS: [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls:       'turn:turn.yourserver.com:3478',
    username:   'user',
    credential: 'password',
  },
],
```

Free options: [Open Relay](https://www.metered.ca/tools/openrelay/) · Self-hosted: [Coturn](https://github.com/coturn/coturn)

---

## Useful commands

```bash
# View all running containers
docker compose ps

# Tail all logs
docker compose logs -f

# Restart backend only
docker compose restart backend

# Rebuild after code changes
docker compose up -d --build backend

# Force renew TLS cert
docker compose run --rm certbot renew --force-renewal

# Stop everything
docker compose down

# Stop and remove volumes
docker compose down -v
```

---

## Whiteboard Features

### Infinite Canvas
- **Pan**: Middle-click drag or right-click drag (unlimited)
- **Zoom**: Ctrl+Scroll (10%-1000%) or +/- buttons
- **Zoom Scaling**: Exponential (×1.2) for smooth experience

### Brush Size Control
- **Range**: 1-30 pixels
- **Controls**: Click +/- buttons or press -/+ keys
- **Display**: Shows current size in toolbar

### Tools
| Key | Tool |
|-----|------|
| P | Pen |
| E | Eraser |
| T | Text |
| R | Rectangle |
| C | Circle |

### Other Controls
- `Ctrl+Z` - Undo
- Click "Clear" - Clear canvas
- "Invite Peers" - Share room code

---

## Fixes Applied

### Fix #1: Infinite Zoom Range
- MIN_ZOOM: 0.5 → 0.1 (10%)
- MAX_ZOOM: 3 → 10 (1000%)
- Linear → Exponential scaling

### Fix #2: Red Warning Line
- Added CSS `[hidden]` rule
- Error indicator hidden on startup

### Fix #3: Drawing Disappearance
- Removed inappropriate `clearRect()` from `_resetCtx()`
- Drawings persist correctly

### Fix #4: Connection Status
- Green for connected, red only for real errors

---

## Files Modified

| File | Changes |
|------|---------|
| `frontend/whiteboard.js` | Pan/zoom, brush size, bug fixes |
| `frontend/app.js` | Connection error handling |
| `frontend/index.html` | UI controls (+/-, zoom buttons) |
| `frontend/style.css` | Display styling, [hidden] rule |

---

## License

MIT — see [LICENSE](LICENSE)