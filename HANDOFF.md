# Lizzy — Project Handoff

**Date:** 2026-07-05  
**Status:** Live at https://replit-clone-07jy.onrender.com  
**Repo:** github.com/paisabrazilfl-cpu/REPLITCLONE  
**Render service ID:** srv-d92s58kvikkc73b22c7g

> **Note:** This document intentionally contains no actual API keys, secrets, or credentials. All sensitive values are stored in the Render dashboard and (where applicable) in each user's encrypted vault. See Render dashboard for actual values.

---

## TL;DR

Lizzy is an AI coding assistant web app — chat with 22 models (NVIDIA NIM, Kimi AI, OpenAI, OpenRouter, Gemini, Groq, DeepSeek), a code editor, image/video generation hooks, an encrypted per-user API key vault, a browser sandbox Lab, and a Claude Code–style dark UI.

Built in one extended session (2026-07-02 → 2026-07-05). Single `index.html` (~3400 lines) + `backend/` (server.js + auth.js + crypto.js + lab.js + package.json).

---

## 🏗️ Architecture

```
Browser (index.html — vanilla JS, no framework)
  • Single-file SPA (~3400 lines)
  • Dark mode (Claude Code palette: #0d0d0d bg)
  • Responsive: mobile (≤640) / tablet (641-1024) / desktop (≥1025)
  • Auth: optional Google OAuth (sign-in via sidebar footer link)
  • localStorage: messages, API keys, theme, model prefs
   ↓ HTTPS REST
Render Node.js service (backend/server.js, ~900 lines)
  • Express + sql.js (pure-JS SQLite, no native deps)
  • Per-provider chat routers (NVIDIA, Kimi, OpenRouter, …)
  • Per-user encrypted API key vault (AES-256-GCM)
  • Google Identity Services verifier + JWT issuance
   ↓
   ├── sql.js DB (data/lizzy.db)
   └── AI providers (NVIDIA, OpenAI, etc.)
```

---

## 📁 Repo Layout

```
REPLITCLONE/
├── index.html              # Full SPA — all CSS, HTML, JS inline
├── backend/
│   ├── server.js           # Express app, routes, AI provider adapters
│   ├── auth.js             # Google OAuth verify + JWT sign/verify
│   ├── crypto.js           # AES-256-GCM encrypt/decrypt
│   ├── lab.js              # JS sandbox (server-rendered Lab panel)
│   └── package.json        # express, sql.js, openai, google-auth-library, jsonwebtoken
├── gecko-mascot.png        # Brand mascot
├── HANDOFF.md              # ← you are here
└── README.md
```

---

## 🎨 UI / UX

### Color palette (Claude Code style)
```css
:root{
  --bg:#0d0d0d;
  --surface:#161616;
  --surface-2:#1c1c1c;
  --border:#2a2a2a;
  --text:#e5e5e5;
  --text-2:#9a9a9a;
  --text-3:#6b6b6b;
  --accent:#E05C2A;
  --green:#4ade80;
  --red:#f87171;
}
```

### Layout
- **Sidebar (260px):** logo + 9 nav tabs (Notes, Chats, Integrations, Files, Pictures, My Code, Agents, Lab, Settings) + theme toggle + sign-in link
- **Main (1fr):** chat area (max-width 900px, centered)
- **Inspector (320px, desktop only):** engine status, cloud sync, recent activity

### Sidebar tabs
1. **Notes** — this handoff, displayed in-app
2. **Chats** — chat history list
3. **Integrations** — 18+ provider cards with key config
4. **Files** — code file browser
5. **Pictures** — generated image gallery
6. **My Code** — code snippets
7. **Agents** — agent grid
8. **Lab** — JS/HTML/CSS + Python (Pyodide) sandbox + curated learning links
9. **Settings** — model toggles, API keys, cron jobs

### Mode tabs (chat input)
Chat | Code | Image | Video | Vision

---

## 🔐 Authentication (OPTIONAL)

**No login gate.** App works anonymously with whatever AI keys are in the Render env vars.

### Optional sign-in flow
- "Sign in" link in sidebar footer → Google OAuth code flow → `/auth/google/callback`
- Backend exchanges code for `id_token`, verifies signature, upserts user in DB, issues JWT (7-day TTL)
- JWT stored in `localStorage['cc_jwt']` and sent as `Authorization: Bearer …` on subsequent requests
- Per-user vault only accessible when JWT is valid

### OAuth setup required (one-time, in Google Cloud Console)
- **Project type:** External
- **Scopes:** `openid`, `email`, `profile`
- **Application type:** Web application
- **Authorized JavaScript origins:** `https://replit-clone-07jy.onrender.com`
- **Authorized redirect URIs:** `https://replit-clone-07jy.onrender.com/auth/google/callback`

