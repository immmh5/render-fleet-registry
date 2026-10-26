#!/usr/bin/env node
/* ==================================================================== *
 *  render-fleet-registry — v3.0.0
 *  ------------------------------------------------------------------
 *  Central registry + control-plane for a fleet of Render.com accounts.
 *
 *  v3 adds (over v2):
 *    - fail-fast env validation at boot
 *    - GET /ready (deep check: GitHub store + accounts)
 *    - scoped API tokens (sha256-hashed at rest) + audit log (persisted)
 *    - per-IP rate limiting on /api/*, body size limit, security headers,
 *      CORS allow-list, constant-time key comparison
 *    - self-describing route table: GET /api/docs
 *    - self-monitoring engine (in-memory history, transition-only
 *      persistence, Telegram alerts, self-heal with daily caps)
 *    - deploy history + rollback, live env editor, usage metrics,
 *      service links, export/import
 *    - static file serving (dashboard/PWA) with CSP
 *
 *  Persistence: GitHub-backed JSON store (storage-adapter pattern —
 *  portable to Oracle Cloud / any Node host by swapping nothing: the
 *  adapter is the only file that touches the network for state).
 *
 *  No dependencies. Node >= 18 (global fetch, AbortController).
 * ==================================================================== */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '3.0.0';

/* ================================================================== *
 *  1. Env + fail-fast validation
 * ================================================================== */

const PORT = Number(process.env.PORT) || 8080;
const REGISTRY_KEY = process.env.REGISTRY_API_KEY || '';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.FLEET_GH_TOKEN || '';
const GH_REPO = process.env.GH_REPO || process.env.FLEET_GH_REPO || process.env.GITHUB_REPO || 'immmh5/render-fleet-registry';
const GH_FILE = process.env.GH_FILE || process.env.FLEET_GH_FILE || process.env.GITHUB_FILE || 'fleet-data.json';
const GH_BRANCH = process.env.GH_BRANCH || process.env.FLEET_GH_BRANCH || process.env.GITHUB_BRANCH || 'main';
const REGISTRY_ACCT_IDX = Number(process.env.REGISTRY_ACCT_IDX || process.env.REGISTRY_ACCOUNT_IDX || 1);
const SELF_URL = (process.env.SELF_URL || process.env.FLEET_URL || '').trim() || null;
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || '';
const TG_API = process.env.TG_API || 'https://api.telegram.org';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 120;
const BODY_LIMIT = Number(process.env.BODY_LIMIT_BYTES) || 1024 * 1024;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MONITOR_CYCLE_MS = 5 * 60 * 1000;

const DEFAULT_LIMITS = {
  customDomainsPerAccount: 5,
  maxServicesPerAccount: 8,
  bandwidthGbPerMonth: 100,
};
const STRATEGIES = ['spread', 'pack'];
const DEFAULT_PLAN = 'free';

/* Accounts come from env: RENDER_ACCOUNT_<IDX>_KEY (+ optional _NAME) */
const ACCOUNTS = [];
for (const k of Object.keys(process.env)) {
  const m = /^RENDER_ACCOUNT_(\d+)_KEY$/.exec(k);
  if (!m) continue;
  const idx = Number(m[1]);
  ACCOUNTS.push({
    idx,
    name: process.env[`RENDER_ACCOUNT_${idx}_NAME`] || `account-${idx}`,
    key: process.env[k] || '',
  });
}
ACCOUNTS.sort((a, b) => a.idx - b.idx);

function validateEnv() {
  const problems = [];
  if (!REGISTRY_KEY || REGISTRY_KEY.length < 16) problems.push('REGISTRY_API_KEY missing or too short (need >= 16 chars)');
  if (!ACCOUNTS.length) problems.push('no RENDER_ACCOUNT_<IDX>_KEY env vars found');
  for (const a of ACCOUNTS) if (!a.key || a.key.length < 10) problems.push(`RENDER_ACCOUNT_${a.idx}_KEY looks invalid`);
  if (!ACCOUNTS.some(a => a.idx === REGISTRY_ACCT_IDX)) problems.push(`REGISTRY_ACCT_IDX=${REGISTRY_ACCT_IDX} has no matching RENDER_ACCOUNT_${REGISTRY_ACCT_IDX}_KEY`);
  const hasTgToken = !!TG_BOT_TOKEN, hasTgChat = !!TG_CHAT_ID;
  if (hasTgToken !== hasTgChat) problems.push('telegram: set BOTH TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or neither)');
  if (!GH_TOKEN) console.warn('[boot] WARN: no GITHUB_TOKEN — store lives in memory only (resets on restart)');
  if (problems.length) {
    console.error('[boot] FATAL — env validation failed:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log(`[boot] env OK — ${ACCOUNTS.length} account(s): ${ACCOUNTS.map(a => `#${a.idx} ${a.name}`).join(', ')}`);
  console.log(`[boot] store: ${GH_TOKEN ? `github ${GH_REPO}@${GH_BRANCH}/${GH_FILE}` : 'memory'} | telegram: ${TG_BOT_TOKEN ? 'on' : 'off'} | leader: #${REGISTRY_ACCT_IDX}`);
}
validateEnv();

/* ================================================================== *
 *  2. Small helpers
 * ================================================================== */

function safeJson(v, n = 200) {
  try { const s = JSON.stringify(v); return s ? s.slice(0, n) : 'null'; }
  catch { return String(v); }
}
function deepMerge(base, patch) {
  for (const key of Object.keys(patch || {})) {
    const v = patch[key];
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      deepMerge(base[key], v);
    } else {
      base[key] = v;
    }
  }
  return base;
}
const sha256hex = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ================================================================== *
 *  3. Store — GitHub-backed JSON (storage adapter)
 * ================================================================== */

function DEFAULT_STORE() {
  return {
    version: 3,
    config: {
      strategy: 'spread',
      warnAtDomainsFree: 1,
      placementNotes: '',
      limits: { ...DEFAULT_LIMITS },
      monitor: {
        checkIntervalMin: 10, failThreshold: 2, autoHeal: true,
        healCooldownMin: 30, maxHealsPerDay: 6, autoResume: false,
      },
      notify: { down: true, up: true, deployFail: true, heal: true },
    },
    projects: {},
    accounts: {},
    tokens: {},
    audit: [],
    monitors: {
      services: {}, heals: [], deploys: {},
      selfPing: { ok: null, at: null, code: null, ms: null },
      persistedAt: null, lastRunAt: null,
    },
  };
}

let mem = null;
let memDirty = false;
let memLoadedAt = 0;
const STORE_TTL_MS = 15_000;

async function ghFetch(urlPath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`https://api.github.com${urlPath}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'render-fleet-registry',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  } finally { clearTimeout(timeout); }
}

async function readStore(opts) {
  const force = !!(opts && opts.force);
  if (!GH_TOKEN) { if (!mem) { mem = DEFAULT_STORE(); memDirty = true; } return mem; }
  if (!force && mem && (memDirty || Date.now() - memLoadedAt < STORE_TTL_MS)) return mem;
  const r = await ghFetch(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${GH_BRANCH}`);
  if (r.status === 404) { mem = DEFAULT_STORE(); memDirty = true; memLoadedAt = Date.now(); return mem; }
  if (r.status !== 200) throw new Error(`store read failed (HTTP ${r.status}): ${safeJson(r.body)}`);
  let parsed = {};
  try { parsed = r.body.content ? JSON.parse(Buffer.from(r.body.content, r.body.encoding || 'base64').toString('utf8')) : {}; }
  catch (e) { parsed = {}; console.error('[store] WARN: stored JSON unparseable, starting fresh —', e.message); }
  mem = deepMerge(DEFAULT_STORE(), parsed);
  memDirty = false;
  memLoadedAt = Date.now();
  return mem;
}

async function writeStore(data, opts) {
  mem = data;
  memDirty = true;
  memLoadedAt = Date.now();
  if (!GH_TOKEN) return { saved: false, mode: 'memory', reason: 'no GITHUB_TOKEN — state is memory-only' };
  const maxAttempts = (opts && opts.maxAttempts) || 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const shaR = await ghFetch(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${GH_BRANCH}`);
    let sha = null;
    if (shaR.status === 200 && shaR.body && typeof shaR.body.sha === 'string') sha = shaR.body.sha;
    else if (shaR.status !== 404) throw new Error(`store sha fetch failed (HTTP ${shaR.status})`);
    const r = await ghFetch(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}`, {
      method: sha ? 'PUT' : 'POST',
      body: {
        message: `registry-store: ${new Date().toISOString()}`,
        branch: GH_BRANCH,
        ...(sha ? { sha } : {}),
        content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
      },
    });
    if (r.status === 200 || r.status === 201) {
      memDirty = false;
      return { saved: true, commit: r.body && r.body.commit && r.body.commit.sha };
    }
    if (r.status === 409 && attempt < maxAttempts) { await new Promise(ok => setTimeout(ok, 400 * attempt)); continue; }
    throw new Error(`store write failed (HTTP ${r.status}): ${safeJson(r.body)}`);
  }
  throw new Error('store write: retries exhausted (sha conflict kept repeating)');
}

