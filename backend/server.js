const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Ensure data dir exists (mounted persistent volume on Fly.io)
fs.mkdirSync('./data', { recursive: true });

const db = new Database('./data/replit.db');

db.exec(`
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

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Serve frontend from parent directory
app.use(express.static(path.join(__dirname, '..')));

// ── PROJECTS API ──────────────────────────────────────────────────────────────

app.post('/api/projects', (req, res) => {
  const id = crypto.randomBytes(5).toString('hex');
  const name = (req.body && req.body.name) || 'my-project';
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(id, name);
  res.json({ id, name });
});

app.get('/api/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const files = db.prepare('SELECT name, content, updated_at FROM files WHERE project_id = ? ORDER BY name').all(req.params.id);
  res.json({ ...project, files });
});

app.put('/api/projects/:id/files', (req, res) => {
  const files = req.body.files || {};
  const upsert = db.prepare(`
    INSERT INTO files (project_id, name, content, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(project_id, name) DO UPDATE SET
      content = excluded.content,
      updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    for (const [name, content] of Object.entries(files)) {
      upsert.run(req.params.id, name, content);
    }
  })();
  res.json({ ok: true });
});

app.delete('/api/projects/:id/files/:name', (req, res) => {
  db.prepare('DELETE FROM files WHERE project_id = ? AND name = ?')
    .run(req.params.id, decodeURIComponent(req.params.name));
  res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/api/ai', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    proc.on('error', e => { clearTimeout(timer); resolve({ stdout, stderr: e.message, code: -1, killed: false }); });
  });
}

app.post('/api/run', async (req, res) => {
  const { language, code, filename } = req.body;
  const runner = RUNNERS[language];
  if (!runner) return res.json({ stdout: '', stderr: `Language not supported: ${language}`, code: 1 });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const baseName = (filename || 'main').replace(/\.[^.]+$/, '');
  const srcFile = path.join(tmpDir, baseName + runner.ext);

  try {
    fs.writeFileSync(srcFile, code);
    let result;

    if (runner.interp) {
      const args = [...(runner.flags || []), srcFile];
      result = await runProc(runner.interp, args, tmpDir);
    } else {
      // Compiled language
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

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomBytes(4).toString('hex');
  let projectId = null;
  let userId = 'User';
  let userColor = COLORS[colorCounter++ % COLORS.length];

  const send = (msg) => { try { ws.send(JSON.stringify(msg)); } catch (_) {} };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'join') {
      projectId = msg.projectId;
      userId = msg.userId || ('User' + clientId.slice(0,4));
      if (!rooms.has(projectId)) rooms.set(projectId, new Map());
      rooms.get(projectId).set(clientId, { ws, userId, userColor });
      send({ type: 'welcome', clientId, userId, userColor });
      broadcast(projectId, clientId, { type: 'presence', users: getUsers(projectId) }, true);
      return;
    }

    if (!projectId) return;

    if (msg.type === 'update') {
      // Persist to DB immediately
      try {
        db.prepare(`
          INSERT INTO files (project_id, name, content, updated_at)
          VALUES (?, ?, ?, strftime('%s','now'))
          ON CONFLICT(project_id, name) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at
        `).run(projectId, msg.file, msg.content);
      } catch (_) {}
      broadcast(projectId, clientId, { type: 'update', file: msg.file, content: msg.content, userId, userColor });
      return;
    }

    if (msg.type === 'cursor') {
      broadcast(projectId, clientId, { type: 'cursor', file: msg.file, line: msg.line, col: msg.col, userId, userColor });
      return;
    }

    if (msg.type === 'ping') { send({ type: 'pong' }); }
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Replit Clone] Backend running on :${PORT}`);
  console.log(`[Replit Clone] SQLite: ./data/replit.db`);
});
