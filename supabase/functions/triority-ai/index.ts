const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
const ALLOWED_TOOL_NAMES = new Set([
  'route_triority_input',
  'parse_grocery_items',
  'assign_grocery_categories',
  'capture_widget_tasks',
]);
const SECRET_NAME = 'gemini_api_key';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-triority-app-version, x-triority-install-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type JsonObject = Record<string, unknown>;

function jsonResponse(body: JsonObject, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function envNumber(name: string, fallback: number) {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function serviceRoleKey() {
  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS') || '';
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw);
      if (typeof parsed?.default === 'string') return parsed.default;
    } catch {}
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    || Deno.env.get('SUPABASE_SECRET_KEY')
    || '';
}

function geminiJsonSchema(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}

function geminiLegacySchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiLegacySchema);
  if (!schema || typeof schema !== 'object') return schema;
  const source = schema as JsonObject;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && typeof value === 'string') {
      out[key] = value.toUpperCase();
    } else if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const properties: JsonObject = {};
      for (const [propKey, propValue] of Object.entries(value as JsonObject)) {
        properties[propKey] = geminiLegacySchema(propValue);
      }
      out[key] = properties;
      if (!source.propertyOrdering) out.propertyOrdering = Object.keys(properties);
    } else {
      out[key] = geminiLegacySchema(value);
    }
  }
  return out;
}

