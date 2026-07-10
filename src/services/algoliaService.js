/**
 * Algolia-as-primary-source perfume data service.
 *
 * Fragrantica's site search is powered by Algolia. Their index `fragrantica_perfumes`
 * contains rich per-record metadata that we can read without ever touching the HTML —
 * which means we bypass Cloudflare's IP-level block entirely.
 *
 * Field names in the index are Croatian (Fragrantica's origin): naslov=name,
 * dizajner=designer, slika=image, etc. This module accepts multiple field-name
 * variants because the index schema has changed historically.
 */

import { v4 as uuidv4 } from 'uuid';

const ALGOLIA_APP_ID = 'FGVI612DFZ';
const ALGOLIA_BASE = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net`;
const INDEX = 'fragrantica_perfumes';

const getApiKey = () => process.env.ALGOLIA_API_KEY || '';

async function algoliaPost(path, body, timeoutMs = 12000, retries = 4) {
    const key = getApiKey();
    if (!key) throw new Error('ALGOLIA_KEY_MISSING: configure ALGOLIA_API_KEY env or paste a key in the admin UI');

    for (let attempt = 0; attempt <= retries; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const res = await fetch(`${ALGOLIA_BASE}${path}`, {
                method: 'POST',
                signal: ac.signal,
                headers: {
                    'X-Algolia-Application-Id': ALGOLIA_APP_ID,
                    'X-Algolia-API-Key': key,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });
            // Algolia throttles per IP/key. Back off and retry on 429 instead of
            // failing the whole import; surface a RATE_LIMITED error if it persists.
            if (res.status === 429) {
                if (attempt < retries) {
                    await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
                    continue;
                }
                throw new Error('RATE_LIMITED: Algolia 429 (Too many requests)');
            }
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || `Algolia HTTP ${res.status}`);
            }
            return res.json();
        } catch (err) {
            // Retry transient aborts/network errors too; rethrow on the last attempt.
            const transient = err.name === 'AbortError' || /network|fetch failed|ECONN/i.test(err.message);
            if (transient && attempt < retries) {
                await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
                continue;
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }
}

// Extract Fragrantica's numeric perfume id from any of the URL shapes they use.
// Example: https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html → 31861
export function extractObjectIdFromUrl(url) {
    if (!url) return null;
    const m = url.match(/-(\d+)\.html(?:[?#]|$)/);
    return m ? m[1] : null;
}

// Try several lookup strategies until one returns the record (or null).
export async function fetchAlgoliaPerfume(url) {
    const objectId = extractObjectIdFromUrl(url);
    if (!objectId) return null;

    // Strategy 1: direct objectID get (cheapest, exact match)
    try {
        const data = await algoliaPost(`/1/indexes/${INDEX}/query`, {
            query: '',
            filters: `objectID:${objectId}`,
            hitsPerPage: 1,
        });
        if (data?.hits?.length) return data.hits[0];
    } catch (err) {
        // Filter syntax may not be supported on facet-only keys — fall through
        if (!String(err.message).includes('not allowed')) {
            console.warn('[algolia] filter lookup failed:', err.message);
        }
    }

    // Strategy 2: query by id token (works when only search ACL is allowed)
    try {
        const data = await algoliaPost(`/1/indexes/${INDEX}/query`, {
            query: objectId,
            hitsPerPage: 5,
        });
        const hit = (data?.hits || []).find(h => h.objectID === objectId);
        if (hit) return hit;
    } catch (err) {
        console.warn('[algolia] query lookup failed:', err.message);
        throw err;
    }

    return null;
}

// Pick the first truthy value across a list of candidate field names.
const pick = (rec, names) => {
    for (const n of names) {
        const v = rec?.[n];
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
};

// Coerce notes — Algolia may store them as comma string, array, or pipe-delimited.
const toNotesArray = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
    return String(raw).split(/[,|;]/).map(s => s.trim()).filter(Boolean);
};

const normalizeGender = (g) => {
    if (!g) return 'unisex';
    const s = String(g).toLowerCase();
    if (s.includes('women') || s.includes('femenino') || s.includes('female') || s === 'f' || s.includes('mujer')) return 'feminine';
    if (s.includes('men') || s.includes('masculino') || s.includes('male') || s === 'm' || s.includes('hombre')) return 'masculine';
    return 'unisex';
};

const yearFromAny = (v) => {
    if (!v) return null;
    const m = String(v).match(/(\d{4})/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    return y >= 1900 && y <= new Date().getFullYear() ? y : null;
};

// Map a raw Algolia record to our perfume schema. Defensive against missing fields —
// returns whatever it can; never throws.
export function mapAlgoliaRecordToPerfume(record, sourceUrl) {
    if (!record) return null;

    const name = pick(record, ['naslov', 'name', 'title', 'nome', 'parfum_name']);
    const brand = pick(record, ['dizajner', 'brand', 'designer', 'kuca', 'manufacturer', 'company']);
    const yearRaw = pick(record, ['godina', 'year', 'launch_year', 'launched', 'release_year', 'datum']);
    const perfumer = pick(record, ['parfumer', 'perfumer', 'nose', 'noses', 'nos', 'created_by']);
    const genderRaw = pick(record, ['spol', 'gender', 'kategorija', 'category', 'pol']);
    const image = pick(record, ['slika', 'image', 'image_url', 'photo', 'picture', 'main_image']);
    const description = pick(record, ['opis', 'description', 'about', 'review_text']);
    const rating = pick(record, ['ocjena', 'rating', 'avg_rating', 'rating_avg', 'rating_value']);

    const topRaw = pick(record, ['nota_glave', 'note_top', 'notes_top', 'top_notes', 'top']);
    const heartRaw = pick(record, ['nota_srce', 'note_heart', 'notes_heart', 'middle_notes', 'heart_notes', 'heart']);
    const baseRaw = pick(record, ['nota_baza', 'note_base', 'notes_base', 'base_notes', 'base']);
    const accordsRaw = pick(record, ['glavni_akordi', 'accords', 'main_accords', 'mainAccords', 'accord']);
    const allNotesRaw = pick(record, ['note', 'notes', 'sve_note', 'all_notes']);

    const notes = {
        top: toNotesArray(topRaw),
        heart: toNotesArray(heartRaw),
        base: toNotesArray(baseRaw),
    };
    // If the index only exposes a flat "notes" array, drop the lot into heart so the UI still shows them.
    if (notes.top.length + notes.heart.length + notes.base.length === 0 && allNotesRaw) {
        notes.heart = toNotesArray(allNotesRaw);
    }

    let imageUrl = image;
    if (imageUrl && !/^https?:\/\//.test(imageUrl)) {
        imageUrl = imageUrl.startsWith('//') ? `https:${imageUrl}` : `https://fimgs.net${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
    }

    let ratingNum = null;
    if (rating !== null) {
        const v = parseFloat(rating);
        if (!isNaN(v)) ratingNum = v > 5 ? Math.round((v / 2) * 10) / 10 : Math.round(v * 10) / 10;
    }

    if (!name || !brand) return null;

    return {
        id: uuidv4(),
        name: String(name).trim().replace(/\s+for\s+(men|women|women and men)\s*$/i, '').trim(),
        brand: String(brand).trim(),
        year: yearFromAny(yearRaw),
        perfumer: Array.isArray(perfumer) ? perfumer.join(', ') : (perfumer ? String(perfumer).trim() : null),
        perfumerImageUrl: null,
        gender: normalizeGender(genderRaw),
        concentration: pick(record, ['koncentracija', 'concentration', 'type']) || null,
        notes,
        accords: toNotesArray(accordsRaw),
        description: description ? String(description).trim() : null,
        imageUrl: imageUrl || null,
        rating: ratingNum,
        longevity: null,   // Not in Algolia — votes live in HTML only
        sillage: null,
        seasonUsage: null,
        sourceUrl,
        scrapedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

export async function getPerfumeViaAlgolia(url) {
    const record = await fetchAlgoliaPerfume(url);
    if (!record) return null;
    return mapAlgoliaRecordToPerfume(record, url);
}

// Fetch canonical slugs for many objectIDs at once (batched OR-filter queries).
// Returns Map<objectID(string), slug>. Skips ids Algolia no longer knows about.
// batchSize kept small: Algolia silently caps results on large OR-filters
// (100 ids → ~50 hits; 20 ids → all). 20 resolves 100%.
export async function fetchSlugsByObjectIds(objectIds, batchSize = 20) {
    const out = new Map();
    const ids = [...new Set(objectIds.map(String).filter(Boolean))];
    for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const filters = batch.map((id) => `objectID:${id}`).join(' OR ');
        const data = await algoliaPost(`/1/indexes/${INDEX}/query`, {
            query: '',
            filters,
            hitsPerPage: batch.length,
            attributesToRetrieve: ['slug', 'dizajner', 'naslov', 'objectID'],
        });
        for (const h of data?.hits || []) {
            const id = String(h.objectID);
            const slug = h.slug || (h.dizajner && h.naslov
                ? `${slugifyFragrantica(h.dizajner)}/${slugifyFragrantica(h.naslov)}`
                : null);
            if (slug) out.set(id, slug.replace(/^\/+|\/+$/g, ''));
        }
        await sleep(120);
    }
    return out;
}

