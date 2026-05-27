import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { scrapePerfume, BROWSER_CONFIG, addStealthScripts } from '../services/scrapingService.js';
import { dataStore } from '../services/dataStore.js';
import { cacheService } from '../services/cacheService.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getAlgoliaJobState } from './algolia.js';

// Memory storage — logos stored as base64 data URLs in the DB, no disk dependency
const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 100 },
    fileFilter: (_req, file, cb) => {
        const ok = /\.(png|jpg|jpeg|webp|svg)$/i.test(file.originalname);
        cb(ok ? null : new Error('Only PNG, JPG, WEBP, SVG allowed'), ok);
    },
});

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
    rateLimitedThisSession: 0,
    startedAt: null,
    errors: [],          // last ~50 errors for display (includes rate-limit retries)
    // Legacy in-memory list (used only when DB not available)
    urls: [],
    total: 0,
    processed: 0,
    failed: 0,
};

// Bulk brand import job state
let brandImportJob = {
    active: false,
    paused: false,
    brandsTotal: 0,
    brandsProcessed: 0,
    brandsSucceeded: 0,
    brandsFailed: 0,
    urlsQueued: 0,
    currentBrand: null,
    results: [],      // [{ brand, queued, skipped, total, error }]
    startedAt: null,
    finishedAt: null,
};

// Discovery phase state — tracks background sitemap reading progress
let catalogDiscovery = {
    active: false,
    phase: null,        // 'reading_index' | 'reading_sitemaps' | 'enqueueing' | 'done' | 'error'
    currentSitemap: null,
    sitemapsTotal: 0,
    sitemapsProcessed: 0,
    urlsFound: 0,
    urlsQueued: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
};

/** Enqueue URLs into DB and optionally start processing. Returns count added.
 *  force=true: re-scrape mode — bypasses existsBySourceUrl check, resets done/failed entries. */