async function configuredGeminiKey() {
  const envKey = Deno.env.get('GEMINI_API_KEY') || '';
  if (envKey.trim()) return envKey.trim();

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = serviceRoleKey();
  if (!supabaseUrl || !serviceKey) return '';
  const params = new URLSearchParams({
    select: 'secret_value',
    name: `eq.${SECRET_NAME}`,
    limit: '1',
  });
  const resp = await fetch(`${supabaseUrl}/rest/v1/tri_ai_server_secrets?${params.toString()}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });
  if (!resp.ok) return '';
  const rows = await resp.json().catch(() => []);
  const value = Array.isArray(rows) ? rows[0]?.secret_value : '';
  return typeof value === 'string' ? value.trim() : '';
}

function safeText(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function assertPlainObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  return value as JsonObject;
}

function clientIp(req: Request) {
  const forwarded = req.headers.get('x-forwarded-for') || '';
  const first = forwarded.split(',')[0]?.trim();
  return first || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unknown';
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function recentCount(scope: string, subjectHash: string, sinceIso: string, limit: number, supabaseUrl: string, serviceKey: string) {
  const params = new URLSearchParams({
    select: 'id',
    scope: `eq.${scope}`,
    subject_hash: `eq.${subjectHash}`,
    created_at: `gte.${sinceIso}`,
    limit: String(limit),
  });
  const resp = await fetch(`${supabaseUrl}/rest/v1/tri_ai_usage_events?${params.toString()}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });
  if (!resp.ok) throw new Error('AI rate check failed.');
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function insertUsageEvents(events: JsonObject[], supabaseUrl: string, serviceKey: string) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/tri_ai_usage_events`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(events),
  });
  if (!resp.ok) throw new Error('AI usage recording failed.');
}

async function cleanupOldEvents(supabaseUrl: string, serviceKey: string) {
  if (Math.random() > 0.02) return;
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({ created_at: `lt.${cutoff}` });
  fetch(`${supabaseUrl}/rest/v1/tri_ai_usage_events?${params.toString()}`, {
    method: 'DELETE',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  }).catch(() => {});
}

async function enforceRateLimit(req: Request) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = serviceRoleKey();
  if (!supabaseUrl || !serviceKey) throw new Error('AI rate limiting is not configured.');

  const windowMs = envNumber('TRIORITY_AI_RATE_WINDOW_MS', 15 * 60 * 1000);
  const installLimit = envNumber('TRIORITY_AI_INSTALL_LIMIT', 40);
  const ipLimit = envNumber('TRIORITY_AI_IP_LIMIT', 160);
  const globalLimit = envNumber('TRIORITY_AI_GLOBAL_LIMIT', 1200);
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const pepper = Deno.env.get('TRIORITY_AI_RATE_SECRET') || serviceKey;

  const installId = safeText(req.headers.get('x-triority-install-id'), 120) || 'missing';
  const ip = clientIp(req);
  const installHash = await sha256(`install:${installId}:${pepper}`);
  const ipHash = await sha256(`ip:${ip}:${pepper}`);
  const globalHash = await sha256(`global:triority:${pepper}`);

  const [installCount, ipCount, globalCount] = await Promise.all([
    recentCount('install', installHash, sinceIso, installLimit + 1, supabaseUrl, serviceKey),
    recentCount('ip', ipHash, sinceIso, ipLimit + 1, supabaseUrl, serviceKey),
    recentCount('global', globalHash, sinceIso, globalLimit + 1, supabaseUrl, serviceKey),
  ]);

  if (installCount >= installLimit || ipCount >= ipLimit || globalCount >= globalLimit) {
    return false;
  }

  await insertUsageEvents([
    { scope: 'install', subject_hash: installHash },
    { scope: 'ip', subject_hash: ipHash },
    { scope: 'global', subject_hash: globalHash },
  ], supabaseUrl, serviceKey);
  cleanupOldEvents(supabaseUrl, serviceKey).catch(() => {});
  return true;
}

function parseAiJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty AI response.');
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error('AI response was not valid JSON.');
  }
}

function geminiTextFromResponse(data: JsonObject) {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const parts = candidates
    .flatMap((candidate: any) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
    .map((part: any) => typeof part?.text === 'string' ? part.text : '')
    .filter(Boolean);
  const text = parts.join('\n').trim();
  if (text) return text;
  const finishReason = candidates.map((candidate: any) => candidate?.finishReason).filter(Boolean).join(', ');
  throw new Error(finishReason ? `Gemini returned no text (${finishReason}).` : 'Gemini returned no text.');
}

function payloadFromJson(value: unknown, toolName: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as JsonObject;
  const nestedKeys = [toolName, 'args', 'result', 'output', 'data'];
  for (const key of nestedKeys) {
    if (obj[key] && typeof obj[key] === 'object') return payloadFromJson(obj[key], toolName);
  }
  return obj;
}

function outputMatchesSchema(value: unknown, schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return true;
  const schemaObj = schema as JsonObject;
  const type = typeof schemaObj.type === 'string' ? schemaObj.type.toLowerCase() : '';

  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const obj = value as JsonObject;
    const required = Array.isArray(schemaObj.required) ? schemaObj.required.filter((item): item is string => typeof item === 'string') : [];
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(obj, key))) return false;
    const properties = schemaObj.properties && typeof schemaObj.properties === 'object' && !Array.isArray(schemaObj.properties)
      ? schemaObj.properties as JsonObject
      : {};
    return required.every((key) => outputMatchesSchema(obj[key], properties[key]));
  }

  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    const itemSchema = (schemaObj as JsonObject).items;
    return value.slice(0, 12).every((item) => outputMatchesSchema(item, itemSchema));
  }

  if (type === 'string') return typeof value === 'string';
  if (type === 'number' || type === 'integer') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

function serverRouteGuardrail(toolName: string) {
  if (toolName !== 'route_triority_input' && toolName !== 'capture_widget_tasks') return '';
  return `Server routing override:
- Split mixed captures into ownership spans before writing JSON. A task row owns only the direct action/event clause; grocery/material rows own item nouns.
- Do not duplicate the same user phrase as both a task and grocery/material row. If an item appears in grocery/material output, do not append that item name to task text.
- A direct action with a person/object plus date/time remains one task; a trailing run of buyable grocery/material nouns after it becomes grocery/material rows, even without "buy/get" wording.
- Grocery/material nouns are open-ended household, medical, hardware, office, project, and food items. Do not depend on a fixed grocery vocabulary.
- For task list routing, use WORKSPACE list names, samples, Personal Context, and domain/model/device/project terms. Exact list names are not required when the task clearly matches a list's context.`;
}

