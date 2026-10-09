'use strict';

/**
 * Render Fleet Registry v2 — الموقع الوسيط
 *
 * orchestrate أي عدد من حسابات Render من نقطة واحدة.
 *
 *  • STATELESS لحالة Render: الخدمات/الدومينات/الحالة تُقرأ من Render API مباشرة.
 *  • METADATA ثابتة (نبذة، فئة، روابط، ملاحظات) تُخزَّن في GitHub repo
 *    عبر GitHub API — لأن Free tier filesystem مؤقت.
 *  • CONFIG ثابت (استراتيجية التوزيع، الحدود، التحذيرات) في نفس الملف.
 *  • المفاتيح تأتي من env vars (لا تُكتب في GitHub أبداً).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const REGISTRY_KEY = process.env.REGISTRY_API_KEY;
const RENDER_BASE = 'https://api.render.com/v1';
const GH_BASE = 'https://api.github.com';

// GitHub-backed storage -----------------------------------------------
const GH_TOKEN = process.env.FLEET_GH_TOKEN || process.env.GITHUB_TOKEN;
const GH_REPO = process.env.FLEET_GH_REPO || 'immmh5/render-fleet-registry';
const GH_FILE = process.env.FLEET_GH_FILE || 'fleet-data.json';
const GH_BRANCH = process.env.FLEET_GH_BRANCH || 'main';

const DEFAULT_PLAN = 'hobby'; // Render free/hobby plan

// قيود خطة hobby الافتراضية (قابلة للتعديل عبر config)
const DEFAULT_LIMITS = {
  customDomainsPerAccount: 2,
  maxServicesPerAccount: 2, // استراتيجية "موقعان لكل حساب" بشكل افتراضي
  bandwidthGbPerMonth: 5,
};

// استراتيجيات التوزيع
const STRATEGIES = ['one_per_account', 'two_per_account', 'load_balanced', 'auto'];

if (!REGISTRY_KEY) {
  console.error('\n[FATAL] REGISTRY_API_KEY not set — cannot start.\n');
  process.exit(1);
}

/* ================================================================== *
 *  Accounts — from env only (secrets never touch GitHub)
 * ================================================================== */

function loadAccounts() {
  const accounts = [];
  for (let i = 1; i <= 50; i++) {
    const key = process.env[`RENDER_ACCOUNT_${i}_KEY`];
    if (!key) continue;
    const name = process.env[`RENDER_ACCOUNT_${i}_NAME`] || `account-${i}`;
    accounts.push({ idx: i, name, key });
  }
  return accounts;
}

const ACCOUNTS = loadAccounts();
if (!ACCOUNTS.length) {
  console.error('\n[FATAL] No RENDER_ACCOUNT_*_KEY env vars set.\n');
  process.exit(1);
}

const REGISTRY_ACCT_IDX = (() => {
  const v = parseInt(process.env.REGISTRY_ACCOUNT_IDX || '1', 10);
  return Number.isFinite(v) && ACCOUNTS.some(a => a.idx === v) ? v : ACCOUNTS[0].idx;
})();

console.log(`[render-fleet] accounts: ${ACCOUNTS.map(a => a.name).join(', ')}`);
console.log(`[render-fleet] registry (leader) account idx=${REGISTRY_ACCT_IDX} (${ACCOUNTS.find(a => a.idx === REGISTRY_ACCT_IDX).name})`);
if (GH_TOKEN) console.log(`[render-fleet] metadata store: github ${GH_REPO}:${GH_FILE}`);
else console.log('[render-fleet] WARNING: no FLEET_GH_TOKEN — metadata disabled (in-memory only)');

/* ================================================================== *
 *  Store — GitHub-backed persistent JSON (with in-memory fallback)
 * ================================================================== */

let mem = null;           // الذاكرة المؤقتة
let memDirty = false;

