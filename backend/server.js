const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const initSqlJs = require('sql.js');
const { verifyGoogleIdToken, signSession, verifySession, authOptional, authRequired } = require('./auth');
const { encrypt, decrypt } = require('./crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cors = require('cors');
const https = require('https');
const { URL } = require('url');

// ── HTTP helper (supports GET/POST with headers/body) ─────────────────────────
function httpReq(method, urlStr, { headers = {}, body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = (parsed.protocol === 'https:' ? https : require('http')).request(urlStr, opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Env helpers ───────────────────────────────────────────────────────────────
const E = (k, fallback) => process.env[k] || fallback || '';
const NV = () => ({
  keys: [
    E('NVIDIA_API_KEY_1'),
    E('NVIDIA_API_KEY_2'),
    E('NVIDIA_API_KEY_3'),
    E('NVIDIA_API_KEY_4'),
    E('NVIDIA_API_KEY_5'),
  ].filter(Boolean),
});
let nvidiaKeyIdx = 0;
const nextNvidiaKey = () => {
  const keys = NV().keys;
  if (!keys.length) return null;
  const k = keys[nvidiaKeyIdx % keys.length];
  nvidiaKeyIdx++;
  return k;
};

// ── AI PROVIDERS ──────────────────────────────────────────────────────────────

async function aiChat({ model, messages, tools, stream, apiKey, baseUrl }) {
  // Uses OpenAI-compatible endpoint
  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey: apiKey || 'dummy', baseURL: baseUrl });
  const params = { model, messages, stream: !!stream };
  if (tools && tools.length) params.tools = tools;
  if (stream) return client.chat.completions.create(params);
  const r = await client.chat.completions.create(params);
  return r;
}

// NVIDIA — OpenAI-compatible at https://integrate.api.nvidia.com/v1
async function chatNVIDIA(model, messages, tools, stream, apiKeyOverride) {
  const key = apiKeyOverride || nextNvidiaKey();
  if (!key) throw new Error('No NVIDIA API key configured');
  return aiChat({
    model, messages, tools, stream,
    apiKey: key,
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  });
}

// Kimi AI (kimi.moonshot.cn) — OpenAI-compatible
async function chatKimi(messages, tools, stream, apiKeyOverride) {
  const key = apiKeyOverride || E('KIMI_API_KEY');
  if (!key) throw new Error('No KIMI_API_KEY configured');
  return aiChat({
    model: 'moonshotai/kimi-v1-128k',
    messages, tools, stream,
    apiKey: key,
    baseUrl: 'https://api.moonshot.cn/v1',
  });
}

// OpenRouter — routes to many models
async function chatOpenRouter(model, messages, tools, stream, apiKeyOverride) {
  const key = apiKeyOverride || E('OPENROUTER_API_KEY');
  if (!key) throw new Error('No OPENROUTER_API_KEY configured');
  return aiChat({
    model, messages, tools, stream,
    apiKey: key,
    baseUrl: 'https://openrouter.ai/api/v1',
  });
}

// OpenAI — direct
async function chatOpenAI(model, messages, tools, stream, apiKeyOverride) {
  const key = apiKeyOverride || E('OPENAI_API_KEY');
  if (!key) throw new Error('No OPENAI_API_KEY configured');
  return aiChat({
    model, messages, tools, stream,
    apiKey: key,
    baseUrl: 'https://api.openai.com/v1',
  });
}

// Google Gemini
async function chatGemini(model, messages, apiKeyOverride) {
  const key = apiKeyOverride || E('GEMINI_API_KEY');
  if (!key) throw new Error('No GEMINI_API_KEY configured');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = { contents, generationConfig: { temperature: 0.7, topP: 0.95, maxOutputTokens: 8192 } };
  const { data } = await httpReq('POST',
    `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${key}`,
    { body }
  );
  if (data.error) throw new Error(data.error.message || 'Gemini error');
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text)?.join('') || '';
  return { choices: [{ message: { content: text, role: 'assistant' } }] };
}

// Groq — fast free tier
async function chatGroq(model, messages, tools, stream, apiKeyOverride) {
  const key = apiKeyOverride || E('GROQ_API_KEY');
  if (!key) throw new Error('No GROQ_API_KEY configured');
  return aiChat({
    model, messages, tools, stream,
    apiKey: key,
    baseUrl: 'https://api.groq.com/openai/v1',
  });
}

// DeepSeek
async function chatDeepSeek(messages, tools, stream, apiKeyOverride) {
  const key = apiKeyOverride || E('DEEPSEEK_API_KEY');
  if (!key) throw new Error('No DEEPSEEK_API_KEY configured');
  return aiChat({
    model: 'deepseek-chat',
    messages, tools, stream,
    apiKey: key,
    baseUrl: 'https://api.deepseek.com',
  });
}

// ── IMAGE GENERATION ─────────────────────────────────────────────────────────

async function generateImage({ prompt, model, apiKey }) {
  model = model || 'black-forest-labs/flux-schnell';
  const key = apiKey || E('REPLICATE_API_KEY') || E('OPENAI_API_KEY');
  if (!key) throw new Error('No image gen API key configured');

  // Replicate (FLUX)
  const replKey = E('REPLICATE_API_KEY');
  if (replKey) {
    // Start generation
    const { data: runData } = await httpReq('POST', 'https://api.replicate.com/v1/predictions', {
      headers: { Authorization: `Token ${replKey}`, 'Content-Type': 'application/json' },
      body: {
        version: model.includes('dev') ? 'b655187a25032634046ae58116922071d3939decab5845538b36b02f8751e11a' : 'a3b2c3d4e5f6...',
        input: { prompt, num_outputs: 1, aspect_ratio: '1:1' },
      },
    });
    // Poll
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const { data: status } = await httpReq('GET', runData.urls.get, {
        headers: { Authorization: `Token ${replKey}` },
      });
      if (status.completed) {
        const url = status.output?.image || status.output?.[0];
        return { url, provider: 'replicate' };
      }
    }
  }

  // FLUX via OpenRouter or direct
  const openrouterKey = E('OPENROUTER_API_KEY');
  if (openrouterKey) {
    const { data } = await httpReq('POST', 'https://openrouter.ai/api/v1/images/generation', {
      headers: { Authorization: `Bearer ${openrouterKey}` },
      body: { model: 'black-forest-labs/flux-schnell', prompt, n: 1, size: '1024x1024' },
    });
    if (data.data?.[0]?.url) return { url: data.data[0].url, provider: 'openrouter' };
  }

  throw new Error('Image generation failed — no provider configured');
}