/* ================================================================== *
 *  4. Render API client
 * ================================================================== */

async function renderCall(account, urlPath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(`https://api.render.com/v1${urlPath}`, {
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
  } finally { clearTimeout(timeout); }
}

const OWNER_CACHE = new Map();
async function ownerIdFor(account) {
  if (OWNER_CACHE.has(account.idx)) return OWNER_CACHE.get(account.idx);
  const r = await renderCall(account, '/owners?limit=10');
  if (r.status >= 400 || !Array.isArray(r.body) || !r.body.length) {
    throw new Error(`owners failed for "${account.name}" (HTTP ${r.status}): ${safeJson(r.body)}`);
  }
  const first = r.body[0];
  const oid = (first && first.owner && first.owner.id) || (first && first.id);
  if (!oid) throw new Error(`owners: no id in response for "${account.name}"`);
  OWNER_CACHE.set(account.idx, oid);
  return oid;
}

async function listServices(account) {
  const services = [];
  let cursor = '', guard = 0;
  while (guard++ < 20) {
    const qs = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
    const { status, body } = await renderCall(account, `/services${qs}`);
    if (status !== 200) throw new Error(`list services for "${account.name}" (HTTP ${status}): ${safeJson(body)}`);
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
    return { id: cd.id, domain: cd.name || cd.domain, verificationStatus: cd.verificationStatus, createdAt: cd.createdAt };
  });
}

/* ================================================================== *
 *  5. Fleet snapshot (live from Render)
 * ================================================================== */

