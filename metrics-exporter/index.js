

const http = require('http');
const client = require('prom-client');
const { parse } = require('flatted');

const N8N_BASE = process.env.N8N_BASE_URL || 'http://n8n:5678';
const OWNER_EMAIL = process.env.N8N_OWNER_EMAIL || 'admin@localhost.local';
const OWNER_PASSWORD = process.env.N8N_OWNER_PASSWORD || 'ChangeMe123456!';
const POLL_INTERVAL_MS = Number(process.env.EXPORTER_POLL_INTERVAL_SECONDS || 15) * 1000;
const EXPORTER_PORT = Number(process.env.EXPORTER_PORT || 9464);

const PRICE_PROMPT_PER_1M = Number(process.env.AI_PRICE_PROMPT_PER_1M_USD || 0.10);
const PRICE_COMPLETION_PER_1M = Number(process.env.AI_PRICE_COMPLETION_PER_1M_USD || 0.40);

const WORKFLOWS = [
  { id: 'training-platform-chatbot-v2', kind: 'trunk', role: null },
  { id: 'chatbot-sales-agent', kind: 'sub', role: 'Sales' },
  { id: 'chatbot-manager-agent', kind: 'sub', role: 'Manager' },
  { id: 'chatbot-instructor-agent', kind: 'sub', role: 'Instructor' },
  { id: 'chatbot-superadmin-agent', kind: 'sub', role: 'SuperAdmin' },
];

function log(msg) {
  console.log(`[exporter] ${msg}`);
}

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'chatbot_exporter_process_' });

const requestsTotal = new client.Counter({
  name: 'chatbot_requests_total',
  help: 'Trunk workflow executions, by how the request was resolved.',
  labelNames: ['outcome'],
  registers: [register],
});

const executionDuration = new client.Histogram({
  name: 'chatbot_execution_duration_seconds',
  help: 'Execution duration of a workflow (the trunk, or one role sub-workflow).',
  labelNames: ['workflow'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40],
  registers: [register],
});

const tokensTotal = new client.Counter({
  name: 'chatbot_tokens_total',
  help: 'Chat model tokens used, by type (prompt/completion) and role.',
  labelNames: ['type', 'role'],
  registers: [register],
});

const costTotal = new client.Counter({
  name: 'chatbot_cost_usd_total',
  help: 'Estimated USD cost of model usage, by role - see AI_PRICE_*_PER_1M_USD; this is an estimate, not a billed figure.',
  labelNames: ['role'],
  registers: [register],
});

const modelCallsTotal = new client.Counter({
  name: 'chatbot_model_calls_total',
  help: 'Number of Chat Model node invocations, by role.',
  labelNames: ['role'],
  registers: [register],
});

const modelCallDuration = new client.Histogram({
  name: 'chatbot_model_call_duration_seconds',
  help: 'Duration of a single Chat Model node invocation, by role.',
  labelNames: ['role'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32],
  registers: [register],
});

const toolCallsTotal = new client.Counter({
  name: 'chatbot_tool_calls_total',
  help: 'Tool node invocations, by tool name and outcome (success/error).',
  labelNames: ['tool', 'status'],
  registers: [register],
});

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, N8N_BASE);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (cookie) headers['Cookie'] = cookie;
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) {  }
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, json, raw: data, cookie: setCookie ? setCookie[0].split(';')[0] : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let sessionCookie = null;

