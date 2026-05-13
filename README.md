# TaskRoom Backend API

Production-grade REST + WebSocket API for the TaskRoom field workforce management platform.

**Live API:** `https://api.taskroom.in` (or your Render subdomain)

---

## Quick start

```bash
cp .env.example .env   # fill in all values
npm install
npm run dev            # nodemon
```

## Production deploy (Render)

1. Push this repo to GitHub.
2. In Render → New Web Service → connect repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Set every variable from `.env.example` in the Render Environment tab.

---

## Environment variables

See `.env.example` for the full list. All are required in production.

Key ones:

| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | Long random string for token signing |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins |
| `RAZORPAY_*` | Payment gateway credentials |
| `FIREBASE_*` | FCM push notifications |
| `CLOUDINARY_*` | Image uploads |
| `RESEND_*` | Transactional email |

---

## API routes

| Prefix | Description |
|---|---|
| `POST /api/auth/register` | Register user |
| `POST /api/auth/login` | Login |
| `GET /api/user/profile` | My profile |
| `GET /api/organization/check` | Check org by code |
| `POST /api/organization/create` | Create org (self-service) |
| `/api/rooms/*` | Room CRUD & membership |
| `/api/tasks/*` | Task & step lifecycle |
| `/api/attendance/*` | Clock in / out, history |
| `/api/analytics/*` | Productivity dashboard |
| `/api/export/*` | PDF / Excel reports |
| `/api/billing/*` | Razorpay plans & payments |
| `/api/upload/*` | Cloudinary image uploads |
| `/api/fcm/*` | FCM token management |
| `/api/admin/plans` | Plan CRUD (admin only) |
| `GET /api/health` | Health check |

---

## WebSocket events (Socket.IO)

| Emit | Direction | Description |
|---|---|---|
| `join_task_location` | Employee → Server | Join tracking room |
| `location_update` | Employee → Server | Send GPS ping |
| `leave_task_location` | Employee → Server | Leave room |
| `watch_task_location` | Manager → Server | Start watching |
| `unwatch_task_location` | Manager → Server | Stop watching |
| `employee_location` | Server → Manager | Real-time location broadcast |

---

## Notes

- `public/` directory has been removed — this is a pure API server.
  The website lives in a separate project.
- Rate limiting: 30 req/15 min on `/api/auth`, 200 req/min on all other `/api` routes.
- Graceful shutdown handles `SIGTERM` (Render deploy restarts).
