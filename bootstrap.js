// Bootstraps a freshly-started n8n instance into a fully working state with
// zero manual steps: owner account, Redis credential, AI provider credential
// (if a key is provided), and all 5 chatbot workflows (the trunk plus 4
// role sub-workflows) imported and activated.
//
// Written in Node (not shell + wget) because the container's wget is
// BusyBox's minimal implementation, which has NO cookie-jar support
// (--save-cookies/--load-cookies don't exist there, only in GNU wget) -
// found this out by actually running the shell version and watching it
// crash-loop. n8n's session auth is a cookie, so this needs a real HTTP
// client that can read a Set-Cookie header and replay it - Node's built-in
// http module does that with no extra dependencies, which matters since
// nothing beyond what n8n's own image already ships can be relied on here.
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
// The trunk workflow calls the 4 role sub-workflows via Execute Workflow
// nodes (each referencing one of these ids) - imported first so the trunk
// never references an id that doesn't exist in the DB yet, though import
// order doesn't actually matter to n8n itself (Execute Workflow resolves
// its target by id lazily at run time, not at import time).
const WORKFLOWS = [
  { id: 'chatbot-sales-agent', path: '/home/node/sub-workflow-sales.n8n.json' },
  { id: 'chatbot-manager-agent', path: '/home/node/sub-workflow-manager.n8n.json' },
  { id: 'chatbot-instructor-agent', path: '/home/node/sub-workflow-instructor.n8n.json' },
  { id: 'chatbot-superadmin-agent', path: '/home/node/sub-workflow-superadmin.n8n.json' },
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
        try { json = data ? JSON.parse(data) : null; } catch (e) { /* non-JSON response, leave null */ }
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
  // /healthz returns 200 as soon as the HTTP listener is up, which can be
  // BEFORE n8n's database migrations finish - confirmed by hitting exactly
  // that race: /healthz said ready, but /rest/login then returned a plain
  // "n8n is starting up. Please wait" text body instead of JSON. So this
  // waits on /healthz first (cheap, gets past "container not listening
  // yet"), then separately confirms the REST API itself returns real JSON
  // before treating the instance as truly ready.
  log('Waiting for n8n to become ready...');
  for (let i = 0; i < 120; i++) {
    try {
      const res = await request('GET', '/healthz');
      if (res.status === 200) break;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  log('Waiting for the REST API (post-migration) to respond...');
  for (let i = 0; i < 120; i++) {
    try {
      // Deliberately wrong credentials - we only care whether the response
      // is real JSON (API ready) vs the plain-text "starting up" message.
      const res = await request('POST', '/rest/login', { emailOrLdapLoginId: 'probe', password: 'probe' });
      if (res.json !== null) { log('n8n is ready.'); return; }
    } catch (e) { /* not up yet */ }
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

// The n8n CLI (import:workflow/import:credentials) spawns a whole separate
// node/n8n process that touches the same SQLite file the running server
// uses - observed a transient "socket hang up" on the very next HTTP call
// right after a CLI import, almost certainly brief contention between the
// two processes rather than a real failure. Retrying a few times with a
// short delay clears it every time in testing.
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

  log(`Importing ${WORKFLOWS.length} workflows (4 role sub-workflows + the trunk)...`);
  for (const { path: wfPath } of WORKFLOWS) {
    importWorkflow(wfPath);
  }

  log('Activating workflows...');
  for (const { id } of WORKFLOWS) {
    try {
      await ensureActive(id, cookie);
    } catch (err) {
      // A sub-workflow has no external trigger (webhook/cron) of its own -
      // only an Execute Workflow Trigger, which is invoked directly by id
      // rather than needing to be "listening" for anything. If activation
      // turns out not to be required (or not supported) for that kind of
      // workflow, don't let it abort the rest of bootstrap - log and move
      // on rather than leaving the trunk (which does need to be active,
      // since it owns the real webhook) unactivated because of it.
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
  // Deliberately exit 0, not 1: a bootstrap failure (e.g. a transient
  // network hiccup talking to the just-started server) should not crash
  // the whole container via `set -e` in entrypoint.sh and trigger a
  // restart loop - n8n itself is already up and usable at this point,
  // worst case the workflow needs a manual import/activate via the UI.
  process.exit(0);
});