async function accountFleet(account) {
  const services = await listServices(account);
  const withDomains = await Promise.all(
    services.map(async (svc) => {
      let customDomains = [];
      try { customDomains = await listCustomDomains(account, svc.service.id); } catch { /* skip */ }
      const sd = svc.service.serviceDetails || {};
      return {
        id: svc.service.id,
        name: svc.service.name,
        type: svc.service.type,
        status: svc.service.suspended === 'suspended' ? 'suspended' : (sd.maintenanceStatus || null),
        suspended: svc.service.suspended,
        suspenders: svc.service.suspenders || [],
        url: sd.url ? sd.url : null,
        createdAt: svc.service.createdAt,
        updatedAt: svc.service.updatedAt,
        repo: svc.service.repo || sd.repo || null,
        branch: svc.service.branch || sd.branch || null,
        ownerId: svc.ownerId || svc.service.ownerId || null,
        lastDeploy: svc.service.lastDeploy || null,
        customDomains,
      };
    })
  );
  return {
    idx: account.idx,
    name: account.name,
    services: withDomains,
    customDomainsUsed: withDomains.reduce((n, s) => n + s.customDomains.length, 0),
    suspendedServices: withDomains.filter(s => s.suspended === 'suspended').length,
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
    acct.bandwidthAllocatedGb = (acct.services || []).reduce((n, s) => n + (Number(s.meta.monthlyBandwidthGb) || 0), 0);
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
 *  6. Placement + alerts
 * ================================================================== */

function scoreAccount(acct, config, needsDomain) {
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const free = Math.max(0, limits.customDomainsPerAccount - acct.customDomainsUsed);
  const services = acct.services ? acct.services.length : 0;
  let score = 0;
  const reasons = [];
  if (needsDomain) {
    score += free * 100;
    reasons.push(`${free} domain slot(s) free`);
    if (free === 0) reasons.push('no domain slots');
  }
  score -= acct.suspendedServices * 60;
  if (acct.suspendedServices) reasons.push(`${acct.suspendedServices} suspended`);
  score -= services * 10;
  reasons.push(`${services} service(s)`);
  if (acct.idx === REGISTRY_ACCT_IDX) {
    score = -100000;
    reasons.push('LEADER account — reserved for the registry itself');
  }
  return { idx: acct.idx, name: acct.name, score, reasons, free, services, suspendedServices: acct.suspendedServices };
}

function pickBest(fleet, config, needsDomain) {
  const ranking = fleet.accounts
    .filter(a => !a.error)
    .map(a => scoreAccount(a, config, needsDomain))
    .sort((x, y) => y.score - x.score);
  const best = ranking[0];
  if (!best || best.score <= -100000) return { recommended: null, reason: 'no usable account — create a new Render account and add its key', ranking };
  if (needsDomain && best.free === 0) return { recommended: null, reason: 'no account has a free custom domain slot', ranking };
  return { recommended: { idx: best.idx, name: best.name }, reason: best.reasons.join(' | '), ranking };
}

function computeAlerts(fleet, config) {
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const warnAt = (config && config.warnAtDomainsFree) || 1;
  const out = [];
  for (const acct of fleet.accounts) {
    if (acct.error) {
      out.push({ level: 'critical', account: acct.name, accountIdx: acct.idx, code: 'acct_error', message: `API error: ${acct.error}` });
      continue;
    }
    if (acct.suspendedServices > 0) {
      out.push({
        level: 'critical', account: acct.name, accountIdx: acct.idx, code: 'billing_suspended',
        message: `${acct.suspendedServices} service(s) suspended by 'billing' — workspace-wide, needs a card or month reset`,
      });
    }
    const free = limits.customDomainsPerAccount - acct.customDomainsUsed;
    if (free <= warnAt) {
      out.push({
        level: free === 0 ? 'warning' : 'info', account: acct.name, accountIdx: acct.idx, code: 'domains_full',
        message: `${acct.customDomainsUsed}/${limits.customDomainsPerAccount} custom domains used, ${free} free`,
      });
    }
    const services = acct.services.length;
    if (services >= limits.maxServicesPerAccount) {
      out.push({
        level: 'warning', account: acct.name, accountIdx: acct.idx, code: 'services_full',
        message: `${services}/${limits.maxServicesPerAccount} services — at/over the configured limit`,
      });
    }
  }
  return out;
}

/* ================================================================== *
 *  7. Telegram alerts
 * ================================================================== */

async function tgSend(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return { sent: false, reason: 'telegram not configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9_000);
  try {
    const res = await fetch(`${TG_API}/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (res.status >= 400) { console.error('[telegram] send failed:', res.status, body.slice(0, 200)); return { sent: false }; }
    return { sent: true };
  } catch (e) {
    console.error('[telegram] send error:', e.message);
    return { sent: false, error: e.message };
  } finally { clearTimeout(timeout); }
}

function notifyFlags(store) {
  const n = (store && store.config && store.config.notify) || {};
  return { down: true, up: true, deployFail: true, heal: true, ...n };
}

function fmtEv(ev) {
  switch (ev.type) {
    case 'down': return `🔴 ${ev.name} تعطّلت — ${ev.url || ''}${ev.code ? ' (HTTP ' + ev.code + ')' : ''}${ev.error ? ' ' + ev.error : ''}`;
    case 'up': return `🟢 ${ev.name} عادت للعمل${ev.downForMin != null ? ' (كانت معطلة ' + ev.downForMin + ' دقيقة)' : ''}`;
    case 'heal': return `🛠 إصلاح ذاتي: ${ev.name} — ${ev.action} (${ev.reason})`;
    case 'heal_failed': return `⚠️ فشل إصلاح ذاتي: ${ev.name} — ${ev.error}`;
    case 'deploy_fail': return `💥 نشر فاشل: ${ev.name} — ${ev.status}${ev.deployId ? ' (' + ev.deployId + ')' : ''}`;
    case 'self_down': return `🚨 المراقب نفسه لا يصل إلى ${ev.url}`;
    default: return `${ev.type}: ${ev.name}`;
  }
}

/* Batch: one message per cycle, grouped by severity order */
async function flushTG(events, store) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return { sent: 0, off: true, reason: 'telegram not configured' };
  if (!events || !events.length) return { sent: 0, skipped: 'no events' };
  const flags = notifyFlags(store);
  const order = ['self_down', 'down', 'deploy_fail', 'heal_failed', 'heal', 'up'];
  const lines = [];
  for (const type of order) {
    if ((type === 'up' && !flags.up) || (type === 'heal' && !flags.heal) ||
        (type === 'heal_failed' && !flags.heal) || (type === 'deploy_fail' && !flags.deployFail)) continue;
    for (const ev of events.filter(e => e.type === type)) lines.push('• ' + fmtEv(ev));
  }
  if (!lines.length) return { sent: 0, skipped: 'all event types muted in config.notify' };
  const header = `📡 render-fleet-registry\n${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC\n`;
  const r = await tgSend(header + lines.join('\n'));
  return r.sent ? { sent: 1 } : { sent: 0, failed: true };
}

/* ================================================================== *
 *  8. Auth: admin key + scoped tokens
 * ================================================================== */

function actorFor(req, store) {
  const h = (req.headers.authorization || '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const givenHash = sha256hex(m[1]);
  if (REGISTRY_KEY && timingSafeEq(givenHash, sha256hex(REGISTRY_KEY))) {
    return { name: 'admin', admin: true, scopes: ['*'] };
  }
  const tokens = (store && store.tokens) || {};
  for (const [name, t] of Object.entries(tokens)) {
    if (t && typeof t.hash === 'string' && timingSafeEq(givenHash, t.hash)) {
      return { name, admin: false, scopes: Array.isArray(t.scopes) ? t.scopes : [] };
    }
  }
  return null;
}

function canAccess(actor, scopes) {
  if (actor.admin) return true;
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  return scopes.some(s => actor.scopes.includes(s));
}

/* ---- rate limiting (per IP, 60s sliding window, /api/* only) ---- */
const RL_WINDOW_MS = 60_000;
const rlHits = new Map();
function rlAllow(ip) {
  const now = Date.now();
  let arr = rlHits.get(ip);
  if (!arr) { arr = []; rlHits.set(ip, arr); }
  while (arr.length && now - arr[0] > RL_WINDOW_MS) arr.shift();
  if (arr.length >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((arr[0] + RL_WINDOW_MS - now) / 1000)) };
  }
  arr.push(now);
  if (rlHits.size > 5000) {
    for (const [k, a] of rlHits) if (!a.length || now - a[a.length - 1] > RL_WINDOW_MS * 2) rlHits.delete(k);
  }
  return { ok: true, remaining: RATE_LIMIT_MAX - arr.length };
}

/* ---- audit log (persisted inside the store) ---- */
function auditPush(store, actor, ip, action, detail) {
  if (!Array.isArray(store.audit)) store.audit = [];
  store.audit.unshift({
    at: new Date().toISOString(),
    actor: actor ? actor.name : 'anonymous',
    ip: ip || null,
    action,
    detail: detail === undefined ? null
      : (typeof detail === 'string' ? detail.slice(0, 300) : detail),
  });
  if (store.audit.length > 300) store.audit.length = 300;
}

/* ================================================================== *
 *  9. Monitor engine
 *     - in-memory result history (since boot, capped)
 *     - state persisted to the store ONLY on transitions/heals
 *     - self-heal: resume (billing-suspended, opt-in) or redeploy
 *       (failed deploy), capped maxHealsPerDay/day + per-service cooldown
 * ================================================================== */

const monitorHist = new Map(); // sid -> [{at, ok, code, ms, url}]
function pushHist(sid, entry) {
  let arr = monitorHist.get(sid);
  if (!arr) { arr = []; monitorHist.set(sid, arr); }
  arr.push(entry);
  if (arr.length > 60) arr.shift();
  return arr;
}

function monitorConfig(store) {
  const c = (store && store.config && store.config.monitor) || {};
  return {
    checkIntervalMin: 10, failThreshold: 2, autoHeal: true,
    healCooldownMin: 30, maxHealsPerDay: 6, autoResume: false, ...c,
  };
}

async function pingUrl(urlStr) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const t0 = Date.now();
  try {
    const res = await fetch(urlStr, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const ms = Date.now() - t0;
    const ok = res.status >= 200 && res.status < 400;
    return { ok, code: res.status, ms };
  } catch (e) {
    return { ok: false, code: null, ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout (10s)' : String(e.message || e).slice(0, 200) };
  } finally { clearTimeout(timeout); }
}

function findSvcInFleet(fleet, sid) {
  for (const acct of fleet.accounts || []) {
    for (const svc of acct.services || []) if (svc.id === sid) return { svc, acctIdx: acct.idx, name: svc.name, account: acct.name };
  }
  return null;
}

/* keep store.monitors in sync with the live fleet (add/remove/urls) */
function syncMonitors(store, fleet) {
  let changed = false;
  const mons = store.monitors.services;
  const cfg = monitorConfig(store);
  const seen = new Set();
  for (const acct of fleet.accounts || []) {
    if (acct.error) continue;
    for (const svc of acct.services || []) {
      if (!svc.id) continue;
      seen.add(svc.id);
      const proj = store.projects[svc.id];
      if (proj && proj.acct !== acct.idx) { proj.acct = acct.idx; changed = true; }
      if (!proj) { store.projects[svc.id] = { acct: acct.idx }; changed = true; }
      const url = (store.projects[svc.id] && store.projects[svc.id].monitorUrl) || svc.url || null;
      let m = mons[svc.id];
      if (url) {
        if (!m) {
          mons[svc.id] = {
            enabled: true, url, intervalMin: cfg.checkIntervalMin,
            state: 'unknown', consecutiveFails: 0, lastCheckAt: null,
            urlPinned: false, healedCount: 0,
          };
          m = mons[svc.id];
          changed = true;
        } else if (m.url !== url && !m.urlPinned) {
          m.url = url; changed = true;
        } else if (!m.intervalMin) {
          m.intervalMin = cfg.checkIntervalMin; changed = true;
        }
      } else if (m && m.enabled) {
        m.enabled = false; changed = true;
      }
    }
  }
  for (const sid of Object.keys(mons)) {
    if (!seen.has(sid)) { delete mons[sid]; monitorHist.delete(sid); changed = true; }
  }
  return changed;
}

/* one check for one service; returns events for Telegram */
async function checkOne(store, fleet, sid) {
  const events = [];
  const m = store.monitors.services[sid];
  if (!m || !m.enabled || !m.url) return events;
  const cfg = monitorConfig(store);
  const now = Date.now();
  const lastAt = m.lastCheckAt ? Date.parse(m.lastCheckAt) : 0;
  if (m.state !== 'down' && lastAt && now - lastAt < (m.intervalMin || cfg.checkIntervalMin) * 60_000) return events;

  const ref = findSvcInFleet(fleet, sid);
  const name = (ref && ref.name) || (store.projects[sid] && store.projects[sid].name) || sid;
  const result = await pingUrl(m.url);
  m.lastCheckAt = new Date().toISOString();
  m.lastOk = result.ok;
  m.lastCode = result.code === null || result.code === undefined ? null : result.code;
  m.lastMs = result.ms || null;
  m.lastError = result.error ? String(result.error).slice(0, 200) : null;
  pushHist(sid, { at: m.lastCheckAt, ok: result.ok, code: m.lastCode, ms: m.lastMs, url: m.url });

  if (result.ok) {
    m.consecutiveFails = 0;
    if (m.state === 'down') {
      events.push({ type: 'up', sid, name, url: m.url, code: m.lastCode, downForMin: m.openedAt ? Math.round((now - Date.parse(m.openedAt)) / 60_000) : null });
      m.state = 'up';
      m.openedAt = null;
    } else if (m.state !== 'up') {
      m.state = 'up';
    }
  } else {
    m.consecutiveFails = (m.consecutiveFails || 0) + 1;
    if (m.state !== 'down' && m.consecutiveFails >= cfg.failThreshold) {
      events.push({ type: 'down', sid, name, url: m.url, code: m.lastCode, error: m.lastError });
      m.state = 'down';
      m.openedAt = new Date().toISOString();
    } else if (m.state !== 'down' && m.consecutiveFails === 1) {
      m.state = 'degraded';
      events.push({ type: 'down', sid, name, url: m.url, code: m.lastCode, error: m.lastError, probe: true, message: `first failure (threshold ${cfg.failThreshold})` });
    }
  }

  /* ---- self-heal (only when confirmed down) ---- */
  if (m.state === 'down' && cfg.autoHeal && ref && !result.ok) {
    const svc = ref.svc;
    const suspended = svc.suspended === 'suspended';
    const suspenders = Array.isArray(svc.suspenders) ? svc.suspenders : [];
    const lastDeployStatus = svc.lastDeploy && svc.lastDeploy.status;
    const failedDeploy = ['build_failed', 'update_failed', 'pre_deploy_failed'].includes(lastDeployStatus);
    let action = null, reason = null;
    if (suspended) {
      if (cfg.autoResume && suspenders.includes('billing')) { action = 'resume'; reason = 'billing-suspended'; }
    } else if (failedDeploy) {
      action = 'redeploy'; reason = `deploy ${lastDeployStatus}`;
    }
    const dayKey = new Date().toISOString().slice(0, 10);
    const todayCount = (store.monitors.heals || []).filter(h => h.at && h.at.slice(0, 10) === dayKey && !h.failed).length;
    const cooldownOk = !m.lastHealAt || (now - Date.parse(m.lastHealAt)) >= cfg.healCooldownMin * 60_000;
    if (action && cooldownOk && todayCount < cfg.maxHealsPerDay) {
      const at = new Date().toISOString();
      try {
        const account = ACCOUNTS.find(a => a.idx === ref.acctIdx) || ACCOUNTS[0];
        if (action === 'resume') {
          await apiServiceAction(account, sid, 'resume');
        } else {
          const r = await renderCall(account, `/services/${sid}/deploys`, { method: 'POST', body: { clearCache: 'do_not_clear' } });
          if (r.status >= 400) throw new Error(`redeploy HTTP ${r.status}: ${safeJson(r.body)}`);
        }
        m.lastHealAt = at;
        m.healedCount = (m.healedCount || 0) + 1;
        store.monitors.heals = store.monitors.heals || [];
        store.monitors.heals.unshift({ at, sid, name, action, reason, accountIdx: ref.acctIdx });
        if (store.monitors.heals.length > 50) store.monitors.heals.length = 50;
        events.push({ type: 'heal', sid, name, action, reason });
      } catch (e) {
        store.monitors.heals = store.monitors.heals || [];
        store.monitors.heals.unshift({ at, sid, name, action, failed: String(e.message || e).slice(0, 150) });
        if (store.monitors.heals.length > 50) store.monitors.heals.length = 50;
        events.push({ type: 'heal_failed', sid, name, action, error: String(e.message || e).slice(0, 150) });
      }
    }
  }
  return events;
}

/* watch deploy statuses from the fleet snapshot; emit fail events */
function deployWatch(store, fleet) {
  const events = [];
  const seen = store.monitors.deploys || (store.monitors.deploys = {});
  const FAIL = ['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled'];
  for (const acct of fleet.accounts || []) {
    if (acct.error) continue;
    for (const svc of acct.services || []) {
      const ld = svc.lastDeploy;
      if (!svc.id || !ld || !ld.id) continue;
      const prev = seen[svc.id];
      if (!prev || prev.id !== ld.id) {
        if (prev && FAIL.includes(ld.status)) {
          events.push({ type: 'deploy_fail', sid: svc.id, name: svc.name, deployId: ld.id, status: ld.status });
        }
        seen[svc.id] = { id: ld.id, status: ld.status, at: ld.createdAt || new Date().toISOString() };
      } else if (prev.status !== ld.status) {
        if (FAIL.includes(ld.status)) {
          events.push({ type: 'deploy_fail', sid: svc.id, name: svc.name, deployId: ld.id, status: ld.status });
        }
        seen[svc.id].status = ld.status;
      }
    }
  }
  return events;
}

/* the registry watches itself too (self-ping) — set SELF_URL env */
async function selfPing(store) {
  if (!SELF_URL) return null;
  const result = await pingUrl(SELF_URL);
  const sp = store.monitors.selfPing = store.monitors.selfPing || {};
  sp.ok = result.ok;
  sp.at = new Date().toISOString();
  sp.code = result.code === null || result.code === undefined ? null : result.code;
  sp.ms = result.ms || null;
  return result.ok ? null : { type: 'self_down', name: 'render-fleet-registry (self)', url: SELF_URL, code: sp.code };
}

let cycleLock = false;
const lastCycle = { at: null, ms: null, summary: null };

async function monitorCycle(manual, cycleCount = 0) {
  if (cycleLock) return { skipped: 'a cycle is already running' };
  cycleLock = true;
  const t0 = Date.now();
  try {
    const store = await readStore({ force: true });
    const fleet = await apiFleet(store);
    const events = deployWatch(store, fleet);
    const changed = syncMonitors(store, fleet);
    const cfg = monitorConfig(store);
    let checked = 0, due = 0;
    const sids = Object.keys(store.monitors.services);
    for (const sid of sids) {
      const m = store.monitors.services[sid];
      if (!m || !m.enabled || !m.url) continue;
      due++;
      try { events.push(...await checkOne(store, fleet, sid)); checked++; }
      catch (e) { console.error(`[monitors] check ${sid} failed:`, e.message); }
    }
    /* self-ping every other cycle (~10 min) — also acts as keep-alive */
    const selfEvent = (cycleCount % 2 === 0 || manual) ? await selfPing(store) : null;
    if (selfEvent) events.push(selfEvent);

    const hasEvents = events.length > 0;
    const heartbeatDue = !store.monitors.persistedAt ||
      (Date.now() - Date.parse(store.monitors.persistedAt)) > 6 * 3600_000;
    let persist = null;
    if (changed || hasEvents || heartbeatDue || manual) {
      store.monitors.lastRunAt = new Date().toISOString();
      store.monitors.persistedAt = store.monitors.persistedAt || new Date().toISOString();
      persist = await writeStore(store);
    }
    const tg = await flushTG(events, store);
    lastCycle.at = new Date().toISOString();
    lastCycle.ms = Date.now() - t0;
    lastCycle.summary = { due, checked, events: events.length, changed };
    return { ok: true, due, checked, events: events.length, changed, persisted: persist ? persist.saved : false, telegram: tg, ms: lastCycle.ms };
  } finally {
    cycleLock = false;
  }
}

/* ================================================================== *
 *  10. HTTP plumbing
 * ================================================================== */

let currentReq = null; // for HEAD-aware send()

function securityHeaders(extra) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(extra || {}),
  };
}

function send(res, status, payload, ct = 'application/json; charset=utf-8', extra) {
  const isHead = !!(currentReq && currentReq.method === 'HEAD');
  const body = (typeof payload === 'string' || Buffer.isBuffer(payload)) ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(status, securityHeaders({ 'Content-Type': ct, ...extra }));
  res.end(isHead ? undefined : body);
}
function sendError(res, status, message) { send(res, status, { error: message }); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', c => {
      data += c;
      if (data.length > BODY_LIMIT) { done(null); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return done({});
      try { done(JSON.parse(data)); } catch { done(null); }
    });
    req.on('error', () => done(null));
  });
}

function getAccount(idx) {
  const a = ACCOUNTS.find(x => String(x.idx) === String(idx));
  if (!a) throw new Error(`unknown account ${idx} (have: ${ACCOUNTS.map(x => x.idx).join(', ')})`);
  return a;
}

/* ---- static files (dashboard + PWA) with CSP ---- */
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function serveStatic(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return null;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
  const ext = path.extname(filePath).toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  const immutable = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.woff2', '.ico'].includes(ext);
  const extra = { 'Cache-Control': immutable ? 'public, max-age=604800, immutable' : 'no-cache' };
  if (ct.startsWith('text/html')) extra['Content-Security-Policy'] = CSP;
  return { body: fs.readFileSync(filePath), ct, extra };
}

function healthInfo() {
  return {
    ok: true,
    service: 'render-fleet-registry',
    version: VERSION,
    accounts: ACCOUNTS.length,
    leader: REGISTRY_ACCT_IDX,
    store: { mode: GH_TOKEN ? 'github' : 'memory', dirty: memDirty },
    monitors: lastCycle.summary,
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString(),
  };
}

async function sendReady(res) {
  const info = { ready: false, checks: {} };
  try {
    if (!GH_TOKEN) {
      info.checks.store = 'memory-mode (by design)';
      info.ready = true;
    } else {
      const r = await ghFetch(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${GH_BRANCH}`);
      info.checks.store = r.status === 200 ? `github OK (${GH_REPO})` : `github HTTP ${r.status}`;
      info.ready = r.status === 200 || r.status === 404;
    }
    info.checks.accounts = ACCOUNTS.length ? `${ACCOUNTS.length} loaded` : 'none';
    if (!ACCOUNTS.length) info.ready = false;
    return send(res, info.ready ? 200 : 503, info);
  } catch (e) {
    info.checks.store = `github error: ${String(e.message || e).slice(0, 150)}`;
    return send(res, 503, info);
  }
}

/* ================================================================== *
 *  11. Router
 * ================================================================== */

const ROUTES = [];
function route(method, pattern, scopes, summary, handler) {
  const names = [];
  const rx = new RegExp('^' + pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
  ROUTES.push({ method, pattern, scopes, summary, handler, rx, names });
}
function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

/* decorate fleet services with their monitor state (read-only summary) */
function decorateMonitors(store, fleet) {
  const mons = (store && store.monitors && store.monitors.services) || {};
  for (const acct of fleet.accounts || []) {
    for (const svc of acct.services || []) {
      const m = mons[svc.id];
      if (m) {
        svc.monitor = {
          enabled: !!m.enabled, state: m.state || 'unknown', url: m.url,
          intervalMin: m.intervalMin || null,
          lastCheckAt: m.lastCheckAt || null,
          lastOk: m.lastOk === undefined ? null : m.lastOk,
          lastCode: m.lastCode === undefined ? null : m.lastCode,
          lastMs: m.lastMs || null,
          consecutiveFails: m.consecutiveFails || 0,
          openedAt: m.openedAt || null,
          lastHealAt: m.lastHealAt || null,
          healedCount: m.healedCount || 0,
        };
      }
    }
  }
}

/* ---- service ops shared by routes + healer ---- */
async function apiServiceAction(account, serviceId, action) {
  const map = {
    suspend: { method: 'POST', path: `/services/${serviceId}/suspend` },
    resume: { method: 'POST', path: `/services/${serviceId}/resume` },
  };
  const op = map[action];
  if (!op) throw new Error(`unknown action ${action}`);
  const r = await renderCall(account, op.path, { method: op.method });
  if (r.status >= 400) throw new Error(`${action} failed (HTTP ${r.status}): ${safeJson(r.body)}`);
  return r.body || { ok: true, action, serviceId };
}

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
    throw new Error(`create failed (HTTP ${res.status}): ${safeJson(res.body)}`);
  }
  return res.body;
}

/* ------------------------- routes ------------------------- */

route('GET', '/api/docs', ['read'], 'هذه القائمة — كل المسارات مع النطاقات المطلوبة', async ctx => {
  const store = await readStore();
  return send(ctx.res, 200, {
    service: 'render-fleet-registry', version: VERSION,
    scopesDoc: {
      read: 'قراءة الحالة (fleet/alerts/config/monitors/logs/usage)',
      write: 'عمليات تعديل الخدمات (create/suspend/resume/domains/deploys/rollback)',
      config: 'تعديل الإعدادات',
      monitors: 'إدارة محرك المراقبة الذاتي',
      admin: 'كل شيء: حذف خدمة، env-vars، tokens، audit، export/import',
      note: 'admin key يمتلك كل النطاقات تلقائياً',
    },
    routes: ROUTES.map(r => ({ method: r.method, path: r.pattern, scopes: r.scopes, summary: r.summary })),
    store: { mode: GH_TOKEN ? 'github' : 'memory', version: store.version },
    telegram: TG_BOT_TOKEN ? 'configured' : 'off',
  });
});

route('GET', '/api/version', ['read'], 'إصدار الخادم', async ctx =>
  send(ctx.res, 200, { version: VERSION, node: process.version }));

route('GET', '/api/fleet', ['read'], 'لقطة الأسطول الحية + حالة المراقبة لكل خدمة', async ctx => {
  const store = await readStore();
  const fleet = await apiFleet(store);
  decorateMonitors(store, fleet);
  const mons = Object.values((store.monitors && store.monitors.services) || {});
  fleet.monitors = {
    enabled: mons.filter(m => m.enabled).length,
    down: mons.filter(m => m.enabled && m.state === 'down').length,
    degraded: mons.filter(m => m.enabled && m.state === 'degraded').length,
  };
  return send(ctx.res, 200, { ...fleet, config: store.config });
});

route('GET', '/api/alerts', ['read'], 'تنبيهات الأسطول (domains/suspension/limits)', async ctx => {
  const store = await readStore();
  const fleet = await apiFleet(store);
  return send(ctx.res, 200, { generatedAt: fleet.generatedAt, alerts: computeAlerts(fleet, store.config) });
});

route('GET', '/api/config', ['read'], 'الإعدادات الحالية', async ctx => {
  const store = await readStore();
  return send(ctx.res, 200, { config: store.config, strategies: STRATEGIES, defaults: DEFAULT_LIMITS });
});

route('PUT', '/api/config', ['config'], 'تعديل الإعدادات (deep merge)', async ctx => {
  if (!ctx.body || typeof ctx.body !== 'object') throw new Error('config object required');
  const store = await readStore({ force: true });
  if (ctx.body.strategy && !STRATEGIES.includes(ctx.body.strategy)) {
    throw new Error(`invalid strategy; one of ${STRATEGIES.join(', ')}`);
  }
  const before = safeJson(store.config, 500);
  store.config = deepMerge(store.config, ctx.body);
  auditPush(store, ctx.actor, ctx.ip, 'config.update', { before, after: safeJson(store.config, 500) });
  const r = await writeStore(store);
  return send(ctx.res, 200, { ok: true, config: store.config, persisted: r.saved, detail: r });
});

route('POST', '/api/config/reset', ['config'], 'إرجاع الإعدادات للافتراضية', async ctx => {
  const store = await readStore({ force: true });
  store.config = DEFAULT_STORE().config;
  auditPush(store, ctx.actor, ctx.ip, 'config.reset', {});
  const r = await writeStore(store);
  return send(ctx.res, 200, { ok: true, config: store.config, persisted: r.saved });
});

route('GET', '/api/accounts', ['read'], 'ملخص الحسابات', async ctx => {
  const store = await readStore();
  const fleet = await apiFleet(store);
  const limits = { ...DEFAULT_LIMITS, ...(store.config.limits || {}) };
  return send(ctx.res, 200, {
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
});

route('PUT', '/api/accounts/:idx', ['write'], 'تحديث بيانات حساب وصفية (email/owner/note)', async ctx => {
  getAccount(ctx.params.idx);
  const store = await readStore({ force: true });
  const cur = store.accounts[ctx.params.idx] || {};
  store.accounts[ctx.params.idx] = deepMerge(cur, ctx.body || {});
  auditPush(store, ctx.actor, ctx.ip, 'account.meta.update', { idx: ctx.params.idx, keys: Object.keys(ctx.body || {}) });
  const r = await writeStore(store);
  return send(ctx.res, 200, { ok: true, accountIdx: Number(ctx.params.idx), meta: store.accounts[ctx.params.idx], persisted: r.saved });
});

route('POST', '/api/suggest', ['read'], 'اقتراح أفضل حساب لاستضافة مشروع جديد', async ctx => {
  const input = ctx.body || {};
  const needsDomain = input.needsDomain !== false;
  const store = await readStore();
  const fleet = input.fleet || await apiFleet(store);
  return send(ctx.res, 200, pickBest(fleet, store.config, needsDomain));
});

route('GET', '/api/services/:acct', ['read'], 'خدمات حساب معين', async ctx => {
  const store = await readStore();
  const fleet = await accountFleet(getAccount(ctx.params.acct));
  decorateMonitors(store, { accounts: [fleet] });
  return send(ctx.res, 200, fleet);
});

route('POST', '/api/services', ['write'], 'إنشاء خدمة (اختيار الحساب تلقائي إن لم تحدد)', async ctx => {
  const body = ctx.body || {};
  const explicit = body.account || body.accountIdx || ctx.url.searchParams.get('account');
  let idx;
  if (explicit) {
    idx = explicit;
  } else {
    const store = await readStore();
    const fleet = await apiFleet(store);
    const needsDomain = !!(body.customDomain || body.needsDomain);
    const suggestion = pickBest(fleet, store.config, needsDomain);
    if (!suggestion.recommended) return sendError(ctx.res, 409, suggestion.reason);
    idx = suggestion.recommended.idx;
  }
  delete body.account;
  delete body.accountIdx;
  const account = getAccount(idx);
  const created = await apiCreateService(account, body);
  const sid = created && created.service ? created.service.id : (created && created.id);
  if (sid) {
    const store = await readStore({ force: true });
    const now = new Date().toISOString();
    store.projects[sid] = deepMerge(store.projects[sid] || {}, body.metadata || {}, {
      name: created && created.service ? created.service.name : undefined,
      createdAt: now,
    });
    const proj = store.projects[sid];
    proj.deploys = Array.isArray(proj.deploys) ? proj.deploys : [];
    proj.deploys.push({ at: now, trigger: 'create', kind: 'created', status: 'pending' });
    proj.lastDeploy = now;
    auditPush(store, ctx.actor, ctx.ip, 'service.create', { sid, accountIdx: account.idx, name: proj.name });
    await writeStore(store);
  }
  return send(ctx.res, 201, { account: account.name, accountIdx: account.idx, service: created });
});

route('POST', '/api/services/:acct/:id/suspend', ['write'], 'تعليق خدمة', async ctx => {
  const account = getAccount(ctx.params.acct);
  const result = await apiServiceAction(account, ctx.params.id, 'suspend');
  const store = await readStore({ force: true });
  auditPush(store, ctx.actor, ctx.ip, 'service.suspend', { serviceId: ctx.params.id, accountIdx: account.idx });
  await writeStore(store);
  return send(ctx.res, 200, result);
});

route('POST', '/api/services/:acct/:id/resume', ['write'], 'إستئناف خدمة', async ctx => {
  const account = getAccount(ctx.params.acct);
  const result = await apiServiceAction(account, ctx.params.id, 'resume');
  const store = await readStore({ force: true });
  const m = store.monitors.services[ctx.params.id];
  if (m) { m.state = 'unknown'; m.consecutiveFails = 0; }
  auditPush(store, ctx.actor, ctx.ip, 'service.resume', { serviceId: ctx.params.id, accountIdx: account.idx });
  await writeStore(store);
  return send(ctx.res, 200, result);
});

route('DELETE', '/api/services/:acct/:id', ['admin'], 'حذف خدمة نهائياً (admin)', async ctx => {
  const account = getAccount(ctx.params.acct);
  const r = await renderCall(account, `/services/${ctx.params.id}`, { method: 'DELETE' });
  if (r.status >= 400) return sendError(ctx.res, r.status, `delete failed: ${safeJson(r.body)}`);
  const store = await readStore({ force: true });
  delete store.projects[ctx.params.id];
  if (store.monitors.services[ctx.params.id]) delete store.monitors.services[ctx.params.id];
  monitorHist.delete(ctx.params.id);
  auditPush(store, ctx.actor, ctx.ip, 'service.delete', { serviceId: ctx.params.id, accountIdx: account.idx });
  await writeStore(store);
  return send(ctx.res, 200, { ok: true, deleted: ctx.params.id, account: account.name });
});

route('PUT', '/api/services/:acct/:id/metadata', ['write'], 'تحديث البيانات الوصفية للمشروع (bandwidth/tag/notes...)', async ctx => {
  getAccount(ctx.params.acct);
  const store = await readStore({ force: true });
  store.projects[ctx.params.id] = deepMerge(store.projects[ctx.params.id] || {}, ctx.body || {});
  auditPush(store, ctx.actor, ctx.ip, 'service.meta.update', { serviceId: ctx.params.id, keys: Object.keys(ctx.body || {}) });
  const r = await writeStore(store);
  return send(ctx.res, 200, { ok: true, serviceId: ctx.params.id, metadata: store.projects[ctx.params.id], persisted: r.saved });
});

route('GET', '/api/services/:acct/:id/custom-domains', ['read'], 'قائمة الدومينات المخصصة', async ctx =>
  send(ctx.res, 200, await listCustomDomains(getAccount(ctx.params.acct), ctx.params.id)));

route('POST', '/api/services/:acct/:id/custom-domains', ['write'], 'إضافة دومين مخصص (يفحص توفر slot أولاً)', async ctx => {
  const account = getAccount(ctx.params.acct);
  const domain = ctx.body && (ctx.body.domain || ctx.body.customDomain);
  if (!domain) throw new Error('body needs {domain: "example.com"}');
  const store = await readStore();
  const limits = { ...DEFAULT_LIMITS, ...(store.config.limits || {}) };
  const fleet = await apiFleet(store);
  const acct = fleet.accounts.find(a => a.idx === account.idx);
  if (acct && acct.customDomainsUsed >= limits.customDomainsPerAccount) {
    return sendError(ctx.res, 402, `${account.name} has reached its ${limits.customDomainsPerAccount}-domain limit`);
  }
  const r = await renderCall(account, `/services/${ctx.params.id}/custom-domains`, { method: 'POST', body: { name: domain } });
  if (r.status >= 400) return sendError(ctx.res, r.status, `add domain failed: ${safeJson(r.body)}`);
  const st = await readStore({ force: true });
  auditPush(st, ctx.actor, ctx.ip, 'domain.add', { serviceId: ctx.params.id, domain });
  await writeStore(st);
  return send(ctx.res, 201, r.body);
});

route('DELETE', '/api/services/:acct/:id/custom-domains/:domainId', ['write'], 'حذف دومين مخصص', async ctx => {
  const account = getAccount(ctx.params.acct);
  const r = await renderCall(account, `/services/${ctx.params.id}/custom-domains/${ctx.params.domainId}`, { method: 'DELETE' });
  if (r.status >= 400) return sendError(ctx.res, r.status, `delete domain failed: ${safeJson(r.body)}`);
  const store = await readStore({ force: true });
  auditPush(store, ctx.actor, ctx.ip, 'domain.delete', { serviceId: ctx.params.id, domainId: ctx.params.domainId });
  await writeStore(store);
  return send(ctx.res, 200, { ok: true, deleted: ctx.params.domainId });
});

route('POST', '/api/services/:acct/:id/custom-domains/:domainId/verify', ['write'], 'إعادة التحقق من دومين', async ctx => {
  const account = getAccount(ctx.params.acct);
  const r = await renderCall(account, `/services/${ctx.params.id}/custom-domains/${ctx.params.domainId}/verify`, { method: 'POST' });
  if (r.status >= 400) return sendError(ctx.res, r.status, `verify failed: ${safeJson(r.body)}`);
  return send(ctx.res, 200, r.body || { ok: true, verified: ctx.params.domainId });
});

route('POST', '/api/services/:acct/:id/deploys', ['write'], 'نشر يدوي (clearCache: true|false)', async ctx => {
  const account = getAccount(ctx.params.acct);
  const clearCache = ctx.body && (ctx.body.clearCache === true || ctx.body.clearCache === 'clear') ? 'clear' : 'do_not_clear';
  const r = await renderCall(account, `/services/${ctx.params.id}/deploys`, { method: 'POST', body: { clearCache } });
  if (r.status >= 400) return sendError(ctx.res, r.status, `deploy failed: ${safeJson(r.body)}`);
  const store = await readStore({ force: true });
  const proj = store.projects[ctx.params.id] = deepMerge(store.projects[ctx.params.id] || {}, {});
  const now = new Date().toISOString();
  proj.deploys = Array.isArray(proj.deploys) ? proj.deploys : [];
  proj.deploys.push({
    at: now, trigger: 'manual', kind: 'deploy', status: 'pending',
    deployId: r.body && r.body.deploy ? r.body.deploy.id : undefined,
  });
  proj.lastDeploy = now;
  auditPush(store, ctx.actor, ctx.ip, 'service.deploy', { serviceId: ctx.params.id, clearCache });
  await writeStore(store);
  return send(ctx.res, 201, r.body);
});

route('GET', '/api/services/:acct/:id/deploys', ['read'], 'النشر الحي من Render + سجل النشر المحلي', async ctx => {
  const account = getAccount(ctx.params.acct);
  const r = await renderCall(account, `/services/${ctx.params.id}/deploys?limit=20`);
  if (r.status >= 400) return sendError(ctx.res, r.status, `deploys failed: ${safeJson(r.body)}`);
  const live = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.deploys) ? r.body.deploys : []);
  const store = await readStore();
  const proj = (store.projects && store.projects[ctx.params.id]) || {};
  const history = (proj.deploys || []).slice(-30).reverse();
  return send(ctx.res, 200, { serviceId: ctx.params.id, live, history });
});

route('POST', '/api/services/:acct/:id/rollback', ['write'], 'تراجع إلى نشر سابق (deployId من قائمة النشر)', async ctx => {
  const account = getAccount(ctx.params.acct);
  const deployId = ctx.body && (ctx.body.deployId || ctx.body.id);
  if (!deployId) throw new Error('body needs { deployId: "dep-..." } — from GET /api/services/:acct/:id/deploys');
  const r = await renderCall(account, `/services/${ctx.params.id}/rollback`, { method: 'POST', body: { deployId } });
  if (r.status >= 400) return sendError(ctx.res, r.status, `rollback failed: ${safeJson(r.body)}`);
  const store = await readStore({ force: true });
  const proj = store.projects[ctx.params.id] = deepMerge(store.projects[ctx.params.id] || {}, {});
  const now = new Date().toISOString();
  proj.deploys = Array.isArray(proj.deploys) ? proj.deploys : [];
  proj.deploys.push({ at: now, trigger: 'rollback', kind: 'rollback', status: 'pending', rolledBackTo: deployId });
  proj.lastDeploy = now;
  auditPush(store, ctx.actor, ctx.ip, 'service.rollback', { serviceId: ctx.params.id, rolledBackTo: deployId });
  await writeStore(store);
  return send(ctx.res, 201, r.body);
});

route('GET', '/api/services/:acct/:id/logs', ['read'], 'سجلات آخر 24 ساعة', async ctx => {
  const account = getAccount(ctx.params.acct);
  const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 60));
  const oid = await ownerIdFor(account);
  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const q = `/logs?ownerId=${encodeURIComponent(oid)}&resource=${encodeURIComponent(ctx.params.id)}` +
    `&startTime=${encodeURIComponent(start)}&direction=backward&limit=${limit}`;
  const r = await renderCall(account, q);
  if (r.status >= 400) return sendError(ctx.res, r.status, `logs failed: ${safeJson(r.body)}`);
  const rows = (r.body && Array.isArray(r.body.logs)) ? r.body.logs : [];
  const logs = rows.map(x => {
    const labels = {};
    (x.labels || []).forEach(l => { labels[l.name] = l.value; });
    return { message: x.message, timestamp: x.timestamp, level: labels.level, type: labels.type, instance: labels.instance };
  }).filter(l => l.message);
  return send(ctx.res, 200, { serviceId: ctx.params.id, count: logs.length, logs });
});