// ── VIDEO GENERATION ─────────────────────────────────────────────────────────

async function generateVideo({ prompt, model }) {
  // Runway ML via API key
  const runwayKey = E('RUNWAY_API_KEY');
  if (runwayKey) {
    const { data } = await httpReq('POST', 'https://api.runwayml.com/v1/video_to_video', {
      headers: { Authorization: `Bearer ${runwayKey}` },
      body: { prompt },
    });
    if (data.id) {
      // Poll
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const { data: status } = await httpReq('GET', `https://api.runwayml.com/v1/jobs/${data.id}`, {
          headers: { Authorization: `Bearer ${runwayKey}` },
        });
        if (status.status === 'completed') return { url: status.output, provider: 'runway' };
        if (status.status === 'failed') break;
      }
    }
  }

  // Kling AI
  const klingKey = E('KLING_API_KEY');
  if (klingKey) {
    const { data } = await httpReq('POST', 'https://api.kling.ai/v1/video/generation', {
      headers: { Authorization: `Bearer ${klingKey}` },
      body: { prompt, duration: 5 },
    });
    if (data.task_id) {
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 4000));
        const { data: status } = await httpReq('GET',
          `https://api.kling.ai/v1/video/generation/${data.task_id}`,
          { headers: { Authorization: `Bearer ${klingKey}` } }
        );
        if (status.status === 'completed') return { url: status.video_url, provider: 'kling' };
        if (status.status === 'failed') break;
      }
    }
  }

  // Fallback: return a placeholder
  return { url: null, provider: 'none', error: 'No video provider configured' };
}

// ── COMPOSIO TOOLS ────────────────────────────────────────────────────────────

const composioCache = { tools: null, ts: 0 };
const COMPOSIO_CACHE_TTL = 10 * 60 * 1000; // 10 min

async function getComposioTools(integration = 'composio') {
  const now = Date.now();
  if (composioCache.tools && now - composioCache.ts < COMPOSIO_CACHE_TTL) {
    return composioCache.tools;
  }
  const key = E('COMPOSIO_API_KEY') || E(`${integration.toUpperCase()}_API_KEY`);
  if (!key) return [];

  try {
    // Fetch active tools/actions from Composio API
    const { data } = await httpReq('GET',
      `https://backend.composio.dev/api/v2/tools/?api_key=${key}&show_all_actions=false&limit=50`,
      { timeoutMs: 15000 }
    );
    const actions = data?.results || data || [];
    const tools = actions.map(a => ({
      type: 'function',
      function: {
        name: a.name?.toLowerCase().replace(/\s+/g, '_') || a.action_name,
        description: a.description || a.name || '',
        parameters: {
          type: 'object',
          properties: (a.input_schema?.properties || {}),
          required: a.input_schema?.required || [],
        },
      },
    })).filter(t => t.function.name);

    composioCache.tools = tools;
    composioCache.ts = now;
    return tools;
  } catch (e) {
    console.error('[Composio] Tool fetch failed:', e.message);
    return [];
  }
}

async function executeComposioTool(toolName, args, apiKey) {
  const key = apiKey || E('COMPOSIO_API_KEY');
  if (!key) throw new Error('No Composio API key');
  try {
    const { data } = await httpReq('POST', 'https://backend.composio.dev/api/v2/actions/trigger', {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: { action_name: toolName, parameters: args },
    });
    return data;
  } catch (e) {
    throw new Error(`Tool execution failed: ${e.message}`);
  }
}

// ── INTEGRATION TOOL EXECUTION ────────────────────────────────────────────────