async function enqueueUrls(urls, autoStart = false, force = false) {
    const added = await dataStore.queueEnqueue(urls, force).catch(() => {
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
        scrapingQueue.rateLimitedThisSession = 0;
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
    let browser = null;
    try {
    browser = await puppeteer.launch(BROWSER_CONFIG);

        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        );

        const brandSlug = brand.trim()
            .replace(/\s+/g, '-')
            .replace(/['']/g, '')
            .replace(/&/g, 'and');

        const brandUrl = `https://www.fragrantica.com/designers/${brandSlug}.html`;
        console.log(`🔍 Fetching brand page: ${brandUrl}`);

        // domcontentloaded is enough — we only need links, not full network idle
        await page.goto(brandUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('a[href*="/perfume/"]', { timeout: 15000 }).catch(() => {});

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
                if (img?.src && img.naturalWidth > 50) return img.src;
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
        if (browser) await browser.close().catch(() => {});
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
            scrapingQueue.rateLimitedThisSession = 0;
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

// POST /api/scrape/brands/bulk - Start background bulk brand import job
router.post('/brands/bulk', requireSuperAdmin, async (req, res) => {
    const { brands, limitPerBrand = 500 } = req.body;

    if (!Array.isArray(brands) || brands.length === 0) {
        return res.json({ success: false, error: 'brands array is required' });
    }
    if (brandImportJob.active) {
        return res.json({ success: false, error: 'A bulk brand import is already running' });
    }

    const cleanBrands = [...new Set(brands.map(b => String(b).trim()).filter(Boolean))];

    brandImportJob = {
        active: true,
        paused: false,
        brandsTotal: cleanBrands.length,
        brandsProcessed: 0,
        brandsSucceeded: 0,
        brandsFailed: 0,
        urlsQueued: 0,
        currentBrand: null,
        results: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
    };

    res.json({ success: true, total: cleanBrands.length, message: 'Bulk brand import started in background' });

    // Run in background
    setImmediate(async () => {
        const existingUrls = new Set(await dataStore.getAllSourceUrls().catch(() => []));
        const limit = parseInt(limitPerBrand) || 500;

        for (const brand of cleanBrands) {
            // Respect pause
            while (brandImportJob.paused && brandImportJob.active) {
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!brandImportJob.active) break;

            brandImportJob.currentBrand = brand;
            try {
                const { urls, brandUrl, logoUrl } = await fetchBrandUrls(brand, limit);
                await dataStore.upsertBrand(brand, logoUrl, brandUrl).catch(() => {});

                const newUrls = urls.filter(u => !existingUrls.has(u));
                const added = await enqueueUrls(newUrls, false);
                newUrls.forEach(u => existingUrls.add(u));

                brandImportJob.urlsQueued += added;
                brandImportJob.brandsSucceeded++;
                brandImportJob.results.push({ brand, total: urls.length, queued: added, skipped: urls.length - added, logoUrl: !!logoUrl });
            } catch (err) {
                brandImportJob.brandsFailed++;
                brandImportJob.results.push({ brand, total: 0, queued: 0, skipped: 0, error: err.message });
            }
            brandImportJob.brandsProcessed++;
        }

        brandImportJob.active = false;
        brandImportJob.currentBrand = null;
        brandImportJob.finishedAt = new Date().toISOString();
    });
});

// POST /api/scrape/brands/bulk/pause - Pause/resume bulk brand import
router.post('/brands/bulk/pause', requireSuperAdmin, (req, res) => {
    if (!brandImportJob.active) return res.json({ success: false, error: 'No active bulk import' });
    brandImportJob.paused = !brandImportJob.paused;
    res.json({ success: true, paused: brandImportJob.paused });
});

// POST /api/scrape/brands/bulk/stop - Stop bulk brand import
router.post('/brands/bulk/stop', requireSuperAdmin, (req, res) => {
    brandImportJob.active = false;
    brandImportJob.paused = false;
    brandImportJob.finishedAt = new Date().toISOString();
    res.json({ success: true });
});

// GET /api/scrape/brands/bulk/status - Get bulk brand import status
router.get('/brands/bulk/status', requireSuperAdmin, (req, res) => {
    res.json({ success: true, job: { ...brandImportJob } });
});

// POST /api/scrape/sitemap - Obtener URLs del sitemap de Fragrantica
router.post('/sitemap', requireSuperAdmin, async (req, res, next) => {
    try {
        const { brand, limit = 100 } = req.body;

        console.log(
            `📥 Fetching sitemap for brand: ${brand || 'all'}, limit: ${limit}`
        );

        const puppeteer = (await import('puppeteer')).default;
        const browser = await puppeteer.launch(BROWSER_CONFIG);

        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
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
                await browser.close().catch(() => {});
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

        await browser.close().catch(() => {});

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
        scrapingQueue.rateLimitedThisSession = 0;
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

    // Compute processing rate and ETA from session data
    let processingRatePerHour = null;
    let etaMs = null;
    if (scrapingQueue.processing && scrapingQueue.startedAt && scrapingQueue.processedThisSession > 0) {
        const elapsedMs = Date.now() - new Date(scrapingQueue.startedAt).getTime();
        const elapsedHours = elapsedMs / (1000 * 60 * 60);
        processingRatePerHour = Math.round(scrapingQueue.processedThisSession / elapsedHours);
        const remaining = (stats.pending || 0) + (stats.processing || 0);
        if (processingRatePerHour > 0) {
            etaMs = Math.round((remaining / processingRatePerHour) * 60 * 60 * 1000);
        }
    }

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
        rateLimitedThisSession: scrapingQueue.rateLimitedThisSession,
        startedAt: scrapingQueue.startedAt,
        activeWorkers,
        configuredWorkers: SCRAPE_WORKERS,
        errors: scrapingQueue.errors.slice(-10),
        // Performance metrics
        processingRatePerHour,
        etaMs,
        // Discovery phase state
        catalogDiscovery: { ...catalogDiscovery },
        // Bulk brand import job
        brandImportJob: { ...brandImportJob, results: brandImportJob.results.slice(-50) },
        // Algolia import job
        algoliaJob: getAlgoliaJobState(),
        // Brand logo fetch job
        logoFetchJob: { ...logoFetchJob, results: logoFetchJob.results.slice(-30) },
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
// Number of parallel scraping workers (tune via SCRAPE_WORKERS env var)
const SCRAPE_WORKERS = Math.max(1, parseInt(process.env.SCRAPE_WORKERS) || 2);
// Delay between each worker's requests (ms) — stagger workers slightly
const BETWEEN_REQUESTS_MS = parseInt(process.env.BETWEEN_REQUESTS_MS) || 15000;
const RATE_LIMIT_PAUSE_MS = parseInt(process.env.RATE_LIMIT_PAUSE_MS) || 60000;

// Active worker count — workers decrement this when they exit
let activeWorkers = 0;

async function scrapeWorker(workerId) {
    activeWorkers++;
    let consecutiveRateLimits = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;

    console.log(`[worker-${workerId}] started`);

    while (scrapingQueue.processing) {
        const item = await dataStore.queueDequeue().catch(() => null);
        if (!item) break; // Queue empty

        const url = typeof item === 'string' ? item : item.url;
        const force = typeof item === 'string' ? false : (item.force ?? false);

        scrapingQueue.current = url;

        try {
            if (!force) {
                const alreadyExists = await dataStore.existsBySourceUrl(url).catch(() => false);
                if (alreadyExists) {
                    console.log(`[worker-${workerId}] ⏭️ Already in DB: ${url}`);
                    await dataStore.queueMark(url, 'done');
                    scrapingQueue.processedThisSession++;
                    consecutiveRateLimits = 0;
                    continue;
                }
            }

            console.log(`[worker-${workerId}] 🔄 Scraping${force ? ' (force)' : ''}: ${url}`);
            const perfume = await scrapePerfume(url);

            if (perfume) {
                if (force) {
                    const existing = await dataStore.getBySourceUrl(url).catch(() => null);
                    if (existing) {
                        await dataStore.update(existing.id, perfume);
                        console.log(`[worker-${workerId}] 🔄 Updated: ${perfume.name}`);
                    } else {
                        await dataStore.add(perfume);
                        console.log(`[worker-${workerId}] ✅ Saved (new): ${perfume.name}`);
                    }
                } else {
                    await dataStore.add(perfume);
                    console.log(`[worker-${workerId}] ✅ Saved: ${perfume.name}`);
                }
                await dataStore.queueMark(url, 'done');
            } else {
                await dataStore.queueMark(url, 'failed', 'No data returned by scraper');
                scrapingQueue.failedThisSession++;
                scrapingQueue.errors.push({ url, error: 'No data returned', type: 'error', time: new Date().toISOString() });
                if (scrapingQueue.errors.length > 50) scrapingQueue.errors.shift();
            }

            scrapingQueue.processedThisSession++;
            consecutiveRateLimits = 0;
        } catch (error) {
            const msg = error.message || '';
            console.error(`[worker-${workerId}] ❌ Failed: ${url} — ${msg}`);

            if (msg.includes('RATE_LIMITED') || msg.includes('Too Many Requests')) {
                consecutiveRateLimits++;
                scrapingQueue.rateLimitedThisSession++;

                // Exponential backoff: 1min → 2min → 5min → 10min
                const backoffSteps = [60000, 120000, 300000, 600000];
                const deferMs = backoffSteps[Math.min(consecutiveRateLimits - 1, backoffSteps.length - 1)];
                // Defer URL in DB — won't be picked up until after deferMs
                await dataStore.queueDefer(url, deferMs).catch(() => dataStore.queueMark(url, 'pending').catch(() => {}));

                const deferMin = Math.round(deferMs / 60000);
                console.warn(`[worker-${workerId}] ⚠️ Rate limit ×${consecutiveRateLimits} — URL deferred ${deferMin}m`);
                scrapingQueue.errors.push({ url, error: `Rate limit (disponible en ${deferMin} min)`, type: 'rate_limit', time: new Date().toISOString() });
                if (scrapingQueue.errors.length > 50) scrapingQueue.errors.shift();

                // Also pause the worker to avoid hammering
                const workerPause = Math.min(deferMs, RATE_LIMIT_PAUSE_MS);
                if (consecutiveRateLimits >= MAX_RATE_LIMIT_RETRIES) {
                    console.warn(`[worker-${workerId}] ⚠️ Multiple rate limits — pausing worker ${workerPause / 60000}min`);
                    consecutiveRateLimits = 0;
                }
                await new Promise(r => setTimeout(r, workerPause));
                continue;
            }

            if (msg.includes('INVALID_DATA')) {
                console.warn(`[worker-${workerId}] ⏭️ Invalid data: ${url}`);
                await dataStore.queueMark(url, 'failed', msg);
                scrapingQueue.failedThisSession++;
                scrapingQueue.errors.push({ url, error: msg, type: 'error', time: new Date().toISOString() });
                if (scrapingQueue.errors.length > 50) scrapingQueue.errors.shift();
                consecutiveRateLimits = 0;
                continue;
            }

            await dataStore.queueMark(url, 'failed', msg);
            scrapingQueue.failedThisSession++;
            scrapingQueue.errors.push({ url, error: msg, type: 'error', time: new Date().toISOString() });
            if (scrapingQueue.errors.length > 50) scrapingQueue.errors.shift();
        }

        await new Promise(r => setTimeout(r, BETWEEN_REQUESTS_MS));
    }

    activeWorkers--;
    console.log(`[worker-${workerId}] done (${activeWorkers} workers still active)`);

    // Last worker out updates state
    if (activeWorkers === 0) {
        scrapingQueue.processing = false;
        scrapingQueue.current = null;
        console.log(`✅ Queue session done. Processed: ${scrapingQueue.processedThisSession}, Failed: ${scrapingQueue.failedThisSession}`);
    }
}

function processQueue() {
    const workers = SCRAPE_WORKERS;
    console.log(`🚀 Starting ${workers} scrape workers (${BETWEEN_REQUESTS_MS}ms between requests each)`);
    for (let i = 1; i <= workers; i++) {
        // Stagger worker start by 2s each to avoid all hitting Chromium at once
        setTimeout(() => scrapeWorker(i), (i - 1) * 2000);
    }
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

        // Queue mode — force=true resets done/failed entries; already-pending/processing stay untouched
        const urls = brandPerfumes.map(p => p.sourceUrl).filter(Boolean);
        const added = await enqueueUrls(urls, true, true); // force=true
        const alreadyQueued = urls.length - added;

        const stats = await dataStore.queueStats().catch(() => ({}));
        res.json({
            success: true,
            added,
            alreadyQueued,
            total: urls.length,
            queueSize: stats.pending ?? added,
            autoStarted: true,
        });
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
        // force=true: bypass existsBySourceUrl check so incomplete perfumes get re-scraped
        const added = await enqueueUrls(urlsToAdd, true, true);

        const stats = await dataStore.queueStats().catch(() => ({}));
        res.json({ success: true, added, queueSize: stats.pending ?? added, autoStarted: true });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/rescrape/queue/ids - Add specific perfume IDs to scraping queue
router.post('/rescrape/queue/ids', requireSuperAdmin, async (req, res, next) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return next(new ApiError('ids array is required', 400));
        }
        if (ids.length > 2000) {
            return next(new ApiError('Maximum 2000 IDs per request', 400));
        }

        // Fetch source URLs for the given IDs
        const perfumes = await dataStore.getByIds(ids);
        const urlsToAdd = perfumes.filter((p) => p.sourceUrl).map((p) => p.sourceUrl);

        if (urlsToAdd.length === 0) {
            return res.json({ success: true, added: 0, queueSize: 0, message: 'No valid source URLs found for selected perfumes' });
        }

        const added = await enqueueUrls(urlsToAdd, true, true);
        const stats = await dataStore.queueStats().catch(() => ({}));
        res.json({ success: true, added, queueSize: stats.pending ?? added, total: ids.length });
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
        scrapingQueue.rateLimitedThisSession = 0;
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

// POST /api/scrape/catalog/upload - Parse uploaded sitemap XML files and queue URLs
const xmlUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 20 } });
router.post('/catalog/upload', requireSuperAdmin, xmlUpload.array('sitemaps'), async (req, res, next) => {
    try {
        const files = req.files || [];
        if (files.length === 0) return res.json({ success: false, error: 'No files uploaded' });

        const existingUrls = new Set(await dataStore.getAllSourceUrls().catch(() => []));
        const allFound = [];

        for (const file of files) {
            const xml = file.buffer.toString('utf-8');
            const urls = (xml.match(/https?:\/\/[^\s<>"]*\/perfume\/[^<\s"]+\.html/g) || [])
                .filter(u => /\/perfume\/[^/]+\/[^/]+\.html$/.test(u));
            allFound.push(...urls);
            console.log(`📂 Sitemap upload "${file.originalname}": ${urls.length} URLs`);
        }

        const uniqueUrls = [...new Set(allFound)];
        const newUrls = uniqueUrls.filter(u => !existingUrls.has(u));
        const added = await enqueueUrls(newUrls, false);

        console.log(`✅ Sitemap upload done: ${uniqueUrls.length} found, ${added} new queued`);
        res.json({
            success: true,
            filesProcessed: files.length,
            totalFound: uniqueUrls.length,
            newQueued: added,
            alreadyExist: uniqueUrls.length - added,
        });
    } catch (err) {
        next(new ApiError(err.message, 500));
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
        console.log('🌍 [bg] Full catalog import: reading Fragrantica sitemaps...');

        // Reset and start discovery tracking
        catalogDiscovery = {
            active: true,
            phase: 'reading_index',
            currentSitemap: 'sitemap.xml',
            sitemapsTotal: 0,
            sitemapsProcessed: 0,
            urlsFound: 0,
            urlsQueued: 0,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: null,
        };

        // Detect Cloudflare / bot-challenge HTML responses (status 200 but not real XML)
        const isBlockedResponse = (text) =>
            text.includes('cf-browser-verification') ||
            text.includes('cf_clearance') ||
            text.includes('Just a moment') ||
            text.includes('Enable JavaScript') ||
            (text.trim().startsWith('<html') && !text.includes('<urlset') && !text.includes('<sitemapindex'));

        // Simple HTTP fetch with timeout
        const httpGet = async (url, ua) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
                const res = await fetch(url, {
                    signal: controller.signal,
                    headers: {
                        'User-Agent': ua,
                        'Accept': 'application/xml,text/xml,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Cache-Control': 'no-cache',
                    },
                });
                clearTimeout(timer);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.text();
            } finally {
                clearTimeout(timer);
            }
        };

        // Fetch via Wayback Machine — archive.org has no Cloudflare bot protection
        // and indexes Fragrantica sitemaps regularly.
        const fetchViaWayback = async (originalUrl) => {
            // Ask Wayback for the most recent snapshot
            const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(originalUrl)}`;
            const meta = await httpGet(apiUrl, 'Mozilla/5.0 (compatible; FragranceAddict/1.0)');
            const { archived_snapshots } = JSON.parse(meta);
            const snapshot = archived_snapshots?.closest;
            if (!snapshot?.available || !snapshot.url) throw new Error('No Wayback snapshot available');
            console.log(`  [bg] Wayback snapshot: ${snapshot.url} (${snapshot.timestamp})`);
            return httpGet(snapshot.url, 'Mozilla/5.0 (compatible; FragranceAddict/1.0)');
        };

        // Try direct fetch first, fall back to Wayback Machine on block/failure
        const fetchXml = async (url) => {
            // 1. Direct fetch with Googlebot UA (most likely whitelisted)
            for (const ua of [
                'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
            ]) {
                try {
                    const text = await httpGet(url, ua);
                    if (!isBlockedResponse(text)) {
                        console.log(`  [bg] ✓ Direct fetch OK: ${url}`);
                        return text;
                    }
                    console.warn(`  [bg] Cloudflare challenge detected for ${url} (UA: ${ua.slice(0, 30)})`);
                } catch (err) {
                    console.warn(`  [bg] Direct fetch failed: ${err.message}`);
                }
            }
            // 2. Fallback: Wayback Machine
            console.log(`  [bg] Trying Wayback Machine for ${url}…`);
            const text = await fetchViaWayback(url);
            if (isBlockedResponse(text)) throw new Error('Wayback snapshot also returned a non-XML response');
            return text;
        };

        try {
            // ── 1. Discover sub-sitemap files from the index ──
            let sitemapUrls = [];
            try {
                const indexXml = await fetchXml('https://www.fragrantica.com/sitemap.xml');
                const matches = indexXml.match(/https?:\/\/[^\s<>"]*sitemap_perfumes_\d+\.xml/g) || [];
                sitemapUrls = [...new Set(matches)];
                console.log(`  [bg] Sitemap index: found ${sitemapUrls.length} perfume sub-sitemaps`);
            } catch (err) {
                console.warn(`  [bg] ⚠️ Could not fetch sitemap index: ${err.message}`);
            }

            // Fallback: probe known numbered paths (Fragrantica typically uses up to ~13 files)
            if (sitemapUrls.length === 0) {
                for (let i = 1; i <= 13; i++) {
                    sitemapUrls.push(`https://www.fragrantica.com/sitemap_perfumes_${i}.xml`);
                }
                console.log(`  [bg] Fallback: probing ${sitemapUrls.length} candidate sub-sitemap URLs`);
            }

            catalogDiscovery.sitemapsTotal = sitemapUrls.length;
            catalogDiscovery.phase = 'reading_sitemaps';

            // ── 2. Extract perfume URLs from each sub-sitemap ──
            const existingUrls = new Set(await dataStore.getAllSourceUrls().catch(() => []));
            const allFound = [];

            for (const sitemapUrl of sitemapUrls) {
                catalogDiscovery.currentSitemap = sitemapUrl.split('/').pop();
                try {
                    const xml = await fetchXml(sitemapUrl);
                    const urls = (xml.match(/https?:\/\/[^\s<>"]*\/perfume\/[^<\s"]+\.html/g) || [])
                        .filter(u => /\/perfume\/[^/]+\/[^/]+\.html$/.test(u));
                    if (urls.length > 0) {
                        allFound.push(...urls);
                        catalogDiscovery.urlsFound = allFound.length;
                        console.log(`  [bg] ${sitemapUrl}: ${urls.length} URLs (total so far: ${allFound.length})`);
                    } else {
                        console.log(`  [bg] ${sitemapUrl}: 0 URLs (empty or end of list)`);
                    }
                } catch (err) {
                    console.warn(`  [bg] ⚠️ Skipping ${sitemapUrl}: ${err.message}`);
                }
                catalogDiscovery.sitemapsProcessed++;
            }

            if (allFound.length === 0) {
                console.error('[bg] ❌ Full catalog: no URLs found from any source.');
                catalogDiscovery.active = false;
                catalogDiscovery.phase = 'error';
                catalogDiscovery.error = 'No se encontraron URLs. Fragrantica y Wayback Machine no devolvieron resultados — intenta de nuevo en unos minutos.';
                catalogDiscovery.finishedAt = new Date().toISOString();
                return;
            }

            const uniqueUrls = [...new Set(allFound)];
            const newUrls = uniqueUrls.filter(u => !existingUrls.has(u));

            // ── 3. Add new URLs to persistent DB queue ──
            catalogDiscovery.phase = 'enqueueing';
            catalogDiscovery.currentSitemap = null;
            const added = await enqueueUrls(newUrls, autoStart);
            catalogDiscovery.urlsQueued = added;

            console.log(`✅ [bg] Full catalog done: ${uniqueUrls.length} unique found, ${added} new queued, ${uniqueUrls.length - added} already existed`);

            catalogDiscovery.active = false;
            catalogDiscovery.phase = 'done';
            catalogDiscovery.finishedAt = new Date().toISOString();
        } catch (err) {
            console.error('[bg] ❌ Full catalog discovery error:', err.message);
            catalogDiscovery.active = false;
            catalogDiscovery.phase = 'error';
            catalogDiscovery.error = err.message;
            catalogDiscovery.finishedAt = new Date().toISOString();
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

// ─── Brand logo fetch job tracker (in-memory) ────────────────────────────────
let logoFetchJob = {
    running: false,
    source: 'db',
    total: 0,
    processed: 0,
    updated: 0,
    failed: 0,
    results: [],
    startedAt: null,
    completedAt: null,
};

// ─── POST /api/scrape/brands/logos ───────────────────────────────────────────
// Fetch brand logos from Fragrantica brand pages (most reliable source for fragrance brands).
// Starts a background job and returns immediately; poll GET /brands/logos/status for progress.

router.post('/brands/logos', requireSuperAdmin, async (req, res, next) => {
    try {
        if (logoFetchJob.running) {
            return res.json({ success: true, status: 'already_running', job: logoFetchJob });
        }

        const { force = false, source = 'db' } = req.body;

        let brandsToProcess;

        if (source === 'algolia') {
            const algoliaKey = process.env.ALGOLIA_API_KEY;
            if (!algoliaKey) {
                return res.json({ success: false, error: 'Algolia API key not configured' });
            }
            // Fetch all brand names from Algolia facet API
            const ALGOLIA_APP_ID = 'FGVI612DFZ';
            const ALGOLIA_INDEX = 'fragrantica_perfumes';
            const algoliaBase = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net`;
            const allBrandNames = new Set();
            const prefixes = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').concat(['']);
            for (const prefix of prefixes) {
                try {
                    const resp = await fetch(
                        `${algoliaBase}/1/indexes/${ALGOLIA_INDEX}/facets/dizajner/query`,
                        {
                            method: 'POST',
                            headers: {
                                'X-Algolia-Application-Id': ALGOLIA_APP_ID,
                                'X-Algolia-API-Key': algoliaKey,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ facetQuery: prefix, maxFacetHits: 100 }),
                            signal: AbortSignal.timeout(10000),
                        }
                    );
                    if (resp.ok) {
                        const data = await resp.json();
                        for (const hit of (data.facetHits || [])) allBrandNames.add(hit.value);
                    }
                    await new Promise(r => setTimeout(r, 120));
                } catch { /* ignore prefix errors */ }
            }
            if (allBrandNames.size === 0) {
                return res.json({ success: false, error: 'No brands found in Algolia — check API key' });
            }
            const brandsWithSavedLogos = await dataStore.getBrandsWithSavedLogos();
            const savedLogoSet = new Set(brandsWithSavedLogos.map(b => b.name.toLowerCase()));
            const names = [...allBrandNames];
            brandsToProcess = force
                ? names.map(name => ({ name }))
                : names.filter(name => !savedLogoSet.has(name.toLowerCase())).map(name => ({ name }));
        } else {
            // Query brands table directly to know which ones truly have no logo_url saved
            const allBrands = await dataStore.getBrands();
            const brandsWithSavedLogos = await dataStore.getBrandsWithSavedLogos();
            const savedLogoSet = new Set(brandsWithSavedLogos.map(b => b.name.toLowerCase()));
            brandsToProcess = force
                ? allBrands.filter(b => b.name)
                : allBrands.filter(b => b.name && !savedLogoSet.has(b.name.toLowerCase()));
        }

        if (brandsToProcess.length === 0) {
            return res.json({ success: true, status: 'done', total: 0, updated: 0, failed: 0, results: [], message: 'All brands already have logos.' });
        }

        logoFetchJob = {
            running: true,
            source,
            total: brandsToProcess.length,
            processed: 0,
            updated: 0,
            failed: 0,
            results: [],
            startedAt: new Date().toISOString(),
            completedAt: null,
        };

        res.json({ success: true, status: 'started', total: brandsToProcess.length });

        setImmediate(async () => {
            const puppeteer = (await import('puppeteer')).default;
            let browser = null;
            try {
                browser = await puppeteer.launch(BROWSER_CONFIG);

                for (const brand of brandsToProcess) {
                    if (!logoFetchJob.running) break;
                    try {
                        const { logoUrl, source } = await fetchBrandLogoMultiSource(browser, brand.name);
                        if (logoUrl) {
                            await dataStore.upsertBrand(brand.name, logoUrl, null);
                            logoFetchJob.results.push({ name: brand.name, logoUrl, source, status: 'updated' });
                            logoFetchJob.updated++;
                            console.log(`🖼️  Logo [${source}] "${brand.name}"`);
                        } else {
                            logoFetchJob.results.push({ name: brand.name, logoUrl: null, source: null, status: 'not_found' });
                            logoFetchJob.failed++;
                        }
                    } catch (err) {
                        logoFetchJob.results.push({ name: brand.name, logoUrl: null, source: null, status: 'error', error: err.message });
                        logoFetchJob.failed++;
                        console.warn(`⚠️  Logo error "${brand.name}": ${err.message}`);
                    }
                    logoFetchJob.processed++;
                    // Respectful delay between brands
                    await new Promise(r => setTimeout(r, 1200));
                }
            } catch (err) {
                console.error('Logo fetch job crashed:', err.message);
            } finally {
                if (browser) await browser.close().catch(() => {});
                logoFetchJob.running = false;
                logoFetchJob.completedAt = new Date().toISOString();
                console.log(`✅ Logo fetch done: ${logoFetchJob.updated} updated, ${logoFetchJob.failed} not found`);
            }
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/scrape/brands/logos/status — poll progress of the background logo fetch job
router.get('/brands/logos/status', requireSuperAdmin, (req, res) => {
    res.json({ success: true, ...logoFetchJob });
});

// ─── Multi-source brand logo fetcher ─────────────────────────────────────────
// Tries sources in order: Clearbit → DuckDuckGo → Parfumo → Fragrantica (multiple slugs)
// Returns { logoUrl, source } or { logoUrl: null, source: null }

async function fetchBrandLogoMultiSource(browser, brandName) {
    // --- Source 1: Clearbit Logo API (fast, no browser, works for major brands) ---
    const clearbitUrl = await tryLogoFromClearbit(brandName);
    if (clearbitUrl) return { logoUrl: clearbitUrl, source: 'clearbit' };

    // --- Source 2: DuckDuckGo Instant Answer (entity image for known brands) ---
    const ddgUrl = await tryLogoFromDuckDuckGo(brandName);
    if (ddgUrl) return { logoUrl: ddgUrl, source: 'duckduckgo' };

    // --- Source 3: Parfumo (fragrance-specific, no anti-bot) ---
    const parfumoUrl = await tryLogoFromParfumo(browser, brandName);
    if (parfumoUrl) return { logoUrl: parfumoUrl, source: 'parfumo' };

    // --- Source 4: Fragrantica (multiple slug patterns) ---
    const fragranticaUrl = await tryLogoFromFragrantica(browser, brandName);
    if (fragranticaUrl) return { logoUrl: fragranticaUrl, source: 'fragrantica' };

    return { logoUrl: null, source: null };
}

// Generate multiple slug variants to try for a brand name
function brandSlugs(brandName) {
    const base = brandName.trim();
    const slugs = [];
    // Variant 1: spaces → hyphens, remove apostrophes, & → and
    slugs.push(base.replace(/\s+/g, '-').replace(/[''']/g, '').replace(/&/g, 'and').replace(/[^\w-]/g, ''));
    // Variant 2: spaces → underscores
    slugs.push(base.replace(/\s+/g, '_').replace(/[''']/g, '').replace(/&/g, 'and').replace(/[^\w_]/g, ''));
    // Variant 3: no separator (compact)
    slugs.push(base.replace(/\s+/g, '').replace(/[''']/g, '').replace(/&/g, 'and').replace(/[^\w]/g, ''));
    // Variant 4: URL-encoded original (handles accents)
    slugs.push(encodeURIComponent(base.replace(/\s+/g, '-')));
    return [...new Set(slugs)];
}

// Clearbit Logo API — fast HTTP, no browser needed, excellent for major consumer brands
async function tryLogoFromClearbit(brandName) {
    try {
        const slug = brandName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
        const candidates = [
            `${slug}.com`,
            `${brandName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.com`,
            `${brandName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '')}.fr`,
            `${slug}parfums.com`,
            `parfums${slug}.com`,
            `maison${slug}.com`,
        ];
        for (const domain of candidates) {
            try {
                const url = `https://logo.clearbit.com/${domain}?size=200&format=png`;
                const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
                if (resp.ok) {
                    const ct = resp.headers.get('content-type') || '';
                    if (ct.startsWith('image/') && !ct.includes('svg')) return url;
                }
            } catch { /* try next */ }
        }
    } catch { /* ignore */ }
    return null;
}

// DuckDuckGo Instant Answer — entity images for well-known brands
async function tryLogoFromDuckDuckGo(brandName) {
    try {
        const q = encodeURIComponent(`${brandName} perfume brand`);
        const resp = await fetch(
            `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        const img = data.Image || data.RelatedTopics?.[0]?.Icon?.URL || null;
        if (img && img.startsWith('http') && !img.includes('duckduckgo.com/i/')) return img;
    } catch { /* ignore */ }
    return null;
}

// Parfumo — fragrance-specific site, friendlier to scraping than Fragrantica
async function tryLogoFromParfumo(browser, brandName) {
    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        const slug = brandName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
        await page.goto(`https://www.parfumo.com/Perfumes/${slug}`, {
            waitUntil: 'domcontentloaded', timeout: 20000,
        });
        await new Promise(r => setTimeout(r, 800));
        const logoUrl = await page.evaluate(() => {
            const selectors = [
                '.brand-logo img', '.house-logo img',
                'img[class*="logo"]', 'img[alt*="logo"]',
                '.brand img', 'header img',
            ];
            for (const sel of selectors) {
                const img = document.querySelector(sel);
                if (img?.src && img.naturalWidth > 30) return img.src;
            }
            return null;
        }).catch(() => null);
        return logoUrl;
    } catch { return null; }
    finally { await page.close().catch(() => {}); }
}

// Fragrantica — tries multiple slug patterns, most authoritative for fragrance brands
async function tryLogoFromFragrantica(browser, brandName) {
    const page = await browser.newPage();
    try {
        await addStealthScripts(page);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        for (const slug of brandSlugs(brandName)) {
            try {
                const url = `https://www.fragrantica.com/designers/${slug}.html`;
                const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
                if (!resp || resp.status() === 404) continue;

                await new Promise(r => setTimeout(r, 1200));

                const logoUrl = await page.evaluate(() => {
                    // Fragrantica stores brand images in /dizajneri/ path or fimgs CDN
                    const selectors = [
                        'img[src*="/dizajneri/"]',
                        'img[src*="fimgs.net"][src*="brand"]',
                        'img[src*="fimgs.net"][src*="mdimg"]',
                        '.brand-header img',
                        'header .cell img',
                        'h1 + div img',
                        '#main-content > div:first-child img',
                    ];
                    for (const sel of selectors) {
                        const img = document.querySelector(sel);
                        if (img?.src && img.naturalWidth > 40 && img.naturalHeight > 20) return img.src;
                    }
                    // Last resort: any fimgs.net image on the page
                    const imgs = [...document.querySelectorAll('img[src*="fimgs.net"]')];
                    const best = imgs.find(i => i.naturalWidth > 40 && !i.src.includes('/thumbs/'));
                    return best?.src || null;
                }).catch(() => null);

                if (logoUrl) return logoUrl;
            } catch { /* try next slug */ }
        }
        return null;
    } finally { await page.close().catch(() => {}); }
}

// GET /api/scrape/brands/without-logos — list of brand names with no logo in DB
router.get('/brands/without-logos', requireSuperAdmin, async (req, res, next) => {
    try {
        const brandsResult = await dataStore.getBrands();
        const missing = brandsResult
            .filter(b => b.name && !b.logo_url)
            .map(b => b.name)
            .sort();
        res.json({ success: true, total: missing.length, brands: missing });
    } catch (err) {
        next(err);
    }
});


// ─── Logo upload: single brand ───────────────────────────────────────────────
// POST /api/scrape/brands/logo/upload
// Form fields: brandName (string), file (image)
router.post(
    '/brands/logo/upload',
    requireSuperAdmin,
    logoUpload.single('file'),
    async (req, res, next) => {
        try {
            if (!req.file) return next(new ApiError('No file uploaded', 400));
            const brandName = (req.body.brandName || '').trim();
            if (!brandName) return next(new ApiError('brandName is required', 400));

            const mime = req.file.mimetype || 'image/png';
            const logoUrl = `data:${mime};base64,${req.file.buffer.toString('base64')}`;

            await dataStore.setBrandLogo(brandName, logoUrl);
            res.json({ success: true, brand: brandName, logoUrl });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Logo upload: bulk (multiple files, filename = brand key) ─────────────────
// POST /api/scrape/brands/logos/bulk-upload
// Form fields: files[] (images); optional mapping[] JSON: [{filename, brandName}]
router.post(
    '/brands/logos/bulk-upload',
    requireSuperAdmin,
    logoUpload.array('files', 100),
    async (req, res, next) => {
        try {
            const files = req.files;
            if (!files || files.length === 0) return next(new ApiError('No files uploaded', 400));

            // Optional explicit mapping: [{filename, brandName}]
            let mapping = {};
            if (req.body.mapping) {
                try {
                    const pairs = JSON.parse(req.body.mapping);
                    if (Array.isArray(pairs)) {
                        pairs.forEach(p => { if (p.filename && p.brandName) mapping[p.filename] = p.brandName; });
                    }
                } catch { /* ignore bad JSON */ }
            }

            const results = [];

            for (const file of files) {
                const mime = file.mimetype || 'image/png';
                const logoUrl = `data:${mime};base64,${file.buffer.toString('base64')}`;
                // Resolve brand name: explicit mapping → original filename without ext
                const brandName = mapping[file.originalname]
                    || file.originalname.replace(/\.[^.]+$/, '');
                try {
                    await dataStore.setBrandLogo(brandName, logoUrl);
                    results.push({ filename: file.originalname, brand: brandName, logoUrl: logoUrl.slice(0, 60) + '…', success: true });
                } catch (err) {
                    results.push({ filename: file.originalname, brand: brandName, success: false, error: err.message });
                }
            }

            const updated = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;
            res.json({ success: true, total: files.length, updated, failed, results });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
