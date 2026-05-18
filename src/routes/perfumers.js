import express from 'express';
import { dataStore } from '../services/dataStore.js';
import { requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();

// ─── Wikipedia / DuckDuckGo auto-search ──────────────────────────────────────

async function searchPerfumerOnWikipedia(name) {
    try {
        // 1. Search Wikipedia for the perfumer
        const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name + ' perfumer')}&srlimit=3&format=json&origin=*`;
        const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
        if (!searchResp.ok) return null;
        const searchData = await searchResp.json();
        const hits = searchData?.query?.search;
        if (!hits?.length) return null;

        // Find best hit — prefer exact name match or "perfumer" in snippet
        const best = hits.find(h =>
            h.title.toLowerCase().includes(name.toLowerCase()) ||
            (h.snippet || '').toLowerCase().includes('perfum')
        ) || hits[0];

        // 2. Fetch page details: image + extract
        const pageUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(best.title)}&prop=pageimages|extracts&exintro=true&piprop=original&pithumbsize=400&exchars=600&format=json&origin=*&redirects=1`;
        const pageResp = await fetch(pageUrl, { signal: AbortSignal.timeout(8000) });
        if (!pageResp.ok) return null;
        const pageData = await pageResp.json();
        const pages = pageData?.query?.pages;
        const page = pages ? Object.values(pages)[0] : null;
        if (!page || page.missing) return null;

        const imageUrl = page.original?.source || page.thumbnail?.source || null;
        const rawExtract = page.extract || '';

        // Strip HTML tags from extract
        const bio = rawExtract
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500) || null;

        // Try to parse nationality from bio text
        const nationalityMatch = bio?.match(
            /\b(French|Spanish|American|British|Italian|German|Japanese|Belgian|Swiss|Brazilian|Argentine|Russian|Australian|Canadian|Dutch|Swedish|Norwegian|Danish|Polish|Portuguese|Greek|Turkish|Chinese|Korean|Indian|Mexican|Colombian|Venezuelan|Moroccan|Egyptian|Lebanese|Israeli|Iranian|South African)\b/i
        );
        const nationality = nationalityMatch
            ? nationalityMatch[1].charAt(0).toUpperCase() + nationalityMatch[1].slice(1).toLowerCase()
            : null;

        return { imageUrl, bio, nationality };
    } catch { return null; }
}

