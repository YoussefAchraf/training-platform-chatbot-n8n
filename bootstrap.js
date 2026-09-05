

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

const BASE = 'http://127.0.0.1:5678';
const OWNER_EMAIL = process.env.N8N_OWNER_EMAIL || 'admin@localhost.local';
const OWNER_PASSWORD = process.env.N8N_OWNER_PASSWORD || 'ChangeMe123456!';
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1';

const WORKFLOWS = [
  { id: 'chatbot-sales-agent', path: '/home/node/sub-workflow-sales.n8n.json' },
  { id: 'chatbot-manager-agent', path: '/home/node/sub-workflow-manager.n8n.json' },
  { id: 'chatbot-instructor-agent', path: '/home/node/sub-workflow-instructor.n8n.json' },
  { id: 'chatbot-superadmin-agent', path: '/home/node/sub-workflow-superadmin.n8n.json' },
  { id: 'chatbot-developer-agent', path: '/home/node/sub-workflow-developer.n8n.json' },
  { id: 'training-platform-chatbot-v2', path: '/home/node/training-platform-chatbot.n8n.json' },
];

function log(msg) {
  console.log(`[bootstrap] ${msg}`);
}

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (cookie) headers['Cookie'] = cookie;

    const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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

async function waitForReady() {
  
  
  
  
  
  
  
  log('Waiting for n8n to become ready...');
  for (let i = 0; i < 120; i++) {
    try {
      const res = await request('GET', '/healthz');
      if (res.status === 200) break;
    } catch (e) {  }
    await new Promise((r) => setTimeout(r, 1000));
  }

  log('Waiting for the REST API (post-migration) to respond...');
  for (let i = 0; i < 120; i++) {
    try {
      
      
      const res = await request('POST', '/rest/login', { emailOrLdapLoginId: 'probe', password: 'probe' });
      if (res.json !== null) { log('n8n is ready.'); return; }
    } catch (e) {  }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('n8n did not become ready in time');
}

async function ensureOwnerAndLogin() {
  log('Ensuring owner account exists...');
  const setup = await request('POST', '/rest/owner/setup', {
    email: OWNER_EMAIL, firstName: 'Admin', lastName: 'User', password: OWNER_PASSWORD,
  });
  if (setup.status === 200) {
    log('Owner account created.');
  } else {
    log(`Owner setup returned ${setup.status} (expected "already setup" on every restart after the first) - continuing.`);
  }

  log('Logging in...');
  let login;
  for (let i = 0; i < 10; i++) {
    login = await request('POST', '/rest/login', {
      emailOrLdapLoginId: OWNER_EMAIL, password: OWNER_PASSWORD,
    });
    if (login.status === 200 && login.cookie) return login.cookie;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Login failed after retries: status=${login.status} body=${login.raw}`);
}

function importCredentials(name, entries) {
  const tmpPath = `/tmp/${name}.json`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries));
  execSync(`n8n import:credentials --input=${tmpPath}`, { stdio: 'inherit' });
}

function importWorkflow(wfPath) {
  execSync(`n8n import:workflow --input=${wfPath}`, { stdio: 'inherit' });
}

async function requestWithRetry(method, path, body, cookie, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await request(method, path, body, cookie);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function ensureActive(workflowId, cookie) {
  const current = await requestWithRetry('GET', `/rest/workflows/${workflowId}`, null, cookie);
  if (current.status !== 200 || !current.json) {
    throw new Error(`Could not fetch workflow after import: status=${current.status} body=${current.raw}`);
  }
  if (current.json.data.active) {
    log(`${workflowId}: already active.`);
    return;
  }
  const versionId = current.json.data.versionId;
  const activate = await requestWithRetry('POST', `/rest/workflows/${workflowId}/activate`, { versionId }, cookie);
  if (activate.status !== 200) {
    throw new Error(`Activation failed: status=${activate.status} body=${activate.raw}`);
  }
  log(`${workflowId}: activated.`);
}

async function main() {
  await waitForReady();
  const cookie = await ensureOwnerAndLogin();

  log('Importing Redis credential...');
  importCredentials('redis-cred', [{
    id: 'redis-credential-auto',
    name: 'Redis account',
    type: 'redis',
    data: { host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD, user: '', database: 0, ssl: false },
  }]);

  if (AI_API_KEY) {
    log(`AI_API_KEY is set - importing AI provider credential (base URL: ${AI_BASE_URL})...`);
    importCredentials('ai-cred', [{
      id: 'kodekloud-credential-auto',
      name: 'KodeKloud AI Proxy account',
      type: 'openAiApi',
      data: { apiKey: AI_API_KEY, url: AI_BASE_URL },
    }]);
  } else {
    log('AI_API_KEY is empty - skipping AI provider credential import.');
    log('  Set it in .env and run: docker compose up -d --force-recreate n8n');
    log('  The workflow will still import/activate, but the Chat Model node will fail at runtime until then.');
  }

  log(`Importing ${WORKFLOWS.length} workflows (5 role sub-workflows + the trunk)...`);
  for (const { path: wfPath } of WORKFLOWS) {
    importWorkflow(wfPath);
  }

  log('Activating workflows...');
  for (const { id } of WORKFLOWS) {
    try {
      await ensureActive(id, cookie);
    } catch (err) {
      
      
      
      
      
      
      
      log(`${id}: activation failed (${err.message}) - continuing.`);
    }
  }

  console.log('');
  console.log('==================================================================');
  console.log('[bootstrap] Ready.');
  console.log(`  Editor:  http://localhost:5678  (login: ${OWNER_EMAIL})`);
  console.log('  Webhook: POST http://localhost:5678/webhook/chatbot/message');
  if (!AI_API_KEY) {
    console.log('  NOTE: AI_API_KEY is not set - the Chat Model node will error');
    console.log('        at runtime until you set it and recreate the n8n container.');
  }
  console.log('==================================================================');
  console.log('');
}

main().catch((err) => {
  console.error('[bootstrap] FAILED:', err.message);
  
  
  
  
  
  process.exit(0);
});
