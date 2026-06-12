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

async function algoliaPost(path, body, timeoutMs = 12000) {
    const key = getApiKey();
    if (!key) throw new Error('ALGOLIA_KEY_MISSING: configure ALGOLIA_API_KEY env or paste a key in the admin UI');

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
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Algolia HTTP ${res.status}`);
        }
        return res.json();
    } finally {
        clearTimeout(timer);
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
    return `https://www.fragrantica.com/perfume/${slug}-${id}.html`;
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
export async function fetchPerfumeUrlsByBrand(brand, limit = 500, maxPages = 200) {
    const facet = (await resolveBrandFacetValue(brand)) || String(brand || '').trim();
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