route('GET', '/api/services/:acct/:id/envs', ['read'], 'متغيرات البيئة (مقنّعة؛ ?reveal=1 للمشرف)', async ctx => {
  const account = getAccount(ctx.params.acct);
  const r = await renderCall(account, `/services/${ctx.params.id}/env-vars`);
  if (r.status >= 400) return sendError(ctx.res, r.status, `env list failed: ${safeJson(r.body)}`);
  const rows = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.envVars) ? r.body.envVars : []);
  const reveal = ctx.url.searchParams.get('reveal') === '1' && ctx.actor.admin;
  const envs = rows.map(e => {
    const key = e.key || (e.envVar && e.envVar.key);
    const val = e.value !== undefined ? e.value : (e.envVar && e.envVar.value);
    return { key, value: reveal ? val : (val === undefined || val === null ? null : '••••••••'), masked: !reveal };
  }).filter(e => e.key);
  return send(ctx.res, 200, { serviceId: ctx.params.id, count: envs.length, revealed: reveal, envs });
});

route('PUT', '/api/services/:acct/:id/envs', ['admin'], 'تحديث متغيرات البيئة (admin فقط)', async ctx => {
  const account = getAccount(ctx.params.acct);
  if (!Array.isArray(ctx.body)) throw new Error('body must be an array of { key, value }');
  const keys = ctx.body.map(e => e && e.key).filter(Boolean);
  if (!keys.length) throw new Error('empty env list — refusing to wipe env vars');
  const r = await renderCall(account, `/services/${ctx.params.id}/env-vars`, { method: 'PUT', body: ctx.body });
  if (r.status >= 400) return sendError(ctx.res, r.status, `env update failed: ${safeJson(r.body)}`);
  const store = await readStore({ force: true });
  auditPush(store, ctx.actor, ctx.ip, 'service.envs.update', { serviceId: ctx.params.id, keys });
  await writeStore(store);
  return send(ctx.res, 200, r.body || { ok: true, updated: keys });
});