// ── Auto-refresh of the rotating Algolia search key ─────────────────────────────
//
// Fragrantica embeds the public search key inline in every page's
// `window.fragranticaRuntime` (as a base64 string decoding to "<hash>validUntil=<ts>").
// We can read it with a plain GET — no login. The only catch is Cloudflare blocks
// our datacenter IP, so we try several Fragrantica mirror domains; if any one
// returns the HTML we extract a fresh key from it.

const KEY_SOURCE_DOMAINS = [
    'https://www.fragrantica.com/',
    'https://www.fragrantica.es/',
    'https://www.fragrantica.com.br/',
    'https://www.fragrantica.ru/',
    'https://www.fragrantica.nl/',
];

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Decode the validUntil timestamp (unix seconds) embedded in an Algolia search key.
export function algoliaKeyExpiry(key) {
    try {
        const decoded = Buffer.from(key + '===', 'base64').toString('utf-8');
        const m = decoded.match(/validUntil=(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    } catch {
        return null;
    }
}

// Pull the freshest Algolia key out of a page's HTML. Returns { key, expiresTs } or null.
export function extractAlgoliaKeyFromHtml(html) {
    if (!html) return null;
    const candidates = new Set(html.match(/[A-Za-z0-9+/]{80,}={0,2}/g) || []);
    let best = null;
    for (const c of candidates) {
        const ts = algoliaKeyExpiry(c);
        if (ts && (!best || ts > best.expiresTs)) best = { key: c, expiresTs: ts };
    }
    return best;
}

/**
 * Fetch a fresh, valid Algolia search key from Fragrantica's public HTML.
 * Tries each mirror domain until one is reachable (not Cloudflare-blocked) and
 * yields a key that is (a) not yet expired and (b) actually accepted by Algolia.
 * @returns {Promise<{ key: string, expiresTs: number, source: string }>}
 * @throws if every mirror is blocked or yields no usable key.
 */
export async function fetchFreshAlgoliaKey({ timeoutMs = 15000 } = {}) {
    const errors = [];
    for (const url of KEY_SOURCE_DOMAINS) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                signal: ac.signal,
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
                },
            });
            const html = await res.text();
            if (!res.ok) { errors.push(`${url} → HTTP ${res.status}`); continue; }
            if (/just a moment|attention required|cf-browser-verification/i.test(html)) {
                errors.push(`${url} → Cloudflare wall`);
                continue;
            }
            const found = extractAlgoliaKeyFromHtml(html);
            if (!found) { errors.push(`${url} → no key in HTML`); continue; }
            if (found.expiresTs <= Math.floor(Date.now() / 1000)) {
                errors.push(`${url} → key already expired`);
                continue;
            }
            // Validate the key really works before trusting it.
            const prev = process.env.ALGOLIA_API_KEY;
            try {
                process.env.ALGOLIA_API_KEY = found.key;
                await algoliaPost(`/1/indexes/${INDEX}/query`, { query: 'dior', hitsPerPage: 1 });
            } catch (e) {
                process.env.ALGOLIA_API_KEY = prev;
                errors.push(`${url} → key rejected by Algolia (${e.message})`);
                continue;
            } finally {
                if (prev !== undefined) process.env.ALGOLIA_API_KEY = prev;
            }
            return { key: found.key, expiresTs: found.expiresTs, source: url };
        } catch (err) {
            errors.push(`${url} → ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`Could not fetch a fresh Algolia key. Tried: ${errors.join('; ')}`);
}

// ── Free discovery by brand / designer / name (Algolia only, no Cloudflare) ──────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Slugify a brand/name the way Fragrantica builds its URL slugs.
function slugifyFragrantica(str) {
    return String(str || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/['’`]/g, '')
        .replace(/&/g, 'and')
        .replace(/\s+/g, '-')
        .replace(/[^A-Za-z0-9-]+/g, '')
        .replace(/^-+|-+$/g, '');
}

