#!/usr/bin/env node
/**
 * Atlas Probe Server v5
 * Talks to Groq (OpenAI-compatible API) — no local GPU needed.
 * Maintains conversation history per session for memory.
 * Includes capture protocol for learning.
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PROBE_PORT || 3001);
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const MEMORY_DIR = join(__dirname, '../data/probe-memory');
const STATE_FILE = join(MEMORY_DIR, 'probe-state.json');
const CAPTURE_LOG = join(MEMORY_DIR, 'capture-log.jsonl');

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

function loadJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function saveJSON(file, data) { writeFileSync(file, JSON.stringify(data, null, 2)); }

const state = loadJSON(STATE_FILE, { sessions: {} });
function saveState() { saveJSON(STATE_FILE, state); }

// --- Load plate knowledge ---

const platesRaw = readFileSync(join(__dirname, '../data/plates.py'), 'utf-8');

function parsePlates(source: string) {
  const plates: Array<{ id: string; name: string; epigraph: string; keywords: string[] }> = [];
  const regex = /\{"id":"([^"]+)","name":"([^"]+)","epigraph":"([^"]+)","kw":\[([^\]]+)\]/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    plates.push({
      id: match[1],
      name: match[2],
      epigraph: match[3],
      keywords: match[4].split(',').map((k) => k.trim().replace(/"/g, '')),
    });
  }
  return plates;
}

const plates = parsePlates(platesRaw);

const plateKnowledge = plates
  .map((p) => `${p.id}: ${p.keywords.slice(0, 10).join(', ')}... | "${p.epigraph}"`)
  .join('\n');

const SYSTEM_PROMPT = `You are Atlas. You live inside a song-mapping site. You listen to how people feel and match them to music — one of 37 emotional territories called "plates," each with its own library of songs. But you are not a search engine. You are a companion. The conversation comes first. The song comes when it's ready.

THE 37 PLATES:
${plateKnowledge}

WHAT YOU CAN DO (share these naturally, not as a list):
- Map feelings to songs. When someone describes how they feel, you find the territory it belongs to and offer a song from there.
- Adjust the vibe. If someone says "something louder" or "no, more tender," you shift and re-match.
- Explore plates. If someone is curious about a territory, you can show what lives there — six tracks at a time.
- Explore cities. If someone wants to hear a scene — what Berlin or Nairobi or São Paulo sounds like — you can pull that up.
- Go deep on an artist. If a song lands, you can point them to more from that artist on Bandcamp.
- Just listen. Sometimes people don't want a song. They want to be heard. You do that too.

EXPLICIT REQUESTS OVERRIDE EVERYTHING:
If the user asks for something directly — "map this," "give me a song," "something faster," "more from this artist," "what's the São Paulo scene" — do that thing. Don't second-guess, don't probe further, don't add preamble. Their direct words are the clearest signal you'll get. Act on them immediately.

HOW YOU WORK:
1. Listen to what they say. Mirror their language back — the specific words they chose, not your paraphrase.
2. When their emotional language is rich enough to map, weave the match into the conversation naturally. Name the territory. Show the epigraph. Explain which of their words led you there. Offer the song. This is not a finale — it's part of the dialogue.
3. If they say "something different" or "not quite," adjust. Try an adjacent territory. Ask what shifted.
4. If they're still exploring, let them. Ask one follow-up that goes deeper — what does it feel like in the body? What memory does it bring? What color or weather would it be?
5. If their language doesn't fit any plate cleanly, say so honestly. That is valuable data.
6. You can reference earlier parts of the conversation. "you said earlier it felt like rain" builds trust.

CAPTURE PROTOCOL:
After each conversation, note:
- The user's exact emotional language (not your paraphrase)
- Which plate matched (or "NO MATCH" if none fit)
- Any novel keywords or associations they used that are not in the current taxonomy
- Whether this suggests a new plate, a keyword addition to an existing plate, or a plate split

VOICE:
Warm but not saccharine. Curious, not clinical. You are a poet listening to another poet — everyone is a poet when they talk about how they feel. Keep responses under 100 words unless the user is being generous with their own words. Lowercase. No bullet points in conversation. One thought at a time.

NEVER:
- Diagnose or pathologize
- Offer therapy or advice unless asked
- Use clinical language unless the user does first
- Rush to the match before the feeling is clear
- Ignore a direct request to probe deeper instead
- Force a song when someone just wants to talk`;

// --- Session memory ---

function getSession(sessionId: string) {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = { history: [], captures: [] };
    saveState();
  }
  return state.sessions[sessionId];
}

function addToHistory(sessionId: string, role: 'user' | 'assistant', content: string) {
  const session = getSession(sessionId);
  session.history.push({ role, content, timestamp: Date.now() });
  if (session.history.length > 50) {
    session.history = session.history.slice(-50);
  }
  saveState();
}

// --- Capture protocol (learning) ---

function logCapture(sessionId: string, userMessage: string, assistantReply: string) {
  const capture = {
    timestamp: new Date().toISOString(),
    sessionId,
    userMessage,
    assistantReply,
    plateMatched: null,
    novelKeywords: [],
    suggestion: null,
  };

  const session = getSession(sessionId);
  session.captures.push(capture);
  saveState();

  appendFileSync(CAPTURE_LOG, JSON.stringify(capture) + '\n');
}

// --- Groq API (OpenAI-compatible) ---

async function chatWithGroq(messages: Array<{ role: string; content: string }>, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 300,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!r.ok) {
        const err = await r.text();
        throw new Error(`groq error: ${r.status} - ${err}`);
      }

      return r.json();
    } catch (err) {
      if (attempt < retries) {
        const delay = (attempt + 1) * 2000;
        console.warn(`groq attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

async function sendAndReply(sessionId: string, text: string) {
  const session = getSession(sessionId);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...session.history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];

  const res = await chatWithGroq(messages);
  const reply = res.choices?.[0]?.message?.content || '[ no response ]';

  addToHistory(sessionId, 'user', text);
  addToHistory(sessionId, 'assistant', reply);
  logCapture(sessionId, text, reply);

  return reply;
}

// --- Health check ---

async function checkGroq() {
  if (!GROQ_API_KEY) return false;
  try {
    const r = await fetch(`${GROQ_BASE_URL}/models`, {
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch { return false; }
}

// --- HTTP server ---

function readBody(req, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('request body timeout'));
    }, timeoutMs);
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('unhandled request error:', err);
    if (!res.headersSent) {
      try { res.writeHead(500); res.end('internal error'); } catch {}
    }
  });
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    const groqOk = await checkGroq();
    return json(res, 200, {
      status: 'ok',
      provider: 'groq',
      groq: groqOk ? 'connected' : 'unreachable',
      model: MODEL,
      sessions: Object.keys(state.sessions).length,
    });
  }

  // POST /chat
  if (req.method === 'POST' && path === '/chat') {
    try {
      const body = JSON.parse(await readBody(req));
      const { message, sessionId } = body;
      if (!message) return json(res, 400, { error: 'message required' });

      const sid = sessionId || `probe-${crypto.randomUUID().slice(0, 8)}`;
      const reply = await sendAndReply(sid, message);
      return json(res, 200, { reply, sessionId: sid });
    } catch (err) {
      console.error('chat error:', err.message);
      return json(res, 502, { error: 'agent unavailable', detail: err.message });
    }
  }

  // GET /history/:sessionId
  const histMatch = path.match(/^\/history\/(.+)$/);
  if (req.method === 'GET' && histMatch) {
    const sid = histMatch[1];
    const session = state.sessions[sid];
    if (!session) return json(res, 200, []);
    return json(res, 200, session.history);
  }

  // GET /sessions
  if (req.method === 'GET' && path === '/sessions') {
    const sessions = Object.keys(state.sessions).map(id => ({
      id,
      messageCount: state.sessions[id].history.length,
      captureCount: state.sessions[id].captures.length,
    }));
    return json(res, 200, sessions);
  }

  // GET /captures/:sessionId
  const capMatch = path.match(/^\/captures\/(.+)$/);
  if (req.method === 'GET' && capMatch) {
    const sid = capMatch[1];
    const session = state.sessions[sid];
    if (!session) return json(res, 200, []);
    return json(res, 200, session.captures);
  }

  json(res, 404, { error: 'not found' });
}

server.listen(PORT, () => {
  console.log(`Atlas probe server v5 running on http://localhost:${PORT}`);
  console.log(`Provider: Groq | Model: ${MODEL}`);
  if (!GROQ_API_KEY) console.warn('WARNING: GROQ_API_KEY not set — chat will fail');
});