route('GET', '/api/services/:acct/:id/usage', ['read'], 'مقاييس bandwidth/CPU (آخر N يوم)', async ctx => {
  const account = getAccount(ctx.params.acct);
  const days = Math.min(60, Math.max(1, Number(ctx.url.searchParams.get('days')) || 30));
  const start = new Date(Date.now() - days * 864e5).toISOString();
  const end = new Date().toISOString();
  const qs = `resource=${encodeURIComponent(ctx.params.id)}&startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`;
  const [bw, cpu] = await Promise.all([
    renderCall(account, `/metrics/bandwidth?${qs}`).catch(e => ({ status: 0, body: null, error: e.message })),
    renderCall(account, `/metrics/cpu?${qs}`).catch(e => ({ status: 0, body: null, error: e.message })),
  ]);
  const summarize = (r, key) => {
    if (r.status !== 200 || !r.body) return { ok: false, httpStatus: r.status };
    let rows = null;
    if (Array.isArray(r.body)) rows = r.body;
    else if (Array.isArray(r.body[key])) rows = r.body[key];
    else if (Array.isArray(r.body.metrics)) rows = r.body.metrics;
    if (!rows) return { ok: false, httpStatus: r.status };
    const pts = rows.map(p => ({ at: p.timestamp || p.time || null, value: Number(p.value) || 0 }));
    const sum = pts.reduce((n, p) => n + p.value, 0);
    const peak = pts.reduce((m, p) => Math.max(m, p.value), 0);
    return {
      ok: true, points: pts.length,
      sum: Number(sum.toFixed(2)), peak: Number(peak.toFixed(2)),
      latest: pts.length ? pts[pts.length - 1].value : 0,
      series: pts.slice(-100),
    };
  };
  return send(ctx.res, 200, {
    serviceId: ctx.params.id, windowDays: days,
    bandwidth: summarize(bw, 'bandwidth'), cpu: summarize(cpu, 'cpu'),
  });
});

