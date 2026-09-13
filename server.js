const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildComparisonMatrix, normalizeObservation } = require('./peak_comparison');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PROVIDER = (process.env.LLM_PROVIDER || 'mock').toLowerCase();
const MODEL = process.env.LLM_MODEL || (PROVIDER === 'gemini' ? 'gemini-3.5-flash-lite' : 'mistral-small-latest');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024);
const MAX_DETECT_BODY_BYTES = Number(process.env.MAX_DETECT_BODY_BYTES || 8 * 1024 * 1024);
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 20);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const MAX_PROMPT_PEAKS_PER_SPECTRUM = Number(process.env.MAX_PROMPT_PEAKS_PER_SPECTRUM || 80);
const MAX_PROMPT_CHANGES = Number(process.env.MAX_PROMPT_CHANGES || 240);
const PROMPT_VERSION = 'reaction-comparison-v2';
const requestLog = new Map();
const MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS || (/gemma/i.test(MODEL) ? 6000 : 1800));
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

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
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

function validateDetectionPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Payload must be an object';
  if (payload.schemaVersion !== '2.0') return 'Unsupported schemaVersion';
  if (!Array.isArray(payload.spectra) || payload.spectra.length === 0) return 'At least one spectrum is required';
  if (payload.spectra.length > 100) return 'Too many spectra';
  const ids = new Set();
  for (const spectrum of payload.spectra) {
    if (!spectrum || typeof spectrum !== 'object') return 'Invalid spectrum';
    if (!spectrum.id || ids.has(spectrum.id)) return 'Spectrum IDs must be unique';
    ids.add(spectrum.id);
    if (!Array.isArray(spectrum.points) || spectrum.points.length < 5 || spectrum.points.length > 500000) {
      return `Invalid points for spectrum ${spectrum.id}`;
    }
    for (const point of spectrum.points) {
      if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) {
        return `Invalid point in spectrum ${spectrum.id}`;
      }
    }
  }
  return null;
}

