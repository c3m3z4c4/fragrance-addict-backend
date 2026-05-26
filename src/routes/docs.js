import express from 'express';
const router = express.Router();

// Build endpoint card HTML
function ep(method, path, title, desc, body, query, response) {
    const mClass = { GET: 'm-get', POST: 'm-post', PUT: 'm-put', PATCH: 'm-patch', DELETE: 'm-delete' }[method] || 'm-get';
    const pathHtml = path.replace(/:([a-zA-Z_]+)/g, '<span class="param">:$1</span>');
    const hasDetails = (body && body.length) || (query && query.length) || response;

    const paramRows = (params) => params.map(([n, t, r]) =>
        `<tr><td class="name">${n}</td><td class="type">${t}</td><td class="${r.includes('required') ? 'req' : 'opt'}">${r}</td></tr>`
    ).join('');

    const bodySection = body?.length ? `
      <div class="ep-section"><div class="ep-slabel">Body (JSON)</div>
      <table class="param-table"><thead><tr><th>Field</th><th>Type</th><th>Note</th></tr></thead>
      <tbody>${paramRows(body)}</tbody></table></div>` : '';

    const querySection = query?.length ? `
      <div class="ep-section"><div class="ep-slabel">Query Params</div>
      <table class="param-table"><thead><tr><th>Param</th><th>Type</th><th>Note</th></tr></thead>
      <tbody>${paramRows(query)}</tbody></table></div>` : '';

    const responseSection = response ? `
      <div class="ep-section"><div class="ep-slabel">Response Example</div>
      <pre>${response}</pre><button class="copy-btn">copy</button></div>` : '';

    const body_ = hasDetails ? `<div class="ep-body">${bodySection}${querySection}${responseSection}</div>` : '';

    return `<div class="endpoint">
      <div class="ep-head">
        <span class="ep-method ${mClass}">${method}</span>
        <span class="ep-path">${pathHtml}</span>
        <span class="ep-desc">${desc || ''}</span>
      </div>${body_}</div>`;
}

function group(label, badge, ...endpoints) {
    return `<div class="endpoint-group">
      <div class="eg-title"><span class="pill ${badge}">${label}</span> &nbsp; endpoints</div>
      ${endpoints.join('')}</div>`;
}

function sectionHeader(icon, title, desc) {
    return `<div class="section-header">
      <div class="section-title"><span class="icon">${icon}</span> ${title}</div>
      <div class="section-desc">${desc}</div></div>`;
}

// ── Pre-render all sections ──────────────────────────────────────────────────

const OVERVIEW = sectionHeader('◈', 'Overview', 'PARFUMERÍA backend API — Node.js + Express + PostgreSQL + Puppeteer') +
    `<div class="base-url"><span class="bu-label">Base URL</span><span class="bu-val" id="baseUrlDisplay">—</span><span class="bu-env">production</span></div>
    <div class="overview-grid">
      <div class="ov-card"><h3>Authentication Methods</h3><ul class="ov-list">
        <li><span class="l">JWT Bearer</span><span class="pill badge-auth">requireAuth</span></li>
        <li><span class="l">JWT + superadmin</span><span class="pill badge-super">superAdmin</span></li>
        <li><span class="l">JWT + admin/super</span><span class="pill badge-admin">admin</span></li>
        <li><span class="l">x-api-key header</span><span class="pill badge-key">apiKey</span></li>
        <li><span class="l">No auth required</span><span class="pill badge-public">public</span></li>
      </ul></div>
      <div class="ov-card"><h3>Modules</h3><ul class="ov-list">
        <li><span class="l">/api/auth</span> Authentication &amp; users</li>
        <li><span class="l">/api/perfumes</span> Catalog CRUD</li>
        <li><span class="l">/api/scrape</span> Scraping &amp; queue</li>
        <li><span class="l">/api/algolia</span> Algolia integration</li>
        <li><span class="l">/api/ai</span> AI recommendations</li>
        <li><span class="l">/api/backup</span> Backup &amp; restore</li>
      </ul></div>
      <div class="ov-card"><h3>Headers</h3><ul class="ov-list">
        <li><span class="l">Authorization</span> Bearer &lt;token&gt;</li>
        <li><span class="l">x-api-key</span> &lt;api_key&gt;</li>
        <li><span class="l">Content-Type</span> application/json</li>
      </ul></div>
      <div class="ov-card"><h3>Response Format</h3><ul class="ov-list">
        <li><span class="l">success</span> boolean</li>
        <li><span class="l">data / perfumes</span> payload</li>
        <li><span class="l">pagination</span> { page, limit, total }</li>
        <li><span class="l">error</span> error message string</li>
      </ul></div>
    </div>
    <div class="endpoint-group"><div class="eg-title">Common HTTP Responses</div>
    <pre><span class="key">"200"</span>: { <span class="key">"success"</span>: <span class="bool">true</span>,  <span class="key">"data"</span>: { ... } }
<span class="key">"400"</span>: { <span class="key">"success"</span>: <span class="bool">false</span>, <span class="key">"error"</span>: <span class="str">"Validation error"</span> }
<span class="key">"401"</span>: { <span class="key">"success"</span>: <span class="bool">false</span>, <span class="key">"error"</span>: <span class="str">"Unauthorized"</span> }
<span class="key">"403"</span>: { <span class="key">"success"</span>: <span class="bool">false</span>, <span class="key">"error"</span>: <span class="str">"Forbidden"</span> }
<span class="key">"500"</span>: { <span class="key">"success"</span>: <span class="bool">false</span>, <span class="key">"error"</span>: <span class="str">"Internal server error"</span> }</pre></div>`;

