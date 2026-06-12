/**
 * Algolia integration routes — Fragrantica data extraction
 *
 * Fragrantica uses Algolia as its search backend. The API key is a
 * client-side temporary key (expires ~every 3 weeks) that can be captured
 * from browser DevTools when visiting fragrantica.com.
 *
 * Application ID: FGVI612DFZ
 * DSN Host: fgvi612dfz-dsn.algolia.net
 * Index: fragrantica_perfumes
 */

import express from 'express';
import { dataStore } from '../services/dataStore.js';
import { requireSuperAdmin, requireApiKey } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { fetchFreshAlgoliaKey, algoliaKeyExpiry } from '../services/algoliaService.js';

const router = express.Router();

const ALGOLIA_APP_ID = 'FGVI612DFZ';
const ALGOLIA_BASE   = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net`;
const INDEX          = 'fragrantica_perfumes';

// ── In-memory job state ─────────────────────────────────────────────────────
let algoliaImportJob = {
    active: false,
    phase: null,       // 'brands' | 'perfumes' | 'enqueueing' | 'done' | 'error'
    brandsDiscovered: 0,
    perfumesDiscovered: 0,
    urlsQueued: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function getApiKey() {
    return process.env.ALGOLIA_API_KEY || '';
}

function parseKeyExpiry(key) {
    try {
        const padded = key + '==';
        const decoded = Buffer.from(padded, 'base64').toString('utf-8');
        const match = decoded.match(/validUntil=(\d+)/);
        return match ? parseInt(match[1]) : null;
    } catch {
        return null;
    }
}

function isKeyValid(key) {
    if (!key) return false;
    const ts = parseKeyExpiry(key);
    if (!ts) return true; // key exists but can't parse expiry — assume valid
    return ts > Math.floor(Date.now() / 1000);
}

function slugify(str) {
    const s = str || '';
    // Normalise accents then strip combining marks
    const normalized = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return normalized
        .toLowerCase()
        .replace(/[''`]/g, '')
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function buildPerfumeUrl(record) {
    const brandSlug = slugify(record.dizajner || '');
    const nameSlug  = slugify(record.naslov   || '');
    const id        = record.objectID;
    return `https://www.fragrantica.com/perfume/${brandSlug}/${nameSlug}-${id}.html`;
}