function runPeakDetector(payload) {
  const script = path.join(__dirname, 'peak_detector', 'peak_detector.py');
  const python = process.env.PYTHON_BIN || 'python3';
  const timeoutMs = Number(process.env.DETECTOR_TIMEOUT_MS || 30_000);
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('Peak detector timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error(`Peak detector unavailable: ${error.message}`)); }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`Peak detector failed${stderr ? `: ${stderr.slice(0, 300)}` : ''}`));
        return;
      }
      try {
        const result = JSON.parse(stdout || '{}');
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) {
        reject(new Error(`Invalid peak detector response: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Payload must be an object';
  if (payload.schemaVersion === '2.0') {
    if (!Array.isArray(payload.spectra) || payload.spectra.length === 0) return 'At least one spectrum is required';
    if (!Array.isArray(payload.peakObservations)) return 'peakObservations must be an array';
    if (!Array.isArray(payload.confirmedPeakIds) || payload.confirmedPeakIds.length === 0) return 'At least one confirmed peak is required';
    const spectrumIds = new Set(payload.spectra.map((spectrum) => String(spectrum?.id || '')));
    if (spectrumIds.has('')) return 'Every spectrum needs an id';
    if (spectrumIds.size !== payload.spectra.length) return 'Spectrum IDs must be unique';
    for (const observation of payload.peakObservations) {
      const normalized = normalizeObservation(observation);
      if (!normalized || !spectrumIds.has(normalized.spectrumId)) return 'Every peak observation needs a valid spectrumId and nu';
    }
    const observationIds = new Set(payload.peakObservations.map((observation) => String(observation.id || '')));
    if (payload.confirmedPeakIds.some((id) => !observationIds.has(String(id)))) return 'confirmedPeakIds must refer to peakObservations';
    return null;
  }
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

function normalizeAnalysisPayload(payload) {
  if (payload.schemaVersion === '2.0') {
    const observations = payload.peakObservations.map(normalizeObservation).filter(Boolean);
    const comparison = buildComparisonMatrix(payload.spectra, observations, payload.analysisSettings || {});
    const confirmedIds = new Set(payload.confirmedPeakIds.map((id) => String(id)));
    return {
      ...payload,
      peakObservations: observations,
      peakGroups: comparison.groups.map(({ observations: _observations, ...group }) => group),
      confirmedPeaks: observations.filter((observation) => confirmedIds.has(observation.id)),
      comparison,
    };
  }
  const observations = (payload.confirmedPeaks || []).map(normalizeObservation).filter(Boolean);
  const spectra = payload.spectrum?.spectra || (payload.spectrum?.files || []).map((name, index) => ({ id: `spectrum-${index + 1}`, name }));
  const comparison = buildComparisonMatrix(spectra, observations, {});
  return { ...payload, schemaVersion: '2.0', spectra, peakObservations: observations, peakGroups: comparison.groups, comparison };
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
  const changeSummary = buildChangeSummary(payload.comparison);
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
    reactionAssessment: {
      status: payload.comparison?.changes?.length ? 'inconclusive' : 'inconclusive',
      summary: 'Mock mode calculated the comparison matrix but did not perform chemical interpretation.',
      confidence: 'low',
      evidence: payload.comparison?.changes || [],
      missingEvidence: ['LLM provider configuration'],
    },
    changeSummary,
    spectra: (payload.spectra || []).map((spectrum) => ({
      spectrumId: spectrum.id,
      peakAssignments: (payload.confirmedPeaks || [])
        .filter((peak) => peak.spectrumId === spectrum.id)
        .map((peak) => ({
          peakId: peak.id,
          nu: Number(peak.nu),
          group: 'Not assigned in mock mode',
          confidence: 'low',
          reasoning: 'Configure an LLM provider for a functional-group assignment.',
        })),
    })),
    comparison: payload.comparison || null,
    schemaVersion: '2.0',
    promptVersion: PROMPT_VERSION,
    model: 'mock',
    created_at: new Date().toISOString(),
  };
}

function compactPromptData(payload) {
  const observations = payload.peakObservations || payload.confirmedPeaks || [];
  const confirmedIds = new Set((payload.confirmedPeakIds || payload.confirmedPeaks?.map((peak) => peak.id) || []).map(String));
  const comparison = payload.comparison || {};
  const changedGroupIds = new Set((comparison.changes || []).map((change) => change.groupId).filter(Boolean));
  const changedPeakIds = new Set();
  (comparison.groups || []).forEach((group) => {
    if (!changedGroupIds.has(group.id)) return;
    (group.members || []).forEach((member) => changedPeakIds.add(String(member.peakId)));
  });

  const bySpectrum = new Map();
  observations.forEach((observation) => {
    const key = String(observation.spectrumId || 'unknown');
    if (!bySpectrum.has(key)) bySpectrum.set(key, []);
    bySpectrum.get(key).push(observation);
  });

  const selected = [];
  bySpectrum.forEach((items) => {
    const ranked = items
      .map((observation) => ({
        observation,
        priority: confirmedIds.has(String(observation.id)) ? 3 : changedPeakIds.has(String(observation.id)) ? 2 : 1,
        score: Number(observation.prominence) || Number(observation.confidence) || 0,
      }))
      .sort((a, b) => b.priority - a.priority || b.score - a.score);
    const limit = Math.max(1, MAX_PROMPT_PEAKS_PER_SPECTRUM);
    selected.push(...ranked.slice(0, Math.max(limit, ranked.filter((item) => item.priority > 1).length)).map((item) => item.observation));
  });

  const changes = (comparison.changes || []).slice(0, Math.max(1, MAX_PROMPT_CHANGES));
  const groupIds = new Set(changes.map((change) => change.groupId).filter(Boolean));
  const groups = (comparison.groups || []).filter((group) => groupIds.has(group.id));
  return {
    observations: selected,
    comparison: { ...comparison, groups, changes },
    limits: {
      maxPeaksPerSpectrum: MAX_PROMPT_PEAKS_PER_SPECTRUM,
      maxChanges: MAX_PROMPT_CHANGES,
      observationsSent: selected.length,
      observationsAvailable: observations.length,
    },
  };
}

function buildChangeSummary(comparison = {}) {
  const summary = {
    disappeared: [],
    appeared: [],
    shifted: [],
    intensityChanges: [],
    widthChanges: [],
  };
  (comparison.changes || []).forEach((change) => {
    const target = change.type === 'disappeared_peak'
      ? summary.disappeared
      : change.type === 'appeared_peak'
        ? summary.appeared
        : change.type === 'shifted_peak'
          ? summary.shifted
          : change.type === 'prominence_change'
            ? summary.intensityChanges
            : change.type === 'width_change' ? summary.widthChanges : null;
    if (target) target.push({ ...change });
  });
  return summary;
}

function buildPrompt(payload, references) {
  const compactGemma = /gemma/i.test(MODEL);
  const compact = compactPromptData(payload);
  const observations = compact.observations;
  const language = payload.analysisSettings?.language || 'en';
  return [
    `SYSTEM: You are a careful FTIR reaction-analysis assistant. Return JSON only. Prompt version: ${PROMPT_VERSION}.`,
    `Write all human-readable strings in language code ${language}.`,
    'Your job is interpretation, not peak detection. Peak coordinates and changes in the comparison matrix are authoritative.',
    'Never invent a peak, spectrumId, peakId, shift, appearance, disappearance, or reaction result. If evidence is insufficient, use status "inconclusive".',
    'Do not identify an exact substance. Discuss functional-group hypotheses only, with confidence and short evidence-based reasoning.',
    compactGemma ? 'Keep the response compact: 3–5 sentence summary, one short evidence sentence per change, and one assignment per confirmed peak.' : 'Keep the response concise but explanatory: the summary must explicitly mention important shifts, disappeared peaks, appeared peaks, and intensity changes.',
    'The final response must contain reactionAssessment, changeSummary, spectra, limitations, schemaVersion, promptVersion, and interpretation.',
    'reactionAssessment.status must be passed, not_passed, or inconclusive. Use passed/not_passed only when the supplied evidence supports that conclusion; otherwise use inconclusive.',
    'changeSummary must classify objective changes into disappeared, appeared, shifted, intensityChanges, and widthChanges. Copy numeric values from the comparison matrix and add a short explanation where useful.',
    'spectra must contain one item per spectrum. peakAssignments should focus on confirmedPeakIds; each assignment must include peakId, nu, group, confidence, and one short reasoning sentence.',
    'Do not return a generic list called Candidate assignments. Every assignment must identify the spectrum through its parent and the exact peak it describes.',
    `All peak observations:\n${JSON.stringify(observations)}`,
    `Confirmed peak IDs:\n${JSON.stringify(payload.confirmedPeakIds || payload.confirmedPeaks?.map((peak) => peak.id) || [])}`,
    `Comparison matrix:\n${JSON.stringify(compact.comparison)}`,
    `Prompt compaction:\n${JSON.stringify(compact.limits)}`,
    `Relevant reference bands:\n${selectRelevantBands(references.bands, observations)}`,
    `Diagnostic rules:\n${references.zones}`,
    'JSON shape: {"schemaVersion":"2.0","promptVersion":"reaction-comparison-v2","interpretation":"...","reactionAssessment":{"status":"inconclusive","summary":"...","confidence":"low","evidence":[],"missingEvidence":[]},"changeSummary":{"disappeared":[],"appeared":[],"shifted":[],"intensityChanges":[],"widthChanges":[]},"spectra":[{"spectrumId":"...","peakAssignments":[{"peakId":"...","nu":0,"group":"...","confidence":"medium","reasoning":"..."}]}],"limitations":[]}',
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
              schemaVersion: { type: 'STRING' },
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
              reactionAssessment: {
                type: 'OBJECT',
                properties: {
                  status: { type: 'STRING' },
                  summary: { type: 'STRING' },
                  confidence: { type: 'STRING' },
                  evidence: { type: 'ARRAY', items: { type: 'OBJECT' } },
                  missingEvidence: { type: 'ARRAY', items: { type: 'STRING' } },
                },
                required: ['status', 'summary', 'confidence', 'evidence', 'missingEvidence'],
              },
              changeSummary: {
                type: 'OBJECT',
                properties: {
                  disappeared: { type: 'ARRAY', items: { type: 'OBJECT' } },
                  appeared: { type: 'ARRAY', items: { type: 'OBJECT' } },
                  shifted: { type: 'ARRAY', items: { type: 'OBJECT' } },
                  intensityChanges: { type: 'ARRAY', items: { type: 'OBJECT' } },
                  widthChanges: { type: 'ARRAY', items: { type: 'OBJECT' } },
                },
                required: ['disappeared', 'appeared', 'shifted', 'intensityChanges', 'widthChanges'],
              },
              spectra: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    spectrumId: { type: 'STRING' },
                    peakAssignments: {
                      type: 'ARRAY',
                      items: {
                        type: 'OBJECT',
                        properties: {
                          peakId: { type: 'STRING' },
                          nu: { type: 'NUMBER' },
                          group: { type: 'STRING' },
                          confidence: { type: 'STRING' },
                          reasoning: { type: 'STRING' },
                        },
                        required: ['peakId', 'nu', 'group', 'confidence', 'reasoning'],
                      },
                    },
                  },
                  required: ['spectrumId', 'peakAssignments'],
                },
              },
              promptVersion: { type: 'STRING' },
            },
            required: ['schemaVersion', 'interpretation', 'confidence', 'reactionAssessment', 'changeSummary', 'spectra', 'limitations', 'promptVersion'],
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
      body: JSON.stringify({ model: MODEL, temperature: 0.1, max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
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
  return {
    ...result,
    schemaVersion: result.schemaVersion || '2.0',
    comparison: result.comparison || payload.comparison || null,
    changeSummary: result.changeSummary || buildChangeSummary(payload.comparison),
    promptVersion: result.promptVersion || PROMPT_VERSION,
    model: result.model || MODEL,
    created_at: result.created_at || new Date().toISOString(),
  };
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
        detectPeaks: 'POST /api/peaks/detect',
        analyze: 'POST /api/analyze',
      },
    });
  }
  if (req.url === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, provider: PROVIDER, model: MODEL });
  if (req.url === '/api/peaks/detect' && req.method === 'POST') {
    if (isRateLimited(req)) {
      log('request.rate_limited', { url: req.url });
      return sendJson(res, 429, { error: 'Rate limit exceeded' });
    }
    try {
      const payload = await readJson(req, MAX_DETECT_BODY_BYTES);
      const validationError = validateDetectionPayload(payload);
      if (validationError) return sendJson(res, 400, { error: validationError });
      log('peak_detection.start', { spectra: payload.spectra.length });
      const result = await runPeakDetector(payload);
      log('peak_detection.complete', { peaks: result.peakObservations?.length || 0, engine: result.engine });
      return sendJson(res, 200, result);
    } catch (error) {
      const status = error.statusCode || 502;
      console.error(`[${new Date().toISOString()}] peak_detection.error`, { status, message: error.message });
      return sendJson(res, status, { error: status === 502 ? 'Peak detector unavailable' : error.message });
    }
  }
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
    const normalizedPayload = normalizeAnalysisPayload(payload);
    log('analysis.start', {
      confirmedPeaks: normalizedPayload.confirmedPeaks.length,
      observations: normalizedPayload.peakObservations.length,
      groups: normalizedPayload.peakGroups.length,
      files: normalizedPayload.spectra?.length || normalizedPayload.spectrum?.files?.length || 0,
    });
    const references = await loadReferences();
    const result = await callProvider(normalizedPayload, references);
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
