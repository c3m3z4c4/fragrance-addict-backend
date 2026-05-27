import puppeteerCore from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Wire the stealth plugin into puppeteer-extra. This patches dozens of headless
// fingerprints (CDP Runtime.enable leak, navigator.webdriver, plugins, codecs,
// hardware concurrency, iframe contentWindow, etc.) that Cloudflare Turnstile checks.
const stealth = StealthPlugin();
// Disable a few sub-evasions that occasionally trip up legit sites
stealth.enabledEvasions.delete('user-agent-override');
puppeteerExtra.use(stealth);

// puppeteer-extra delegates the actual binary launch to the wrapped module.
// Point it at the same `puppeteer` package we already depend on.
const puppeteer = puppeteerExtra;
void puppeteerCore;

// Block these resource types — saves CPU, RAM, bandwidth, and renders pages faster.
// Images/fonts/css/media are not needed for HTML scraping.
const BLOCKED_RESOURCE_TYPES = new Set([
    'image',
    'media',
    'font',
    'stylesheet',
    'manifest',
    'texttrack',
    'eventsource',
    'websocket',
    'other',
]);

// Block these domains — ads, analytics, trackers, third-party widgets.
// Keep Fragrantica's own domains; only block known third-parties.
const BLOCKED_DOMAIN_PATTERNS = [
    'google-analytics.com',
    'googletagmanager.com',
    'googlesyndication.com',
    'googleadservices.com',
    'doubleclick.net',
    'facebook.net',
    'facebook.com/tr',
    'connect.facebook.net',
    'hotjar.com',
    'mixpanel.com',
    'segment.io',
    'amplitude.com',
    'fullstory.com',
    'cloudflareinsights.com',
    'sentry.io',
    'newrelic.com',
    'bugsnag.com',
    'taboola.com',
    'outbrain.com',
    'criteo.com',
    'adsystem',
    'adservice',
    'amazon-adsystem',
    'scorecardresearch.com',
    'quantserve.com',
    'addthis.com',
    'sharethis.com',
    'disqus.com',
    'youtube.com/embed',
    'vimeo.com',
];

const SHOULD_BLOCK_URL = (url) => {
    const lower = url.toLowerCase();
    for (const pattern of BLOCKED_DOMAIN_PATTERNS) {
        if (lower.includes(pattern)) return true;
    }
    return false;
};

export const BROWSER_CONFIG = {
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 60000,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,800',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--no-zygote',
        '--disable-crash-reporter',
        '--renderer-process-limit=1',
        '--disable-features=site-per-process,Translate,TranslateUI,IsolateOrigins,LazyFrameLoading',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--no-pings',
        '--disable-software-rasterizer',
        '--disable-breakpad',
        '--disable-prompt-on-repost',
        '--disable-hang-monitor',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-ipc-flooding-protection',
        '--memory-pressure-off',
        // Cap V8 heap inside Chromium renderer
        '--js-flags=--max-old-space-size=256 --max-semi-space-size=64',
    ],
};

const PAGE_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_PAGES_BEFORE_RESTART = parseInt(process.env.BROWSER_RESTART_AFTER_PAGES) || 30;

class BrowserPool {
    constructor() {
        this.browser = null;
        this.pagesServed = 0;
        this.launching = null;
        this.shuttingDown = false;
    }

    async _launch() {
        if (this.launching) return this.launching;
        this.launching = (async () => {
            console.log('🌐 Launching Chromium (pool)');
            this.browser = await puppeteer.launch(BROWSER_CONFIG);
            this.pagesServed = 0;
            this.browser.on('disconnected', () => {
                console.warn('🌐 Browser disconnected');
                this.browser = null;
            });
            this.launching = null;
            return this.browser;
        })();
        return this.launching;
    }

    async getBrowser() {
        if (this.shuttingDown) throw new Error('Browser pool is shutting down');
        if (!this.browser || !this.browser.connected) {
            await this._launch();
        }
        if (this.pagesServed >= MAX_PAGES_BEFORE_RESTART) {
            console.log(`♻️ Recycling browser after ${this.pagesServed} pages`);
            await this._closeBrowser();
            await this._launch();
        }
        return this.browser;
    }

    async _closeBrowser() {
        if (!this.browser) return;
        try {
            await this.browser.close();
        } catch { /* ignore */ }
        this.browser = null;
        this.pagesServed = 0;
    }