async function executeIntegrationTool(id, args, userId) {
  // Get user-scoped API key if available, fall back to env
  const uk = (k) => userId ? (getUserApiKey(userId, k.toLowerCase()) || E(k)) : E(k);
  const handlers = {
    tavily: async () => {
      const key = uk('TAVILY_API_KEY');
      if (!key) throw new Error('No TAVILY_API_KEY');
      const { data } = await httpReq('POST', 'https://api.tavily.com/v3/search', {
        body: { query: args.query || args.q || args.prompt, api_key: key, max_results: 5 },
      });
      return data;
    },
    github: async () => {
      const token = E('GITHUB_TOKEN');
      if (!token) throw new Error('No GITHUB_TOKEN');
      const endpoint = args.endpoint || '/user';
      const { data } = await httpReq('GET', `https://api.github.com${endpoint}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'ClawCode/1.0' },
      });
      return data;
    },
    websearch: async () => handlers.tavily(), // aliases
    scrapfly: async () => {
      const apiKey = uk('SCRAPFLY_API_KEY');
      if (!apiKey) throw new Error('No SCRAPFLY_API_KEY');
      const url = args.url || args.website;
      if (!url) throw new Error('Missing url parameter');
      const { data } = await httpReq('POST', 'https://api.scrapfly.io/scrape', {
        headers: { 'Content-Type': 'application/json' },
        body: { key: apiKey, url, format: 'json', render: true },
      });
      return data;
    },
    scrapingbee: async () => {
      const key = uk('SCRAPINGBEE_API_KEY');
      if (!key) throw new Error('No SCRAPINGBEE_API_KEY');
      const url = args.url;
      if (!url) throw new Error('Missing url parameter');
      const { data } = await httpReq('GET',
        `https://api.scrapingbee.com/v1/?api_key=${key}&url=${encodeURIComponent(url)}&render_js=true`,
      );
      return { content: data };
    },
    exa: async () => {
      const key = uk('EXA_API_KEY');
      if (!key) throw new Error('No EXA_API_KEY');
      const { data } = await httpReq('POST', 'https://api.exa.ai/search', {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: { query: args.query || args.q, numResults: 5, contents: { text: true } },
      });
      return data;
    },
    firecrawl: async () => {
      const key = uk('FIRECRAWL_API_KEY');
      if (!key) throw new Error('No FIRECRAWL_API_KEY');
      const url = args.url;
      if (!url) throw new Error('Missing url parameter');
      const { data } = await httpReq('POST', 'https://api.firecrawl.dev/v1/scrape', {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: { url },
      });
      return data;
    },
    railway: async () => {
      const token = E('RAILWAY_TOKEN');
      if (!token) throw new Error('No RAILWAY_TOKEN');
      const { data } = await httpReq('GET', 'https://backboard.railway.app/project', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return data;
    },
    e2b: async () => {
      const key = uk('E2B_API_KEY');
      if (!key) throw new Error('No E2B_API_KEY');
      // List sandboxes
      const { data } = await httpReq('GET', 'https://api.e2b.dev/v1/sandbox', {
        headers: { Authorization: `Bearer ${key}` },
      });
      return data;
    },
    massive: async () => {
      const key = uk('MASSIVE_API_KEY');
      if (!key) throw new Error('No MASSIVE_API_KEY');
      const { data } = await httpReq('POST', 'https://api.massive.tech/v1/chat', {
        body: { query: args.query || args.prompt || args.message, key },
      });
      return data;
    },
    discord: async () => {
      // Discord bot — just validate token is set
      const token = E('DISCORD_BOT_TOKEN');
      if (!token) throw new Error('No DISCORD_BOT_TOKEN');
      const { data } = await httpReq('GET', 'https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });
      return data;
    },
    steel: async () => {
      const key = E('STEEL_API_KEY');
      if (!key) throw new Error('No STEEL_API_KEY');
      const { data } = await httpReq('POST', 'https://api.steel.dev/v1/search', {
        body: { query: args.query || args.q, key },
      });
      return data;
    },
    screenshotone: async () => {
      const key = E('SCREENSHOTONE_API_KEY');
      if (!key) throw new Error('No SCREENSHOTONE_API_KEY');
      const url = args.url;
      if (!url) throw new Error('Missing url parameter');
      const { data } = await httpReq('GET',
        `https://api.screenshotone.com/take?access_key=${key}&url=${encodeURIComponent(url)}&format=png&full_page=true`,
      );
      return { screenshot_url: `data:image/png;base64,${Buffer.from(data).toString('base64').slice(0, 100)}...` };
    },
  };

  const fn = handlers[id] || handlers[args?._integ];
  if (!fn) throw new Error(`No handler for integration: ${id}`);
  return fn();
}

// ── MODEL ROUTER ──────────────────────────────────────────────────────────────

const MODEL_CONFIG = {
  // OpenAI
  'gpt-4o':           { provider: 'openai',   model: 'gpt-4o',                  hidden: false },
  'gpt-4o-mini':      { provider: 'openai',   model: 'gpt-4o-mini',             hidden: false },
  'gpt-4-turbo':     { provider: 'openai',   model: 'gpt-4-turbo',            hidden: false },
  // Gemini
  'gemini-2-flash':  { provider: 'gemini',   model: 'gemini-2.0-flash',       hidden: false },
  'gemini-2-pro':    { provider: 'gemini',   model: 'gemini-2.0-pro',         hidden: false },
  // Groq
  'llama-3.1-70b':   { provider: 'groq',     model: 'llama-3.1-70b-versatile', hidden: false },
  'llama-3.1-8b':    { provider: 'groq',     model: 'llama-3.1-8b-instant',   hidden: false },
  'mixtral-8x7b':    { provider: 'groq',     model: 'mixtral-8x7b-32768',     hidden: false },
  // DeepSeek
  'deepseek-v3':      { provider: 'deepseek', model: 'deepseek-chat',         hidden: false },
  'deepseek-r1':      { provider: 'deepseek', model: 'deepseek-reasoner',     hidden: false },
  // OpenRouter (misc)
  'claude-3.5-sonnet': { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', hidden: false },
  // Kimi
  'kimi-v1':         { provider: 'kimi',     model: 'moonshotai/kimi-v1-128k', hidden: false },
  // NVIDIA
  'nvidia-nemotron': { provider: 'nvidia',   model: 'nvidia/nemotron-3-ultra-550b-a55b', hidden: false },
  'nvidia-kimi-k2':  { provider: 'nvidia',   model: 'moonshotai/kimi-k2.6',   hidden: false },
  'nvidia-glm':      { provider: 'nvidia',   model: 'z-ai/glm-5.1',            hidden: false },
  'nvidia-llama-vl': { provider: 'nvidia',   model: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1', hidden: false },
  'nvidia-phi4-mm':   { provider: 'nvidia',   model: 'microsoft/phi-4-multimodal-instruct', hidden: false },
  'nvidia-deepseek': { provider: 'nvidia',   model: 'deepseek-ai/deepseek-v4-pro', hidden: false },
  'nvidia-mistral':  { provider: 'nvidia',   model: 'mistralai/mistral-small-4-119b-2603', hidden: false },
};

async function routeChat({ model, messages, tools, enabledTools, userId }) {
  const cfg = MODEL_CONFIG[model] || { provider: 'openai', model };
  // If user is logged in, prefer their per-user API key over env var
  const userKey = userId ? getUserApiKey(userId, cfg.provider) : null;
  const allTools = [];

  // Add Composio tools if API key present
  if (E('COMPOSIO_API_KEY') && enabledTools?.includes('composio')) {
    const composioTools = await getComposioTools();
    allTools.push(...composioTools);
  }

  // Add integration tools if enabled
  if (enabledTools?.length) {
    for (const tid of enabledTools) {
      const def = INTEGRATION_DEFS[tid];
      if (def?.toolSchema) allTools.push(def.toolSchema);
    }
  }

  // Merge with model tools
  const mergedTools = [...(tools || []), ...allTools];
  const chatParams = { messages, tools: mergedTools.length ? mergedTools : undefined };

  switch (cfg.provider) {
    case 'nvidia': {
      const res = await chatNVIDIA(cfg.model, messages, mergedTools.length ? mergedTools : undefined, false, userKey);
      return res;
    }
    case 'kimi': {
      const res = await chatKimi(messages, mergedTools.length ? mergedTools : undefined, false, userKey);
      return res;
    }
    case 'openrouter': {
      const res = await chatOpenRouter(cfg.model, messages, mergedTools.length ? mergedTools : undefined, false, userKey);
      return res;
    }
    case 'gemini': {
      const res = await chatGemini(cfg.model, messages, userKey);
      return res;
    }
    case 'groq': {
      const res = await chatGroq(cfg.model, messages, mergedTools.length ? mergedTools : undefined, false, userKey);
      return res;
    }
    case 'deepseek': {
      const res = await chatDeepSeek(messages, mergedTools.length ? mergedTools : undefined, false, userKey);
      return res;
    }
    case 'openai':
    default: {
      const res = await chatOpenAI(cfg.model, messages, mergedTools.length ? mergedTools : undefined, false, userKey);
      return res;
    }
  }
}

// ── INTEGRATION DEFS (server-side map) ────────────────────────────────────────

const INTEGRATION_DEFS = {
  tavily: {
    name: 'Tavily Web Search',
    toolSchema: {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for current information and get cited results',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
      },
    },
  },
  exa: {
    name: 'Exa Search',
    toolSchema: {
      type: 'function',
      function: {
        name: 'exa_search',
        description: 'Deep web search with semantic understanding',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
      },
    },
  },
  scrapfly: {
    name: 'ScrapFly Web Scraper',
    toolSchema: {
      type: 'function',
      function: {
        name: 'scrape_website',
        description: 'Scrape and extract content from any website URL',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'Website URL to scrape' } }, required: ['url'] },
      },
    },
  },
  firecrawl: {
    name: 'Firecrawl AI Scraper',
    toolSchema: {
      type: 'function',
      function: {
        name: 'firecrawl_scrape',
        description: 'AI-powered web scraping with content extraction',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'Website URL' } }, required: ['url'] },
      },
    },
  },
  scrapingbee: {
    name: 'ScrapingBee',
    toolSchema: {
      type: 'function',
      function: {
        name: 'scrapingbee_scrape',
        description: 'Web scraping with headless browser rendering',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to scrape' } }, required: ['url'] },
      },
    },
  },
  screenshotone: {
    name: 'ScreenshotOne',
    toolSchema: {
      type: 'function',
      function: {
        name: 'take_screenshot',
        description: 'Take a screenshot of any webpage',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to screenshot' } }, required: ['url'] },
      },
    },
  },
  github: {
    name: 'GitHub',
    toolSchema: {
      type: 'function',
      function: {
        name: 'github_api',
        description: 'Call the GitHub REST API — pass endpoint path like /user or /repos/:owner/:repo',
        parameters: { type: 'object', properties: { endpoint: { type: 'string', description: 'GitHub API endpoint path' } }, required: ['endpoint'] },
      },
    },
  },
  massive: {
    name: 'Massive AI',
    toolSchema: {
      type: 'function',
      function: {
        name: 'massive_query',
        description: 'Query the Massive AI agent',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Query or prompt' } }, required: ['query'] },
      },
    },
  },
  steel: {
    name: 'Steel.dev',
    toolSchema: {
      type: 'function',
      function: {
        name: 'steel_search',
        description: 'Search using Steel.dev browser API',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
      },
    },
  },
};