const HEALTH = sectionHeader('♥', 'Health Check', 'Live server status — polled every 10 seconds') +
    `<div class="health-grid">
      <div class="health-card"><div class="hc-label">API Status</div><div class="hc-value green" id="hStatus">—</div></div>
      <div class="health-card"><div class="hc-label">Database</div><div class="hc-value" id="hDb">—</div></div>
      <div class="health-card"><div class="hc-label">Uptime</div><div class="hc-value" id="hUptime">—</div></div>
      <div class="health-card"><div class="hc-label">Memory (heap)</div><div class="hc-value" id="hMem">—</div></div>
      <div class="health-card"><div class="hc-label">Perfumes in DB</div><div class="hc-value green" id="hPerf">—</div></div>
      <div class="health-card"><div class="hc-label">Queue Pending</div><div class="hc-value amber" id="hQueue">—</div></div>
    </div>` +
    group('public', 'badge-public',
        ep('GET', '/api/health', 'Server health status', 'Returns uptime, DB, memory, counts', null, null,
            `{
  <span class="key">"status"</span>: <span class="str">"ok"</span>,
  <span class="key">"uptime"</span>: <span class="num">86400</span>,
  <span class="key">"database"</span>: { <span class="key">"connected"</span>: <span class="bool">true</span>, <span class="key">"stats"</span>: { <span class="key">"perfumes"</span>: <span class="num">5541</span> } },
  <span class="key">"memory"</span>: { <span class="key">"used"</span>: <span class="str">"89 MB"</span> }
}`)
    );

const AUTH = sectionHeader('⊕', 'Authentication', 'JWT-based auth with Google OAuth. Token expires in 7 days.') +
    group('public', 'badge-public',
        ep('POST', '/api/auth/register', 'Register account', '',
            [['email', 'string', 'required'], ['password', 'string', 'required'], ['name', 'string', 'optional']], null,
            `{ <span class="key">"token"</span>: <span class="str">"eyJ..."</span>, <span class="key">"user"</span>: { <span class="key">"role"</span>: <span class="str">"user"</span> } }`),
        ep('POST', '/api/auth/login', 'Login — get JWT', '',
            [['email', 'string', 'required'], ['password', 'string', 'required']], null,
            `{ <span class="key">"token"</span>: <span class="str">"eyJ..."</span>, <span class="key">"user"</span>: { <span class="key">"email"</span>: <span class="str">"..."</span>, <span class="key">"role"</span>: <span class="str">"superadmin"</span> } }`),
        ep('GET', '/api/auth/google', 'Initiate Google OAuth', 'Redirects to Google consent screen'),
        ep('GET', '/api/auth/google/callback', 'Google OAuth callback', 'Redirects with JWT on success')
    ) +
    group('requireAuth', 'badge-auth',
        ep('GET', '/api/auth/me', 'Get current profile', ''),
        ep('PATCH', '/api/auth/me', 'Update profile', '',
            [['name', 'string', 'optional'], ['avatarUrl', 'string', 'optional']]),
        ep('PATCH', '/api/auth/me/password', 'Change password', '',
            [['currentPassword', 'string', 'required'], ['newPassword', 'string', 'required']])
    ) +
    group('superAdmin', 'badge-super',
        ep('GET', '/api/auth/users', 'List all users', '',
            null, [['page', 'number', 'optional'], ['limit', 'number', 'optional']]),
        ep('PATCH', '/api/auth/users/:id', 'Update user', ''),
        ep('PATCH', '/api/auth/users/:id/role', 'Change user role', '',
            [['role', 'string', 'required — user | admin | superadmin']]),
        ep('DELETE', '/api/auth/users/:id', 'Delete user', 'Permanent')
    );

const PERFUMES = sectionHeader('◎', 'Perfumes', 'Core catalog. Reads are public; writes require x-api-key.') +
    group('public', 'badge-public',
        ep('GET', '/api/perfumes', 'List perfumes', 'Filter, sort, paginate',
            null, [['page', 'number', 'optional'], ['limit', 'number', 'optional'], ['brand', 'string', 'optional'], ['gender', 'string', 'optional'], ['sort', 'string', 'optional'], ['q', 'string', 'optional']],
            `{ <span class="key">"data"</span>: [...], <span class="key">"pagination"</span>: { <span class="key">"total"</span>: <span class="num">5541</span>, <span class="key">"page"</span>: <span class="num">1</span>, <span class="key">"limit"</span>: <span class="num">20</span> } }`),
        ep('GET', '/api/perfumes/stats', 'Catalog statistics', ''),
        ep('GET', '/api/perfumes/brands', 'All brand names', 'Distinct, sorted'),
        ep('GET', '/api/perfumes/search', 'Full-text search', '',
            null, [['q', 'string', 'required'], ['limit', 'number', 'optional']]),
        ep('GET', '/api/perfumes/brand/:brand', 'Perfumes by brand', ''),
        ep('GET', '/api/perfumes/perfumers', 'List all perfumers', ''),
        ep('GET', '/api/perfumes/perfumer/:name', 'Perfumes by perfumer', ''),
        ep('GET', '/api/perfumes/perfumer/:name/brands', 'Brands by perfumer', ''),
        ep('GET', '/api/perfumes/perfumer/:name/brand/:brand', 'Perfumer + brand', ''),
        ep('GET', '/api/perfumes/:id', 'Get single perfume', 'Full object with notes, accords, metrics')
    ) +
    group('x-api-key', 'badge-key',
        ep('POST', '/api/perfumes', 'Create perfume', '',
            [['name', 'string', 'required'], ['brand', 'string', 'required'], ['sourceUrl', 'string', 'required']]),
        ep('PUT', '/api/perfumes/:id', 'Update perfume', ''),
        ep('DELETE', '/api/perfumes/:id', 'Delete perfume', 'Permanent')
    );

