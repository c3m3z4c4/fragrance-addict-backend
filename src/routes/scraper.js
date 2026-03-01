import express from 'express';
import rateLimit from 'express-rate-limit';
import { scrapePerfume } from '../services/scrapingService.js';
import { dataStore } from '../services/dataStore.js';
import { cacheService } from '../services/cacheService.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = express.Router();

// Rate limit específico para scraping (más restrictivo)
const scrapeLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    max: 5, // máximo 5 scrapes por minuto
    message: { error: 'Límite de scraping alcanzado, espera un momento' },
});

// Validar URL
const isValidUrl = (string) => {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
};

// Estado de la cola de scraping
// In-memory state for the active scraping session (stats & control flags).
// The actual URL list lives in the scrape_queue DB table so it survives restarts.
let scrapingQueue = {
    processing: false,
    current: null,
    processedThisSession: 0,
    failedThisSession: 0,
    startedAt: null,
    errors: [],          // last ~20 errors for display
    // Legacy in-memory list (used only when DB not available)
    urls: [],
    total: 0,
    processed: 0,
    failed: 0,
};

/** Enqueue URLs into DB and optionally start processing. Returns count added. */
async function enqueueUrls(urls, autoStart = false) {
    const added = await dataStore.queueEnqueue(urls).catch(() => {
        // DB unavailable — fall back to in-memory
        const newUrls = urls.filter(u => !scrapingQueue.urls.includes(u));
        scrapingQueue.urls.push(...newUrls);
        scrapingQueue.total = scrapingQueue.urls.length + scrapingQueue.processed;
        return newUrls.length;
    });
    if (autoStart && !scrapingQueue.processing && added > 0) {
        scrapingQueue.processing = true;
        scrapingQueue.startedAt = new Date().toISOString();
        scrapingQueue.processedThisSession = 0;
        scrapingQueue.failedThisSession = 0;
        scrapingQueue.errors = [];
        processQueue();
    }
    return added;
}