const DEFAULT_STORE = () => ({
  version: 2,
  updatedAt: null,
  config: {
    strategy: 'auto',
    limits: { ...DEFAULT_LIMITS },
    warnAtBandwidthPct: 80,  // حذّر عند هذا النسبة من 5GB
    warnAtDomainsFree: 0,    // حذّر عند هذا العدد المتبقي من الدومينات
    placementNotes: [],
  },
  projects: {}, // serviceId -> { title, description, category, repo, branch, note, tags, createdAt, ownerId }
  accounts: {}, // idx -> { email, owner, plan, note, createdAt }
});

async function ghFetch(p, opts = {}) {
  const res = await fetch(`${GH_BASE}${p}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

/** اقرأ الـ store (GitHub أولاً، ثم الذاكرة، ثم الافتراضي). */
async function readStore() {
  if (GH_TOKEN) {
    try {
      const r = await ghFetch(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${GH_BRANCH}`);
      if (r.status === 200 && r.body && r.body.content) {
        const raw = Buffer.from(r.body.content, 'base64').toString('utf8');
        const parsed = JSON.parse(raw);
        mem = deepMerge(DEFAULT_STORE(), parsed);
        memDirty = false;
        return mem;
      }
    } catch (e) {
      console.error('[store] read failed, using memory:', e.message);
    }
  }
  if (!mem) mem = DEFAULT_STORE();
  return mem;
}

/** اكتب الـ store كله إلى GitHub (create or update). */
async function writeStore(data) {
  mem = data;
  memDirty = true;
  if (!GH_TOKEN) return { saved: false, reason: 'no FLEET_GH_TOKEN' };

  data.updatedAt = new Date().toISOString();
  const content = JSON.stringify(data, null, 2);

  // احصل على sha الحالي (create vs update)
  const cur = await ghFetch(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${GH_BRANCH}`);
  const sha = (cur.status === 200 && cur.body && cur.body.sha) ? cur.body.sha : undefined;

  const r = await ghFetch(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}`, {
    method: 'PUT',
    body: {
      message: `fleet-data: update by registry ${new Date().toISOString()}`,
      content: Buffer.from(content).toString('base64'),
      branch: GH_BRANCH,
      ...(sha ? { sha } : {}),
    },
  });
  if (r.status === 200 || r.status === 201) {
    memDirty = false;
    return { saved: true, sha: r.body && r.body.content ? r.body.content.sha : undefined };
  }
  return { saved: false, reason: `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}` };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over === undefined ? base : over;
  if (typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] === undefined) continue;
    out[k] = (typeof base[k] === 'object' && base[k] !== null && typeof over[k] === 'object')
      ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

/* ================================================================== *
 *  Render API helper
 * ================================================================== */