async function searchPerfumerOnDuckDuckGo(name) {
    try {
        const q = encodeURIComponent(`${name} perfumer`);
        const resp = await fetch(
            `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (!resp.ok) return null;
        const data = await resp.json();

        const imageUrl = (data.Image && !data.Image.includes('duckduckgo.com/i/')) ? data.Image : null;
        const rawAbstract = data.Abstract || data.RelatedTopics?.[0]?.Text || '';
        const bio = rawAbstract.replace(/<[^>]+>/g, '').trim().slice(0, 500) || null;

        const nationalityMatch = bio?.match(
            /\b(French|Spanish|American|British|Italian|German|Japanese|Belgian|Swiss|Brazilian|Argentine|Russian|Australian|Canadian|Dutch|Swedish|Norwegian|Danish|Polish|Portuguese|Greek|Turkish|Chinese|Korean|Indian|Mexican|Colombian|Venezuelan|Moroccan|Egyptian|Lebanese|Israeli|Iranian|South African)\b/i
        );
        const nationality = nationalityMatch
            ? nationalityMatch[1].charAt(0).toUpperCase() + nationalityMatch[1].slice(1).toLowerCase()
            : null;

        return (imageUrl || bio) ? { imageUrl, bio, nationality } : null;
    } catch { return null; }
}

async function autofillPerfumer(name) {
    // Wikipedia first (richer data), then DuckDuckGo
    const wiki = await searchPerfumerOnWikipedia(name);
    if (wiki?.bio || wiki?.imageUrl) return wiki;
    const ddg = await searchPerfumerOnDuckDuckGo(name);
    if (ddg?.bio || ddg?.imageUrl) return ddg;
    return { imageUrl: null, bio: null, nationality: null };
}

// ─── Bulk autofill job (in-memory) ───────────────────────────────────────────
let autofillJob = {
    running: false,
    total: 0,
    processed: 0,
    updated: 0,
    failed: 0,
    results: [],
    startedAt: null,
    completedAt: null,
};

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/perfumers — list all (with verified data merged)
router.get('/', async (req, res, next) => {
    try {
        const perfumers = await dataStore.getPerfumers();
        res.json({ success: true, data: perfumers });
    } catch (error) {
        next(error);
    }
});

// GET /api/perfumers/autofill/status — bulk job progress
router.get('/autofill/status', requireSuperAdmin, (req, res) => {
    res.json({ success: true, ...autofillJob });
});

// GET /api/perfumers/:name — single perfumer verified data
router.get('/:name', async (req, res, next) => {
    try {
        const data = await dataStore.getPerfumerByName(decodeURIComponent(req.params.name));
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

// PUT /api/perfumers/:name — upsert verified perfumer data (superadmin only)
router.put('/:name', requireSuperAdmin, async (req, res, next) => {
    try {
        const name = decodeURIComponent(req.params.name);
        const { imageUrl, bio, nationality, verified } = req.body;
        await dataStore.upsertPerfumer({ name, imageUrl, bio, nationality, verified });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// PATCH /api/perfumers/:name/verify — toggle verified flag only
router.patch('/:name/verify', requireSuperAdmin, async (req, res, next) => {
    try {
        const name = decodeURIComponent(req.params.name);
        const { verified } = req.body;
        await dataStore.setPerfumerVerified(name, !!verified);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// POST /api/perfumers/:name/autofill — search Wikipedia/DDG for one perfumer
router.post('/:name/autofill', requireSuperAdmin, async (req, res, next) => {
    try {
        const name = decodeURIComponent(req.params.name);
        const data = await autofillPerfumer(name);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

// POST /api/perfumers/bulk-autofill — background batch search for multiple perfumers
router.post('/bulk-autofill', requireSuperAdmin, async (req, res, next) => {
    try {
        if (autofillJob.running) {
            return res.json({ success: true, status: 'already_running', job: autofillJob });
        }

        // names[] = specific list, or empty = all without data
        const { names, saveResults = true } = req.body;
        const allPerfumers = await dataStore.getPerfumers();
        const toProcess = names?.length
            ? allPerfumers.filter(p => names.includes(p.name))
            : allPerfumers.filter(p => !p.bio && !p.nationality);

        if (!toProcess.length) {
            return res.json({ success: true, status: 'done', total: 0, updated: 0, failed: 0, results: [] });
        }

        autofillJob = {
            running: true, total: toProcess.length, processed: 0,
            updated: 0, failed: 0, results: [],
            startedAt: new Date().toISOString(), completedAt: null,
        };

        res.json({ success: true, status: 'started', total: toProcess.length });

        setImmediate(async () => {
            for (const p of toProcess) {
                if (!autofillJob.running) break;
                try {
                    const data = await autofillPerfumer(p.name);
                    if (data.imageUrl || data.bio) {
                        if (saveResults) {
                            await dataStore.upsertPerfumer({
                                name: p.name,
                                imageUrl: data.imageUrl || undefined,
                                bio: data.bio || undefined,
                                nationality: data.nationality || undefined,
                            });
                        }
                        autofillJob.results.push({ name: p.name, ...data, status: 'found' });
                        autofillJob.updated++;
                    } else {
                        autofillJob.results.push({ name: p.name, status: 'not_found' });
                        autofillJob.failed++;
                    }
                } catch (err) {
                    autofillJob.results.push({ name: p.name, status: 'error', error: err.message });
                    autofillJob.failed++;
                }
                autofillJob.processed++;
                await new Promise(r => setTimeout(r, 600));
            }
            autofillJob.running = false;
            autofillJob.completedAt = new Date().toISOString();
            console.log(`✅ Perfumer autofill done: ${autofillJob.updated} found, ${autofillJob.failed} not found`);
        });
    } catch (error) {
        next(error);
    }
});

// DELETE /api/perfumers/:name — remove verified data (revert to scraped)
router.delete('/:name', requireSuperAdmin, async (req, res, next) => {
    try {
        await dataStore.deletePerfumerData(decodeURIComponent(req.params.name));
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

export default router;