const SCRAPER = sectionHeader('⧫', 'Scraper', 'Puppeteer pipeline. Persistent DB queue. 15s delay between requests.') +
    group('superAdmin — single &amp; batch', 'badge-super',
        ep('GET', '/api/scrape/perfume', 'Scrape single URL', '',
            null, [['url', 'string', 'required'], ['save', 'boolean', 'optional — saves to DB']]),
        ep('POST', '/api/scrape/batch', 'Batch scrape (max 10)', '',
            [['urls', 'string[]', 'required — max 10'], ['save', 'boolean', 'optional']])
    ) +
    group('superAdmin — brand scraping', 'badge-super',
        ep('POST', '/api/scrape/brand', 'Scrape brand page', '',
            [['brand', 'string', 'required'], ['limit', 'number', 'optional — default 500'], ['autoStart', 'boolean', 'optional']]),
        ep('POST', '/api/scrape/brands', 'Scrape multiple brands (max 20)', '',
            [['brands', 'string[]', 'required'], ['limitPerBrand', 'number', 'optional'], ['autoStart', 'boolean', 'optional']]),
        ep('POST', '/api/scrape/brands/bulk', 'Background bulk brand import', '',
            [['brands', 'string[]', 'required'], ['limitPerBrand', 'number', 'optional']]),
        ep('POST', '/api/scrape/brands/bulk/pause', 'Pause / resume bulk import', ''),
        ep('POST', '/api/scrape/brands/bulk/stop', 'Stop bulk import', ''),
        ep('GET', '/api/scrape/brands/bulk/status', 'Bulk import job status', '')
    ) +
    group('superAdmin — logos', 'badge-super',
        ep('POST', '/api/scrape/brands/logos', 'Fetch brand logos', 'Multi-source: Clearbit → DDG → Parfumo → Fragrantica',
            [['force', 'boolean', 'optional']]),
        ep('GET', '/api/scrape/brands/logos/status', 'Logo job status', ''),
        ep('GET', '/api/scrape/brands/without-logos', 'Brands missing logos', ''),
        ep('POST', '/api/scrape/brands/logo/upload', 'Upload single brand logo', 'multipart/form-data',
            [['brandName', 'string', 'required'], ['file', 'image', 'required — PNG/JPG/WEBP/SVG']]),
        ep('POST', '/api/scrape/brands/logos/bulk-upload', 'Bulk upload logos', 'multipart/form-data',
            [['files[]', 'image[]', 'required — up to 100'], ['mapping', 'JSON string', 'optional']])
    ) +
    group('superAdmin — queue', 'badge-super',
        ep('POST', '/api/scrape/queue', 'Add URLs to queue', 'Deduplicates vs DB',
            [['urls', 'string[]', 'required']], null,
            `{ <span class="key">"added"</span>: <span class="num">150</span>, <span class="key">"skipped"</span>: <span class="num">12</span>, <span class="key">"queueSize"</span>: <span class="num">2958</span> }`),
        ep('POST', '/api/scrape/queue/start', 'Start queue processing', ''),
        ep('POST', '/api/scrape/queue/stop', 'Pause queue', 'URLs persist; resume any time'),
        ep('GET', '/api/scrape/queue/status', 'Queue status + live stats', '', null, null,
            `{
  <span class="key">"processing"</span>: <span class="bool">true</span>, <span class="key">"remaining"</span>: <span class="num">2958</span>,
  <span class="key">"processed"</span>: <span class="num">6073</span>, <span class="key">"failed"</span>: <span class="num">4</span>,
  <span class="key">"processingRatePerHour"</span>: <span class="num">240</span>, <span class="key">"etaMs"</span>: <span class="num">44280000</span>
}`),
        ep('POST', '/api/scrape/queue/check', 'Check which URLs exist', '',
            [['urls', 'string[]', 'required']]),
        ep('POST', '/api/scrape/queue/retry-failed', 'Retry all failed URLs', ''),
        ep('DELETE', '/api/scrape/queue', 'Clear queue', '',
            null, [['status', 'string', 'optional — failed | done | pending (omit = all)']])
    ) +
    group('superAdmin — catalog discovery', 'badge-super',
        ep('POST', '/api/scrape/catalog/upload', 'Upload sitemap XML files', 'multipart/form-data',
            [['sitemaps', 'file[]', 'required — up to 20 .xml files']]),
        ep('POST', '/api/scrape/catalog/full', 'Full catalog discovery', 'Fetches all sitemaps via Googlebot UA / Wayback'),
        ep('POST', '/api/scrape/sitemap', 'Get URLs from sitemap/brand', '',
            [['brand', 'string', 'optional'], ['limit', 'number', 'optional']])
    ) +
    group('superAdmin — maintenance', 'badge-super',
        ep('GET', '/api/scrape/incomplete', 'Perfumes missing data', '',
            null, [['limit', 'number', 'optional — max 1000']]),
        ep('GET', '/api/scrape/incomplete/by-brand', 'Incomplete grouped by brand', ''),
        ep('POST', '/api/scrape/rescrape', 'Re-scrape by IDs (max 100)', '',
            [['ids', 'string[]', 'required']]),
        ep('POST', '/api/scrape/rescrape/queue', 'Queue all incomplete', ''),
        ep('POST', '/api/scrape/rescrape/queue/ids', 'Queue by IDs (max 2000)', '',
            [['ids', 'string[]', 'required']]),
        ep('POST', '/api/scrape/rescrape/brand', 'Re-scrape incomplete from brand', '',
            [['brand', 'string', 'required'], ['direct', 'boolean', 'optional — sync mode, max 100']]),
        ep('GET', '/api/scrape/duplicates', 'Find duplicate perfumes', ''),
        ep('DELETE', '/api/scrape/duplicates', 'Remove duplicates', 'Keeps highest-rated'),
        ep('GET', '/api/scrape/cache/stats', 'Cache stats', ''),
        ep('DELETE', '/api/scrape/cache', 'Clear cache', ''),
        ep('POST', '/api/scrape/reset', '⚠ RESET ALL DATA — irreversible', '',
            [['confirm', 'string', 'required — must equal "CONFIRM_RESET"']])
    );