async function algoliaPost(path, body) {
    const key = getApiKey();
    if (!key) throw new Error('Algolia API key not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(`${ALGOLIA_BASE}${path}`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'X-Algolia-Application-Id': ALGOLIA_APP_ID,
                'X-Algolia-API-Key': key,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        clearTimeout(timer);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Algolia HTTP ${res.status}`);
        }
        return res.json();
    } finally {
        clearTimeout(timer);
    }
}

// Fetch a single facet page
async function fetchFacetPage(field, prefix, max = 100) {
    const data = await algoliaPost(
        `/1/indexes/${INDEX}/facets/${field}/query`,
        { facetQuery: prefix, maxFacetHits: max },
    );
    return data.facetHits || [];
}

// Fetch ALL values of a facet by iterating a–z + digits + specials
async function fetchAllFacetValues(field) {
    const prefixes = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
        .concat(['', 'à','á','â','ä','å','ç','è','é','ê','ë','ì','í',
                 'ñ','ò','ó','ô','ö','ø','ù','ú','û','ü','š','ž']);
    const results = {};
    for (const prefix of prefixes) {
        try {
            const hits = await fetchFacetPage(field, prefix);
            for (const h of hits) results[h.value] = h.count;
            await new Promise(r => setTimeout(r, 200)); // rate limit respect
        } catch (err) {
            console.warn(`[algolia] facet "${field}" prefix "${prefix}": ${err.message}`);
        }
    }
    return results;
}

// Fetch ALL perfumes for a brand using facetFilters (correct syntax for string facets)
async function fetchPerfumesForBrand(brand, maxPages = 200) {
    const urls = [];
    for (let page = 0; page < maxPages; page++) {
        const data = await algoliaPost(`/1/indexes/${INDEX}/query`, {
            query: '',
            facetFilters: [`dizajner:${brand}`],
            hitsPerPage: 1000,
            page,
            attributesToRetrieve: ['naslov', 'dizajner', 'objectID'],
        });
        const hits = data.hits || [];
        hits.forEach(h => urls.push(buildPerfumeUrl(h)));
        if (data.page >= (data.nbPages || 1) - 1) break;
        await new Promise(r => setTimeout(r, 150));
    }
    return urls;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/algolia/status
router.get('/status', requireSuperAdmin, (req, res) => {
    const key = getApiKey();
    const valid = isKeyValid(key);
    const ts = key ? parseKeyExpiry(key) : null;
    res.json({
        success: true,
        configured: !!key,
        valid,
        expiresAt: ts ? new Date(ts * 1000).toISOString() : null,
        expiresTs: ts,
        keyPreview: key ? key.slice(0, 8) + '…' : null,
        job: { ...algoliaImportJob },
    });
});

// POST /api/algolia/key — save new Algolia API key (persisted across restarts)
router.post('/key', requireSuperAdmin, async (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return res.json({ success: false, error: 'apiKey is required' });
    }
    const key = apiKey.trim();
    const ts = parseKeyExpiry(key);
    process.env.ALGOLIA_API_KEY = key;
    if (ts) process.env.ALGOLIA_KEY_EXPIRES = String(ts);

    // Persist to DB so the rotating key survives container restarts.
    let persisted = false;
    try {
        await dataStore.setSetting('ALGOLIA_API_KEY', key);
        persisted = true;
    } catch (err) {
        console.warn('[algolia] Could not persist key to DB:', err.message);
    }

    res.json({
        success: true,
        valid: isKeyValid(key),
        expiresAt: ts ? new Date(ts * 1000).toISOString() : null,
        persisted,
        message: persisted
            ? 'API key saved and persisted — it will survive restarts.'
            : 'API key saved for this session (DB unavailable, will not persist across restarts).',
    });
});

// Shared: fetch a fresh key from Fragrantica's public HTML, persist it, apply it.
// Used by the manual refresh endpoint and the auto-refresh scheduler.
export async function refreshAlgoliaKey() {
    const { key, expiresTs, source } = await fetchFreshAlgoliaKey();
    process.env.ALGOLIA_API_KEY = key;
    process.env.ALGOLIA_KEY_EXPIRES = String(expiresTs);
    let persisted = false;
    try {
        await dataStore.setSetting('ALGOLIA_API_KEY', key);
        persisted = true;
    } catch (err) {
        console.warn('[algolia] Could not persist refreshed key:', err.message);
    }
    console.log(`🔑 Algolia key refreshed from ${source} (expires ${new Date(expiresTs * 1000).toISOString()})`);
    return { key, expiresTs, source, persisted };
}

// POST /api/algolia/key/external — ingest a key fetched by an off-server cron
// (e.g. GitHub Actions), authed by x-api-key instead of a JWT. Use this when
// Cloudflare blocks the server IP so it cannot self-refresh: the cron runs the
// fetch+extract from a non-blocked IP and pushes the key here.
router.post('/key/external', requireApiKey, async (req, res, next) => {
    try {
        const key = (req.body?.apiKey || '').trim();
        if (!key) return next(new ApiError('apiKey is required', 400));
        const exp = algoliaKeyExpiry(key);
        if (exp && exp <= Math.floor(Date.now() / 1000)) {
            return next(new ApiError('Provided key is already expired', 400));
        }
        process.env.ALGOLIA_API_KEY = key;
        if (exp) process.env.ALGOLIA_KEY_EXPIRES = String(exp);
        let persisted = false;
        try { await dataStore.setSetting('ALGOLIA_API_KEY', key); persisted = true; } catch { /* noop */ }
        console.log(`🔑 Algolia key ingested via API (expires ${exp ? new Date(exp * 1000).toISOString() : 'unknown'})`);
        res.json({ success: true, persisted, expiresAt: exp ? new Date(exp * 1000).toISOString() : null });
    } catch (err) {
        next(new ApiError(err.message, 500));
    }
});

// POST /api/algolia/key/refresh — auto-fetch a fresh key from Fragrantica's public HTML
router.post('/key/refresh', requireSuperAdmin, async (req, res, next) => {
    try {
        const r = await refreshAlgoliaKey();
        res.json({
            success: true,
            valid: true,
            expiresAt: new Date(r.expiresTs * 1000).toISOString(),
            source: r.source,
            persisted: r.persisted,
            message: 'Fetched and applied a fresh Algolia key automatically.',
        });
    } catch (err) {
        next(new ApiError(err.message, 502));
    }
});

// GET /api/algolia/brands — fetch all brands from Algolia
router.get('/brands', requireSuperAdmin, async (req, res, next) => {
    try {
        if (!isKeyValid(getApiKey())) {
            return res.json({ success: false, error: 'Algolia API key is missing or expired' });
        }
        const brands = await fetchAllFacetValues('dizajner');
        const list = Object.entries(brands)
            .map(([name, count]) => ({
                name,
                count,
                slug: slugify(name),
                url: `https://www.fragrantica.com/designers/${slugify(name)}.html`,
            }))
            .sort((a, b) => b.count - a.count);
        res.json({ success: true, total: list.length, brands: list });
    } catch (err) {
        next(new ApiError(err.message, 500));
    }
});