// GET /api/scrape/perfume?url=... - Scrapear un perfume
router.get('/perfume', requireSuperAdmin, scrapeLimiter, async (req, res, next) => {
    try {
        const { url, save } = req.query;

        if (!url) {
            return next(new ApiError('URL requerida', 400));
        }

        if (!isValidUrl(url)) {
            return next(new ApiError('URL inválida', 400));
        }

        console.log(`📥 Solicitud de scraping: ${url}`);

        const perfume = await scrapePerfume(url);

        // Guardar automáticamente si se indica
        if (save === 'true' && perfume) {
            await dataStore.add(perfume);
            console.log(`💾 Perfume guardado: ${perfume.name}`);
        }

        res.json({ success: true, data: perfume });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/batch - Scrapear múltiples URLs
router.post('/batch', requireSuperAdmin, async (req, res, next) => {
    try {
        const { urls, save = false } = req.body;

        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return next(new ApiError('Array de URLs requerido', 400));
        }

        if (urls.length > 10) {
            return next(new ApiError('Máximo 10 URLs por batch', 400));
        }

        // Validar todas las URLs
        for (const url of urls) {
            if (!isValidUrl(url)) {
                return next(new ApiError(`URL inválida: ${url}`, 400));
            }
        }

        console.log(`📥 Batch scraping: ${urls.length} URLs`);

        const results = [];
        const errors = [];

        // Procesar secuencialmente para respetar rate limits
        for (const url of urls) {
            try {
                const perfume = await scrapePerfume(url);

                if (save && perfume) {
                    await dataStore.add(perfume);
                }

                results.push({ url, success: true, data: perfume });
            } catch (error) {
                errors.push({ url, success: false, error: error.message });
            }
        }

        res.json({
            success: true,
            processed: results.length,
            failed: errors.length,
            results,
            errors,
        });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// ─── Shared helper: fetch all perfume URLs from a Fragrantica brand page ───────

async function fetchBrandUrls(brand, limit = 500) {
    const puppeteer = (await import('puppeteer')).default;
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        const brandSlug = brand.trim()
            .replace(/\s+/g, '-')
            .replace(/['']/g, '')
            .replace(/&/g, 'and');

        const brandUrl = `https://www.fragrantica.com/designers/${brandSlug}.html`;
        console.log(`🔍 Fetching brand page: ${brandUrl}`);

        await page.goto(brandUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('a[href*="/perfume/"]', { timeout: 10000 }).catch(() => {});

        // Extract brand logo — Fragrantica stores brand images in their CDN
        const logoUrl = await page.evaluate(() => {
            // Priority order: brand-specific CDN path, then any fimgs.net image
            const selectors = [
                'img[src*="/dizajneri/"]',
                'img[src*="fimgs.net"][src*="/mdimg/"]',
                '.brand-header img',
                'header img',
                '#main-content img',
            ];
            for (const sel of selectors) {
                const img = document.querySelector(sel);
                if (img?.src && !img.src.includes('logo') && img.naturalWidth > 50) return img.src;
            }
            // Fallback: first fimgs.net image (Fragrantica CDN)
            const anyFimgs = document.querySelector('img[src*="fimgs.net"]');
            return anyFimgs?.src || null;
        }).catch(() => null);

        let urls = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href*="/perfume/"]'))
                .map(a => a.href)
                .filter(h => h.includes('/perfume/') && !h.includes('#') && !h.includes('?') && /\/perfume\/[^/]+\/[^/]+\.html$/.test(h))
        );
        urls = [...new Set(urls)].slice(0, limit);
        console.log(`  Found ${urls.length} URLs for brand "${brand}", logo: ${logoUrl ? 'yes' : 'no'}`);
        return { urls, brandUrl, logoUrl };
    } finally {
        await browser.close();
    }
}

// POST /api/scrape/brand - Scraping automático de una marca completa
router.post('/brand', requireSuperAdmin, async (req, res, next) => {
    try {
        const { brand, limit = 500, autoStart = false } = req.body;

        if (!brand || typeof brand !== 'string' || !brand.trim()) {
            return next(new ApiError('Brand name is required', 400));
        }

        const { urls, brandUrl, logoUrl } = await fetchBrandUrls(brand.trim(), parseInt(limit));

        if (urls.length === 0) {
            return res.json({
                success: false,
                error: `No perfume URLs found for brand "${brand}". Check the exact name as it appears on Fragrantica.`,
                brand,
                queued: 0,
            });
        }

        // Save brand logo to DB (even if no new URLs)
        await dataStore.upsertBrand(brand.trim(), logoUrl, brandUrl).catch(err =>
            console.warn(`⚠️ Could not save brand logo for "${brand}": ${err.message}`)
        );

        // Add to persistent DB queue (ON CONFLICT DO NOTHING deduplicates)
        const added = await enqueueUrls(urls, autoStart);
        const skipped = urls.length - added;

        console.log(`📥 Brand "${brand}": ${added} queued, ${skipped} already in queue/db, logo: ${logoUrl ? logoUrl.slice(0, 60) : 'none'}`);

        const stats = await dataStore.queueStats().catch(() => ({}));
        res.json({
            success: true,
            brand,
            brandUrl,
            logoUrl,
            total: urls.length,
            queued: added,
            skipped,
            queueSize: stats.pending ?? added,
            autoStarted: autoStart && added > 0,
        });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/brands - Scraping automático de varias marcas
router.post('/brands', requireSuperAdmin, async (req, res, next) => {
    try {
        const { brands, limitPerBrand = 500, autoStart = false } = req.body;

        if (!brands || !Array.isArray(brands) || brands.length === 0) {
            return next(new ApiError('brands array is required', 400));
        }

        if (brands.length > 20) {
            return next(new ApiError('Maximum 20 brands per request', 400));
        }

        const existingUrls = new Set(await dataStore.getAllSourceUrls().catch(() => []));
        const results = [];
        let totalQueued = 0;
        let totalSkipped = 0;

        for (const brand of brands) {
            if (!brand || typeof brand !== 'string' || !brand.trim()) continue;
            try {
                const { urls, brandUrl, logoUrl } = await fetchBrandUrls(brand.trim(), parseInt(limitPerBrand));
                const newUrls = urls.filter(u => !existingUrls.has(u));

                // Save brand logo to DB
                await dataStore.upsertBrand(brand.trim(), logoUrl, brandUrl).catch(err =>
                    console.warn(`⚠️ Could not save brand logo for "${brand}": ${err.message}`)
                );

                const added = await enqueueUrls(newUrls, false);
                newUrls.forEach(u => existingUrls.add(u)); // avoid cross-brand dups within this request

                totalQueued += added;
                totalSkipped += urls.length - added;

                results.push({
                    brand: brand.trim(),
                    brandUrl,
                    logoUrl,
                    total: urls.length,
                    queued: added,
                    skipped: urls.length - added,
                });

                console.log(`📥 Brand "${brand}": ${added} queued, logo: ${logoUrl ? 'yes' : 'no'}`);
            } catch (err) {
                results.push({ brand: brand.trim(), error: err.message, queued: 0 });
            }
        }

        if (autoStart && !scrapingQueue.processing && totalQueued > 0) {
            scrapingQueue.processing = true;
            scrapingQueue.startedAt = new Date().toISOString();
            scrapingQueue.processedThisSession = 0;
            scrapingQueue.failedThisSession = 0;
            scrapingQueue.errors = [];
            processQueue();
        }

        const stats = await dataStore.queueStats().catch(() => ({}));
        res.json({
            success: true,
            brands: results,
            totalQueued,
            totalSkipped,
            queueSize: stats.pending ?? totalQueued,
            autoStarted: autoStart && totalQueued > 0,
        });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/sitemap - Obtener URLs del sitemap de Fragrantica
router.post('/sitemap', requireSuperAdmin, async (req, res, next) => {
    try {
        const { brand, limit = 100 } = req.body;

        console.log(
            `📥 Fetching sitemap for brand: ${brand || 'all'}, limit: ${limit}`
        );

        const puppeteer = (await import('puppeteer')).default;
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        });

        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        let urls = [];

        if (brand) {
            // Fragrantica brand URLs formats:
            // - https://www.fragrantica.com/designers/Dior.html
            // - https://www.fragrantica.com/designers/Tom-Ford.html

            // Normalize brand name for URL
            const brandSlug = brand
                .trim()
                .replace(/\s+/g, '-') // Replace spaces with hyphens
                .replace(/['']/g, '') // Remove apostrophes
                .replace(/&/g, 'and'); // Replace & with 'and'

            const brandUrl = `https://www.fragrantica.com/designers/${brandSlug}.html`;
            console.log(`Fetching brand page: ${brandUrl}`);

            try {
                await page.goto(brandUrl, {
                    waitUntil: 'networkidle2',
                    timeout: 60000,
                });

                // Wait for perfume links to load
                await page
                    .waitForSelector('a[href*="/perfume/"]', { timeout: 10000 })
                    .catch(() => {
                        console.log(
                            'Waiting for perfume links timed out, continuing...'
                        );
                    });

                urls = await page.evaluate(() => {
                    const links = document.querySelectorAll(
                        'a[href*="/perfume/"]'
                    );
                    return Array.from(links)
                        .map((link) => link.href)
                        .filter((href) => {
                            // Filter only valid perfume detail pages
                            return (
                                href.includes('/perfume/') &&
                                !href.includes('#') &&
                                !href.includes('?') &&
                                href.match(/\/perfume\/[^/]+\/[^/]+\.html$/)
                            );
                        });
                });

                // Remove duplicates
                urls = [...new Set(urls)];

                console.log(
                    `Found ${urls.length} perfume URLs for brand ${brand}`
                );

                // If no URLs found, try the search page as fallback
                if (urls.length === 0) {
                    console.log(
                        'No URLs found on brand page, trying search...'
                    );
                    const searchUrl = `https://www.fragrantica.com/search/?query=${encodeURIComponent(
                        brand
                    )}`;
                    await page.goto(searchUrl, {
                        waitUntil: 'networkidle2',
                        timeout: 60000,
                    });

                    // Wait a bit for results to load
                    await new Promise((resolve) => setTimeout(resolve, 2000));

                    urls = await page.evaluate(() => {
                        const links = document.querySelectorAll(
                            'a[href*="/perfume/"]'
                        );
                        return Array.from(links)
                            .map((link) => link.href)
                            .filter(
                                (href) =>
                                    href.includes('/perfume/') &&
                                    href.match(/\.html$/)
                            );
                    });

                    urls = [...new Set(urls)];
                    console.log(`Found ${urls.length} perfume URLs via search`);
                }
            } catch (navError) {
                console.error(`Navigation error: ${navError.message}`);
                await browser.close();
                return res.json({
                    success: false,
                    error: `Could not load brand page for "${brand}". Make sure the brand name matches exactly as shown on Fragrantica (e.g., "Dior", "Tom Ford", "Chanel").`,
                    urls: [],
                    count: 0,
                });
            }
        } else {
            // Fetch from sitemap
            try {
                await page.goto('https://www.fragrantica.com/sitemap.xml', {
                    waitUntil: 'networkidle2',
                    timeout: 60000,
                });

                const sitemapContent = await page.content();

                // Extract perfume sitemap URLs
                const sitemapMatches =
                    sitemapContent.match(/sitemap_perfumes_\d+\.xml/g) || [];
                console.log(`Found ${sitemapMatches.length} perfume sitemaps`);

                if (sitemapMatches.length > 0) {
                    // Get first sitemap for perfumes
                    const sitemapUrl = `https://www.fragrantica.com/${sitemapMatches[0]}`;
                    console.log(`Fetching: ${sitemapUrl}`);

                    await page.goto(sitemapUrl, {
                        waitUntil: 'networkidle2',
                        timeout: 60000,
                    });

                    urls = await page.evaluate(() => {
                        const locs = document.querySelectorAll('loc');
                        return Array.from(locs)
                            .map((loc) => loc.textContent)
                            .filter((url) => url && url.includes('/perfume/'));
                    });

                    console.log(`Found ${urls.length} URLs in sitemap`);
                }
            } catch (sitemapError) {
                console.error(`Sitemap error: ${sitemapError.message}`);
            }
        }

        await browser.close();

        // Limit results
        urls = urls.slice(0, parseInt(limit));

        console.log(`Returning ${urls.length} perfume URLs`);

        res.json({
            success: true,
            count: urls.length,
            urls,
            brand: brand || null,
        });
    } catch (error) {
        console.error('Sitemap error:', error);
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/queue/check - Check which URLs already exist
router.post('/queue/check', requireSuperAdmin, async (req, res, next) => {
    try {
        const { urls } = req.body;

        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return next(new ApiError('Array de URLs requerido', 400));
        }

        // Filter valid URLs
        const validUrls = urls.filter((url) => isValidUrl(url));

        // Get existing perfume URLs
        let existingUrls = [];
        try {
            existingUrls = await dataStore.getAllSourceUrls();
        } catch (error) {
            console.warn('Could not fetch existing URLs:', error.message);
        }

        const existingSet = new Set(existingUrls);
        const existing = validUrls.filter((url) => existingSet.has(url));
        const newUrls = validUrls.filter((url) => !existingSet.has(url));

        res.json({
            success: true,
            total: validUrls.length,
            existingCount: existing.length,
            newCount: newUrls.length,
            existing,
            newUrls,
        });
    } catch (error) {
        console.error('Check URLs error:', error);
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/queue - Add URLs to scraping queue
router.post('/queue', requireSuperAdmin, async (req, res, next) => {
    try {
        const { urls } = req.body;

        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return next(new ApiError('Array de URLs requerido', 400));
        }

        // Filter valid URLs and remove duplicates
        const validUrls = [...new Set(urls.filter((url) => isValidUrl(url)))];

        // Get existing perfume URLs to avoid duplicates
        let existingUrls = new Set();
        try {
            const existing = await dataStore.getAllSourceUrls();
            existingUrls = new Set(existing);
        } catch (error) {
            console.warn(
                'Could not fetch existing URLs, proceeding without duplicate check:',
                error.message
            );
        }

        const added = await enqueueUrls(validUrls, false);
        const skipped = validUrls.length - added;

        console.log(`📥 Added ${added} URLs to queue (${skipped} already in queue/db)`);

        const stats = await dataStore.queueStats().catch(() => ({}));
        res.json({
            success: true,
            added,
            skipped,
            queueSize: stats.pending ?? added,
        });
    } catch (error) {
        console.error('Queue error:', error);
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/queue/start - Start (or resume) processing the DB-backed queue
router.post('/queue/start', requireSuperAdmin, async (req, res, next) => {
    try {
        if (scrapingQueue.processing) {
            return res.json({ success: false, message: 'Queue already processing' });
        }

        // Reset any URLs stuck in 'processing' state from a previous crash
        const stuck = await dataStore.queueResetStuck().catch(() => 0);
        if (stuck > 0) console.log(`♻️ Reset ${stuck} stuck URLs to pending`);

        const stats = await dataStore.queueStats().catch(() => ({ pending: 0 }));
        if (stats.pending === 0) {
            return res.json({ success: false, message: 'No pending URLs in queue' });
        }

        scrapingQueue.processing = true;
        scrapingQueue.startedAt = new Date().toISOString();
        scrapingQueue.processedThisSession = 0;
        scrapingQueue.failedThisSession = 0;
        scrapingQueue.errors = [];

        console.log(`🚀 Starting queue: ${stats.pending} pending URLs`);
        processQueue();

        res.json({ success: true, message: 'Queue processing started', pending: stats.pending });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/queue/stop - Pause queue (pending URLs stay in DB, resume any time)
router.post('/queue/stop', requireSuperAdmin, async (req, res) => {
    scrapingQueue.processing = false;
    console.log('⏸️ Queue paused');
    const stats = await dataStore.queueStats().catch(() => ({}));
    res.json({
        success: true,
        message: 'Queue paused — resume any time to continue from where it left off',
        processedThisSession: scrapingQueue.processedThisSession,
        remaining: stats.pending ?? 0,
    });
});

// GET /api/scrape/queue/status - Queue status (DB counts + in-memory session info)
router.get('/queue/status', requireSuperAdmin, async (req, res) => {
    const stats = await dataStore.queueStats().catch(() => ({ pending: 0, processing: 0, done: 0, failed: 0, total: 0 }));
    res.json({
        success: true,
        processing: scrapingQueue.processing,
        current: scrapingQueue.current,
        // DB-based totals (accurate, survive restarts)
        remaining: stats.pending + (stats.processing || 0),
        processed: stats.done,
        failed: stats.failed,
        total: stats.total,
        // Session info
        processedThisSession: scrapingQueue.processedThisSession,
        failedThisSession: scrapingQueue.failedThisSession,
        startedAt: scrapingQueue.startedAt,
        errors: scrapingQueue.errors.slice(-10),
    });
});

// POST /api/scrape/queue/retry-failed - Move all failed entries back to pending
router.post('/queue/retry-failed', requireSuperAdmin, async (req, res, next) => {
    try {
        const count = await dataStore.queueRetryFailed();
        console.log(`♻️ Retrying ${count} failed URLs`);
        res.json({ success: true, retried: count });
    } catch (err) {
        next(new ApiError(err.message, 500));
    }
});

// DELETE /api/scrape/queue - Clear queue (all or by status)
router.delete('/queue', requireSuperAdmin, async (req, res, next) => {
    try {
        const { status } = req.query; // ?status=failed | ?status=done | (empty = all)
        if (scrapingQueue.processing && (!status || status === 'pending')) {
            return res.json({ success: false, message: 'Stop the queue before clearing pending items' });
        }
        const deleted = await dataStore.queueClear(status || null);
        console.log(`🗑️ Queue cleared (${status || 'all'}): ${deleted} rows`);
        res.json({ success: true, deleted, message: `Cleared ${deleted} queue entries` });
    } catch (err) {
        next(new ApiError(err.message, 500));
    }
});

// Background queue processor
async function processQueue() {
    let consecutiveRateLimits = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;
    const RATE_LIMIT_PAUSE_MS = 120000; // 2 min pause on rate limit

    while (scrapingQueue.processing) {
        // ── Dequeue next pending URL from DB ──────────────────────────────────
        const url = await dataStore.queueDequeue().catch(() => null);

        // No more pending URLs → done
        if (!url) break;

        scrapingQueue.current = url;

        try {
            // ── Validate: skip if already scraped & saved ─────────────────────
            const alreadyExists = await dataStore.existsBySourceUrl(url).catch(() => false);
            if (alreadyExists) {
                console.log(`⏭️ Already in DB, skipping: ${url}`);
                await dataStore.queueMark(url, 'done');
                scrapingQueue.processedThisSession++;
                consecutiveRateLimits = 0;
                continue; // No delay needed for skip
            }

            // ── Scrape ────────────────────────────────────────────────────────
            console.log(`🔄 Scraping: ${url}`);
            const perfume = await scrapePerfume(url);

            if (perfume) {
                await dataStore.add(perfume);
                await dataStore.queueMark(url, 'done');
                console.log(`✅ Saved: ${perfume.name}`);
            } else {
                // scrapePerfume returned null/undefined (no data)
                await dataStore.queueMark(url, 'failed', 'No data returned by scraper');
                scrapingQueue.failedThisSession++;
                scrapingQueue.errors.push({ url, error: 'No data returned', time: new Date().toISOString() });
            }

            scrapingQueue.processedThisSession++;
            consecutiveRateLimits = 0;
        } catch (error) {
            const msg = error.message || '';
            console.error(`❌ Failed: ${url} — ${msg}`);

            // Rate limit → put back as pending and wait
            if (msg.includes('RATE_LIMITED') || msg.includes('Too Many Requests')) {
                consecutiveRateLimits++;
                await dataStore.queueMark(url, 'pending').catch(() => {});
                console.warn(`⚠️ Rate limit (${consecutiveRateLimits}/${MAX_RATE_LIMIT_RETRIES})`);

                if (consecutiveRateLimits >= MAX_RATE_LIMIT_RETRIES) {
                    const longPause = 5 * 60 * 1000;
                    console.warn(`⚠️ Multiple rate limits. Pausing ${longPause / 60000} min then resuming…`);
                    scrapingQueue.errors.push({ url, error: `Rate limit × ${MAX_RATE_LIMIT_RETRIES}: paused ${longPause / 60000} min`, time: new Date().toISOString() });
                    consecutiveRateLimits = 0;
                    await new Promise(r => setTimeout(r, longPause));
                } else {
                    await new Promise(r => setTimeout(r, RATE_LIMIT_PAUSE_MS));
                }
                continue; // Retry from DB (URL is pending again)
            }

            // Invalid data → mark failed, skip
            if (msg.includes('INVALID_DATA')) {
                console.warn(`⏭️ Invalid data: ${url}`);
                await dataStore.queueMark(url, 'failed', msg);
                scrapingQueue.failedThisSession++;
                scrapingQueue.errors.push({ url, error: msg, time: new Date().toISOString() });
                consecutiveRateLimits = 0;
                continue;
            }

            // Other errors → mark failed, keep going
            await dataStore.queueMark(url, 'failed', msg);
            scrapingQueue.failedThisSession++;
            scrapingQueue.errors.push({ url, error: msg, time: new Date().toISOString() });
            if (scrapingQueue.errors.length > 20) scrapingQueue.errors.shift();
        }

        // Respectful delay between requests
        await new Promise(r => setTimeout(r, 15000));
    }

    scrapingQueue.processing = false;
    scrapingQueue.current = null;
    console.log(`✅ Queue session done. Processed: ${scrapingQueue.processedThisSession}, Failed: ${scrapingQueue.failedThisSession}`);
}

// GET /api/scrape/incomplete/by-brand - Incomplete perfumes grouped by brand
router.get('/incomplete/by-brand', requireSuperAdmin, async (req, res, next) => {
    try {
        // Fetch up to 5000 to cover most catalogues
        const perfumes = await dataStore.getIncomplete({ limit: 5000 });

        const brandMap = {};
        for (const p of perfumes) {
            if (!p.brand) continue;
            if (!brandMap[p.brand]) {
                brandMap[p.brand] = { brand: p.brand, count: 0, ids: [], urls: [] };
            }
            brandMap[p.brand].count++;
            brandMap[p.brand].ids.push(p.id);
            if (p.sourceUrl) brandMap[p.brand].urls.push(p.sourceUrl);
        }

        const brands = Object.values(brandMap).sort((a, b) => b.count - a.count);
        res.json({ success: true, brands, total: perfumes.length });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/rescrape/brand - Queue or directly re-scrape all incomplete from a brand
router.post('/rescrape/brand', requireSuperAdmin, async (req, res, next) => {
    try {
        const { brand, direct = false } = req.body;
        if (!brand) return next(new ApiError('brand is required', 400));

        const perfumes = await dataStore.getIncomplete({ limit: 5000 });
        const brandPerfumes = perfumes.filter(p => p.brand === brand && p.sourceUrl);

        if (brandPerfumes.length === 0) {
            return res.json({ success: true, added: 0, message: 'No incomplete perfumes for this brand' });
        }

        if (direct) {
            // Direct re-scrape (synchronous, max 100)
            if (brandPerfumes.length > 100) {
                return next(new ApiError('Too many perfumes for direct mode — use queue instead', 400));
            }
            const results = [];
            const errors = [];
            for (const p of brandPerfumes) {
                try {
                    const scraped = await scrapePerfume(p.sourceUrl);
                    if (scraped) {
                        await dataStore.update(p.id, scraped);
                        results.push({ id: p.id, name: p.name, success: true });
                    }
                } catch (err) {
                    errors.push({ id: p.id, error: err.message });
                }
                await new Promise(r => setTimeout(r, 15000));
            }
            return res.json({ success: true, processed: results.length, failed: errors.length, results, errors });
        }

        // Queue mode — re-scrape clears done/failed status for these URLs so they run again
        const urls = brandPerfumes.map(p => p.sourceUrl).filter(Boolean);
        // For re-scrape, reset existing queue entries to pending; enqueue new ones
        await dataStore.queueClear('done').catch(() => {});
        const added = await enqueueUrls(urls, true);

        const stats = await dataStore.queueStats().catch(() => ({}));
        res.json({ success: true, added, queueSize: stats.pending ?? added, autoStarted: true });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// GET /api/scrape/incomplete - Perfumes missing notes, accords, or performance data
router.get('/incomplete', requireSuperAdmin, async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        const [perfumes, count] = await Promise.all([
            dataStore.getIncomplete({ limit }),
            dataStore.countIncomplete(),
        ]);

        const mapped = perfumes.map((p) => ({
            id: p.id,
            name: p.name,
            brand: p.brand,
            sourceUrl: p.sourceUrl,
            hasSillage: !!p.sillage,
            hasLongevity: !!p.longevity,
            hasSimilarPerfumes: !!(p.similarPerfumes?.length),
            hasNotes: !!(p.notes?.top?.length || p.notes?.heart?.length || p.notes?.base?.length),
            hasAccords: !!(p.accords?.length),
        }));

        res.json({ success: true, count, perfumes: mapped });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/rescrape - Re-scrape specific perfumes by ID
router.post('/rescrape', requireSuperAdmin, async (req, res, next) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return next(new ApiError('ids array is required', 400));
        }
        if (ids.length > 100) {
            return next(new ApiError('Maximum 100 IDs per request', 400));
        }

        const results = [];
        const errors = [];

        for (const id of ids) {
            try {
                const existing = await dataStore.getById(id);
                if (!existing?.sourceUrl) {
                    errors.push({ id, error: 'No source URL found' });
                    continue;
                }

                const perfume = await scrapePerfume(existing.sourceUrl);
                if (perfume) {
                    await dataStore.update(id, perfume);
                    results.push({ id, name: perfume.name, success: true });
                }
            } catch (err) {
                errors.push({ id, error: err.message });
            }

            await new Promise((r) => setTimeout(r, 15000));
        }

        res.json({
            success: true,
            processed: results.length,
            failed: errors.length,
            results,
            errors,
        });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/rescrape/queue - Add incomplete perfumes to scraping queue (auto-starts)
router.post('/rescrape/queue', requireSuperAdmin, async (req, res, next) => {
    try {
        const { limit = 500 } = req.body;
        const perfumes = await dataStore.getIncomplete({ limit });

        const stats0 = await dataStore.queueStats().catch(() => ({}));
        if (perfumes.length === 0) {
            return res.json({ success: true, added: 0, queueSize: stats0.pending ?? 0, message: 'No incomplete perfumes found' });
        }

        const urlsToAdd = perfumes.filter((p) => p.sourceUrl).map((p) => p.sourceUrl);
        const added = await enqueueUrls(urlsToAdd, true);

        const stats = await dataStore.queueStats().catch(() => ({}));
        res.json({ success: true, added, queueSize: stats.pending ?? added, autoStarted: true });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/reset - Wipe ALL perfumes and brands (requires confirmation)
router.post('/reset', requireSuperAdmin, async (req, res, next) => {
    try {
        const { confirm } = req.body;
        if (confirm !== 'CONFIRM_RESET') {
            return next(new ApiError('Send { confirm: "CONFIRM_RESET" } to proceed', 400));
        }

        // Stop scraping queue and clear DB queue
        scrapingQueue.processing = false;
        scrapingQueue.current = null;
        scrapingQueue.processedThisSession = 0;
        scrapingQueue.failedThisSession = 0;
        scrapingQueue.errors = [];
        await dataStore.queueClear().catch(() => {});

        const [perfumesResult, brandsResult] = await Promise.all([
            dataStore.clearPerfumes(),
            dataStore.clearBrands(),
        ]);

        console.log(`🗑️ Reset: deleted ${perfumesResult.deleted} perfumes, ${brandsResult.deleted} brands`);

        res.json({
            success: true,
            deleted: {
                perfumes: perfumesResult.deleted,
                brands: brandsResult.deleted,
            },
            message: 'All perfumes and brands have been deleted. Ready for fresh scraping.',
        });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/catalog/full - Discover & queue ALL perfumes from Fragrantica sitemaps
// Responds immediately (202) to avoid Traefik timeout; discovery runs in background.
router.post('/catalog/full', requireSuperAdmin, async (req, res, _next) => {
    const { autoStart = true } = req.body;

    // Respond immediately so Traefik doesn't cut the connection (discovery takes minutes)
    res.json({
        success: true,
        status: 'discovering',
        message: 'Sitemap discovery started in background. URLs will be added to the queue as they are found — check the queue panel below.',
        sitemapsDiscovered: 0,
        totalFound: 0,
        newQueued: 0,
        alreadyExist: 0,
        estimatedHours: 0,
        estimatedDays: 0,
        autoStarted: false,
    });

    // Run discovery asynchronously after the response is sent
    setImmediate(async () => {
        console.log('🌍 [bg] Full catalog import: reading Fragrantica sitemaps via Puppeteer...');
        let browser = null;
        try {
            const puppeteer = (await import('puppeteer')).default;
            browser = await puppeteer.launch({
                headless: 'new',
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            });

            const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

            const fetchXml = async (url) => {
                const page = await browser.newPage();
                try {
                    await page.setUserAgent(BROWSER_UA);
                    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
                    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
                    return await page.content();
                } finally {
                    await page.close();
                }
            };

            // ── 1. Discover sub-sitemap files from the index ──
            let sitemapUrls = [];
            try {
                const indexXml = await fetchXml('https://www.fragrantica.com/sitemap.xml');
                const matches = indexXml.match(/https?:\/\/[^\s<>"]*sitemap_perfumes_\d+\.xml/g) || [];
                sitemapUrls = [...new Set(matches)];
                console.log(`  [bg] Sitemap index: found ${sitemapUrls.length} perfume sub-sitemaps`);
            } catch (err) {
                console.warn(`  [bg] ⚠️ Could not fetch sitemap.xml: ${err.message}`);
            }

            // Fallback: probe known numbered paths (Fragrantica uses sitemap_perfumes_1.xml … N.xml)
            if (sitemapUrls.length === 0) {
                for (let i = 1; i <= 6; i++) {
                    sitemapUrls.push(`https://www.fragrantica.com/sitemap_perfumes_${i}.xml`);
                }
                console.log(`  [bg] Fallback: probing ${sitemapUrls.length} candidate sub-sitemap URLs`);
            }

            // ── 2. Extract perfume URLs from each sub-sitemap ──
            const existingUrls = new Set(await dataStore.getAllSourceUrls().catch(() => []));
            const allFound = [];

            for (const sitemapUrl of sitemapUrls) {
                try {
                    const xml = await fetchXml(sitemapUrl);
                    const urls = (xml.match(/https?:\/\/[^\s<>"]*\/perfume\/[^<\s"]+\.html/g) || [])
                        .filter(u => /\/perfume\/[^/]+\/[^/]+\.html$/.test(u));
                    if (urls.length > 0) {
                        allFound.push(...urls);
                        console.log(`  [bg] ${sitemapUrl}: ${urls.length} URLs`);
                    } else {
                        console.log(`  [bg] ${sitemapUrl}: 0 URLs (empty or blocked)`);
                    }
                } catch (err) {
                    console.warn(`  [bg] ⚠️ Skipping ${sitemapUrl}: ${err.message}`);
                }
            }

            if (allFound.length === 0) {
                console.error('[bg] ❌ Full catalog: no URLs found from any sitemap. Fragrantica may be blocking access.');
                return;
            }

            const uniqueUrls = [...new Set(allFound)];
            const newUrls = uniqueUrls.filter(u => !existingUrls.has(u));

            // ── 3. Add new URLs to persistent DB queue ──
            const added = await enqueueUrls(newUrls, autoStart);

            console.log(`✅ [bg] Full catalog done: ${uniqueUrls.length} unique found, ${added} new queued, ${uniqueUrls.length - added} already existed`);
        } catch (err) {
            console.error('[bg] ❌ Full catalog discovery error:', err.message);
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });
});

// GET /api/scrape/cache/stats - Estadísticas del caché
router.get('/cache/stats', requireSuperAdmin, (req, res) => {
    const stats = cacheService.stats();
    res.json({ success: true, data: stats });
});

// DELETE /api/scrape/cache - Limpiar caché
router.delete('/cache', requireSuperAdmin, (req, res) => {
    cacheService.flush();
    res.json({ success: true, message: 'Caché limpiado' });
});

// GET /api/scrape/duplicates - Find duplicate perfumes (same name+brand)
router.get('/duplicates', requireSuperAdmin, async (req, res, next) => {
    try {
        const duplicates = await dataStore.findDuplicates();
        res.json({ success: true, data: duplicates, count: duplicates.length });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/scrape/duplicates - Delete duplicates keeping highest-rated
router.delete('/duplicates', requireSuperAdmin, async (req, res, next) => {
    try {
        const result = await dataStore.deleteDuplicates();
        const count = result?.deleted ?? 0;
        res.json({ success: true, deleted: count, message: `Deleted ${count} duplicate perfume(s)` });
    } catch (err) {
        next(err);
    }
});

export default router;