route('GET', '/api/services/:acct/:id/links', ['read'], 'روابط إدارية للخدمة', async ctx => {
  const store = await readStore();
  const proj = (store.projects && store.projects[ctx.params.id]) || {};
  return send(ctx.res, 200, {
    serviceId: ctx.params.id,
    links: Array.isArray(proj.links) ? proj.links : [],
    hint: 'POST {label,url} للإضافة، DELETE /api/services/:acct/:id/links/:linkId للحذف',
  });
});

route('POST', '/api/services/:acct/:id/links', ['write'], 'إضافة رابط إداري (github/uptime/domain...)', async ctx => {
  getAccount(ctx.params.acct);
  const { label, url } = ctx.body || {};
  if (!label || !url || !/^https?:\/\//i.test(url)) throw new Error('body needs { label: "GitHub", url: "https://..." }');
  const store = await readStore({ force: true });
  const proj = store.projects[ctx.params.id] = deepMerge(store.projects[ctx.params.id] || {}, {});
  proj.links = Array.isArray(proj.links) ? proj.links : [];
  const entry = { id: 'lnk_' + crypto.randomBytes(6).toString('hex'), label, url, addedAt: new Date().toISOString() };
  proj.links.push(entry);
  if (proj.links.length > 30) proj.links.length = 30;
  auditPush(store, ctx.actor, ctx.ip, 'service.link.add', { serviceId: ctx.params.id, label });
  const r = await writeStore(store);
  return send(ctx.res, 201, { ok: true, link: entry, persisted: r.saved });
});

route('DELETE', '/api/services/:acct/:id/links/:linkId', ['write'], 'حذف رابط إداري', async ctx => {
  getAccount(ctx.params.acct);
  const store = await readStore({ force: true });
  const proj = (store.projects && store.projects[ctx.params.id]) || {};
  if (!Array.isArray(proj.links)) throw new Error('no links on this project');
  const before = proj.links.length;
  proj.links = proj.links.filter(l => l.id !== ctx.params.linkId);
  if (proj.links.length === before) throw new Error(`no link with id ${ctx.params.linkId}`);
  auditPush(store, ctx.actor, ctx.ip, 'service.link.delete', { serviceId: ctx.params.id, linkId: ctx.params.linkId });
  const r = await writeStore(store);
  return send(ctx.res, 200, { ok: true, removed: ctx.params.linkId, persisted: r.saved });
});

/* ------------------- monitors ------------------- */

route('GET', '/api/monitors', ['read'], 'حالة محرك المراقبة الذاتي (كل خدمة)', async ctx => {
  const store = await readStore();
  const services = {};
  for (const [sid, m] of Object.entries((store.monitors && store.monitors.services) || {})) {
    services[sid] = { ...m, history: (monitorHist.get(sid) || []).slice(-20) };
  }
  return send(ctx.res, 200, {
    config: monitorConfig(store),
    notify: notifyFlags(store),
    services,
    heals: (store.monitors && store.monitors.heals) || [],
    selfPing: (store.monitors && store.monitors.selfPing) || null,
    cycle: { intervalMin: MONITOR_CYCLE_MS / 60_000, running: cycleLock, lastRunAt: lastCycle.at, lastRunMs: lastCycle.ms, lastResult: lastCycle.summary },
  });
});

route('POST', '/api/monitors/run', ['monitors', 'write'], 'تشغيل دورة فحص فورية', async ctx => {
  const result = await monitorCycle(true, 0);
  return send(ctx.res, 200, { ok: true, ...result });
});

route('PUT', '/api/monitors/:sid', ['monitors', 'write'], 'ضبط مراقبة خدمة (enabled/url/intervalMin)', async ctx => {
  const b = ctx.body || {};
  const store = await readStore({ force: true });
  if (!store.monitors.services[ctx.params.sid]) {
    throw new Error(`no monitor entry for ${ctx.params.sid} — run POST /api/monitors/run once so the fleet syncs`);
  }
  const m = store.monitors.services[ctx.params.sid];
  if (b.enabled !== undefined) m.enabled = !!b.enabled;
  if (b.url !== undefined) {
    if (!/^https?:\/\//i.test(b.url)) throw new Error('url must start with http:// or https://');
    m.url = b.url;
    m.urlPinned = true;
    m.state = 'unknown';
    m.consecutiveFails = 0;
    m.lastCheckAt = null;
  }
  if (b.intervalMin !== undefined) {
    const n = Number(b.intervalMin);
    if (!Number.isFinite(n) || n < 1 || n > 1440) throw new Error('intervalMin must be 1..1440');
    m.intervalMin = n;
  }
  if (b.urlPinned === false) m.urlPinned = false;
  auditPush(store, ctx.actor, ctx.ip, 'monitor.update', { sid: ctx.params.sid, keys: Object.keys(b) });
  const r = await writeStore(store);
  return send(ctx.res, 200, { ok: true, monitor: m, persisted: r.saved });
});

route('POST', '/api/monitors/:sid/check', ['monitors', 'write'], 'فحص فوري لخدمة واحدة', async ctx => {
  const sid = ctx.params.sid;
  const store = await readStore({ force: true });
  const m = store.monitors.services[sid];
  if (!m || !m.enabled) throw new Error(`no enabled monitor for ${sid}`);
  m.lastCheckAt = null; // force due
  const fleet = await apiFleet(store);
  const events = await checkOne(store, fleet, sid);
  await writeStore(store);
  const tg = await flushTG(events, store);
  return send(ctx.res, 200, {
    ok: true, monitor: m,
    history: (monitorHist.get(sid) || []).slice(-10),
    events, telegramSent: tg.sent,
  });
});

route('GET', '/api/monitors/history', ['read'], 'سجل نتائج الفحص في الذاكرة (منذ الإقلاع)', async ctx => {
  const out = {};
  for (const [sid, arr] of monitorHist.entries()) out[sid] = arr.slice(-60);
  return send(ctx.res, 200, { points: out, note: 'in-memory since boot; persisted state in /api/monitors' });
});

/* ------------------- audit / export / tokens ------------------- */

route('GET', '/api/audit', ['admin'], 'سجل التدقيق (آخر 300 عملية)', async ctx => {
  const store = await readStore();
  const limit = Math.min(300, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 100));
  return send(ctx.res, 200, { count: (store.audit || []).length, audit: (store.audit || []).slice(0, limit) });
});

route('GET', '/api/export', ['admin'], 'تصدير الـ store كاملاً (نسخة احتياطية)', async ctx => {
  const store = await readStore();
  return send(ctx.res, 200, { exportedAt: new Date().toISOString(), store });
});

route('POST', '/api/import', ['admin'], 'استيراد store (merge افتراضياً؛ replace:false→replace)', async ctx => {
  const b = ctx.body || {};
  const inc = b.store || b.data;
  if (!inc || typeof inc !== 'object') throw new Error('body needs { store: {...}, merge: true|false }');
  const store = await readStore({ force: true });
  const merge = b.merge !== false;
  const allowed = ['config', 'projects', 'accounts', 'monitors'];
  const sanitized = {};
  for (const k of allowed) if (inc[k] !== undefined) sanitized[k] = inc[k];
  if (!Object.keys(sanitized).length) throw new Error(`no importable keys found (allowed: ${allowed.join(', ')})`);
  if (merge) {
    for (const k of Object.keys(sanitized)) store[k] = deepMerge(store[k] || {}, sanitized[k]);
  } else {
    for (const k of Object.keys(sanitized)) store[k] = sanitized[k];
  }
  auditPush(store, ctx.actor, ctx.ip, 'store.import', { merge, keys: Object.keys(sanitized) });
  const r = await writeStore(store);
  return send(ctx.res, 200, { ok: true, merge, keys: Object.keys(sanitized), persisted: r.saved });
});

route('GET', '/api/tokens', ['admin'], 'قائمة tokens النطاق (hashes فقط)', async ctx => {
  const store = await readStore();
  const tokens = Object.entries(store.tokens || {}).map(([name, t]) => ({
    name, scopes: t.scopes || [], createdAt: t.createdAt || null,
  }));
  return send(ctx.res, 200, { tokens, note: 'raw token shown only once at creation' });
});

route('POST', '/api/tokens', ['admin'], 'إنشاء token نطاق محدود (يُعرض مرة واحدة فقط)', async ctx => {
  const b = ctx.body || {};
  const name = String(b.name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error('invalid name: lowercase letters/digits/dashes, max 32 chars');
  const allowedScopes = ['read', 'write', 'config', 'monitors'];
  const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes)].filter(s => allowedScopes.includes(s)) : [];
  if (!scopes.length) throw new Error(`scopes required: at least one of ${allowedScopes.join(', ')}`);
  const store = await readStore({ force: true });
  if (store.tokens[name]) throw new Error(`token "${name}" already exists — DELETE /api/tokens/${name} first`);
  if (Object.keys(store.tokens).length >= 20) throw new Error('token limit reached (20)');
  const raw = 'tok_' + crypto.randomBytes(24).toString('hex');
  store.tokens[name] = { hash: sha256hex(raw), scopes, createdAt: new Date().toISOString() };
  auditPush(store, ctx.actor, ctx.ip, 'token.create', { name, scopes });
  const r = await writeStore(store);
  return send(ctx.res, 201, {
    ok: true, name, scopes, token: raw, persisted: r.saved,
    warning: 'احفظ هذا الـ token الآن — لن يظهر مجدداً (نخزّن hash فقط)',
  });
});