const ALGOLIA = sectionHeader('◉', 'Algolia', 'Fragrantica uses Algolia (App: FGVI612DFZ, Index: fragrantica_perfumes). Key from browser DevTools — expires ~3 weeks.') +
    group('superAdmin', 'badge-super',
        ep('GET', '/api/algolia/status', 'Key validity + job state', '', null, null,
            `{
  <span class="key">"valid"</span>: <span class="bool">true</span>, <span class="key">"expiresAt"</span>: <span class="str">"2026-06-14T00:00:00Z"</span>,
  <span class="key">"job"</span>: { <span class="key">"phase"</span>: <span class="str">"done"</span>, <span class="key">"perfumesDiscovered"</span>: <span class="num">131000</span> }
}`),
        ep('POST', '/api/algolia/key', 'Save API key', 'Persists for session',
            [['apiKey', 'string', 'required — x-algolia-api-key from DevTools']]),
        ep('GET', '/api/algolia/brands', 'Fetch all brands from Algolia', '~1,853 brands via facet iteration'),
        ep('POST', '/api/algolia/import/catalog', 'Start full catalog import', 'Background job — per-brand facetFilters pagination', null, null,
            `{ <span class="key">"success"</span>: <span class="bool">true</span>, <span class="key">"message"</span>: <span class="str">"Algolia catalog import started in background"</span> }`),
        ep('POST', '/api/algolia/import/stop', 'Stop catalog import', '')
    );

const AI = sectionHeader('★', 'AI', 'Multi-provider recommendations. Supports Gemini, OpenAI, Anthropic.') +
    group('superAdmin — provider mgmt', 'badge-super',
        ep('GET', '/api/ai/providers', 'List AI providers', ''),
        ep('PUT', '/api/ai/providers/:provider/key', 'Set provider API key', '',
            [['apiKey', 'string', 'required']]),
        ep('PATCH', '/api/ai/providers/:provider/model', 'Set provider model', '',
            [['model', 'string', 'required']]),
        ep('POST', '/api/ai/providers/:provider/activate', 'Activate provider', ''),
        ep('POST', '/api/ai/providers/:provider/test', 'Test provider connection', ''),
        ep('GET', '/api/ai/config', 'Get AI config', ''),
        ep('PATCH', '/api/ai/config', 'Update AI config', '',
            [['systemPrompt', 'string', 'optional'], ['temperature', 'number', 'optional'], ['maxTokens', 'number', 'optional']])
    ) +
    group('requireAuth', 'badge-auth',
        ep('GET', '/api/ai/models', 'List available models', ''),
        ep('POST', '/api/ai/recommendations', 'Get AI recommendations', '',
            [['preferences', 'string', 'required'], ['limit', 'number', 'optional']], null,
            `{ <span class="key">"recommendations"</span>: [{ <span class="key">"name"</span>: <span class="str">"Sauvage"</span>, <span class="key">"score"</span>: <span class="num">0.94</span> }] }`)
    );

const FAVORITES = sectionHeader('♡', 'Favorites', 'Per-user favorites list. All endpoints require authentication.') +
    group('requireAuth', 'badge-auth',
        ep('GET', '/api/favorites', 'Get my favorites', ''),
        ep('POST', '/api/favorites/:id', 'Add to favorites', ''),
        ep('DELETE', '/api/favorites/:id', 'Remove from favorites', '')
    );

const PERFUMERS = sectionHeader('◷', 'Perfumers', 'Perfumer/nose profiles with autofill support.') +
    group('public', 'badge-public',
        ep('GET', '/api/perfumers', 'List all perfumers', 'Sorted by perfume count'),
        ep('GET', '/api/perfumers/:name', 'Get perfumer', 'Full profile + associated perfumes')
    ) +
    group('superAdmin', 'badge-super',
        ep('GET', '/api/perfumers/autofill/status', 'Autofill job status', ''),
        ep('PUT', '/api/perfumers/:name', 'Update perfumer', ''),
        ep('PATCH', '/api/perfumers/:name/verify', 'Toggle verified status', ''),
        ep('POST', '/api/perfumers/:name/autofill', 'Autofill perfumer data', ''),
        ep('POST', '/api/perfumers/bulk-autofill', 'Bulk autofill all unverified', ''),
        ep('DELETE', '/api/perfumers/:name', 'Delete perfumer', '')
    );

const CONTENT = sectionHeader('≡', 'Content', 'CMS-style content blocks (About page, etc.)') +
    group('public', 'badge-public',
        ep('GET', '/api/content/about', 'Get about page content', '')
    ) +
    group('superAdmin', 'badge-super',
        ep('PUT', '/api/content/about', 'Update about page', '',
            [['content', 'string', 'required'], ['title', 'string', 'optional']])
    );

const BACKUP = sectionHeader('⊞', 'Backup', 'Full DB backup/restore with configurable destinations.') +
    group('superAdmin', 'badge-super',
        ep('GET', '/api/backup/config', 'Get backup config', ''),
        ep('POST', '/api/backup/config', 'Update backup config', '',
            [['schedule', 'string', 'optional — cron'], ['destination', 'string', 'optional'], ['retention', 'number', 'optional']]),
        ep('POST', '/api/backup/create', 'Create backup now', ''),
        ep('GET', '/api/backup/list', 'List backups', ''),
        ep('POST', '/api/backup/restore', 'Restore from backup', '',
            [['filename', 'string', 'required'], ['source', 'string', 'optional — local | remote']]),
        ep('DELETE', '/api/backup/local/:filename', 'Delete local backup', ''),
        ep('POST', '/api/backup/test-destination', 'Test backup destination', ''),
        ep('GET', '/api/backup/export', 'Export all data as JSON', ''),
        ep('POST', '/api/backup/import', 'Import data from JSON', '',
            [['data', 'object', 'required'], ['merge', 'boolean', 'optional']])
    );

const ACTIVITY = sectionHeader('⟁', 'Activity', 'Event logging and analytics.') +
    group('public', 'badge-public',
        ep('POST', '/api/activity/log', 'Log event', '',
            [['event', 'string', 'required'], ['data', 'object', 'optional']])
    ) +
    group('superAdmin', 'badge-super',
        ep('GET', '/api/activity/stats', 'Activity statistics', '')
    );