async function renderCall(account, urlPath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const res = await fetch(`${RENDER_BASE}${urlPath}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${account.key}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function listServices(account) {
  const services = [];
  let cursor = '', guard = 0;
  while (guard++ < 20) {
    const qs = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
    const { status, body } = await renderCall(account, `/services${qs}`);
    if (status !== 200) throw new Error(`list services for "${account.name}" (HTTP ${status}): ${JSON.stringify(body)}`);
    const rows = Array.isArray(body) ? body : (body && Array.isArray(body.services) ? body.services : []);
    services.push(...rows);
    cursor = body && body.cursor;
    if (!cursor || rows.length === 0) break;
  }
  return services;
}

async function listCustomDomains(account, serviceId) {
  const { status, body } = await renderCall(account, `/services/${serviceId}/custom-domains`);
  if (status !== 200) return [];
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.customDomains) ? body.customDomains : []);
  return rows.map(d => {
    const cd = d.customDomain || d;
    return {
      id: cd.id, domain: cd.domain,
      verificationStatus: cd.verificationStatus,
      createdAt: cd.createdAt,
    };
  });
}

/* ================================================================== *
 *  Fleet snapshot (live state from Render)
 * ================================================================== */

async function accountFleet(account) {
  const services = await listServices(account);
  const withDomains = await Promise.all(
    services.map(async (svc) => {
      let customDomains = [];
      try { customDomains = await listCustomDomains(account, svc.service.id); } catch { /* skip */ }
      return {
        id: svc.service.id,
        name: svc.service.name,
        type: svc.service.type,
        status: svc.service.status,
        suspended: svc.service.suspended,
        suspenders: svc.service.suspenders || [],
        url: svc.service.serviceDetails && svc.service.serviceDetails.url ? svc.service.serviceDetails.url : null,
        createdAt: svc.service.createdAt,
        updatedAt: svc.service.updatedAt,
        repo: svc.service.repo || (svc.service.serviceDetails && svc.service.serviceDetails.repo) || null,
        branch: svc.service.branch || (svc.service.serviceDetails && svc.service.serviceDetails.branch) || null,
        ownerId: svc.ownerId || (svc.service.ownerId) || null,
        customDomains,
      };
    })
  );
  return {
    idx: account.idx,
    name: account.name,
    services: withDomains,
    customDomainsUsed: withDomains.reduce((n, s) => n + s.customDomains.length, 0),
    suspendedServices: withDomains.filter(s => s.suspended).length,
  };
}

async function apiFleet(store) {
  const limits = { ...DEFAULT_LIMITS, ...((store && store.config && store.config.limits) || {}) };
  const fleets = await Promise.all(
    ACCOUNTS.map(a => accountFleet(a).catch(e => ({
      idx: a.idx, name: a.name, error: String(e.message || e), services: [],
      customDomainsUsed: 0, suspendedServices: 0,
    })))
  );
  // دمج البيانات الوصفية
  for (const acct of fleets) {
    const meta = (store && store.accounts && store.accounts[acct.idx]) || {};
    acct.email = meta.email || null;
    acct.owner = meta.owner || null;
    acct.plan = meta.plan || DEFAULT_PLAN;
    acct.note = meta.note || null;
    acct.createdAt = meta.createdAt || null;
    for (const svc of acct.services || []) {
      svc.meta = (store && store.projects && store.projects[svc.id]) || {};
    }
    // تقدير عرض النطاق: مجموع تقديرات المشاريع على الحساب
    acct.bandwidthAllocatedGb = (acct.services || [])
      .reduce((n, s) => n + (Number(s.meta.monthlyBandwidthGb) || 0), 0);
    acct.bandwidthLimitGb = limits.bandwidthGbPerMonth;
  }
  return {
    generatedAt: new Date().toISOString(),
    accountCount: ACCOUNTS.length,
    leader: REGISTRY_ACCT_IDX,
    accounts: fleets,
    totals: {
      services: fleets.reduce((n, a) => n + (a.services ? a.services.length : 0), 0),
      suspended: fleets.reduce((n, a) => n + (a.suspendedServices || 0), 0),
      customDomainsUsed: fleets.reduce((n, a) => n + (a.customDomainsUsed || 0), 0),
      customDomainsLimit: limits.customDomainsPerAccount * ACCOUNTS.length,
      bandwidthAllocatedGb: fleets.reduce((n, a) => n + (a.bandwidthAllocatedGb || 0), 0),
      bandwidthLimitGb: limits.bandwidthGbPerMonth * ACCOUNTS.length,
    },
  };
}

/* ================================================================== *
 *  Placement — decide which account hosts a new project
 * ================================================================== */

function scoreAccount(acct, config, needsDomain) {
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const free = Math.max(0, limits.customDomainsPerAccount - acct.customDomainsUsed);
  const services = acct.services ? acct.services.length : 0;
  let score = 0;
  const reasons = [];

  // الدومينات هي أندر مورد
  if (needsDomain) {
    score += free * 100;
    reasons.push(`${free} domein slot(s) free`);
    if (free === 0) reasons.push('no domain slots');
  }
  // عقوبة الخدمات المعلّقة
  score -= acct.suspendedServices * 60;
  if (acct.suspendedServices) reasons.push(`${acct.suspendedServices} suspended`);
  // عقوبة عدد الخدمات (كلما قلّ كان أفضل)
  score -= services * 10;
  reasons.push(`${services} service(s)`);
  // علامة "هذا حساب القائد" — لا تضيف مشاريع عليه أبداً
  if (acct.idx === REGISTRY_ACCT_IDX) {
    score = -100000;
    reasons.push('LEADER account — reserved for the registry itself');
  }
  return { idx: acct.idx, name: acct.name, score, reasons, free, services,
           suspendedServices: acct.suspendedServices };
}

function pickBest(fleet, config, needsDomain) {
  const ranking = fleet.accounts
    .filter(a => !a.error)
    .map(a => scoreAccount(a, config, needsDomain))
    .sort((x, y) => y.score - x.score);

  const best = ranking[0];
  if (!best || best.score <= -100000) {
    return { recommended: null, reason: 'no usable account — create a new Render account and add its key', ranking };
  }
  if (needsDomain && best.free === 0) {
    return { recommended: null, reason: 'no account has a free custom domain slot', ranking };
  }
  return { recommended: { idx: best.idx, name: best.name }, reason: best.reasons.join(' | '), ranking };
}

/* ================================================================== *
 *  Alerts
 * ================================================================== */

function computeAlerts(fleet, config) {
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const out = [];
  for (const acct of fleet.accounts) {
    if (acct.error) {
      out.push({ level: 'critical', account: acct.name, accountIdx: acct.idx,
                 code: 'acct_error', message: `API error: ${acct.error}` });
      continue;
    }
    if (acct.suspendedServices > 0) {
      out.push({ level: 'critical', account: acct.name, accountIdx: acct.idx,
                 code: 'billing_suspended',
                 message: `${acct.suspendedServices} service(s) suspended by 'billing' — workspace-wide, needs a card or month reset` });
    }
    const free = limits.customDomainsPerAccount - acct.customDomainsUsed;
    if (free <= config.warnAtDomainsFree) {
      out.push({ level: free === 0 ? 'warning' : 'info', account: acct.name, accountIdx: acct.idx,
                 code: 'domains_full',
                 message: `${acct.customDomainsUsed}/${limits.customDomainsPerAccount} custom domains used, ${free} free` });
    }
    const services = acct.services.length;
    if (services >= limits.maxServicesPerAccount) {
      out.push({ level: 'warning', account: acct.name, accountIdx: acct.idx,
                 code: 'services_full',
                 message: `${services}/${limits.maxServicesPerAccount} services — at/over the configured limit` });
    }
  }
  return out;
}

/* ================================================================== *
 *  Auth + helpers
 * ================================================================== */

function authorized(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return !!(m && m[1] && m[1] === REGISTRY_KEY);
}

function send(res, status, payload, ct = 'application/json') {
  const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': ct });
  res.end(body);
}
function sendError(res, status, message) { send(res, status, { error: message }); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function getAccount(idx) {
  const a = ACCOUNTS.find(x => String(x.idx) === String(idx));
  if (!a) throw new Error(`unknown account ${idx} (have: ${ACCOUNTS.map(x => x.idx).join(', ')})`);
  return a;
}

/* ================================================================== *
 *  Service actions
 * ================================================================== */

async function apiCreateService(account, body) {
  if (!body || typeof body !== 'object') throw new Error('JSON body required');
  const { status, body: ownersBody } = await renderCall(account, '/owners?limit=10');
  if (status !== 200 || !Array.isArray(ownersBody) || !ownersBody.length) {
    throw new Error(`could not resolve owner for "${account.name}" (HTTP ${status})`);
  }
  const owner = ownersBody[0].owner || ownersBody[0];
  const payload = Object.assign({}, body, { ownerId: owner.id });
  const res = await renderCall(account, '/services', { method: 'POST', body: payload });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`create failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function apiServiceAction(account, serviceId, action) {
  const map = {
    suspend: { method: 'POST', path: `/services/${serviceId}/suspend` },
    resume: { method: 'POST', path: `/services/${serviceId}/resume` },
  };
  const op = map[action];
  if (!op) throw new Error(`unknown action ${action}`);
  const r = await renderCall(account, op.path, { method: op.method });
  if (r.status >= 400) throw new Error(`${action} failed (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
  return r.body || { ok: true, action, serviceId };
}

/* ================================================================== *
 *  HTTP server
 * ================================================================== */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  // ---- /health (no auth) -----------------------------------------
  if (pathname === '/health' && method === 'GET') {
    return send(res, 200, { ok: true, accounts: ACCOUNTS.length,
                            leader: REGISTRY_ACCT_IDX, uptime: process.uptime(),
                            time: new Date().toISOString() });
  }

  // ---- dashboard (auth via ?key= or Bearer) ----------------------
  if ((pathname === '/' || pathname === '/index.html') && method === 'GET') {
    const h = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const q = url.searchParams.get('key');
    if (!REGISTRY_KEY || (h !== REGISTRY_KEY && q !== REGISTRY_KEY)) {
      return sendError(res, 401, 'unauthorized — pass ?key=<REGISTRY_API_KEY> or Authorization: Bearer <key>');
    }
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    } catch (e) { return sendError(res, 500, `dashboard missing: ${e.message}`); }
  }

  if (!pathname.startsWith('/api')) return sendError(res, 404, `not found: ${pathname}`);
  if (!authorized(req)) return sendError(res, 401, 'unauthorized — send Authorization: Bearer <REGISTRY_API_KEY>');

  const parts = pathname.split('/').filter(Boolean);
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : null;
  if (body === null && ['POST', 'PUT', 'PATCH'].includes(method)) return sendError(res, 400, 'invalid JSON body');

  try {
    /* ---------- /api/fleet ---------- */
    if (parts[1] === 'fleet' && method === 'GET') {
      const store = await readStore();
      const fleet = await apiFleet(store);
      return send(res, 200, { ...fleet, config: store.config });
    }

    /* ---------- /api/alerts ---------- */
    if (parts[1] === 'alerts' && method === 'GET') {
      const store = await readStore();
      const fleet = await apiFleet(store);
      return send(res, 200, { generatedAt: fleet.generatedAt, alerts: computeAlerts(fleet, store.config) });
    }

    /* ---------- /api/config ---------- */
    if (parts[1] === 'config' && method === 'GET') {
      const store = await readStore();
      return send(res, 200, { config: store.config, strategies: STRATEGIES, defaults: DEFAULT_LIMITS });
    }
    if (parts[1] === 'config' && method === 'PUT') {
      if (!body || typeof body !== 'object') throw new Error('config object required');
      const store = await readStore();
      if (body.strategy && !STRATEGIES.includes(body.strategy)) {
        throw new Error(`invalid strategy; one of ${STRATEGIES.join(', ')}`);
      }
      store.config = deepMerge(store.config, body);
      const r = await writeStore(store);
      return send(res, 200, { ok: true, config: store.config, persisted: r.saved, detail: r });
    }

    /* ---------- /api/accounts ---------- */
    if (parts[1] === 'accounts' && method === 'GET') {
      const store = await readStore();
      const fleet = await apiFleet(store);
      const limits = { ...DEFAULT_LIMITS, ...(store.config.limits || {}) };
      return send(res, 200, {
        generatedAt: fleet.generatedAt,
        leader: REGISTRY_ACCT_IDX,
        accounts: fleet.accounts.map(a => {
          const meta = store.accounts[a.idx] || {};
          return {
            idx: a.idx, name: a.name,
            isLeader: a.idx === REGISTRY_ACCT_IDX,
            email: meta.email, owner: meta.owner, plan: meta.plan || DEFAULT_PLAN,
            note: meta.note, accountCreatedAt: meta.createdAt,
            services: a.services.length,
            suspendedServices: a.suspendedServices,
            customDomainsUsed: a.customDomainsUsed,
            customDomainsFree: Math.max(0, limits.customDomainsPerAccount - a.customDomainsUsed),
            customDomainsLimit: limits.customDomainsPerAccount,
            maxServices: limits.maxServicesPerAccount,
            error: a.error || undefined,
          };
        }),
      });
    }
    // /api/accounts/:idx (PUT metadata only — the key stays in env)
    if (parts[1] === 'accounts' && parts[2] && method === 'PUT' && !parts[3]) {
      getAccount(parts[2]); // validate
      const store = await readStore();
      const cur = store.accounts[parts[2]] || {};
      store.accounts[parts[2]] = deepMerge(cur, body || {});
      const r = await writeStore(store);
      return send(res, 200, { ok: true, accountIdx: Number(parts[2]), meta: store.accounts[parts[2]], persisted: r.saved });
    }

    /* ---------- /api/suggest ---------- */
    if (parts[1] === 'suggest' && method === 'POST') {
      const input = body || {};
      const needsDomain = input.needsDomain !== false;
      const store = await readStore();
      const fleet = input.fleet || await apiFleet(store);
      return send(res, 200, pickBest(fleet, store.config, needsDomain));
    }

    /* ---------- /api/services ---------- */
    if (parts[1] === 'services' && method === 'GET' && parts[2] && !parts[3]) {
      return send(res, 200, await accountFleet(getAccount(parts[2])));
    }
    if (parts[1] === 'services' && method === 'POST' && !parts[2]) {
      const explicit = (body && (body.account || body.accountIdx)) || url.searchParams.get('account');
      let idx;
      if (explicit) {
        idx = explicit;
      } else {
        const store = await readStore();
        const fleet = await apiFleet(store);
        const needsDomain = !!(body && (body.customDomain || body.needsDomain));
        const suggestion = pickBest(fleet, store.config, needsDomain);
        if (!suggestion.recommended) return sendError(res, 409, suggestion.reason);
        idx = suggestion.recommended.idx;
      }
      delete body.account; delete body.accountIdx;
      const account = getAccount(idx);
      const created = await apiCreateService(account, body);
      // سجّل البيانات الوصفية إن أعطيت
      const sid = created && created.service ? created.service.id : (created && created.id);
      if (sid) {
        const store = await readStore();
        const now = new Date().toISOString();
        store.projects[sid] = deepMerge(store.projects[sid] || {}, body.metadata || {}, {
          name: created && created.service ? created.service.name : undefined,
          createdAt: now,
        });
        const proj = store.projects[sid];
        proj.deploys = Array.isArray(proj.deploys) ? proj.deploys : [];
        proj.deploys.push({ at: now, trigger: 'create', kind: 'created', status: 'pending' });
        proj.lastDeploy = now;
        await writeStore(store);
      }
      return send(res, 201, { account: account.name, accountIdx: account.idx, service: created });
    }

    /* ---------- /api/services/:acct/:id/<action> ---------- */
    if (parts[1] === 'services' && parts[2] && parts[3] && parts[4] === 'suspend' && method === 'POST') {
      return send(res, 200, await apiServiceAction(getAccount(parts[2]), parts[3], 'suspend'));
    }
    if (parts[1] === 'services' && parts[2] && parts[3] && parts[4] === 'resume' && method === 'POST') {
      return send(res, 200, await apiServiceAction(getAccount(parts[2]), parts[3], 'resume'));
    }

    /* ---------- /api/services/:acct/:id/custom-domains ---------- */
    if (parts[1] === 'services' && parts[2] && parts[3] && parts[4] === 'custom-domains') {
      const account = getAccount(parts[2]);
      if (method === 'GET') return send(res, 200, await listCustomDomains(account, parts[3]));
      if (method === 'POST') {
        const domain = body && (body.domain || body.customDomain);
        if (!domain) return sendError(res, 400, 'body needs {domain: "example.com"}');
        // تأكد من وجود دومين متاح على هذا الحساب
        const store = await readStore();
        const limits = { ...DEFAULT_LIMITS, ...(store.config.limits || {}) };
        const fleet = await apiFleet(store);
        const acct = fleet.accounts.find(a => a.idx === account.idx);
        if (acct && acct.customDomainsUsed >= limits.customDomainsPerAccount) {
          return sendError(res, 402, `${account.name} has reached its ${limits.customDomainsPerAccount}-domain limit`);
        }
        const r = await renderCall(account, `/services/${parts[3]}/custom-domains`, {
          method: 'POST', body: { customDomain: { domain } },
        });
        if (r.status >= 400) return sendError(res, r.status, `add domain failed: ${JSON.stringify(r.body)}`);
        return send(res, 201, r.body);
      }
      if (method === 'DELETE' && parts[5]) {
        const r = await renderCall(account, `/services/${parts[3]}/custom-domains/${parts[5]}`, { method: 'DELETE' });
        if (r.status >= 400) return sendError(res, r.status, `delete domain failed: ${JSON.stringify(r.body)}`);
        return send(res, 200, { ok: true, deleted: parts[5] });
      }
    }

    /* ---------- /api/services/:acct/:id/deploys ---------- */
    if (parts[1] === 'services' && parts[2] && parts[3] && parts[4] === 'deploys' && method === 'POST') {
      const account = getAccount(parts[2]);
      const clearCache = body && (body.clearCache === true || body.clearCache === 'clear')
        ? 'clear' : 'do_not_clear';
      const r = await renderCall(account, `/services/${parts[3]}/deploys`, { method: 'POST', body: { clearCache } });
      if (r.status >= 400) return sendError(res, r.status, `deploy failed: ${JSON.stringify(r.body)}`);
      // حدّث تاريخ آخر نشر في البيانات الوصفية + سجّل في سجلّ النشر
      const store = await readStore();
      if (store.projects[parts[3]]) {
        const proj = store.projects[parts[3]];
        const now = new Date().toISOString();
        proj.deploys = Array.isArray(proj.deploys) ? proj.deploys : [];
        proj.deploys.push({ at: now, trigger: 'manual', kind: 'deploy', status: 'pending',
          deployId: r.body && r.body.deploy ? r.body.deploy.id : undefined });
        proj.lastDeploy = now;
        await writeStore(store);
      }
      return send(res, 201, r.body);
    }

    /* ---------- /api/services/:acct/:id/envs ---------- */
    if (parts[1] === 'services' && parts[2] && parts[3] && parts[4] === 'envs') {
      const account = getAccount(parts[2]);
      if (method === 'GET') {
        const r = await renderCall(account, `/services/${parts[3]}/env-vars`);
        return send(res, r.status >= 400 ? 502 : 200, r.status >= 400 ? { error: JSON.stringify(r.body) } : r.body);
      }
      if (method === 'PUT') {
        const r = await renderCall(account, `/services/${parts[3]}/env-vars`, { method: 'PUT', body });
        if (r.status >= 400) return sendError(res, r.status, `env update failed: ${JSON.stringify(r.body)}`);
        return send(res, 200, r.body || { ok: true });
      }
    }

    /* ---------- /api/services/:acct/:id/metadata ---------- */
    if (parts[1] === 'services' && parts[2] && parts[3] && parts[4] === 'metadata' && (method === 'PUT' || method === 'PATCH')) {
      getAccount(parts[2]);
      const store = await readStore();
      store.projects[parts[3]] = deepMerge(store.projects[parts[3]] || {}, body || {});
      const r = await writeStore(store);
      return send(res, 200, { ok: true, serviceId: parts[3], metadata: store.projects[parts[3]], persisted: r.saved });
    }

    /* ---------- /api/services/:acct/:id (DELETE) ---------- */
    if (parts[1] === 'services' && parts[2] && parts[3] && !parts[4] && method === 'DELETE') {
      const account = getAccount(parts[2]);
      const r = await renderCall(account, `/services/${parts[3]}`, { method: 'DELETE' });
      if (r.status >= 400) return sendError(res, r.status, `delete failed: ${JSON.stringify(r.body)}`);
      const store = await readStore();
      delete store.projects[parts[3]];
      await writeStore(store);
      return send(res, 200, { ok: true, deleted: parts[3], account: account.name });
    }

    return sendError(res, 404, `no route: ${method} ${pathname}`);
  } catch (e) {
    return sendError(res, 502, e.message || String(e));
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[render-fleet] listening on :${PORT}`));