async function requestGemini(system: string, user: string, maxTokens: number, schema: unknown, toolName: string, apiKey: string) {
  const jsonSchema = geminiJsonSchema(schema);
  const legacySchema = geminiLegacySchema(schema);
  const schemaText = JSON.stringify(jsonSchema);
  const shapeInstruction = `Return ONLY a valid JSON object matching this exact top-level shape. No markdown, no explanation, no wrapper key:\n${schemaText}`;
  const guardedSystem = [system, serverRouteGuardrail(toolName)].filter(Boolean).join('\n\n');
  const outputTokens = Math.min(8192, Math.max(4096, maxTokens * 4, maxTokens + 3000));
  const base = {
    systemInstruction: { parts: [{ text: `${guardedSystem}\n\n${shapeInstruction}` }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
  };
  const requests = [
    {
      ...base,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: outputTokens,
        responseMimeType: 'application/json',
      },
    },
    {
      ...base,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: outputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: jsonSchema,
      },
    },
    {
      ...base,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: outputTokens,
        responseMimeType: 'application/json',
        responseSchema: legacySchema,
      },
    },
    {
      ...base,
      contents: [{
        role: 'user',
        parts: [{ text: `${user}\n\nReturn only valid JSON matching this schema:\n${schemaText}` }],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: outputTokens,
        responseMimeType: 'application/json',
      },
    },
  ];

  let lastError: unknown = null;
  for (const body of requests) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resp = await fetch(GEMINI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({ error: { message: resp.statusText || 'Gemini request failed.' } }));
      if (resp.ok) {
        try {
          const parsed = payloadFromJson(parseAiJson(geminiTextFromResponse(data)), toolName);
          if (!outputMatchesSchema(parsed, schema)) throw new Error('Gemini response did not match schema.');
          return parsed;
        } catch (error) {
          lastError = error;
          break;
        }
      }
      lastError = data;
      if (![429, 500, 502, 503, 504].includes(resp.status)) break;
      await new Promise((resolve) => setTimeout(resolve, [700, 1500, 3000][attempt] || 3000));
    }
  }
  const message = typeof (lastError as any)?.error?.message === 'string'
    ? (lastError as any).error.message
    : 'Gemini request failed.';
  throw new Error(message);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: { message: 'Method not allowed.' } }, 405);

  try {
    const apiKey = await configuredGeminiKey();
    if (!apiKey) return jsonResponse({ error: { message: 'Built-in AI is not configured.' } }, 503);

    const rateOk = await enforceRateLimit(req);
    if (!rateOk) return jsonResponse({ error: { message: 'Built-in AI is busy. Try again later.' } }, 429);

    const body = assertPlainObject(await req.json());
    const toolName = safeText(body.toolName, 80);
    if (!ALLOWED_TOOL_NAMES.has(toolName)) {
      return jsonResponse({ error: { message: 'Unsupported AI tool.' } }, 400);
    }

    const system = safeText(body.system, 14000);
    const user = safeText(body.user, 8000);
    const maxTokensRaw = Number(body.maxTokens);
    const maxTokens = Number.isFinite(maxTokensRaw) ? Math.max(200, Math.min(1200, Math.floor(maxTokensRaw))) : 800;
    const schema = body.schema;
    if (!system || !user || !schema || typeof schema !== 'object') {
      return jsonResponse({ error: { message: 'Missing AI request fields.' } }, 400);
    }

    const output = await requestGemini(system, user, maxTokens, schema, toolName, apiKey);
    return jsonResponse({ output });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Built-in AI request failed.';
    return jsonResponse({ error: { message } }, 500);
  }
});
