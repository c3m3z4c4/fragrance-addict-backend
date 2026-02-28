import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { dataStore } from '../services/dataStore.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const ALLOWED_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-flash-latest',
];
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** Maps profile gender to DB gender value */
const GENDER_MAP = { man: 'masculine', woman: 'feminine', unisex: 'unisex' };

/** Returns true if the user is eligible for Gemini features (Gmail or Google OAuth) */
function isGmailUser(user) {
    return user.provider === 'google' || (user.email && user.email.toLowerCase().endsWith('@gmail.com'));
}

/** Build a human-readable profile block from optional user profile data */
function buildProfileBlock(profile) {
    if (!profile) return '';
    const parts = [];
    if (profile.ageRange)          parts.push(`Age range: ${profile.ageRange}`);
    if (profile.gender)            parts.push(`Gender preference: ${profile.gender}`);
    if (profile.intensity)         parts.push(`Preferred intensity: ${profile.intensity}`);
    if (profile.occasions?.length) parts.push(`Preferred occasions: ${profile.occasions.join(', ')}`);
    if (profile.seasons?.length)   parts.push(`Preferred seasons: ${profile.seasons.join(', ')}`);
    return parts.length ? `User profile:\n${parts.map(p => `- ${p}`).join('\n')}` : '';
}

/** Format a perfume row for the catalog block (compact, token-efficient) */
function formatCatalogEntry(p) {
    const accords = (p.accords || []).slice(0, 3).join(', ');
    const notes = [
        ...(p.notes?.top || []),
        ...(p.notes?.heart || []),
    ].slice(0, 4).join(', ');
    const extra = accords || notes;
    return `- ${p.name} by ${p.brand}${p.concentration ? ` [${p.concentration}]` : ''}${p.gender ? ` (${p.gender})` : ''}${extra ? `: ${extra}` : ''}`;
}

/**
 * GET /api/ai/models
 */
router.get('/models', requireAuth, (_req, res) => {
    res.json({ models: ALLOWED_MODELS, default: DEFAULT_MODEL });
});

/**
 * POST /api/ai/recommendations
 * Body: { model?: string, profile?: { ageRange, gender, occasions, seasons, intensity } }
 * Requires JWT auth + Gmail/Google account.
 */
router.post('/recommendations', requireAuth, async (req, res, next) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return next(new ApiError('Gemini API key not configured on this server', 503));
        }

        if (!isGmailUser(req.user)) {
            return next(new ApiError('Gemini recommendations are available for Google/Gmail users only', 403));
        }

        const requestedModel = req.body?.model;
        const model = (requestedModel && ALLOWED_MODELS.includes(requestedModel))
            ? requestedModel
            : DEFAULT_MODEL;

        const profile = req.body?.profile || null;

        // Resolve DB gender filter from profile
        const dbGender = profile?.gender ? GENDER_MAP[profile.gender] : null;

        // ── 1. Fetch catalog perfumes (up to 120, filtered by gender if provided) ──
        let catalogPerfumes = [];
        try {
            const catalogResult = await dataStore.getAll({
                page: 1,
                limit: 120,
                ...(dbGender ? { gender: dbGender } : {}),
                sortBy: 'rating',
            });
            catalogPerfumes = catalogResult?.data || [];
        } catch {
            // Non-fatal — continue without catalog context
        }

        // ── 2. Fetch user's favourites ──
        const favorites = await dataStore.getUserFavorites(req.user.id);
        const favoriteIds = new Set((favorites || []).map(p => p.id));

        // Remove favorites from catalog to avoid re-recommending them
        const catalogFiltered = catalogPerfumes.filter(p => !favoriteIds.has(p.id));

        // ── 3. Build prompt sections ──
        let favoritesBlock = '';
        if (favorites && favorites.length > 0) {
            const lines = favorites.map((p) => {
                const notes = [
                    ...(p.notes?.top || []),
                    ...(p.notes?.heart || []),
                    ...(p.notes?.base || []),
                ].slice(0, 6).join(', ');
                const accords = (p.accords || []).slice(0, 4).join(', ');
                return `- ${p.name} by ${p.brand}${p.concentration ? ` (${p.concentration})` : ''}${notes ? `: notes ${notes}` : ''}${accords ? `; accords ${accords}` : ''}`;
            });
            favoritesBlock = `User's favourite perfumes (taste reference — do NOT re-recommend these):\n${lines.join('\n')}`;
        } else {
            favoritesBlock = 'The user has not saved any favourite perfumes yet.';
        }

        let catalogBlock = '';
        if (catalogFiltered.length > 0) {
            const entries = catalogFiltered.map(formatCatalogEntry).join('\n');
            catalogBlock = `\nOur perfume catalog (${catalogFiltered.length} fragrances${dbGender ? `, ${dbGender} only` : ''}) — prioritize recommending from this list:\n${entries}`;
        }

        const profileBlock = buildProfileBlock(profile);

        const prompt = `You are an expert perfume sommelier for a fragrance catalog app. Your task is to recommend exactly 5 perfumes the user would love.

INSTRUCTIONS:
- Prioritize perfumes from the catalog list provided below
- Do NOT recommend any perfume already in the user's favourites list
- Tailor recommendations to the user profile (age, gender, occasions, seasons, intensity)
- For each suggestion: name, brand, one-sentence reason tailored to this specific user, and 2-3 key notes/accords
- Respond ONLY with raw JSON, no markdown fences: {"recommendations":[{"name":"...","brand":"...","reason":"...","keyNotes":["...","..."]}]}

${favoritesBlock}
${profileBlock ? `\n${profileBlock}` : ''}
${catalogBlock}`;

        const geminiRes = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.85, maxOutputTokens: 1400 },
            }),
        });

        if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            console.error(`❌ Gemini API error (model: ${model}):`, errText);
            return next(new ApiError(`Gemini API request failed (model: ${model})`, 502));
        }

        const geminiData = await geminiRes.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

        let recommendations;
        try {
            recommendations = JSON.parse(rawText).recommendations || [];
        } catch {
            const match = rawText.match(/\{[\s\S]*\}/);
            try {
                recommendations = match ? JSON.parse(match[0]).recommendations || [] : [];
            } catch {
                recommendations = [];
            }
        }

        res.json({
            success: true,
            recommendations,
            basedOnFavorites: favorites?.length || 0,
            catalogSize: catalogFiltered.length,
            model,
        });
    } catch (err) {
        next(err);
    }
});

export default router;