const APIKEYS = sectionHeader('⊗', 'API Keys', 'Programmatic access. Pass key via x-api-key header.') +
    group('x-api-key', 'badge-key',
        ep('POST', '/api/keys/generate', 'Generate new key', '',
            [['name', 'string', 'required'], ['scopes', 'string[]', 'optional']]),
        ep('GET', '/api/keys', 'List keys', ''),
        ep('GET', '/api/keys/stats', 'Key usage stats', ''),
        ep('DELETE', '/api/keys/:id', 'Revoke key', '')
    ) +
    group('public', 'badge-public',
        ep('POST', '/api/keys/validate', 'Validate key', '',
            [['apiKey', 'string', 'required']], null,
            `{ <span class="key">"valid"</span>: <span class="bool">true</span>, <span class="key">"scopes"</span>: [<span class="str">"read"</span>, <span class="str">"write"</span>] }`)
    );

// ── HTML ─────────────────────────────────────────────────────────────────────

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PARFUMERÍA — API Console</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#04060a;--bg1:#080c12;--bg2:#0d1219;--bg3:#121820;
  --border:#1a2030;--border2:#243040;
  --green:#00e87a;--gdim:#00a855;--gbg:rgba(0,232,122,.06);
  --amber:#ffab00;--adim:#c27f00;--abg:rgba(255,171,0,.06);
  --blue:#38bdf8;--bdim:#0e7490;--bbg:rgba(56,189,248,.06);
  --red:#ff4d6a;--rdim:#b91c3a;--rbg:rgba(255,77,106,.06);
  --purple:#b06aff;
  --text:#c5d0dc;--text2:#7a8fa8;--text3:#3d5068;
  --font:'JetBrains Mono',monospace;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.6;overflow:hidden}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:var(--bg1)}
::-webkit-scrollbar-thumb{background:var(--border2)}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;
  background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.025) 2px,rgba(0,0,0,.025) 4px)}
/* LOGIN */
#login{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg);z-index:100}
.login-bg{position:fixed;inset:0;background:radial-gradient(ellipse 60% 50% at 50% 50%,rgba(0,232,122,.04),transparent 70%);pointer-events:none}
.login-grid{position:fixed;inset:0;pointer-events:none;
  background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);
  background-size:40px 40px;opacity:.4}
.login-box{position:relative;z-index:1;width:420px;border:1px solid var(--border2);background:var(--bg1);padding:2rem 2.5rem}
.login-box::before{content:'';position:absolute;inset:-1px;
  background:linear-gradient(135deg,rgba(0,232,122,.12),transparent 50%,rgba(0,232,122,.04));pointer-events:none}
.ascii-logo{font-size:9.5px;line-height:1.25;color:var(--gdim);margin-bottom:1.5rem;text-align:center;white-space:pre}
.login-title{color:var(--green);font-size:11px;letter-spacing:.2em;text-transform:uppercase;margin-bottom:.2rem}
.login-sub{color:var(--text3);font-size:11px;margin-bottom:1.75rem}
.field{margin-bottom:1rem}
.field label{display:block;font-size:10px;color:var(--text2);letter-spacing:.12em;text-transform:uppercase;margin-bottom:.4rem}
.field input{width:100%;background:var(--bg2);border:1px solid var(--border2);color:var(--text);
  font-family:var(--font);font-size:13px;padding:.55rem .8rem;outline:none;transition:border-color .15s,box-shadow .15s}
.field input:focus{border-color:var(--gdim);box-shadow:0 0 0 2px rgba(0,232,122,.1)}
.field input::placeholder{color:var(--text3)}
.btn-login{width:100%;background:var(--green);color:#000;border:none;font-family:var(--font);
  font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;
  padding:.65rem;cursor:pointer;transition:background .15s,box-shadow .15s;margin-top:.5rem}