// Canonical Fragrantica perfume URL from an Algolia record. Prefers the record's
// own `slug` ("Dior/Sauvage"); falls back to slugifying brand + name.
export function buildPerfumeUrlFromRecord(record) {
    const id = record?.objectID || record?.id;
    if (!id) return null;
    const slug = record.slug
        ? record.slug.replace(/^\/+|\/+$/g, '')
        : `${slugifyFragrantica(record.dizajner)}/${slugifyFragrantica(record.naslov)}`;
    return `https://www.fragrantica.es/perfume/${slug}-${id}.html`;
}

// Resolve a loosely-typed brand name to the EXACT facet value in the index
// (facet values are case-sensitive, e.g. "Tom Ford"). Returns null if no match.
export async function resolveBrandFacetValue(brand) {
    const q = String(brand || '').trim();
    if (!q) return null;
    const data = await algoliaPost(`/1/indexes/${INDEX}/facets/dizajner/query`, {
        facetQuery: q,
        maxFacetHits: 20,
    });
    const hits = data?.facetHits || [];
    if (!hits.length) return null;
    const exact = hits.find((h) => h.value.toLowerCase() === q.toLowerCase());
    return (exact || hits[0]).value;
}

/**
 * Discover every perfume of a brand via Algolia faceting — free, no Cloudflare.
 * @returns {Promise<{ facet: string|null, urls: string[], records: object[] }>}
 */