route('DELETE', '/api/tokens/:name', ['admin'], 'إبطال token', async ctx => {
  const store = await readStore({ force: true });
  if (!store.tokens[ctx.params.name]) throw new Error(`no token named "${ctx.params.name}"`);
  delete store.tokens[ctx.params.name];
  auditPush(store, ctx.actor, ctx.ip, 'token.delete', { name: ctx.params.name });
  const r = await writeStore(store);
  return send(ctx.res, 200, { ok: true, deleted: ctx.params.name, persisted: r.saved });
});

/* ================================================================== *
 *  12. HTTP server
 * ================================================================== */

const server = http.createServer(async (req, res) => {
  currentReq = req;
  try {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return sendError(res, 400, 'bad request url'); }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return sendError(res, 400, 'bad path encoding'); }
    pathname = pathname.replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();
    const ip = clientIp(req);

    /* CORS (allow-list only) */
    const origin = req.headers.origin || '';
    if (origin && CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    /* preflight */
    if (pathname.startsWith('/api') && method === 'OPTIONS') {
      res.writeHead(204, securityHeaders({
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '86400',
      }));
      return res.end();
    }

    /* liveness — no auth, UptimeRobot-friendly (GET/HEAD) */
    if (pathname === '/health' && (method === 'GET' || method === 'HEAD')) {
      return send(res, 200, healthInfo());
    }

    /* readiness — deep check, no auth */
    if (pathname === '/ready' && (method === 'GET' || method === 'HEAD')) {
      return await sendReady(res);
    }

    /* static (dashboard + PWA) — public */
    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
        return send(res, pathname === '/robots.txt' ? 200 : 404,
          pathname === '/robots.txt' ? 'User-agent: *\nDisallow: /api/\n' : 'not found',
          'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
      }
      const staticFile = serveStatic(pathname);
      if (staticFile) return send(res, 200, staticFile.body, staticFile.ct, staticFile.extra);
    }

    /* everything else is /api and authed */
    if (!pathname.startsWith('/api')) return sendError(res, 404, `not found: ${pathname}`);

    const rl = rlAllow(ip);
    if (!rl.ok) {
      return send(res, 429, { error: 'rate limit exceeded — slow down', retryAfterSec: rl.retryAfter },
        'application/json; charset=utf-8', { 'Retry-After': String(rl.retryAfter) });
    }

    const authStore = await readStore();
    const actor = actorFor(req, authStore);
    if (!actor) return sendError(res, 401, 'unauthorized — send Authorization: Bearer <token> (admin key or scoped token)');

    const match = matchRoute(method, pathname);
    if (!match) return sendError(res, 404, `no route: ${method} ${pathname} — see GET /api/docs`);
    if (!canAccess(actor, match.route.scopes)) {
      return sendError(res, 403, `forbidden — token "${actor.name}" lacks required scope (need one of: ${match.route.scopes.join(', ')})`);
    }

    let body = null;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const rb = await readBody(req);
      if (rb === null) return sendError(res, 400, 'invalid or oversized JSON body');
      body = rb;
    }

    const ctx = { req, res, url, method, pathname, params: match.params, actor, body, ip };
    return await match.route.handler(ctx);
  } catch (e) {
    console.error(`[http] ${req.method} ${req.url} failed:`, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
    if (!res.headersSent) return sendError(res, 502, String((e && e.message) || e).slice(0, 300));
  }
});

/* ================================================================== *
 *  13. Boot
 * ================================================================== */

let cycleCount = 0;
(async () => {
  try {
    const store = await readStore({ force: true });
    console.log(`[boot] store v${store.version || '?'} loaded — ${Object.keys(store.projects).length} projects | tokens: ${Object.keys(store.tokens).length} | audits: ${(store.audit || []).length}`);
  } catch (e) {
    console.error('[boot] store load failed (continuing with defaults):', e.message);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[render-fleet] v${VERSION} listening on :${PORT}`);
    console.log(`[render-fleet] GET /health | GET /ready | GET /api/docs (Bearer key) | routes: ${ROUTES.length} | monitors cycle: every ${MONITOR_CYCLE_MS / 60_000} min`);
  });
  setTimeout(() => {
    monitorCycle(false, 0).catch(e => console.error('[monitors] first cycle failed:', e.message));
  }, 15_000);
  setInterval(() => {
    cycleCount++;
    monitorCycle(false, cycleCount).catch(e => console.error('[monitors] cycle failed:', e.message));
  }, MONITOR_CYCLE_MS).unref();
})();