.btn-login:hover{background:#00ff88;box-shadow:0 0 20px rgba(0,232,122,.25)}
.btn-login:disabled{background:var(--text3);cursor:not-allowed;box-shadow:none}
.login-error{font-size:11px;color:var(--red);margin-top:.75rem;padding:.5rem .75rem;background:var(--rbg);border:1px solid var(--rdim);display:none}
/* BLINK */
.blink{animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
/* APP */
#app{display:none;height:100vh;flex-direction:column}
#app.v{display:flex}
/* TOPBAR */
#tb{display:flex;align-items:center;gap:1rem;padding:0 1rem;height:40px;background:var(--bg1);border-bottom:1px solid var(--border);flex-shrink:0}
.tb-logo{font-size:12px;font-weight:700;color:var(--green);letter-spacing:.15em;white-space:nowrap}
.tb-logo s2{color:var(--text2);font-weight:400}
.tb-mid{flex:1;display:flex;align-items:center;gap:.75rem;padding:0 1rem;border-left:1px solid var(--border);border-right:1px solid var(--border);overflow:hidden}
.pill{display:inline-flex;align-items:center;gap:.35rem;font-size:10px;padding:.15rem .45rem;border:1px solid;letter-spacing:.07em}
.pg{color:var(--green);border-color:rgba(0,232,122,.3);background:var(--gbg)}
.pa{color:var(--amber);border-color:rgba(255,171,0,.3);background:var(--abg)}
.pr{color:var(--red);border-color:rgba(255,77,106,.3);background:var(--rbg)}
.pb{color:var(--blue);border-color:rgba(56,189,248,.3);background:var(--bbg)}
.dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.dot.pulse{animation:p 2s ease infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}
.tb-user{font-size:11px;color:var(--text2);white-space:nowrap}
.tb-user em{color:var(--green);font-style:normal}
.btn-sm{font-family:var(--font);font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:.3rem .7rem;
  cursor:pointer;border:1px solid;background:transparent;transition:all .15s}
.btn-sm.logout{border-color:rgba(255,77,106,.3);color:var(--red)}
.btn-sm.logout:hover{border-color:var(--red);background:var(--rbg)}
/* MAIN */
#main{display:flex;flex:1;overflow:hidden}
/* SIDEBAR */
#sb{width:196px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column}
.sb-sec{padding:.6rem 0;border-bottom:1px solid var(--border)}
.sb-lbl{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--text3);padding:.2rem 1rem .35rem}
.ni{display:flex;align-items:center;gap:.5rem;padding:.32rem 1rem;font-size:11px;color:var(--text2);cursor:pointer;
  transition:all .1s;border-left:2px solid transparent;user-select:none}
.ni:hover{color:var(--text);background:rgba(255,255,255,.02)}
.ni.on{color:var(--green);border-left-color:var(--green);background:var(--gbg)}
.ni .ic{font-size:10px;width:14px;text-align:center;flex-shrink:0}
.ni .nc{margin-left:auto;font-size:9px;color:var(--text3);background:var(--bg2);padding:.1rem .3rem}
/* QUEUE WIDGET */
.ql{padding:.9rem 1rem;border-top:1px solid var(--border);margin-top:auto}
.ql-t{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);margin-bottom:.5rem}
.ql-s{display:flex;justify-content:space-between;font-size:11px;padding:.08rem 0}
.ql-s .k{color:var(--text2)}.ql-s .v{color:var(--green);font-weight:500}
.ql-s .v.a{color:var(--amber)}.ql-s .v.r{color:var(--red)}
.ql-prog{height:3px;background:var(--border2);margin:.5rem 0;overflow:hidden}
.ql-bar{height:100%;background:var(--green);transition:width .5s ease}
.ql-proc{display:flex;align-items:center;gap:.35rem;font-size:10px;color:var(--gdim);margin-top:.35rem}
/* CONTENT */
#content{flex:1;overflow-y:auto;padding:2rem}
.sec{display:none}
.sec.on{display:block}
/* SECTION HEADER */
.sh{margin-bottom:1.75rem}
.sh-title{font-size:17px;font-weight:700;color:var(--text);letter-spacing:.04em;display:flex;align-items:center;gap:.6rem;margin-bottom:.3rem}
.sh-title .ic{font-size:13px;color:var(--green)}
.sh-desc{font-size:12px;color:var(--text2);max-width:620px}
/* BADGES */
.badge-super{color:var(--red);border-color:rgba(255,77,106,.4);background:var(--rbg)}
.badge-admin{color:var(--amber);border-color:rgba(255,171,0,.4);background:var(--abg)}
.badge-auth{color:var(--blue);border-color:rgba(56,189,248,.4);background:var(--bbg)}
.badge-public{color:var(--text2);border-color:var(--border2)}
.badge-key{color:var(--purple);border-color:rgba(176,106,255,.4);background:rgba(176,106,255,.06)}
/* HEALTH GRID */
.hg{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1rem;margin-bottom:2rem}
.hc{background:var(--bg1);border:1px solid var(--border);padding:.9rem 1.1rem}
.hc-l{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);margin-bottom:.4rem}
.hc-v{font-size:20px;font-weight:700;color:var(--text)}
.hc-v.green{color:var(--green)}.hc-v.amber{color:var(--amber)}.hc-v.red{color:var(--red)}
/* OVERVIEW GRID */
.og{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:2rem}
.oc{background:var(--bg1);border:1px solid var(--border);padding:1.1rem 1.25rem}
.oc h3{font-size:10px;color:var(--text2);letter-spacing:.1em;text-transform:uppercase;margin-bottom:.65rem}
.ol{list-style:none}
.ol li{display:flex;align-items:center;gap:.5rem;padding:.2rem 0;font-size:11px;color:var(--text2);border-bottom:1px solid var(--border)}
.ol li:last-child{border-bottom:none}
.ol .l{color:var(--text);min-width:115px;flex-shrink:0}
/* ENDPOINT GROUP */
.eg{margin-bottom:1.75rem}
.eg-t{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);
  padding:.35rem 0;border-bottom:1px solid var(--border);margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.endpoint{background:var(--bg1);border:1px solid var(--border);margin-bottom:.4rem;transition:border-color .15s}