async function login() {
  const res = await request('POST', '/rest/login', { emailOrLdapLoginId: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (res.status !== 200 || !res.cookie) throw new Error(`login failed: status=${res.status} body=${res.raw}`);
  sessionCookie = res.cookie;
}

async function apiGet(path) {
  let res = await request('GET', path, null, sessionCookie);
  if (res.status === 401) {
    await login();
    res = await request('GET', path, null, sessionCookie);
  }
  return res;
}

const nodeTypeCache = new Map(); 
let nodeTypeCacheLoadedAt = 0;
const NODE_TYPE_CACHE_TTL_MS = 5 * 60 * 1000;

async function refreshNodeTypes() {
  
  
  
  
  
  
  let allResolved = true;
  for (const wf of WORKFLOWS) {
    const res = await apiGet(`/rest/workflows/${wf.id}`);
    if (res.status !== 200 || !res.json || !res.json.data) {
      log(`could not fetch workflow ${wf.id} (status ${res.status}) - will retry next cycle.`);
      allResolved = false;
      continue;
    }
    const map = new Map();
    for (const n of res.json.data.nodes) map.set(n.name, n.type);
    nodeTypeCache.set(wf.id, map);
  }
  if (allResolved) nodeTypeCacheLoadedAt = Date.now();
}

function isChatModelType(type) {
  return typeof type === 'string' && type.startsWith('@n8n/n8n-nodes-langchain.lmChat');
}
function isToolType(type) {
  return type === '@n8n/n8n-nodes-langchain.toolHttpRequest' || type === '@n8n/n8n-nodes-langchain.mcpClientTool';
}

function estimateCostUsd(promptTokens, completionTokens) {
  return (promptTokens / 1_000_000) * PRICE_PROMPT_PER_1M + (completionTokens / 1_000_000) * PRICE_COMPLETION_PER_1M;
}

const TRUNK_OUTCOME_NODES = [
  ['Respond 401 - Unauthorized', 'unauthorized'],
  ['Respond 429 - Too Many Requests', 'rate_limited'],
  ['Respond 200 - Guardrail Refusal', 'guardrail_blocked'],
  ['Respond 200 - Cached Reply (0 tokens)', 'cache_hit'],
  ["Respond 403 - Role Not Recognized", 'role_not_recognized'],
  ['Respond 200 - Success', 'success'],
];

function processTrunkExecution(rd) {
  const ranNodes = new Set(Object.keys(rd.runData));
  let outcome = 'unknown';
  for (const [nodeName, label] of TRUNK_OUTCOME_NODES) {
    if (ranNodes.has(nodeName)) { outcome = label; break; }
  }
  requestsTotal.inc({ outcome });
}

function processSubWorkflowExecution(rd, role, workflowId) {
  const typeMap = nodeTypeCache.get(workflowId) || new Map();

  for (const [nodeName, runs] of Object.entries(rd.runData)) {
    const nodeType = typeMap.get(nodeName);

    if (isChatModelType(nodeType)) {
      for (const run of runs) {
        modelCallsTotal.inc({ role });
        if (typeof run.executionTime === 'number') {
          modelCallDuration.observe({ role }, run.executionTime / 1000);
        }
        try {
          const out = run.data.ai_languageModel[0][0].json;
          const usage = out.tokenUsage || {};
          const prompt = usage.promptTokens || 0;
          const completion = usage.completionTokens || 0;
          if (prompt) tokensTotal.inc({ type: 'prompt', role }, prompt);
          if (completion) tokensTotal.inc({ type: 'completion', role }, completion);
          if (prompt || completion) costTotal.inc({ role }, estimateCostUsd(prompt, completion));
        } catch (e) {  }
      }
      continue;
    }

    if (isToolType(nodeType)) {
      for (const run of runs) {
        toolCallsTotal.inc({ tool: nodeName, status: run.executionStatus === 'error' ? 'error' : 'success' });
      }
    }
  }
}

const lastSeenId = new Map(); 

async function processExecution(wf, execId) {
  const res = await apiGet(`/rest/executions/${execId}?includeData=true`);
  if (res.status !== 200 || !res.json || !res.json.data) return;
  const execMeta = res.json.data;
  if (typeof execMeta.data !== 'string') return;

  let rd;
  try {
    rd = parse(execMeta.data).resultData;
  } catch (e) {
    return;
  }
  if (!rd || !rd.runData) return;

  if (execMeta.startedAt && execMeta.stoppedAt) {
    const seconds = (new Date(execMeta.stoppedAt) - new Date(execMeta.startedAt)) / 1000;
    executionDuration.observe({ workflow: wf.kind === 'trunk' ? 'trunk' : wf.role }, seconds);
  }

  if (wf.kind === 'trunk') {
    processTrunkExecution(rd);
  } else {
    processSubWorkflowExecution(rd, wf.role, wf.id);
  }
}

async function pollWorkflow(wf) {
  const filter = encodeURIComponent(JSON.stringify({ workflowId: wf.id }));
  const res = await apiGet(`/rest/executions?filter=${filter}&limit=20`);
  if (res.status !== 200 || !res.json) return;
  const items = (res.json.data && res.json.data.results) || res.json.results || res.json.data || [];
  const seen = lastSeenId.get(wf.id) || 0;
  const fresh = items
    .filter((i) => Number(i.id) > seen && (i.status === 'success' || i.status === 'error'))
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const item of fresh) {
    try {
      await processExecution(wf, item.id);
    } catch (e) {
      console.error(`[exporter] failed to process execution ${item.id} (${wf.id}):`, e.message);
    }
    lastSeenId.set(wf.id, Math.max(lastSeenId.get(wf.id) || 0, Number(item.id)));
  }
}

async function pollAll() {
  if (!sessionCookie) await login();
  if (!nodeTypeCacheLoadedAt || Date.now() - nodeTypeCacheLoadedAt > NODE_TYPE_CACHE_TTL_MS) {
    await refreshNodeTypes();
  }
  for (const wf of WORKFLOWS) {
    try {
      await pollWorkflow(wf);
    } catch (e) {
      console.error(`[exporter] poll failed for ${wf.id}:`, e.message);
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': register.contentType });
    res.end(await register.metrics());
    return;
  }
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

async function main() {
  log(`starting, n8n base: ${N8N_BASE}`);
  
  
  for (let i = 0; i < 60; i++) {
    try {
      await login();
      log('logged in.');
      break;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await refreshNodeTypes();
  server.listen(EXPORTER_PORT, () => log(`listening on :${EXPORTER_PORT} (/metrics, /healthz)`));
  setInterval(() => { pollAll().catch((e) => console.error('[exporter] poll cycle failed:', e.message)); }, POLL_INTERVAL_MS);
  pollAll().catch((e) => console.error('[exporter] initial poll failed:', e.message));
}

main();
