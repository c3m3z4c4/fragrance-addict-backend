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
let scrapingQueue = {
    urls: [],
    processing: false,
    current: null,
    processed: 0,
    failed: 0,
    total: 0,
    startedAt: null,
    errors: [],
};

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

        const newUrls = validUrls.filter((url) => !existingUrls.has(url));

        scrapingQueue.urls.push(...newUrls);
        scrapingQueue.total =
            scrapingQueue.urls.length + scrapingQueue.processed;

        console.log(
            `📥 Added ${newUrls.length} URLs to queue (${
                validUrls.length - newUrls.length
            } duplicates skipped)`
        );

        res.json({
            success: true,
            added: newUrls.length,
            skipped: validUrls.length - newUrls.length,
            queueSize: scrapingQueue.urls.length,
        });
    } catch (error) {
        console.error('Queue error:', error);
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/queue/start - Start processing the queue
router.post('/queue/start', requireSuperAdmin, async (req, res, next) => {
    try {
        if (scrapingQueue.processing) {
            return res.json({
                success: false,
                message: 'Queue already processing',
            });
        }

        if (scrapingQueue.urls.length === 0) {
            return res.json({ success: false, message: 'Queue is empty' });
        }

        scrapingQueue.processing = true;
        scrapingQueue.startedAt = new Date().toISOString();
        scrapingQueue.errors = [];

        console.log(
            `🚀 Starting queue processing: ${scrapingQueue.urls.length} URLs`
        );

        // Start processing in background
        processQueue();

        res.json({
            success: true,
            message: 'Queue processing started',
            queueSize: scrapingQueue.urls.length,
        });
    } catch (error) {
        next(new ApiError(error.message, 500));
    }
});

// POST /api/scrape/queue/stop - Stop processing the queue
router.post('/queue/stop', requireSuperAdmin, (req, res) => {
    scrapingQueue.processing = false;
    console.log('⏹️ Queue processing stopped');

    res.json({
        success: true,
        message: 'Queue processing stopped',
        processed: scrapingQueue.processed,
        remaining: scrapingQueue.urls.length,
    });
});

// GET /api/scrape/queue/status - Get queue status
router.get('/queue/status', requireSuperAdmin, (req, res) => {
    res.json({
        success: true,
        processing: scrapingQueue.processing,
        current: scrapingQueue.current,
        processed: scrapingQueue.processed,
        failed: scrapingQueue.failed,
        remaining: scrapingQueue.urls.length,
        total: scrapingQueue.total,
        startedAt: scrapingQueue.startedAt,
        errors: scrapingQueue.errors.slice(-10), // Last 10 errors
    });
});

// DELETE /api/scrape/queue - Clear the queue
router.delete('/queue', requireSuperAdmin, (req, res) => {
    scrapingQueue = {
        urls: [],
        processing: false,
        current: null,
        processed: 0,
        failed: 0,
        total: 0,
        startedAt: null,
        errors: [],
    };

    console.log('🗑️ Queue cleared');
    res.json({ success: true, message: 'Queue cleared' });
});

// Background queue processor
async function processQueue() {
    let consecutiveRateLimits = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;
    const RATE_LIMIT_PAUSE_MS = 120000; // 2 minutes pause on rate limit

    while (scrapingQueue.processing && scrapingQueue.urls.length > 0) {
        const url = scrapingQueue.urls.shift();
        scrapingQueue.current = url;

        try {
            console.log(`🔄 Processing: ${url}`);
            const perfume = await scrapePerfume(url);

            if (perfume) {
                await dataStore.add(perfume);
                console.log(`✅ Saved: ${perfume.name}`);
            }

            scrapingQueue.processed++;
            consecutiveRateLimits = 0; // Reset on success
        } catch (error) {
            const errorMessage = error.message || '';
            console.error(`❌ Failed: ${url} - ${errorMessage}`);

            // Check if it's a rate limit error
            if (
                errorMessage.includes('RATE_LIMITED') ||
                errorMessage.includes('Too Many Requests')
            ) {
                consecutiveRateLimits++;
                console.warn(
                    `⚠️ Rate limit detected (${consecutiveRateLimits}/${MAX_RATE_LIMIT_RETRIES})`
                );

                // Put the URL back at the front of the queue for retry
                scrapingQueue.urls.unshift(url);

                if (consecutiveRateLimits >= MAX_RATE_LIMIT_RETRIES) {
                    console.error(
                        '🛑 Too many rate limits. Stopping queue to prevent blocking.'
                    );
                    scrapingQueue.errors.push({
                        url,
                        error: 'Rate limit alcanzado múltiples veces. Cola pausada automáticamente.',
                        time: new Date().toISOString(),
                    });
                    scrapingQueue.processing = false;
                    break;
                }

                // Pause for 1 minute before retrying
                console.log(
                    `⏸️ Pausando ${
                        RATE_LIMIT_PAUSE_MS / 1000
                    } segundos por rate limit...`
                );
                await new Promise((resolve) =>
                    setTimeout(resolve, RATE_LIMIT_PAUSE_MS)
                );
                continue;
            }

            // For invalid data errors, just skip and continue
            if (errorMessage.includes('INVALID_DATA')) {
                console.warn(`⏭️ Skipping invalid data: ${url}`);
                scrapingQueue.failed++;
                scrapingQueue.errors.push({
                    url,
                    error: errorMessage,
                    time: new Date().toISOString(),
                });
                consecutiveRateLimits = 0;
                continue;
            }

            // For other errors, log and continue
            scrapingQueue.failed++;
            scrapingQueue.errors.push({
                url,
                error: errorMessage,
                time: new Date().toISOString(),
            });
        }

        // Delay between requests (15 seconds to be safer against rate limits)
        await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    scrapingQueue.processing = false;
    scrapingQueue.current = null;
    console.log(
        `✅ Queue processing complete. Processed: ${scrapingQueue.processed}, Failed: ${scrapingQueue.failed}`
    );
}

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

export default router;