// ── SQLITE INIT ───────────────────────────────────────────────────────────────

const DATA_DIR = './data';
const DB_PATH  = path.join(DATA_DIR, 'replit.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null, dbDirty = false, saveTimer = null;

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
      id TEXT PRIMARY KEY, name TEXT DEFAULT 'my-project',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS files (
      project_id TEXT, name TEXT, content TEXT DEFAULT '',
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_id TEXT UNIQUE,
      email TEXT UNIQUE,
      name TEXT,
      picture TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      last_seen INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS user_api_keys (
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, provider_id)
    );
    CREATE TABLE IF NOT EXISTS user_chats (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      name TEXT,
      messages TEXT,
      active INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, chat_id)
    );
    CREATE TABLE IF NOT EXISTS user_pictures (
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS user_crons (
      user_id TEXT NOT NULL,
      cron_id TEXT NOT NULL,
      name TEXT,
      prompt TEXT,
      schedule TEXT,
      enabled INTEGER DEFAULT 1,
      last_run INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, cron_id)
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (user_id, key)
    );
  `);
  saveTimer = setInterval(() => { if (dbDirty) { saveDb(); dbDirty = false; } }, 10000);
  console.log('[DB] Initialized (sql.js)');
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function closeDb() {
  if (saveTimer) clearInterval(saveTimer);
  if (db && dbDirty) saveDb();
  if (db) db.close();
}

function dbRun(sql, ...params) { db.run(sql, params); dbDirty = true; }
function dbGet(sql, ...params) {
  const stmt = db.prepare(sql); stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free(); return undefined;
}
function dbAll(sql, ...params) {
  const stmt = db.prepare(sql); stmt.bind(params);
  const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free();
  return rows;
}

// ── EXPRESS APP ───────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
// Optional auth middleware - populates req.user if JWT is valid, otherwise continues unauthenticated
app.use(authOptional);
// Static files with no-cache headers to prevent stale bundles
app.use(express.static(path.join(__dirname, '..'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Build-Time', new Date().toISOString());
  }
}));

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

// Upsert user from Google ID token, issue our JWT session
app.post('/auth/google', async (req, res) => {
  try {
    const { id_token, credential } = req.body;
    const token = id_token || credential;
    if (!token) return res.status(400).json({ error: 'Missing id_token' });

    const profile = await verifyGoogleIdToken(token);

    // Upsert user in DB
    const userId = 'u_' + profile.google_id;
    const now = Math.floor(Date.now() / 1000);

    // Try to find existing user
    const existing = db.exec(`SELECT * FROM users WHERE google_id = '${profile.google_id.replace(/'/g, "''")}'`);
    let user;
    if (existing.length > 0 && existing[0].values.length > 0) {
      const row = existing[0].values[0];
      user = { id: row[0], google_id: row[1], email: row[2], name: row[3], picture: row[4] };
      // Update last_seen
      db.run(`UPDATE users SET last_seen = ${now}, name = '${(profile.name || '').replace(/'/g, "''")}', picture = '${(profile.picture || '').replace(/'/g, "''")}' WHERE google_id = '${profile.google_id.replace(/'/g, "''")}'`);
    } else {
      db.run(`INSERT INTO users (id, google_id, email, name, picture, created_at, last_seen)
              VALUES ('${userId}', '${profile.google_id.replace(/'/g, "''")}',
                      '${(profile.email || '').replace(/'/g, "''")}',
                      '${(profile.name || '').replace(/'/g, "''")}',
                      '${(profile.picture || '').replace(/'/g, "''")}',
                      ${now}, ${now})`);
      user = { id: userId, google_id: profile.google_id, email: profile.email, name: profile.name, picture: profile.picture };
    }
    dbDirty = true;

    const jwtToken = signSession(user);
    res.json({ token: jwtToken, user });
  } catch (e) {
    console.error('[Auth]', e.message);
    res.status(401).json({ error: 'Invalid Google token: ' + e.message });
  }
});

