/**
 * Hosted scraping-API fetch layer.
 *
 * This is the recommended way to get Fragrantica HTML: a third-party scraping
 * API (ScraperAPI / ScrapingBee / ZenRows) fetches the page through rotating
 * residential IPs and solves Cloudflare on their infrastructure, then returns
 * the final rendered HTML over a plain HTTP GET.
 *
 * Two big wins over Puppeteer-on-our-VPS:
 *   1. No Chromium runs on our server → no CPU spikes → no Hostinger malware
 *      flag and no Cloudflare IP ban.
 *   2. Residential IPs are trusted by Cloudflare → we get the REAL page with
 *      full data (notes, accords, vote breakdowns), not a challenge wall.
 *
 * Configure via env (or the admin UI):
 *   SCRAPER_API_PROVIDER = scraperapi | scrapingbee | zenrows
 *   SCRAPER_API_KEY      = <key>
 */

const PROVIDERS = {
    scraperapi: {
        label: 'ScraperAPI',
        signupUrl: 'https://www.scraperapi.com',
        build: (key, url, { render }) => {
            const p = new URLSearchParams({
                api_key: key,
                url,
                render: render ? 'true' : 'false',
                country_code: 'us',
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
                country_code: 'us',
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
            return `https://api.zenrows.com/v1/?${p.toString()}`;
        },
    },
};

export function getProxyConfig() {
    const provider = (process.env.SCRAPER_API_PROVIDER || '').toLowerCase();
    const key = process.env.SCRAPER_API_KEY || '';
    const def = PROVIDERS[provider];
    return {
        provider: def ? provider : null,
        label: def?.label || null,
        configured: !!(def && key),
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
    if (!def) throw new Error('SCRAPER_PROXY_MISSING: set SCRAPER_API_PROVIDER (scraperapi|scrapingbee|zenrows)');
    if (!key) throw new Error('SCRAPER_PROXY_MISSING: set SCRAPER_API_KEY');

    const render = opts.render !== false;
    const timeoutMs = opts.timeoutMs || 70000;
    const endpoint = def.build(key, url, { render });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(endpoint, { signal: ac.signal });
        const body = await res.text();
        if (!res.ok) {
            // Scraping APIs return the upstream status / their own error in body
            throw new Error(`${def.label} ${res.status}: ${body.slice(0, 200)}`);
        }
        if (!body || body.length < 200) {
            throw new Error(`${def.label} returned empty/short body (${body.length} bytes)`);
        }
        return body;
    } finally {
        clearTimeout(timer);
    }
}
