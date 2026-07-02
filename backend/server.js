const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const initSqlJs = require('sql.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const DATA_DIR = './data';
const DB_PATH  = path.join(DATA_DIR, 'replit.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── sql.js wrapper (mimics better-sqlite3 sync API) ─────────────────────────

let db = null;
let dbDirty = false;
let saveTimer = null;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT DEFAULT 'my-project',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS files (
      project_id TEXT,
      name TEXT,
      content TEXT DEFAULT '',
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (project_id, name)
    );
  `);

  // Periodic flush every 10s if dirty
  saveTimer = setInterval(() => {
    if (dbDirty) { saveDb(); dbDirty = false; }
  }, 10_000);

  console.log('[DB] Initialized (sql.js)');
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buf);
}

function closeDb() {
  if (saveTimer) clearInterval(saveTimer);
  if (db && dbDirty) saveDb();
  if (db) db.close();
}

// ── sql.js helpers (better-sqlite3-like API) ──────────────────────────────────

function dbRun(sql, ...params) {
  db.run(sql, params);
  dbDirty = true;
}

function dbGet(sql, ...params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

function dbAll(sql, ...params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Serve frontend from parent directory
app.use(express.static(path.join(__dirname, '..')));

// ── PROJECTS API ──────────────────────────────────────────────────────────────

app.post('/api/projects', (req, res) => {
  const id   = crypto.randomBytes(5).toString('hex');
  const name = (req.body && req.body.name) || 'my-project';
  db.run('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)', [id, name]);
  dbDirty = true;
  res.json({ id, name });
});

app.get('/api/projects/:id', (req, res) => {
  const project = dbGet('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const files = dbAll('SELECT name, content, updated_at FROM files WHERE project_id = ? ORDER BY name', req.params.id);
  res.json({ ...project, files });
});

app.put('/api/projects/:id/files', (req, res) => {
  const files = req.body.files || {};
  const now   = Math.floor(Date.now() / 1000);
  for (const [name, content] of Object.entries(files)) {
    db.run(`
      INSERT INTO files (project_id, name, content, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, name) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
    `, [req.params.id, name, content, now]);
  }
  dbDirty = true;
  res.json({ ok: true });
});

app.delete('/api/projects/:id/files/:name', (req, res) => {
  db.run('DELETE FROM files WHERE project_id = ? AND name = ?',
    req.params.id, decodeURIComponent(req.params.name));
  dbDirty = true;
  res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ── CODE EXECUTION ────────────────────────────────────────────────────────────

const RUNNERS = {
  javascript: { interp: 'node',    ext: '.js'  },
  python:     { interp: 'python3', ext: '.py'  },
  bash:       { interp: 'bash',    ext: '.sh'  },
  ruby:       { interp: 'ruby',    ext: '.rb'  },
  php:        { interp: 'php',     ext: '.php' },
  typescript: { interp: 'ts-node', ext: '.ts', flags: ['--transpile-only'] },
  cpp: {
    ext: '.cpp',
    compile: (src, bin) => ['g++', [src, '-o', bin, '-std=c++17', '-O2']],
    run:     (bin)      => [bin, []]
  },
  java: {
    ext: '.java',
    compile: (src, dir) => ['javac', ['-d', dir, src]],
    run:     (dir, cls) => ['java', ['-cp', dir, cls]]
  },
  rust: {
    ext: '.rs',
    compile: (src, bin) => ['rustc', [src, '-o', bin]],
    run:     (bin)      => [bin, []]
  },
  go: {
    ext: '.go',
    compile: (src, bin) => ['go', ['build', '-o', bin, src]],
    run:     (bin)      => [bin, []]
  }
};

function runProc(cmd, args, cwd, timeoutMs = 15000) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', killed = false;
    const safe_env = {
      PATH: process.env.PATH,
      HOME: cwd,
      GOPATH: '/tmp/go',
      GOCACHE: path.join(cwd, '.gocache'),
      CARGO_HOME: '/tmp/cargo',
      RUSTUP_HOME: '/tmp/rustup',
    };
    const proc = spawn(cmd, args, { cwd, env: safe_env });
    const timer = setTimeout(() => { killed = true; proc.kill('SIGKILL'); }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d; if (stdout.length > 200000) proc.kill(); });
    proc.stderr.on('data', d => { stderr += d; if (stderr.length > 50000) proc.kill(); });
    proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code: killed ? -1 : (code ?? -1), killed }); });
    proc.on('error', e   => { clearTimeout(timer); resolve({ stdout, stderr: e.message,  code: -1, killed: false }); });
  });
}

app.post('/api/run', async (req, res) => {
  const { language, code, filename } = req.body;
  const runner = RUNNERS[language];
  if (!runner) return res.json({ stdout: '', stderr: `Language not supported: ${language}`, code: 1 });

  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const baseName = (filename || 'main').replace(/\.[^.]+$/, '');
  const srcFile  = path.join(tmpDir, baseName + runner.ext);

  try {
    fs.writeFileSync(srcFile, code);
    let result;

    if (runner.interp) {
      const args = [...(runner.flags || []), srcFile];
      result = await runProc(runner.interp, args, tmpDir);
    } else {
      const binPath = path.join(tmpDir, baseName);
      const [cc, ca] = runner.compile(srcFile, language === 'java' ? tmpDir : binPath);
      const cr = await runProc(cc, ca, tmpDir, 30000);
      if (cr.code !== 0) {
        result = { stdout: '', stderr: cr.stderr || cr.stdout, code: cr.code, killed: cr.killed };
      } else {
        const [rc, ra] = language === 'java' ? runner.run(tmpDir, baseName) : runner.run(binPath);
        result = await runProc(rc, ra, tmpDir);
      }
    }

    res.json(result);
  } catch (e) {
    res.json({ stdout: '', stderr: e.message, code: 1 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── WEBSOCKET REAL-TIME COLLAB ────────────────────────────────────────────────

const rooms = new Map(); // projectId → Map(clientId → {ws, userId, color})
const COLORS = ['#f97316','#3b82f6','#10b981','#a855f7','#ef4444','#eab308','#06b6d4','#ec4899','#14b8a6','#8b5cf6'];
let colorCounter = 0;

wss.on('connection', (ws) => {
  const clientId  = crypto.randomBytes(4).toString('hex');
  let projectId    = null;
  let userId       = 'User';
  let userColor    = COLORS[colorCounter++ % COLORS.length];

  const send = (msg) => { try { ws.send(JSON.stringify(msg)); } catch (_) {} };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'join') {
      projectId = msg.projectId;
      userId    = msg.userId || ('User' + clientId.slice(0,4));
      if (!rooms.has(projectId)) rooms.set(projectId, new Map());
      rooms.get(projectId).set(clientId, { ws, userId, userColor });
      send({ type: 'welcome', clientId, userId, userColor });
      broadcast(projectId, clientId, { type: 'presence', users: getUsers(projectId) }, true);
      return;
    }

    if (!projectId) return;

    if (msg.type === 'update') {
      try {
        const now = Math.floor(Date.now() / 1000);
        db.run(`
          INSERT INTO files (project_id, name, content, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(project_id, name) DO UPDATE SET
            content = excluded.content,
            updated_at = excluded.updated_at
        `, [projectId, msg.file, msg.content, now]);
        dbDirty = true;
      } catch (_) {}
      broadcast(projectId, clientId, { type: 'update', file: msg.file, content: msg.content, userId, userColor });
      return;
    }

    if (msg.type === 'cursor') {
      broadcast(projectId, clientId, { type: 'cursor', file: msg.file, line: msg.line, col: msg.col, userId, userColor });
      return;
    }

    if (msg.type === 'ping') send({ type: 'pong' });
  });

  ws.on('close', () => {
    if (projectId && rooms.has(projectId)) {
      rooms.get(projectId).delete(clientId);
      if (rooms.get(projectId).size === 0) rooms.delete(projectId);
      else broadcast(projectId, clientId, { type: 'presence', users: getUsers(projectId) }, true);
    }
  });
});

function getUsers(projectId) {
  if (!rooms.has(projectId)) return [];
  return [...rooms.get(projectId).values()].map(p => ({ userId: p.userId, userColor: p.userColor }));
}

function broadcast(projectId, senderClientId, msg, includeSender = false) {
  if (!rooms.has(projectId)) return;
  const data = JSON.stringify(msg);
  rooms.get(projectId).forEach((peer, cid) => {
    if ((includeSender || cid !== senderClientId) && peer.ws.readyState === 1) {
      try { peer.ws.send(data); } catch (_) {}
    }
  });
}

// Keep connections alive
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
  });
}, 25000);

// ── Startup ───────────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { closeDb(); process.exit(0); });
process.on('SIGINT',  () => { closeDb(); process.exit(0); });

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Replit Clone] Backend running on :${PORT}`);
    console.log(`[Replit Clone] SQLite: ${DB_PATH}`);
  });
}).catch(err => {
  console.error('[Replit Clone] DB init failed:', err);
  process.exit(1);
});