    async getPage({ blockResources = true, stealth = false } = {}) {
        const browser = await this.getBrowser();
        this.pagesServed++;
        const page = await browser.newPage();
        await page.setUserAgent(PAGE_USER_AGENT);
        await page.setViewport({ width: 1280, height: 800 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Upgrade-Insecure-Requests': '1',
            // Hints that real Chrome sends — make request fingerprint match
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="124", "Google Chrome";v="124"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        });

        if (blockResources) {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                const url = req.url();
                // Never block Cloudflare challenge assets — needed to clear the JS challenge
                if (url.includes('challenges.cloudflare.com') || url.includes('cdn-cgi/challenge-platform')) {
                    return req.continue().catch(() => {});
                }
                if (BLOCKED_RESOURCE_TYPES.has(type)) return req.abort().catch(() => {});
                if (type !== 'document' && SHOULD_BLOCK_URL(url)) return req.abort().catch(() => {});
                return req.continue().catch(() => {});
            });
        }

        // puppeteer-extra-plugin-stealth handles fingerprint spoofing at the browser level.
        // injectStealth() remains available for callers that explicitly need extra masking.
        if (stealth) await injectStealth(page);

        return page;
    }

    async withPage(opts, fn) {
        if (typeof opts === 'function') { fn = opts; opts = {}; }
        const page = await this.getPage(opts);
        try {
            return await fn(page);
        } finally {
            await page.close().catch(() => {});
        }
    }

    async shutdown() {
        this.shuttingDown = true;
        await this._closeBrowser();
    }
}

export async function injectStealth(page) {
    await page.evaluateOnNewDocument(() => {
        // navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete Object.getPrototypeOf(navigator).webdriver;

        // plugins + mimeTypes
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const arr = [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                ];
                arr.__proto__ = PluginArray.prototype;
                return arr;
            },
        });
        Object.defineProperty(navigator, 'mimeTypes', {
            get: () => {
                const arr = [{ type: 'application/pdf', suffixes: 'pdf', description: '' }];
                arr.__proto__ = MimeTypeArray.prototype;
                return arr;
            },
        });

        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

        // chrome runtime spoof
        window.chrome = {
            runtime: {},
            loadTimes: () => ({}),
            csi: () => ({}),
            app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
        };

        // permissions API
        if (navigator.permissions?.query) {
            const originalQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (params) =>
                params.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission, onchange: null })
                    : originalQuery(params);
        }

        // WebGL vendor/renderer spoof — Cloudflare fingerprints these
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return 'Intel Inc.';          // UNMASKED_VENDOR_WEBGL
            if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
            return getParameter.apply(this, [param]);
        };
        if (typeof WebGL2RenderingContext !== 'undefined') {
            const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function (param) {
                if (param === 37445) return 'Intel Inc.';
                if (param === 37446) return 'Intel Iris OpenGL Engine';
                return getParameter2.apply(this, [param]);
            };
        }

        // Hide automation indicators from window
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });
}

// Wait for Cloudflare challenge to clear. Returns true if page is real, false if still challenged.
// Default 45s — Turnstile JS challenge in headless can take 15-30s to auto-solve even with stealth.
export async function waitForCloudflare(page, maxWaitMs = 45000) {
    const start = Date.now();
    let lastTitle = '';
    while (Date.now() - start < maxWaitMs) {
        const state = await page.evaluate(() => {
            const t = (document.title || '').toLowerCase();
            const h1 = (document.querySelector('h1')?.textContent || '').toLowerCase();
            const challenged = t.includes('just a moment') ||
                   t.includes('attention required') ||
                   t.includes('checking your browser') ||
                   h1.includes('just a moment') ||
                   !!document.querySelector('#challenge-form, #challenge-running, .cf-browser-verification, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
            return { challenged, title: document.title || '' };
        }).catch(() => ({ challenged: false, title: '' }));
        lastTitle = state.title;
        if (!state.challenged) return true;
        await new Promise(r => setTimeout(r, 2000));
    }
    console.warn(`⏱️  Cloudflare did NOT clear after ${maxWaitMs}ms. Final title: "${lastTitle}"`);
    return false;
}

export const browserPool = new BrowserPool();

const shutdown = async (signal) => {
    console.log(`🛑 ${signal} received — closing browser pool`);
    await browserPool.shutdown();
    process.exit(0);
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