// OAuth2 callback: receives ?code from Google, exchanges for id_token
// Used by the fallback "Sign in with Google" link in the auth gate
app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'https://replit-clone-07jy.onrender.com/auth/google/callback',
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.id_token) {
      return res.status(400).send('Token exchange failed: ' + JSON.stringify(tokens).slice(0, 200));
    }
    // Verify the id_token
    const profile = await verifyGoogleIdToken(tokens.id_token);
    // Upsert user
    const userId = 'u_' + profile.google_id;
    const now = Math.floor(Date.now() / 1000);
    const existing = db.exec(`SELECT * FROM users WHERE google_id = '${profile.google_id.replace(/'/g, "''")}'`);
    let user;
    if (existing.length > 0 && existing[0].values.length > 0) {
      user = { id: userId, google_id: profile.google_id, email: profile.email, name: profile.name, picture: profile.picture };
      db.run(`UPDATE users SET last_seen = ${now} WHERE google_id = '${profile.google_id.replace(/'/g, "''")}'`);
    } else {
      db.run(`INSERT INTO users (id, google_id, email, name, picture, created_at, last_seen) VALUES ('${userId}', '${profile.google_id.replace(/'/g, "''")}', '${(profile.email || '').replace(/'/g, "''")}', '${(profile.name || '').replace(/'/g, "''")}', '${(profile.picture || '').replace(/'/g, "''")}', ${now}, ${now})`);
      user = { id: userId, google_id: profile.google_id, email: profile.email, name: profile.name, picture: profile.picture };
    }
    dbDirty = true;
    const jwtToken = signSession(user);
    // Return HTML that stores JWT in localStorage and closes the popup (or redirects)
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><body><script>
      localStorage.setItem('cc_jwt', ${JSON.stringify(jwtToken)});
      if (window.opener) { window.opener.location.reload(); window.close(); }
      else { window.location.href = '/'; }
    </script><p>Signing you in...</p></body></html>`);
  } catch (e) {
    res.status(500).send('OAuth error: ' + e.message);
  }
});

// Get current user from JWT (or null if not logged in)
app.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: req.user });
});

// ── PER-USER VAULT (encrypted API keys) ──────────────────────────────────────

// List which providers the user has configured (does NOT return keys)
app.get('/api/user/keys', authRequired, (req, res) => {
  const rows = db.exec(`SELECT provider_id, updated_at FROM user_api_keys WHERE user_id = '${req.user.uid}'`);
  const keys = rows.length > 0 ? rows[0].values.map(r => ({ provider: r[0], updated_at: r[1] })) : [];
  res.json({ keys });
});

// Set/update a key (encrypted with master key before storage)
app.put('/api/user/keys/:provider', authRequired, (req, res) => {
  const { provider } = req.params;
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  try {
    const enc = encrypt(key);
    db.run(`INSERT OR REPLACE INTO user_api_keys (user_id, provider_id, encrypted_key, updated_at)
            VALUES ('${req.user.uid}', '${provider.replace(/'/g, "''")}', '${enc.replace(/'/g, "''")}', strftime('%s','now'))`);
    dbDirty = true;
    res.json({ ok: true, provider });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a key
app.delete('/api/user/keys/:provider', authRequired, (req, res) => {
  const { provider } = req.params;
  db.run(`DELETE FROM user_api_keys WHERE user_id = '${req.user.uid}' AND provider_id = '${provider.replace(/'/g, "''")}'`);
  dbDirty = true;
  res.json({ ok: true });
});

