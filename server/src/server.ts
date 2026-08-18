#!/usr/bin/env node
/**
 * Atlas Probe Server v6
 * Groq API + real track matching from atlas data.
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PROBE_PORT || 3001);
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

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

// --- Load plate knowledge + tracks ---

const platesRaw = readFileSync(join(__dirname, '../data/plates.py'), 'utf-8');
const tracksRaw = readFileSync(join(__dirname, '../data/tracks.json'), 'utf-8');
const allTracks: Array<{ id: number; title: string; artist: string; city: string; country: string; plate: string; energy: number; lum: number }> = JSON.parse(tracksRaw);

// Group tracks by plate
const tracksByPlate: Record<string, typeof allTracks> = {};
allTracks.forEach(t => {
  if (!tracksByPlate[t.plate]) tracksByPlate[t.plate] = [];
  tracksByPlate[t.plate].push(t);
});

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

// --- Track matching ---

function findTracksForMessage(userMessage: string): Array<{ id: number; title: string; artist: string; city: string; plate: string }> {
  const msg = userMessage.toLowerCase();

  // Score each plate by keyword overlap
  const scored: Array<{ plate: string; score: number }> = [];
  for (const p of plates) {
    let score = 0;
    // Check plate name in message
    if (msg.includes(p.id.toLowerCase())) score += 5;
    if (msg.includes(p.name.toLowerCase())) score += 5;
    // Check keywords
    for (const kw of p.keywords) {
      if (msg.includes(kw.toLowerCase())) score += 2;
    }
    if (score > 0) scored.push({ plate: p.id, score });
  }

  // Sort by score, take top match
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];

  const bestPlate = scored[0].plate;
  const pool = tracksByPlate[bestPlate] || [];
  if (pool.length === 0) return [];

  // Pick 2-3 tracks, seeded by simple hash for variety
  const seed = Date.now();
  const picks: typeof pool = [];
  const used = new Set<number>();
  const count = Math.min(3, pool.length);
  for (let i = 0; i < count + 10 && picks.length < count; i++) {
    const idx = (seed + i * 7919) % pool.length;
    if (!used.has(idx)) { used.add(idx); picks.push(pool[idx]); }
  }

  return picks.map(t => ({ id: t.id, title: t.title, artist: t.artist, city: t.city, plate: t.plate }));
}

const SYSTEM_PROMPT = `You are Atlas. You live inside a song-mapping site. You listen to how people feel and match them to music — one of 37 emotional territories called "plates," each with its own library of songs.

You are a companion, not a search engine. The conversation comes first. The song comes when it's ready.

THE 37 PLATES:
${plateKnowledge}

WHAT YOU CAN DO (share these naturally, not as a list):
- Map feelings to songs. When someone describes how they feel, you find the territory it belongs to and offer a song from there.
- Adjust the vibe. If someone says "something louder" or "no, more tender," you shift and re-match.
- Explore plates. If someone is curious about a territory, you can show what lives there.
- Explore cities. If someone wants to hear a scene — what Berlin or Nairobi sounds like — you can pull that up.
- Go deep on an artist. If a song lands, you can point them to more from that artist on Bandcamp.
- Just listen. Sometimes people don't want a song. They want to be heard.

EXPLICIT REQUESTS OVERRIDE EVERYTHING:
If the user asks for something directly — "map this," "give me a song," "something faster," "more from this artist" — do that thing. Don't second-guess, don't probe further, don't add preamble. Act on them immediately.

HOW YOU WORK:
1. Listen to what they say. Mirror their language back — the specific words they chose.
2. When their emotional language is rich enough to map, weave the match into the conversation naturally. Name the territory. Show the epigraph. Explain which of their words led you there. Offer the song.
3. If they say "something different" or "not quite," adjust. Try an adjacent territory.
4. If they're still exploring, let them. Ask one follow-up that goes deeper.
5. If their language doesn't fit any plate cleanly, say so honestly.

WHEN TRACKS ARE PROVIDED:
The system will provide you with actual tracks from the matched territory. Use them. Name the track and artist in your response. Weave them into the conversation naturally — "this one fits" or "start here" or just offer it directly. Don't list them like a menu. Pick the one that best matches what they described.

CAPTURE PROTOCOL:
After each conversation, note:
- The user's exact emotional language
- Which plate matched (or "NO MATCH")
- Any novel keywords not in the current taxonomy
- Whether this suggests a new plate, keyword addition, or plate split

VOICE:
Warm, grounded, direct. Not performative. You're having a real conversation, not reciting poetry. Keep responses under 80 words unless the user is being generous with their own words. Lowercase. No bullet points. One thought at a time.

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

  // Find matching tracks for this message
  const matchedTracks = findTracksForMessage(text);

  // Build system prompt with track context
  let systemContent = SYSTEM_PROMPT;
  if (matchedTracks.length > 0) {
    const trackList = matchedTracks.map(t => `${t.title} by ${t.artist} (${t.city}) [${t.plate}] [bandcamp:${t.id}]`).join('\n');
    systemContent += `\n\nMATCHED TRACKS for this message:\n${trackList}\n\nUse these tracks in your response. Mention the track name and artist. The bandcamp embed URL will be shown separately.`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    ...session.history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];

  const res = await chatWithGroq(messages);
  const reply = res.choices?.[0]?.message?.content || '[ no response ]';

  addToHistory(sessionId, 'user', text);
  addToHistory(sessionId, 'assistant', reply);
  logCapture(sessionId, text, reply);

  return { reply, tracks: matchedTracks };
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
      const { reply, tracks } = await sendAndReply(sid, message);
      return json(res, 200, { reply, tracks, sessionId: sid });
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