.endpoint:hover{border-color:var(--border2)}
.ep-h{display:flex;align-items:center;gap:.65rem;padding:.55rem .85rem;cursor:pointer;user-select:none}
.mth{font-size:10px;font-weight:700;letter-spacing:.08em;min-width:46px;text-align:center;padding:.15rem .35rem;flex-shrink:0}
.m-get{color:#34d399;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.2)}
.m-post{color:#60a5fa;background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.2)}
.m-put{color:#fbbf24;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.2)}
.m-patch{color:#a78bfa;background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.2)}
.m-delete{color:#f87171;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.2)}
.ep-path{font-size:12px;color:var(--text);flex:1;letter-spacing:.02em}
.ep-path .param{color:var(--amber)}
.ep-desc{font-size:11px;color:var(--text2);text-align:right}
.ep-body{display:none;padding:.65rem .85rem .9rem;border-top:1px solid var(--border);background:var(--bg2)}
.ep-body.open{display:block}
.ep-sl{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--text3);margin:.6rem 0 .35rem}
.ep-sl:first-child{margin-top:0}
.pt{width:100%;border-collapse:collapse;font-size:11px}
.pt th{text-align:left;padding:.28rem .45rem;background:var(--bg3);color:var(--text3);font-weight:400;font-size:10px;letter-spacing:.07em}
.pt td{padding:.28rem .45rem;border-top:1px solid var(--border);color:var(--text2)}
.pt td.n{color:var(--gdim)}.pt td.t{color:var(--adim);font-size:10px}
.pt td.req{color:var(--red);font-size:10px}.pt td.opt{color:var(--text3);font-size:10px}
code{font-family:var(--font);font-size:11px;background:var(--bg);color:var(--green);padding:.1rem .3rem;border:1px solid var(--border)}
pre{background:var(--bg);border:1px solid var(--border);padding:.65rem .8rem;overflow-x:auto;font-size:11px;color:var(--text2);line-height:1.55}
pre .key{color:var(--amber)}pre .str{color:var(--green)}pre .num{color:var(--blue)}pre .bool{color:var(--purple)}
.copy-btn{font-family:var(--font);font-size:9px;letter-spacing:.07em;text-transform:uppercase;padding:.18rem .45rem;
  cursor:pointer;border:1px solid var(--border2);background:transparent;color:var(--text3);transition:all .15s;float:right;margin-top:-1.4rem}
.copy-btn:hover{color:var(--green);border-color:var(--gdim)}
.copy-btn.copied{color:var(--green);border-color:var(--green)}
/* BASE URL */
.bu{display:flex;align-items:center;gap:.75rem;background:var(--bg1);border:1px solid var(--border);padding:.55rem 1rem;margin-bottom:1.75rem}
.bu-lbl{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)}
.bu-val{font-size:12px;color:var(--blue);flex:1}
.bu-env{font-size:10px;padding:.18rem .45rem;background:var(--gbg);color:var(--green);border:1px solid rgba(0,232,122,.2)}
@media(max-width:768px){#sb{display:none}.og{grid-template-columns:1fr}.hg{grid-template-columns:1fr 1fr}.login-box{width:90%;padding:1.5rem}}
</style>
</head>
<body>
<div id="login">
  <div class="login-bg"></div><div class="login-grid"></div>
  <div class="login-box">
    <div class="ascii-logo"> ____  _   ____  _____ _   _ __  __ _____ ____  ___   _
|  _ \\/ | |  _ \\|  ___| | | |  \\/  || ___|  _ \\|_ _| / \\
| |_) / | | |_) | |_  | | | | |\\/| || |__ | |_) || | / _ \\
|  __/| | |  _ &lt;|  _| | |_| | |  | ||  __||    / | |/ ___ \\
|_|   |_| |_| \\_\\_|    \\___/|_|  |_||_|   |_|\\_\\|___/_/   \\_\\</div>
    <div class="login-title">API Console</div>
    <div class="login-sub">Restricted — superadmin &amp; admin only</div>
    <div class="field"><label>Email</label>
      <input type="email" id="em" placeholder="admin@domain.com" autocomplete="username"></div>
    <div class="field"><label>Password</label>
      <input type="password" id="pw" placeholder="••••••••••••" autocomplete="current-password"></div>
    <button class="btn-login" id="lbtn" onclick="doLogin()"><span id="ll">AUTHENTICATE</span></button>
    <div class="login-error" id="lerr"></div>
  </div>
</div>

<div id="app">
  <div id="tb">
    <div class="tb-logo">PARFUMERÍA <s2>API</s2></div>
    <div class="tb-mid">
      <span id="hPill" class="pill pa"><span class="dot pulse"></span> checking...</span>
      <span id="dPill" class="pill pa"><span class="dot pulse"></span> db</span>
      <span id="qPill" class="pill pb"><span class="dot"></span> queue</span>
    </div>
    <div class="tb-user">session: <em id="uem">—</em></div>
    <button class="btn-sm logout" onclick="logout()">LOGOUT</button>
  </div>
  <div id="main">
    <div id="sb">
      <div class="sb-sec">
        <div class="sb-lbl">Navigation</div>
        <div class="ni on" onclick="go('overview')" id="n-overview"><span class="ic">◈</span>Overview</div>
        <div class="ni" onclick="go('health')" id="n-health"><span class="ic">♥</span>Health</div>
      </div>
      <div class="sb-sec">
        <div class="sb-lbl">Endpoints</div>
        <div class="ni" onclick="go('auth')" id="n-auth"><span class="ic">⊕</span>Auth<span class="nc">11</span></div>
        <div class="ni" onclick="go('perfumes')" id="n-perfumes"><span class="ic">◎</span>Perfumes<span class="nc">13</span></div>
        <div class="ni" onclick="go('scraper')" id="n-scraper"><span class="ic">⧫</span>Scraper<span class="nc">26</span></div>
        <div class="ni" onclick="go('algolia')" id="n-algolia"><span class="ic">◉</span>Algolia<span class="nc">5</span></div>
        <div class="ni" onclick="go('ai')" id="n-ai"><span class="ic">★</span>AI<span class="nc">8</span></div>
        <div class="ni" onclick="go('favorites')" id="n-favorites"><span class="ic">♡</span>Favorites<span class="nc">3</span></div>
        <div class="ni" onclick="go('perfumers')" id="n-perfumers"><span class="ic">◷</span>Perfumers<span class="nc">8</span></div>
        <div class="ni" onclick="go('content')" id="n-content"><span class="ic">≡</span>Content<span class="nc">2</span></div>
        <div class="ni" onclick="go('backup')" id="n-backup"><span class="ic">⊞</span>Backup<span class="nc">9</span></div>
        <div class="ni" onclick="go('activity')" id="n-activity"><span class="ic">⟁</span>Activity<span class="nc">2</span></div>
        <div class="ni" onclick="go('apikeys')" id="n-apikeys"><span class="ic">⊗</span>API Keys<span class="nc">5</span></div>
      </div>
      <div class="ql">
        <div class="ql-t">Live Queue</div>
        <div class="ql-prog"><div class="ql-bar" id="qb" style="width:0%"></div></div>
        <div class="ql-s"><span class="k">pending</span><span class="v a" id="qp">—</span></div>
        <div class="ql-s"><span class="k">completed</span><span class="v" id="qd">—</span></div>
        <div class="ql-s"><span class="k">failed</span><span class="v r" id="qf">—</span></div>
        <div class="ql-s"><span class="k">total</span><span class="v" id="qt">—</span></div>
        <div class="ql-proc" id="qpr" style="display:none"><span class="dot pulse" style="color:var(--green)"></span>processing</div>
      </div>
    </div>
    <div id="content">
      <div class="sec on" id="s-overview">${OVERVIEW}</div>
      <div class="sec" id="s-health">${HEALTH}</div>
      <div class="sec" id="s-auth">${AUTH}</div>
      <div class="sec" id="s-perfumes">${PERFUMES}</div>
      <div class="sec" id="s-scraper">${SCRAPER}</div>
      <div class="sec" id="s-algolia">${ALGOLIA}</div>
      <div class="sec" id="s-ai">${AI}</div>
      <div class="sec" id="s-favorites">${FAVORITES}</div>
      <div class="sec" id="s-perfumers">${PERFUMERS}</div>
      <div class="sec" id="s-content">${CONTENT}</div>
      <div class="sec" id="s-backup">${BACKUP}</div>
      <div class="sec" id="s-activity">${ACTIVITY}</div>
      <div class="sec" id="s-apikeys">${APIKEYS}</div>
    </div>
  </div>
</div>
<script>
const API=window.location.origin;
let tok=localStorage.getItem('dt');
let hi,qi;
async function doLogin(){
  const em=document.getElementById('em').value.trim(),pw=document.getElementById('pw').value;
  const btn=document.getElementById('lbtn'),ll=document.getElementById('ll'),err=document.getElementById('lerr');
  if(!em||!pw){showE('Email and password required');return;}
  btn.disabled=true;ll.textContent='AUTHENTICATING...';err.style.display='none';
  try{
    const r=await fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em,password:pw})});
    const d=await r.json();
    if(!r.ok||!d.token) throw new Error(d.error||d.message||'Authentication failed');
    const role=d.user?.role||'';
    if(!['admin','superadmin'].includes(role)) throw new Error('Access denied — admin or superadmin required');
    localStorage.setItem('dt',d.token);localStorage.setItem('du',JSON.stringify(d.user));
    tok=d.token;launch(d.user);
  }catch(e){showE(e.message);}
  finally{btn.disabled=false;ll.textContent='AUTHENTICATE';}
}
function showE(m){const e=document.getElementById('lerr');e.textContent='⊗ '+m;e.style.display='block';}
function logout(){localStorage.removeItem('dt');localStorage.removeItem('du');clearInterval(hi);clearInterval(qi);
  document.getElementById('app').classList.remove('v');document.getElementById('login').style.display='flex';tok=null;}