// Get all decrypted keys for the authenticated user (for device sync)
// Only accessible with a valid JWT — same security as a password manager
app.get('/api/user/keys/all', authRequired, (req, res) => {
  const rows = db.exec(`SELECT provider_id, encrypted_key FROM user_api_keys WHERE user_id = '${req.user.uid}'`);
  const keys = {};
  if (rows.length > 0) {
    for (const [provider, enc] of rows[0].values) {
      const dec = decrypt(enc);
      if (dec) keys[provider] = dec;
    }
  }
  res.json({ keys });
});

// Helper: get a user's decrypted key for a provider (used internally)
function getUserApiKey(uid, provider) {
  try {
    const rows = db.exec(`SELECT encrypted_key FROM user_api_keys WHERE user_id = '${uid.replace(/'/g, "''")}' AND provider_id = '${provider.replace(/'/g, "''")}'`);
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return decrypt(rows[0].values[0][0]);
  } catch (e) {
    return null;
  }
}

// ── PER-USER CHATS (chat history sync) ───────────────────────────────────────

app.get('/api/user/chats', authRequired, (req, res) => {
  const rows = db.exec(`SELECT chat_id, name, messages, active, updated_at FROM user_chats WHERE user_id = '${req.user.uid}' ORDER BY updated_at DESC`);
  const chats = rows.length > 0 ? rows[0].values.map(r => ({
    chat_id: r[0], name: r[1], messages: JSON.parse(r[2] || '[]'), active: r[3], updated_at: r[4]
  })) : [];
  res.json({ chats });
});

app.put('/api/user/chats/:chat_id', authRequired, (req, res) => {
  const { chat_id } = req.params;
  const { name, messages, active } = req.body;
  const msgs = JSON.stringify(messages || []);
  db.run(`INSERT OR REPLACE INTO user_chats (user_id, chat_id, name, messages, active, updated_at)
          VALUES ('${req.user.uid}', '${chat_id.replace(/'/g, "''")}',
                  '${(name || '').replace(/'/g, "''")}', '${msgs.replace(/'/g, "''")}',
                  ${active ? 1 : 0}, strftime('%s','now'))`);
  dbDirty = true;
  res.json({ ok: true });
});

app.delete('/api/user/chats/:chat_id', authRequired, (req, res) => {
  const { chat_id } = req.params;
  db.run(`DELETE FROM user_chats WHERE user_id = '${req.user.uid}' AND chat_id = '${chat_id.replace(/'/g, "''")}'`);
  dbDirty = true;
  res.json({ ok: true });
});

// ── PER-USER SETTINGS ─────────────────────────────────────────────────────────

app.get('/api/user/settings', authRequired, (req, res) => {
  const rows = db.exec(`SELECT key, value FROM user_settings WHERE user_id = '${req.user.uid}'`);
  const settings = {};
  if (rows.length > 0) rows[0].values.forEach(r => { settings[r[0]] = r[1]; });
  res.json({ settings });
});

app.put('/api/user/settings', authRequired, (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'Missing settings' });
  for (const [k, v] of Object.entries(settings)) {
    db.run(`INSERT OR REPLACE INTO user_settings (user_id, key, value)
            VALUES ('${req.user.uid}', '${k.replace(/'/g, "''")}', '${String(v).replace(/'/g, "''")}')`);
  }
  dbDirty = true;
  res.json({ ok: true });
});

// ── PER-USER CRONS ────────────────────────────────────────────────────────────

app.get('/api/user/crons', authRequired, (req, res) => {
  const rows = db.exec(`SELECT cron_id, name, prompt, schedule, enabled, last_run FROM user_crons WHERE user_id = '${req.user.uid}' ORDER BY created_at`);
  const crons = rows.length > 0 ? rows[0].values.map(r => ({
    id: r[0], name: r[1], prompt: r[2], schedule: r[3], enabled: r[4] === 1, last_run: r[5]
  })) : [];
  res.json({ crons });
});

app.put('/api/user/crons/:cron_id', authRequired, (req, res) => {
  const { cron_id } = req.params;
  const { name, prompt, schedule, enabled } = req.body;
  db.run(`INSERT OR REPLACE INTO user_crons (user_id, cron_id, name, prompt, schedule, enabled)
          VALUES ('${req.user.uid}', '${cron_id.replace(/'/g, "''")}',
                  '${(name || '').replace(/'/g, "''")}',
                  '${(prompt || '').replace(/'/g, "''")}',
                  '${(schedule || '').replace(/'/g, "''")}',
                  ${enabled ? 1 : 0})`);
  dbDirty = true;
  res.json({ ok: true });
});

