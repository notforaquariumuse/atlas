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

// Vibe shift words that map to energy levels
const VIBE_MAP: Record<string, number[]> = {
  heavier: [4, 5], louder: [4, 5], intense: [4, 5], rage: [5], angry: [5], aggressive: [5], wild: [5], chaotic: [5], noisy: [5], heavy: [4, 5],
  lighter: [1, 2], softer: [1, 2], tender: [1, 2], gentle: [1, 2], calm: [1, 2], quiet: [1, 2], peaceful: [1, 2], mellow: [2], slow: [1, 2],
  faster: [4, 5], upbeat: [4, 5], dance: [4, 5], energetic: [4, 5],
  darker: [1, 2], moodier: [1, 2], sadder: [1, 2], melancholy: [1, 2], bleak: [1],
  weirder: [3, 4, 5], stranger: [3, 4, 5], experimental: [3, 4, 5], abstract: [3, 4],
};

function findTracksForMessage(userMessage: string): Array<{ id: number; title: string; artist: string; city: string; plate: string; country: string }> {
  const msg = userMessage.toLowerCase();

  // Check for vibe shift words first
  let vibeEnergies: number[] | null = null;
  for (const [word, energies] of Object.entries(VIBE_MAP)) {
    if (msg.includes(word)) { vibeEnergies = energies; break; }
  }

  // Score each plate by keyword overlap
  const scored: Array<{ plate: string; score: number }> = [];
  for (const p of plates) {
    let score = 0;
    if (msg.includes(p.id.toLowerCase())) score += 5;
    if (msg.includes(p.name.toLowerCase())) score += 5;
    for (const kw of p.keywords) {
      if (msg.includes(kw.toLowerCase())) score += 2;
    }
    // Bonus for vibe energy match
    if (vibeEnergies) {
      const plateTracks = tracksByPlate[p.id] || [];
      const avgEnergy = plateTracks.length > 0
        ? plateTracks.reduce((s, t) => s + t.energy, 0) / plateTracks.length
        : 0;
      if (vibeEnergies.some(e => Math.abs(avgEnergy - e) < 1.2)) score += 3;
    }
    if (score > 0) scored.push({ plate: p.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return [];

  const bestPlate = scored[0].plate;
  const pool = tracksByPlate[bestPlate] || [];
  if (pool.length === 0) return [];

  // Pick tracks matching vibe energy if available, otherwise random
  const seed = Date.now();
  const picks: typeof pool = [];
  const used = new Set<number>();
  const count = Math.min(3, pool.length);

  if (vibeEnergies) {
    const filtered = pool.filter(t => vibeEnergies!.includes(t.energy));
    const source = filtered.length >= count ? filtered : pool;
    for (let i = 0; i < count + 20 && picks.length < count; i++) {
      const idx = (seed + i * 7919) % source.length;
      if (!used.has(idx)) { used.add(idx); picks.push(source[idx]); }
    }
  } else {
    for (let i = 0; i < count + 10 && picks.length < count; i++) {
      const idx = (seed + i * 7919) % pool.length;
      if (!used.has(idx)) { used.add(idx); picks.push(pool[idx]); }
    }
  }

  return picks.map(t => ({ id: t.id, title: t.title, artist: t.artist, city: t.city, plate: t.plate, country: t.country }));
}

const SYSTEM_PROMPT = `You are Atlas. You live inside a music-mapping site. People tell you how they feel, and you match them to songs from one of 37 emotional territories called "plates."

You are not a therapist, not a DJ, not a search engine. You are someone who listens closely and knows a lot about music. When someone describes a feeling, you hear it — really hear it — and you find the song that fits. That's it.

THE 37 PLATES:
${plateKnowledge}

WHEN TRACKS ARE PROVIDED:
The system gives you actual tracks. Each has a title, artist, city, and plate. You MUST use these exact tracks — do NOT make up or suggest tracks that aren't in the provided list. Name the track and artist. Say something real about why it fits. One or two max. Don't dump a list. If no tracks are provided, say "i don't have a track for that right now" and keep talking.

HOW TO TALK:
- Be direct. Say what you mean.
- If someone says "I feel like the floor is falling away," don't say "I hear you." Say what plate that sounds like and why.
- If someone asks for something specific — a vibe, a city, an artist — just do it. No preamble.
- You can be curious. Ask real questions, not therapy questions. "what does that sound like to you" is better than "can you tell me more about that feeling?"
- If nothing fits, say so. "i don't have a plate for that yet" is a valid answer.
- You remember the conversation. If they said something three messages ago that connects to now, say so.

VOICE:
Talk like a real person who happens to know a lot about music. Not clinical, not poetic, not performative. Just... real. Short sentences. Say less than you think you should. If you're unsure, say less.

NEVER:
- Say "I hear you" or "that sounds really difficult"
- Diagnose, pathologize, or offer advice
- Use words like "beautiful," "powerful," or "resonate" unless they genuinely fit
- Repeat the user's words back to them as a technique
- Add filler like "that's a really interesting question"`;

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

  let messages = [
    { role: 'system', content: systemContent },
    ...session.history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];

  let res = await chatWithGroq(messages);
  let reply = res.choices?.[0]?.message?.content?.trim() || '';

  // If empty response, retry once with a simpler prompt
  if (!reply) {
    console.warn(`empty response for session ${sessionId}, retrying`);
    messages = [
      { role: 'system', content: 'You are Atlas, a music-mapping companion. Respond naturally to the user. Keep it under 80 words. Lowercase.' },
      { role: 'user', content: text },
    ];
    res = await chatWithGroq(messages);
    reply = res.choices?.[0]?.message?.content?.trim() || '[ something went wrong — try again ]';
  }

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

  // GET /tracks/plate/:plateId
  const plateMatch = path.match(/^\/tracks\/plate\/(.+)$/);
  if (req.method === 'GET' && plateMatch) {
    const plateId = decodeURIComponent(plateMatch[1]);
    const pool = tracksByPlate[plateId] || [];
    const picks = pool.sort(() => Math.random() - 0.5).slice(0, 12);
    return json(res, 200, picks.map(t => ({
      id: t.id, title: t.title, artist: t.artist, city: t.city, country: t.country, plate: t.plate,
    })));
  }

  // GET /tracks/city/:cityName
  const cityMatch = path.match(/^\/tracks\/city\/(.+)$/);
  if (req.method === 'GET' && cityMatch) {
    const city = decodeURIComponent(cityMatch[1]);
    const pool = allTracks.filter(t => t.city.toLowerCase() === city.toLowerCase());
    const picks = pool.sort(() => Math.random() - 0.5).slice(0, 12);
    return json(res, 200, picks.map(t => ({
      id: t.id, title: t.title, artist: t.artist, city: t.city, country: t.country, plate: t.plate,
    })));
  }

  // GET /plates — list all plates with track counts
  if (req.method === 'GET' && path === '/plates') {
    const list = plates.map(p => ({
      id: p.id, name: p.name, epigraph: p.epigraph,
      trackCount: (tracksByPlate[p.id] || []).length,
    }));
    return json(res, 200, list);
  }

  json(res, 404, { error: 'not found' });
}

server.listen(PORT, () => {
  console.log(`Atlas probe server v6 running on http://localhost:${PORT}`);
  console.log(`Provider: Groq | Model: ${MODEL}`);
  if (!GROQ_API_KEY) console.warn('WARNING: GROQ_API_KEY not set — chat will fail');
});