function launch(u){
  document.getElementById('login').style.display='none';
  document.getElementById('app').classList.add('v');
  document.getElementById('uem').textContent=u.email||u.name||'admin';
  const bu=document.getElementById('baseUrlDisplay');if(bu)bu.textContent=API;
  pollH();pollQ();hi=setInterval(pollH,10000);qi=setInterval(pollQ,5000);
}
async function pollH(){
  try{
    const r=await fetch(API+'/api/health');const d=await r.json();
    const ok=d.status==='ok'||d.status==='healthy';
    setV('hStatus',ok?'ONLINE':'DEGRADED',ok?'green':'red');
    setV('hDb',d.database?.connected?'CONNECTED':'ERROR',d.database?.connected?'green':'red');
    setV('hUptime',fmt(d.uptime));
    setV('hMem',d.memory?.used||d.memory?.rss||'—');
    setV('hPerf',(d.database?.stats?.perfumes??'—').toLocaleString(),'green');
    setV('hQueue',(d.queue?.pending??'—').toLocaleString(),'amber');
    const hp=document.getElementById('hPill');
    hp.className='pill '+(ok?'pg':'pr');hp.innerHTML='<span class="dot'+(ok?' pulse':'')+'">&nbsp;</span>&nbsp;'+(ok?'healthy':'degraded');
    const dp=document.getElementById('dPill');
    dp.className='pill '+(d.database?.connected?'pg':'pr');dp.innerHTML='<span class="dot"></span>&nbsp;db '+(d.database?.connected?'ok':'error');
  }catch(e){setV('hStatus','OFFLINE','red');}
}
async function pollQ(){
  try{
    const r=await fetch(API+'/api/scrape/queue/status',{headers:{Authorization:'Bearer '+tok}});
    const d=await r.json();
    const tot=d.total||1,done=d.processed||0,pct=Math.min(100,Math.round(done/tot*100));
    document.getElementById('qp').textContent=(d.remaining??'—').toLocaleString?.()??d.remaining??'—';
    document.getElementById('qd').textContent=(d.processed??'—').toLocaleString?.()??d.processed??'—';
    document.getElementById('qf').textContent=(d.failed??'—').toLocaleString?.()??d.failed??'—';
    document.getElementById('qt').textContent=(d.total??'—').toLocaleString?.()??d.total??'—';
    document.getElementById('qb').style.width=pct+'%';
    document.getElementById('qpr').style.display=d.processing?'flex':'none';
    const qp2=document.getElementById('qPill');
    qp2.className='pill '+(d.processing?'pg':'pb');
    qp2.innerHTML='<span class="dot'+(d.processing?' pulse':'')+'">&nbsp;</span>&nbsp;queue '+(d.processing?'running':'paused');
  }catch(e){}
}
function setV(id,val,cls){const e=document.getElementById(id);if(!e)return;e.textContent=val;if(cls)e.className='hc-v '+cls;}
function fmt(s){if(!s)return'—';const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);return(d>0?d+'d ':'')+h+'h '+m+'m';}
function go(n){
  document.querySelectorAll('.sec').forEach(s=>s.classList.remove('on'));
  document.querySelectorAll('.ni').forEach(i=>i.classList.remove('on'));
  const s=document.getElementById('s-'+n),ni=document.getElementById('n-'+n);
  if(s)s.classList.add('on');if(ni)ni.classList.add('on');
  document.getElementById('content').scrollTop=0;
}
document.addEventListener('click',e=>{
  const h=e.target.closest('.ep-h');
  if(h){const b=h.nextElementSibling;if(b?.classList.contains('ep-body'))b.classList.toggle('open');}
  if(e.target.classList.contains('copy-btn')){
    const pre=e.target.previousElementSibling;if(!pre)return;
    navigator.clipboard.writeText(pre.innerText).catch(()=>{});
    e.target.textContent='copied!';e.target.classList.add('copied');
    setTimeout(()=>{e.target.textContent='copy';e.target.classList.remove('copied');},1500);
  }
});
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
document.getElementById('em').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('pw').focus();});
(function init(){
  if(tok){const u=JSON.parse(localStorage.getItem('du')||'{}');if(u.email){launch(u);return;}}
  document.getElementById('login').style.display='flex';
})();
<\/script>
</body>
</html>`;

router.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'no-store');
    res.send(PAGE);
});

export default router;