export async function fetchPerfumeUrlsByBrand(brand, limit = 500, maxPages = 200, { alreadyResolved = false } = {}) {
    const facet = alreadyResolved
        ? String(brand || '').trim()
        : (await resolveBrandFacetValue(brand)) || String(brand || '').trim();
    const urls = [];
    const records = [];
    for (let page = 0; page < maxPages && urls.length < limit; page++) {
        const data = await algoliaPost(`/1/indexes/${INDEX}/query`, {
            query: '',
            facetFilters: [[`dizajner:${facet}`]],
            hitsPerPage: 1000,
            page,
            attributesToRetrieve: ['naslov', 'dizajner', 'objectID', 'id', 'slug', 'thumbnail', 'picture', 'godina'],
        });
        const hits = data?.hits || [];
        for (const h of hits) {
            const u = buildPerfumeUrlFromRecord(h);
            if (u) { urls.push(u); records.push(h); }
        }
        if (data.page >= (data.nbPages || 1) - 1) break;
        await sleep(150);
    }
    return { facet, urls: urls.slice(0, limit), records: records.slice(0, limit) };
}

/**
 * Enumerate EVERY brand (designer) facet value in the index — free, no Cloudflare.
 * Fragrantica no longer publishes XML sitemaps (sitemap.xml → 404), so brand
 * faceting is now the only reliable way to discover the whole catalogue.
 * Sweeps facetQuery across a..z + 0-9 + '' and unions the results.
 * @returns {Promise<string[]>} sorted, de-duplicated brand facet values
 */
export async function fetchAllBrandFacets() {
    const prefixes = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').concat(['']);
    const brands = new Set();
    for (const prefix of prefixes) {
        try {
            const data = await algoliaPost(
                `/1/indexes/${INDEX}/facets/dizajner/query`,
                { facetQuery: prefix, maxFacetHits: 100 }
            );
            for (const hit of (data?.facetHits || [])) brands.add(hit.value);
        } catch (err) {
            console.warn(`[algolia] brand facet sweep "${prefix}" failed: ${err.message}`);
            if (/RATE_LIMITED/.test(err.message)) await sleep(10000);
        }
        await sleep(300);
    }
    return [...brands].sort((a, b) => a.localeCompare(b));
}

/**
 * Discover the ENTIRE Fragrantica catalogue via Algolia brand faceting.
 * Replaces the dead sitemap crawl. Streams progress through onProgress(state).
 * @returns {Promise<{ urls: string[], brands: string[] }>}
 */
export async function discoverFullCatalogViaAlgolia({ limitPerBrand = 5000, onProgress } = {}) {
    const brands = await fetchAllBrandFacets();
    const allUrls = new Set();
    let done = 0;
    for (const brand of brands) {
        try {
            // alreadyResolved=true: `brand` came straight out of fetchAllBrandFacets,
            // so it IS the exact facet value already — skip the redundant
            // resolveBrandFacetValue() call that was doubling our Algolia request
            // rate and tripping 429s after ~70 brands.
            const { urls } = await fetchPerfumeUrlsByBrand(brand, limitPerBrand, 200, { alreadyResolved: true });
            urls.forEach(u => allUrls.add(u));
            await sleep(600);
        } catch (err) {
            console.warn(`[algolia] discover "${brand}" failed: ${err.message}`);
            // Rate-limited: back off hard instead of immediately hammering the next
            // brand (which was just re-triggering more 429s and stalling progress).
            if (/RATE_LIMITED/.test(err.message)) await sleep(20000);
        }
        done++;
        if (typeof onProgress === 'function') {
            onProgress({ brandsTotal: brands.length, brandsProcessed: done, currentBrand: brand, urlsFound: allUrls.size });
        }
    }
    return { urls: [...allUrls], brands };
}

/**
 * Search perfumes by free-text name/query via Algolia — free, no Cloudflare.
 * @returns {Promise<{ urls: string[], records: object[] }>}
 */
export async function searchPerfumeUrlsByName(query, limit = 50) {
    const data = await algoliaPost(`/1/indexes/${INDEX}/query`, {
        query: String(query || '').trim(),
        hitsPerPage: Math.min(limit, 1000),
        attributesToRetrieve: ['naslov', 'dizajner', 'objectID', 'id', 'slug', 'thumbnail', 'picture', 'godina'],
    });
    const records = data?.hits || [];
    const urls = [];
    for (const h of records) {
        const u = buildPerfumeUrlFromRecord(h);
        if (u) urls.push(u);
    }
    return { urls: urls.slice(0, limit), records: records.slice(0, limit) };
}
