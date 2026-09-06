const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PROVIDER = (process.env.LLM_PROVIDER || 'mock').toLowerCase();
const MODEL = process.env.LLM_MODEL || (PROVIDER === 'gemini' ? 'gemini-3.5-flash-lite' : 'mistral-small-latest');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024);
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 20);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const requestLog = new Map();
const MAX_OUTPUT_TOKENS = /gemma/i.test(MODEL) ? 6000 : 1200;
const PROVIDER_TIMEOUT_MS = /gemma/i.test(MODEL) ? 90_000 : 30_000;

const referenceDir = path.resolve(
  process.env.REFERENCE_DIR || path.join(__dirname, '..', '.ai', 'ftir-band-assignment', 'references')
);

function log(event, details = {}) {
  console.log(`[${new Date().toISOString()}] ${event}`, details);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function clientKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  const now = Date.now();
  const key = clientKey(req);
  const entries = (requestLog.get(key) || []).filter((time) => now - time < RATE_WINDOW_MS);
  entries.push(now);
  requestLog.set(key, entries);
  return entries.length > RATE_LIMIT;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Payload must be an object';
  if (payload.version !== '1.0') return 'Unsupported payload version';
  if (!Array.isArray(payload.confirmedPeaks) || payload.confirmedPeaks.length === 0) {
    return 'At least one confirmed peak is required';
  }
  if (payload.confirmedPeaks.length > 200) return 'Too many confirmed peaks';
  for (const peak of payload.confirmedPeaks) {
    if (!Number.isFinite(Number(peak?.nu))) return 'Each peak needs a finite nu';
    if (peak.localWindow && (!Array.isArray(peak.localWindow) || peak.localWindow.length > 500)) {
      return 'Invalid localWindow';
    }
  }
  return null;
}

async function loadReferences() {
  const [bands, zones] = await Promise.all([
    fs.readFile(path.join(referenceDir, 'bands_master.md'), 'utf8'),
    fs.readFile(path.join(referenceDir, 'diagnostic_zones.md'), 'utf8'),
  ]);
  return { bands, zones };
}

function selectRelevantBands(markdown, peaks) {
  const peakValues = peaks.map((peak) => Number(peak.nu)).filter(Number.isFinite);
  const lines = markdown.split(/\r?\n/);
  const selected = lines.filter((line) => {
    if (!line.trim().startsWith('|') || line.includes('Диапазон')) return false;
    const numbers = line.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (numbers.length < 2) return false;
    const low = Math.min(numbers[0], numbers[1]);
    const high = Math.max(numbers[0], numbers[1]);
    return peakValues.some((peak) => peak >= low - 30 && peak <= high + 30);
  });
  return ['| Relevant reference ranges from bands_master.md |', ...selected.slice(0, 120)].join('\n');
}

function mockInterpretation(payload) {
  return {
    interpretation: 'Mock response: confirmed peaks received. Configure LLM_PROVIDER to enable a cloud provider.',
    candidates: payload.confirmedPeaks.map((peak) => ({
      nu: Number(peak.nu),
      assignments: [],
      explanation: 'Reference lookup and model interpretation are disabled in mock mode.',
      confidence: 'low',
    })),
    supporting_peaks: [],
    missing_evidence: ['LLM provider configuration'],
    confidence: 'low',
    sources: [],
    limitations: ['Mock provider response; no chemical interpretation was performed.'],
    model: 'mock',
    created_at: new Date().toISOString(),
  };
}