app.delete('/api/user/crons/:cron_id', authRequired, (req, res) => {
  const { cron_id } = req.params;
  db.run(`DELETE FROM user_crons WHERE user_id = '${req.user.uid}' AND cron_id = '${cron_id.replace(/'/g, "''")}'`);
  dbDirty = true;
  res.json({ ok: true });
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────

app.post('/api/projects', (req, res) => {
  const id   = crypto.randomBytes(5).toString('hex');
  const name = req.body?.name || 'my-project';
  dbRun('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)', id, name);
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
    dbRun(`INSERT INTO files (project_id, name, content, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
      req.params.id, name, content, now);
  }
  dbDirty = true;
  res.json({ ok: true });
});

app.delete('/api/projects/:id/files/:name', (req, res) => {
  dbRun('DELETE FROM files WHERE project_id = ? AND name = ?', req.params.id, decodeURIComponent(req.params.name));
  dbDirty = true;
  res.json({ ok: true });
});

// ── AI CHAT + TOOL CALLING ────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { model, messages, tools: forcedTools, enabledTools } = req.body;
  const userId = req.user?.uid || null;

  try {
    // 1. Get AI response (may include tool calls)
    const aiRes = await routeChat({ model, messages, tools: forcedTools, enabledTools, userId });
    const choice = aiRes.choices?.[0];
    let reply = choice?.message?.content || '';
    const toolCalls = choice?.message?.tool_calls || [];

    // 2. If tool calls present, execute them and build result
    const toolResults = [];
    for (const tc of toolCalls) {
      const fn = tc.function;
      try {
        let result;
        // Check if it's a Composio tool
        const isComposio = !INTEGRATION_DEFS[fn.name];
        if (isComposio) {
          const args = JSON.parse(fn.arguments || '{}');
          result = await executeComposioTool(fn.name, args, E('COMPOSIO_API_KEY'));
        } else {
          const args = JSON.parse(fn.arguments || '{}');
          result = await executeIntegrationTool(fn.name, args, userId);
        }
        toolResults.push({ tool_call_id: tc.id, name: fn.name, result });
      } catch (e) {
        toolResults.push({ tool_call_id: tc.id, name: fn.name, error: e.message });
      }
    }

    // 3. If tools were called, do a second pass to get final answer
    if (toolResults.length > 0) {
      const toolMessages = messages.concat([
        choice.message,
        ...toolResults.map(r => ({
          role: 'tool',
          tool_call_id: r.tool_call_id,
          name: r.name,
          content: typeof r.result === 'object' ? JSON.stringify(r.result, null, 2) : String(r.result || r.error || ''),
        })),
      ]);
      const finalRes = await routeChat({ model, messages: toolMessages, tools: forcedTools, enabledTools, userId });
      reply = finalRes.choices?.[0]?.message?.content || reply;
    }

    res.json({ reply, toolCalls: toolResults.map(t => ({ name: t.name, result: t.result || null, error: t.error || null })) });
  } catch (e) {
    console.error('[Chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Streaming chat
app.post('/api/chat/stream', async (req, res) => {
  const { model, messages, tools, enabledTools } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  try {
    const aiRes = await routeChat({ model, messages, tools, enabledTools, stream: true, userId: req.user?.uid || null });
    for await (const chunk of aiRes) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

// ── IMAGE GENERATION ─────────────────────────────────────────────────────────

app.post('/api/image', async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt required' });
  try {
    const result = await generateImage({ prompt, model });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VIDEO GENERATION ─────────────────────────────────────────────────────────

app.post('/api/video', async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt required' });
  try {
    const result = await generateVideo({ prompt, model });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TOOL EXECUTION ───────────────────────────────────────────────────────────

app.post('/api/tools/execute', async (req, res) => {
  const { toolId, args } = req.body;
  if (!toolId) return res.status(400).json({ error: 'toolId required' });
  try {
    const userId = req.user?.uid || null;
    const result = await executeIntegrationTool(toolId, args || {}, userId);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List available tools based on configured env vars
app.get('/api/tools', async (req, res) => {
  const tools = [];
  const envChecks = [
    { id: 'tavily',       name: 'Tavily Web Search',    envKey: 'TAVILY_API_KEY',       desc: 'Live web search with citations' },
    { id: 'exa',          name: 'Exa Search',            envKey: 'EXA_API_KEY',           desc: 'Deep semantic web search' },
    { id: 'scrapfly',     name: 'ScrapFly',              envKey: 'SCRAPFLY_API_KEY',      desc: 'Web scraper with JS rendering' },
    { id: 'firecrawl',    name: 'Firecrawl',             envKey: 'FIRECRAWL_API_KEY',     desc: 'AI-powered web scraper' },
    { id: 'scrapingbee',  name: 'ScrapingBee',          envKey: 'SCRAPINGBEE_API_KEY',   desc: 'Headless browser scraper' },
    { id: 'github',       name: 'GitHub',                envKey: 'GITHUB_TOKEN',          desc: 'Repos, issues, PRs' },
    { id: 'railway',      name: 'Railway',               envKey: 'RAILWAY_TOKEN',         desc: 'Deploy management' },
    { id: 'e2b',          name: 'E2B Sandbox',           envKey: 'E2B_API_KEY',           desc: 'AI code execution sandbox' },
    { id: 'massive',      name: 'Massive AI',            envKey: 'MASSIVE_API_KEY',       desc: 'AI agent queries' },
    { id: 'discord',      name: 'Discord Bot',           envKey: 'DISCORD_BOT_TOKEN',     desc: 'Discord bot actions' },
    { id: 'steel',        name: 'Steel.dev',             envKey: 'STEEL_API_KEY',        desc: 'Browser search API' },
    { id: 'screenshotone',name: 'ScreenshotOne',         envKey: 'SCREENSHOTONE_API_KEY', desc: 'Website screenshots' },
    { id: 'composio',     name: 'Composio Tools',        envKey: 'COMPOSIO_API_KEY',      desc: '100+ tool integrations' },
  ];

  for (const check of envChecks) {
    if (E(check.envKey)) {
      const def = INTEGRATION_DEFS[check.id];
      tools.push({
        id: check.id,
        name: check.name,
        desc: check.desc,
        configured: true,
        schema: def?.toolSchema || null,
      });
    }
  }

  // Add Composio tools
  if (E('COMPOSIO_API_KEY')) {
    try {
      const compTools = await getComposioTools();
      tools.push({ id: 'composio', name: 'Composio Tools', desc: `${compTools.length} tools active`, configured: true, tools: compTools });
    } catch (_) {}
  }

  res.json({ tools, count: tools.length });
});

// Health
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now(), providers: { nvidia: NV().keys.length > 0, kimi: !!E('KIMI_API_KEY'), openrouter: !!E('OPENROUTER_API_KEY'), openai: !!E('OPENAI_API_KEY'), gemini: !!E('GEMINI_API_KEY'), groq: !!E('GROQ_API_KEY'), deepseek: !!E('DEEPSEEK_API_KEY'), composio: !!E('COMPOSIO_API_KEY') } }));

// ── CODE EXECUTION ────────────────────────────────────────────────────────────

const RUNNERS = {
  javascript: { interp: 'node',    ext: '.js'  },
  python:     { interp: 'python3', ext: '.py'  },
  bash:       { interp: 'bash',    ext: '.sh'  },
  ruby:       { interp: 'ruby',    ext: '.rb'  },
  php:        { interp: 'php',     ext: '.php' },
  typescript: { interp: 'ts-node', ext: '.ts', flags: ['--transpile-only'] },
  cpp: { ext: '.cpp', compile: (src, bin) => ['g++', [src, '-o', bin, '-std=c++17', '-O2']], run: bin => [bin, []] },
  java: { ext: '.java', compile: (src, dir) => ['javac', ['-d', dir, src]], run: (dir, cls) => ['java', ['-cp', dir, cls]] },
  rust: { ext: '.rs', compile: (src, bin) => ['rustc', [src, '-o', bin]], run: bin => [bin, []] },
  go: { ext: '.go', compile: (src, bin) => ['go', ['build', '-o', bin, src]], run: bin => [bin, []] },
};

function runProc(cmd, args, cwd, timeoutMs = 15000) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', killed = false;
    const safe_env = { PATH: process.env.PATH, HOME: cwd, GOPATH: '/tmp/go', GOCACHE: path.join(cwd, '.gocache'), CARGO_HOME: '/tmp/cargo', RUSTUP_HOME: '/tmp/rustup' };
    const proc = spawn(cmd, args, { cwd, env: safe_env });
    const timer = setTimeout(() => { killed = true; proc.kill('SIGKILL'); }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d; if (stdout.length > 200000) proc.kill(); });
    proc.stderr.on('data', d => { stderr += d; if (stderr.length > 50000) proc.kill(); });
    proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code: killed ? -1 : (code ?? -1), killed }); });
    proc.on('error', e => { clearTimeout(timer); resolve({ stdout, stderr: e.message, code: -1 }); });
  });
}

app.post('/api/run', async (req, res) => {
  const { language, code, filename } = req.body;
  const runner = RUNNERS[language];
  if (!runner) return res.json({ stdout: '', stderr: `Language not supported: ${language}`, code: 1 });

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const baseName = (filename || 'main').replace(/\.[^.]+$/, '');
  const srcFile = path.join(tmpDir, baseName + runner.ext);

  try {
    fs.writeFileSync(srcFile, code);
    let result;
    if (runner.interp) {
      result = await runProc(runner.interp, [...(runner.flags || []), srcFile], tmpDir);
    } else {
      const binPath = path.join(tmpDir, baseName);
      const [cc, ca] = runner.compile(srcFile, language === 'java' ? tmpDir : binPath);
      const cr = await runProc(cc, ca, tmpDir, 30000);
      if (cr.code !== 0) result = { stdout: '', stderr: cr.stderr || cr.stdout, code: cr.code, killed: cr.killed };
      else result = await runProc(...runner.run(language === 'java' ? tmpDir : binPath, baseName), tmpDir);
    }
    res.json(result);
  } catch (e) {
    res.json({ stdout: '', stderr: e.message, code: 1 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── WEBSOCKET ────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });
const rooms = new Map();
const COLORS = ['#f97316','#3b82f6','#10b981','#a855f7','#ef4444','#eab308','#06b6d4','#ec4899'];
let colorIdx = 0;

wss.on('connection', ws => {
  const clientId = crypto.randomBytes(4).toString('hex');
  let projectId = null, userId = 'User', userColor = COLORS[colorIdx++ % COLORS.length];
  const send = msg => { try { ws.send(JSON.stringify(msg)); } catch (_) {} };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'join') {
      projectId = msg.projectId;
      userId = msg.userId || `User${clientId.slice(0,4)}`;
      if (!rooms.has(projectId)) rooms.set(projectId, new Map());
      rooms.get(projectId).set(clientId, { ws, userId, userColor });
      send({ type: 'welcome', clientId, userId, userColor });
      broadcast(projectId, clientId, { type: 'presence', users: getUsers(projectId) }, true);
      return;
    }
    if (!projectId) return;
    if (msg.type === 'update') {
      const now = Math.floor(Date.now() / 1000);
      dbRun(`INSERT INTO files (project_id, name, content, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
        projectId, msg.file, msg.content, now);
      dbDirty = true;
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

function getUsers(pid) { return [...(rooms.get(pid)?.values() || [])].map(p => ({ userId: p.userId, userColor: p.userColor })); }
function broadcast(pid, sender, msg, includeSender = false) {
  if (!rooms.has(pid)) return;
  const data = JSON.stringify(msg);
  rooms.get(pid).forEach((peer, cid) => {
    if ((includeSender || cid !== sender) && peer.ws.readyState === 1) {
      try { peer.ws.send(data); } catch (_) {}
    }
  });
}

setInterval(() => { wss.clients.forEach(ws => { if (ws.readyState === 1) try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {} }); }, 25000);

// ── STARTUP ────────────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { closeDb(); process.exit(0); });
process.on('SIGINT',  () => { closeDb(); process.exit(0); });

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Claw Code] Backend on :${PORT}`);
    console.log(`[Claw Code] SQLite: ${DB_PATH}`);
  });
}).catch(err => {
  console.error('[Claw Code] DB init failed:', err);
  process.exit(1);
});
