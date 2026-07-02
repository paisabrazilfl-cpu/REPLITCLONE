# AI Notes

## Model
Mavis (MiniMax Agent) — deployment task

## Objective
Deploy the Replit Clone repo from GitHub to Render as a live Web Service.

## Why
- User wants the app accessible at a public URL via Render
- Repo was already on GitHub; needed Render config + push
- The app has a Node.js backend (Express + WebSocket) + SQLite persistence

## Key Decisions

### `rootDir: ""` (repo root) vs `rootDir: "backend"`
Chose repo root so:
- Build command `cd backend && npm install` stays explicit
- Start command `cp index.html backend/index.html` works cleanly
- `backend/server.js` serves static files via `path.join(__dirname, '..')` → correct path

### Persistent volume for SQLite
Render's filesystem is ephemeral. The app uses `better-sqlite3` for project/file persistence.
Solution: `render.yaml` mounts a 1GB persistent disk at `/app/backend/data`.
Risk: volume deleted = DB lost (acceptable for v1).

### `better-sqlite3` native module
`npm install` fails without build tools in some envs. Fixed by:
- `npm install --ignore-scripts` (local dev)
- `npm rebuild better-sqlite3` in Render build command (has Node.js + Python + make)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `better-sqlite3` fails to build on Render | Low | High | `npm rebuild` in buildCommand |
| SQLite volume deleted, DB lost | Low | Medium | No user data worth preserving yet |
| Render free tier sleeps after 15 min inactivity | High | Low | Upgrade to paid plan or add uptime cron |
| Port mismatch (`$PORT` env var) | Low | High | Set PORT=10000 explicitly in env vars |
| `index.html` not found at startup | Low | High | `cp index.html backend/index.html` in startCommand |

## Next Steps
- [ ] Verify Render deploy succeeds after push
- [ ] Check `/api/health` endpoint on live URL
- [ ] Test project creation and file persistence across redeploys
- [ ] Consider PostgreSQL swap for production (SQLite not great for concurrent writes)
- [ ] Add `ANTHROPIC_API_KEY` env var on Render for AI assistant
- [ ] Set up custom domain if desired