// POST /api/algolia/import/catalog — queue ALL perfumes via Algolia
router.post('/import/catalog', requireSuperAdmin, async (req, res) => {
    if (!isKeyValid(getApiKey())) {
        return res.json({ success: false, error: 'Algolia API key is missing or expired' });
    }
    if (algoliaImportJob.active) {
        return res.json({ success: false, error: 'An Algolia import is already running' });
    }

    algoliaImportJob = {
        active: true, phase: 'brands', brandsDiscovered: 0,
        perfumesDiscovered: 0, urlsQueued: 0,
        startedAt: new Date().toISOString(), finishedAt: null, error: null,
    };

    res.json({ success: true, message: 'Algolia catalog import started in background' });

    setImmediate(async () => {
        try {
            // 1. Get all brands via facet API
            console.log('[algolia] Fetching all brands…');
            const brandMap = await fetchAllFacetValues('dizajner');
            const brandNames = Object.keys(brandMap);
            algoliaImportJob.brandsDiscovered = brandNames.length;
            algoliaImportJob.phase = 'perfumes';
            console.log(`[algolia] Found ${brandNames.length} brands`);

            // 2. For each brand, fetch perfumes using facetFilters (requires only search ACL)
            const existingUrls = new Set(await dataStore.getAllSourceUrls().catch(() => []));
            const allUrls = [];

            for (const brand of brandNames) {
                if (!algoliaImportJob.active) break;
                try {
                    const urls = await fetchPerfumesForBrand(brand);
                    urls.forEach(u => { if (!existingUrls.has(u)) allUrls.push(u); });
                    algoliaImportJob.perfumesDiscovered += urls.length;
                } catch (err) {
                    console.warn(`[algolia] Brand "${brand}": ${err.message}`);
                }
            }

            // 3. Enqueue
            algoliaImportJob.phase = 'enqueueing';
            const uniqueNew = [...new Set(allUrls)];
            const added = await dataStore.queueEnqueue(uniqueNew, false).catch(() => 0);
            algoliaImportJob.urlsQueued = added;

            console.log(`[algolia] Done: ${algoliaImportJob.perfumesDiscovered} found, ${uniqueNew.length} new, ${added} queued`);
            algoliaImportJob.active = false;
            algoliaImportJob.phase = 'done';
            algoliaImportJob.finishedAt = new Date().toISOString();
        } catch (err) {
            console.error('[algolia] Import error:', err.message);
            algoliaImportJob.active = false;
            algoliaImportJob.phase = 'error';
            algoliaImportJob.error = err.message;
            algoliaImportJob.finishedAt = new Date().toISOString();
        }
    });
});

// POST /api/algolia/import/stop
router.post('/import/stop', requireSuperAdmin, (req, res) => {
    algoliaImportJob.active = false;
    algoliaImportJob.finishedAt = new Date().toISOString();
    res.json({ success: true });
});

export function getAlgoliaJobState() { return { ...algoliaImportJob }; }
export default router;