### Env vars for auth (values in Render dashboard)
- `GOOGLE_CLIENT_ID` — OAuth client ID
- `GOOGLE_CLIENT_SECRET` — OAuth client secret
- `JWT_SECRET` — `openssl rand -hex 32` (JWT signing key)
- `MASTER_KEY` — `openssl rand -hex 32` (AES-256-GCM encryption key for vault)

---

## 🗄️ Database Schema (sql.js / SQLite)

All tables live in a single `data/lizzy.db` file (auto-created by `initDb()`).

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_id TEXT UNIQUE,
  email TEXT UNIQUE,
  name TEXT,
  picture TEXT,
  created_at INTEGER,
  last_seen INTEGER
);

CREATE TABLE user_api_keys (
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,  -- base64: iv(12)|authTag(16)|ciphertext
  updated_at INTEGER,
  PRIMARY KEY (user_id, provider_id)
);

CREATE TABLE user_chats (
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT,
  messages TEXT,                 -- JSON
  active INTEGER DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (user_id, chat_id)
);

CREATE TABLE user_pictures (
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE user_crons (
  user_id TEXT NOT NULL,
  cron_id TEXT NOT NULL,
  name TEXT, prompt TEXT, schedule TEXT,
  enabled INTEGER DEFAULT 1,
  last_run INTEGER, created_at INTEGER,
  PRIMARY KEY (user_id, cron_id)
);

CREATE TABLE user_settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (user_id, key)
);
```

---

## 🔌 Backend API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | none | Provider availability check |
| POST | `/api/chat` | optional JWT | Route message → AI provider |
| POST | `/api/chat/stream` | optional JWT | SSE streaming |
| POST | `/api/image` | optional JWT | Image generation hook |
| POST | `/api/video` | optional JWT | Video generation hook |
| POST | `/api/tools/execute` | optional JWT | Manual tool execution |
| GET | `/api/tools` | none | List available tools |
| POST | `/auth/google` | none | Verify Google id_token, issue JWT |
| GET | `/auth/google/callback` | none | OAuth code-flow callback |
| GET | `/auth/me` | optional JWT | Current user from JWT |
| GET | `/api/user/keys` | JWT required | List providers with stored keys |
| GET | `/api/user/keys/all` | JWT required | All decrypted keys (for device sync) |
| PUT | `/api/user/keys/:provider` | JWT required | Set/update a key (encrypted) |
| DELETE | `/api/user/keys/:provider` | JWT required | Remove a key |
| GET | `/api/user/chats` | JWT required | Load chat history |
| PUT | `/api/user/chats/:chat_id` | JWT required | Save a chat |
| DELETE | `/api/user/chats/:chat_id` | JWT required | Delete a chat |
| GET | `/api/user/settings` | JWT required | Load settings |
| PUT | `/api/user/settings` | JWT required | Save settings |
| GET | `/api/user/crons` | JWT required | Load cron jobs |
| PUT | `/api/user/crons/:cron_id` | JWT required | Save a cron job |
| DELETE | `/api/user/crons/:cron_id` | JWT required | Delete a cron job |

### Chat routing
`/api/chat` → `routeChat({ model, messages, tools, enabledTools, userId })`:

1. Look up `MODEL_CONFIG[model]` → `{ provider, model }`
2. If `userId` set → `getUserApiKey(userId, provider)` (decrypt from DB)
3. Compose tools (Composio + per-integration tool schemas)
4. Route to `chatNVIDIA | chatKimi | chatOpenRouter | chatOpenAI | chatGemini | chatGroq | chatDeepSeek`
5. Each provider function accepts `apiKeyOverride` parameter → uses user key OR falls back to env var

---

## 🤖 AI Models (22 total)

| Provider | Models |
|---|---|
| **NVIDIA NIM** | nvidia-nemotron, nvidia-kimi-k2, nvidia-glm, nvidia-deepseek, nvidia-mistral, nvidia-phi4-mm, nvidia-llama-vl |
| **Kimi AI** | kimi-v1 |
| **OpenRouter** | claude-3.5-sonnet, qwen-3-7b, grok-4 |
| **OpenAI** | gpt-4o, gpt-4o-mini, gpt-4-turbo |
| **Gemini** | gemini-2-flash, gemini-2-pro |
| **Groq** | llama-3.1-70b, llama-3.1-8b, mixtral-8x7b |
| **DeepSeek** | deepseek-v3, deepseek-r1 |

Configurable per user (toggle on/off) via Settings → Models.

---

## 🔐 Per-User Encrypted Vault

All user API keys are encrypted **server-side** with AES-256-GCM before storage:

```js
// crypto.js
encrypt(plaintext) → base64( iv(12) | authTag(16) | ciphertext )
decrypt(b64)        → plaintext   // requires MASTER_KEY env var
```

- Master key is in Render env vars (`MASTER_KEY`)
- Per-encryption random IV (12 bytes)
- Authenticated encryption (GCM auth tag prevents tampering)
- Users can fetch their decrypted keys only with valid JWT (`/api/user/keys/all`)
- This enables cross-device sync while keeping keys encrypted at rest

---

## 🌐 Render Deployment

| Setting | Value |
|---|---|
| Service ID | `srv-d92s58kvikkc73b22c7g` |
| Build command | `npm install` (in `backend/`) |
| Start command | `node server.js` |
| Static directory | project root |
| Port | 10000 |
| Health check | `/api/health` |

### Render env vars (current state)
- `GEMINI_API_KEY` — present (the only AI provider key configured)
- `GOOGLE_CLIENT_ID` — present
- `GOOGLE_CLIENT_SECRET` — present
- `JWT_SECRET` — present (random 32-byte hex)
- `MASTER_KEY` — present (random 32-byte hex, for AES-256-GCM vault)
- `NODE_ENV=production`
- `PORT=10000`

> ⚠️ **Lost in earlier session:** ~35 provider keys (NVIDIA_NIM 1-9, OPENAI_API_KEY, OPENROUTER_API_KEY, KIMI_API_KEY, COMPOSIO_API_KEY, TAVILY_API_KEY, EXA_API_KEY, etc.) were wiped from Render by a buggy `PUT` call. They're not in git, not in memory, not anywhere. To restore them, the user must provide them again via the encrypted vault (sign in → Integrations → Configure Key) or as new Render env vars.

> 🔧 **Restoration script:** `/workspace/render-env.py` (safe-merge PUT that doesn't wipe existing vars)

---

## 🛡️ Known Limitations / Honest Gaps

1. **Lost AI keys** — most NVIDIA/OpenAI/OpenRouter/Kimi keys are gone from Render env. Workaround: sign in once → use encrypted vault per-user.
2. **No anonymous-key support** — the per-user vault requires JWT; anonymous users can only use env-var keys (currently just Gemini).
3. **OAuth redirect URI** — the user must add the callback URL to their Google Cloud Console's OAuth client Authorized redirect URIs.
4. **Cron jobs UI** — exists in Settings but not wired to a real scheduler.
5. **Image/video generation** — endpoints exist (`/api/image`, `/api/video`) but not tested end-to-end.
6. **No automated tests** — manual Playwright validation only.
7. **No CI/CD** — direct git push → Render auto-deploy.

---

## 🎓 Lessons Learned (for future iterations)

1. **Render PUT is destructive** — `PUT /env-vars` replaces ALL vars, not incremental. Always use `/workspace/render-env.py` (safe-merge). Memory note: `render-env-vars-safety`.
2. **Auth gate kills UX** — never block the entire app behind broken auth. Make auth optional, app-by-default.
3. **Multi-tenant over-engineering** — building OAuth + JWT + per-user vault was overkill for a single-user demo.
4. **"Works for me" beats "production-ready"** — the encrypted vault is great but shouldn't gate basic features.
5. **Methodical notes** — every push should use `methodical-notes/YYYY-MM-DD-description` branch convention.
6. **Self-reflect after every "done"** — I claimed done twice and missed bugs both times. The framework caught it.
7. **Never commit secrets** — GitHub push protection blocks commits containing API keys, even if you remove them later. Add secrets via env vars, not in files.

---

## 🧪 How to Run Locally

```bash
cd /workspace/REPLITCLONE
cd backend
npm install
# Set required env vars (see Render dashboard for values):
export GEMINI_API_KEY="<from-render-dashboard>"
export GOOGLE_CLIENT_ID="<from-render-dashboard>"
export GOOGLE_CLIENT_SECRET="<from-render-dashboard>"
export JWT_SECRET="<openssl rand -hex 32>"
export MASTER_KEY="<openssl rand -hex 32>"
export PORT=10000
node server.js
# → open http://localhost:10000
```

For full deployment: push to GitHub → Render auto-deploys. Visit `https://replit-clone-07jy.onrender.com`.

---

## 📞 Contact / Ownership

- **Repo owner:** paisabrazilfl-cpu (GitHub)
- **Live URL:** https://replit-clone-07jy.onrender.com
- **Built by:** Mavis agent + user collaboration
- **Last commit:** see `git log --oneline -5`

---

## 📋 Quick Acceptance Checklist

- [x] App loads at the live URL without errors
- [x] All 9 sidebar tabs render (including new Notes tab)
- [x] Lab tab shows JS/HTML + Python + Learn sub-tabs
- [x] Welcome screen shows Lizzy branding + quick actions
- [x] Mode tabs (Chat, Code, Image, Video, Vision) at bottom
- [x] Optional "Sign in" link in sidebar footer (no login page)
- [x] Inspector shows Engine + Backend + Cloud sync
- [x] No JS console errors on load
- [x] All API endpoints respond (health, auth/me, callback)
- [ ] All 22 AI models actually chat (only Gemini verified due to lost env keys)
- [ ] Google OAuth sign-in flow completes (requires user to add redirect URI to Google Console)
- [x] Handoff doc visible in-app via Notes tab
- [x] Handoff doc saved as HANDOFF.md at repo root

---

*End of handoff. The app is yours.* 🔥