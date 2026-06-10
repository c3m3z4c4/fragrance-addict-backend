/**
 * Hosted scraping-API fetch layer.
 *
 * This is the recommended way to get Fragrantica HTML: a third-party scraping
 * API (Decodo / ScraperAPI / ScrapingBee / ZenRows) fetches the page through
 * rotating residential IPs and solves Cloudflare on their infrastructure, then
 * returns the final rendered HTML.
 *
 * Two big wins over Puppeteer-on-our-VPS:
 *   1. No Chromium runs on our server → no CPU spikes → no Hostinger malware
 *      flag and no Cloudflare IP ban.
 *   2. Residential IPs are trusted by Cloudflare → we get the REAL page with
 *      full data (notes, accords, vote breakdowns), not a challenge wall.
 *
 * Configure via env (or the admin UI):
 *   SCRAPER_API_PROVIDER = decodo | scraperapi | scrapingbee | zenrows
 *   SCRAPER_API_KEY      = <key>
 *   SCRAPER_API_GEO      = es | us | ...   (optional, default: none)
 *
 * Two provider styles are supported:
 *   - GET providers expose `build(key, url, opts) -> endpointUrl` and the raw
 *     response body IS the HTML.
 *   - POST providers (Decodo) expose `request(key, url, opts) -> { endpoint, init }`
 *     and `parse(body) -> html` to pull the HTML out of a JSON envelope.
 */

const GEO = (process.env.SCRAPER_API_GEO || '').trim().toLowerCase();

// Build a Basic auth header from whatever shape the dashboard handed the user:
//   "Basic abc123"  → used as-is
//   "user:pass"     → Basic base64(user:pass)
//   "abc123"        → assumed already-encoded token → "Basic abc123"
function basicAuth(key) {
    const k = key.trim();
    if (/^Basic\s/i.test(k)) return k;
    if (k.includes(':')) return `Basic ${Buffer.from(k).toString('base64')}`;
    return `Basic ${k}`;
}

const PROVIDERS = {
    decodo: {
        label: 'Decodo',
        signupUrl: 'https://decodo.com',
        // Decodo Web Scraping API — POST a JSON job, get the HTML back in
        // results[0].content. `headless: "html"` renders JS + solves Cloudflare.
        request: (key, url, { render }) => {
            const body = { url };
            if (render) body.headless = 'html';
            if (GEO) body.geo = GEO;
            return {
                endpoint: 'https://scraper-api.decodo.com/v2/scrape',
                init: {
                    method: 'POST',
                    headers: {
                        'Authorization': basicAuth(key),
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify(body),
                },
            };
        },
        parse: (text) => {
            const j = JSON.parse(text);
            const r = Array.isArray(j.results) ? j.results[0] : j;
            const content = r?.content ?? r?.body ?? r?.html;
            if (!content) {
                throw new Error(`Decodo returned no content: ${text.slice(0, 200)}`);
            }
            return typeof content === 'string' ? content : JSON.stringify(content);
        },
    },
    scraperapi: {
        label: 'ScraperAPI',
        signupUrl: 'https://www.scraperapi.com',
        build: (key, url, { render }) => {
            const p = new URLSearchParams({
                api_key: key,
                url,
                render: render ? 'true' : 'false',
                country_code: GEO || 'us',
            });
            return `https://api.scraperapi.com/?${p.toString()}`;
        },
    },
    scrapingbee: {
        label: 'ScrapingBee',
        signupUrl: 'https://www.scrapingbee.com',
        build: (key, url, { render }) => {
            const p = new URLSearchParams({
                api_key: key,
                url,
                render_js: render ? 'true' : 'false',
                premium_proxy: 'true',
                country_code: GEO || 'us',
            });
            return `https://app.scrapingbee.com/api/v1/?${p.toString()}`;
        },
    },
    zenrows: {
        label: 'ZenRows',
        signupUrl: 'https://www.zenrows.com',
        build: (key, url, { render }) => {
            const p = new URLSearchParams({
                apikey: key,
                url,
                js_render: render ? 'true' : 'false',
                antibot: 'true',
                premium_proxy: 'true',
            });
            if (GEO) p.set('proxy_country', GEO);
            return `https://api.zenrows.com/v1/?${p.toString()}`;
        },
    },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function getProxyConfig() {
    const provider = (process.env.SCRAPER_API_PROVIDER || '').toLowerCase();
    const key = process.env.SCRAPER_API_KEY || '';
    const def = PROVIDERS[provider];
    return {
        provider: def ? provider : null,
        label: def?.label || null,
        configured: !!(def && key),
        geo: GEO || null,
        availableProviders: Object.entries(PROVIDERS).map(([id, d]) => ({ id, label: d.label, signupUrl: d.signupUrl })),
    };
}

export function isProxyConfigured() {
    return getProxyConfig().configured;
}

/**
 * Fetch a URL's HTML through the configured scraping API.
 * @param {string} url       target page
 * @param {object} opts      { render = true, timeoutMs = 70000 }
 * @returns {Promise<string>} the page HTML
 */
export async function fetchHtmlViaProxy(url, opts = {}) {
    const provider = (process.env.SCRAPER_API_PROVIDER || '').toLowerCase();
    const key = process.env.SCRAPER_API_KEY || '';
    const def = PROVIDERS[provider];
    if (!def) throw new Error(`SCRAPER_PROXY_MISSING: set SCRAPER_API_PROVIDER (${PROVIDER_IDS.join('|')})`);
    if (!key) throw new Error('SCRAPER_PROXY_MISSING: set SCRAPER_API_KEY');

    const render = opts.render !== false;
    const timeoutMs = opts.timeoutMs || 70000;

    // Resolve endpoint + request init for both GET (build) and POST (request) providers.
    let endpoint, init, parse;
    if (typeof def.request === 'function') {
        ({ endpoint, init } = def.request(key, url, { render }));
        parse = def.parse || ((b) => b);
    } else {
        endpoint = def.build(key, url, { render });
        init = {};
        parse = (b) => b;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(endpoint, { ...init, signal: ac.signal });
        const body = await res.text();
        if (!res.ok) {
            // Scraping APIs return the upstream status / their own error in body
            throw new Error(`${def.label} ${res.status}: ${body.slice(0, 200)}`);
        }
        const html = parse(body);
        if (!html || html.length < 200) {
            throw new Error(`${def.label} returned empty/short body (${html ? html.length : 0} bytes)`);
        }
        return html;
    } finally {
        clearTimeout(timer);
    }
}