function buildPrompt(payload, references) {
  const compactGemma = /gemma/i.test(MODEL);
  return [
    'You are an FTIR interpretation assistant. Return JSON only.',
    'Do not identify an exact substance. Produce ranked functional-group hypotheses.',
    compactGemma ? 'Be concise: return exactly one best candidate per confirmed peak, with one short reasoning sentence. Mention alternatives briefly inside reasoning.' : '',
    'Use the confirmed observations and the supplied references. Preserve every observed nu.',
    'Return fields: interpretation, candidates, supporting_peaks, missing_evidence, confidence, sources, limitations, model, created_at. Every candidates item must include nu when it refers to a specific confirmed peak; never omit nu for a single-peak analysis.',
    `Confirmed observations:\n${JSON.stringify(payload.confirmedPeaks)}`,
    `Relevant reference bands:\n${selectRelevantBands(references.bands, payload.confirmedPeaks)}`,
    `Diagnostic rules:\n${references.zones}`,
  ].join('\n\n');
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

function normalizeResult(result, payload) {
  const normalized = result && typeof result === 'object' ? { ...result } : {};
  const supporting = Array.isArray(normalized.supporting_peaks) ? normalized.supporting_peaks : [];
  normalized.candidates = (Array.isArray(normalized.candidates) ? normalized.candidates : []).map((candidate, index) => {
    const item = candidate && typeof candidate === 'object' ? { ...candidate } : {};
    const related = supporting[index];
    if (!item.nu && Number.isFinite(Number(related?.nu))) item.nu = Number(related.nu);
    if (!item.group && !item.assignment && !item.label && related?.assignment) item.assignment = related.assignment;
    if (!item.reasoning && !item.explanation) item.explanation = 'The model returned no explanation for this candidate.';
    return item;
  });
  if (!normalized.candidates.length && payload.confirmedPeaks.length === 1) {
    normalized.candidates = [{
      nu: Number(payload.confirmedPeaks[0].nu),
      assignment: 'No assignment returned',
      explanation: normalized.interpretation || 'The model returned no candidate assignment.',
      confidence: normalized.confidence || 'low',
    }];
  }
  return normalized;
}

async function callProvider(payload, references) {
  if (PROVIDER === 'mock') return mockInterpretation(payload);
  const prompt = buildPrompt(payload, references);
  log('provider.request', { provider: PROVIDER, model: MODEL, peaks: payload.confirmedPeaks.length, promptChars: prompt.length });
  let response;
  if (PROVIDER === 'gemini') {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not configured');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(key)}`;
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseSchema: {
            type: 'OBJECT',
            properties: {
              interpretation: { type: 'STRING' },
              candidates: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    nu: { type: 'NUMBER' },
                    group: { type: 'STRING' },
                    assignment: { type: 'STRING' },
                    likelihood: { type: 'STRING' },
                    reasoning: { type: 'STRING' },
                  },
                  required: ['nu', 'group', 'reasoning'],
                },
              },
              supporting_peaks: { type: 'ARRAY', items: { type: 'OBJECT' } },
              missing_evidence: { type: 'ARRAY', items: { type: 'STRING' } },
              confidence: { type: 'STRING' },
              limitations: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: ['interpretation', 'candidates', 'confidence'],
          },
        },
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } else if (PROVIDER === 'mistral') {
    const key = process.env.MISTRAL_API_KEY;
    if (!key) throw new Error('MISTRAL_API_KEY is not configured');
    response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, temperature: 0.1, max_tokens: 1200, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } else {
    throw new Error(`Unsupported provider: ${PROVIDER}`);
  }
  if (!response.ok) {
    const providerError = (await response.text()).slice(0, 800);
    log('provider.response.error', { status: response.status, provider: PROVIDER, model: MODEL, body: providerError });
    throw new Error(`Provider request failed: ${response.status}`);
  }
  const data = await response.json();
  const text = PROVIDER === 'gemini'
    ? data.candidates?.[0]?.content?.parts?.[0]?.text
    : data.choices?.[0]?.message?.content;
  const result = normalizeResult(extractJson(text), payload);
  log('provider.response.ok', { provider: PROVIDER, model: MODEL, responseChars: String(text || '').length });
  return { ...result, model: result.model || MODEL, created_at: result.created_at || new Date().toISOString() };
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  log('request', { method: req.method, url: req.url, origin: req.headers.origin || null, remote: clientKey(req) });
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.url === '/' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      service: 'FTIR analysis API',
      endpoints: {
        health: 'GET /health',
        analyze: 'POST /api/analyze',
      },
    });
  }
  if (req.url === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, provider: PROVIDER, model: MODEL });
  if (req.url !== '/api/analyze' || req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
  if (isRateLimited(req)) {
    log('request.rate_limited', { url: req.url });
    return sendJson(res, 429, { error: 'Rate limit exceeded' });
  }
  try {
    const payload = await readJson(req);
    const validationError = validatePayload(payload);
    if (validationError) {
      log('request.invalid', { error: validationError });
      return sendJson(res, 400, { error: validationError });
    }
    log('analysis.start', { peaks: payload.confirmedPeaks.length, files: payload.spectrum?.files?.length || 0 });
    const references = await loadReferences();
    const result = await callProvider(payload, references);
    log('analysis.complete', { status: 200, durationMs: Date.now() - startedAt });
    return sendJson(res, 200, { ok: true, result });
  } catch (error) {
    const status = error.statusCode || 502;
    console.error(`[${new Date().toISOString()}] analysis.error`, { status, message: error.message, durationMs: Date.now() - startedAt });
    return sendJson(res, status, { error: status === 502 ? 'Analysis provider unavailable' : error.message });
  }
});

server.listen(PORT, HOST, () => {
  log('server.ready', { address: `http://${HOST}:${PORT}`, provider: PROVIDER, model: MODEL, allowedOrigin: ALLOWED_ORIGIN });
});
