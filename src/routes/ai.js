import { Router } from 'express';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { dataStore } from '../services/dataStore.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();

// ─── Provider definitions ─────────────────────────────────────────────────────

const PROVIDERS = {
    google_gemini: {
        label: 'Google Gemini',
        models: [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
            'gemini-1.5-flash',
            'gemini-1.5-pro',
        ],
        defaultModel: 'gemini-2.5-flash',
        envKey: 'GEMINI_API_KEY',
    },
    openai: {
        label: 'OpenAI ChatGPT',
        models: [
            'gpt-4o',
            'gpt-4o-mini',
            'gpt-4-turbo',
            'gpt-3.5-turbo',
        ],
        defaultModel: 'gpt-4o-mini',
        envKey: 'OPENAI_API_KEY',
    },
    anthropic: {
        label: 'Anthropic Claude',
        models: [
            'claude-opus-4-7',
            'claude-sonnet-4-6',
            'claude-haiku-4-5-20251001',
        ],
        defaultModel: 'claude-haiku-4-5-20251001',
        envKey: 'ANTHROPIC_API_KEY',
    },
};

// In-memory cache for active provider (refreshed on each config change)
let _activeProviderCache = null;

async function getActiveProvider() {
    const dbRow = await dataStore.getActiveAIProvider();
    if (dbRow && dbRow.apiKey) {
        return { provider: dbRow.provider, apiKey: dbRow.apiKey, model: dbRow.activeModel };
    }
    // Fallback: check DB providers without key + env vars
    const rows = await dataStore.getAIProviders().catch(() => []);
    for (const row of rows) {
        const def = PROVIDERS[row.provider];
        if (!def) continue;
        const envKey = process.env[def.envKey];
        if (envKey) return { provider: row.provider, apiKey: envKey, model: row.activeModel || def.defaultModel };
    }
    // Final fallback: GEMINI_API_KEY env (legacy)
    const legacyKey = process.env.GEMINI_API_KEY;
    if (legacyKey) return { provider: 'google_gemini', apiKey: legacyKey, model: 'gemini-2.5-flash' };
    return null;
}

// ─── Provider-specific recommend helpers ──────────────────────────────────────

async function recommendWithGemini(apiKey, model, prompt) {
    const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
    const resp = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.85,
                maxOutputTokens: 2048,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    properties: {
                        recommendations: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    name:     { type: 'string' },
                                    brand:    { type: 'string' },
                                    reason:   { type: 'string' },
                                    keyNotes: { type: 'array', items: { type: 'string' } },
                                },
                                required: ['name', 'brand', 'reason', 'keyNotes'],
                            },
                        },
                    },
                    required: ['recommendations'],
                },
            },
        }),
    });
    if (!resp.ok) {
        const err = await resp.text();
        const hint = resp.status === 404 ? `Model "${model}" not found`
            : resp.status === 429 ? 'Quota exceeded'
            : `Gemini API error ${resp.status}`;
        throw new ApiError(hint, 502);
    }
    const data = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return parseRecommendations(rawText);
}

async function recommendWithOpenAI(apiKey, model, prompt) {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'You are an expert perfume sommelier. Always respond with valid JSON.' },
                { role: 'user', content: prompt + '\n\nRespond with JSON: {"recommendations": [...]}' },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 2048,
            temperature: 0.85,
        }),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const hint = resp.status === 401 ? 'Invalid OpenAI API key'
            : resp.status === 429 ? 'OpenAI quota exceeded'
            : `OpenAI error ${resp.status}: ${err.error?.message || ''}`;
        throw new ApiError(hint, 502);
    }
    const data = await resp.json();
    const rawText = data?.choices?.[0]?.message?.content || '';
    return parseRecommendations(rawText);
}

async function recommendWithAnthropic(apiKey, model, prompt) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: 2048,
            messages: [{
                role: 'user',
                content: prompt + '\n\nRespond with JSON only: {"recommendations": [...]}',
            }],
        }),
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const hint = resp.status === 401 ? 'Invalid Anthropic API key'
            : resp.status === 429 ? 'Anthropic quota exceeded'
            : `Anthropic error ${resp.status}: ${err.error?.message || ''}`;
        throw new ApiError(hint, 502);
    }
    const data = await resp.json();
    const rawText = data?.content?.[0]?.text || '';
    return parseRecommendations(rawText);
}

function parseRecommendations(rawText) {
    try {
        return JSON.parse(rawText).recommendations || [];
    } catch {
        const match = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || rawText.match(/(\{[\s\S]*\})/);
        try {
            return JSON.parse(match?.[1] ?? match?.[0] ?? '{}').recommendations || [];
        } catch { return []; }
    }
}

// ─── Test connection helpers ──────────────────────────────────────────────────

async function testGemini(apiKey) {
    const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const count = data.models?.length || 0;
    return `Connected — ${count} models available`;
}

async function testOpenAI(apiKey) {
    const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error?.message || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const count = data.data?.length || 0;
    return `Connected — ${count} models available`;
}

async function testAnthropic(apiKey) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 401) throw new Error('Invalid API key');
    if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error?.message || `HTTP ${resp.status}`);
    }
    return 'Connected — API key valid';
}

// ─── Shared prompt builder ────────────────────────────────────────────────────

const GENDER_MAP = { man: 'masculine', woman: 'feminine', unisex: 'unisex' };

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

function buildRecommendPrompt(favorites, catalogFiltered, profile, dbGender) {
    let favoritesBlock = '';
    if (favorites && favorites.length > 0) {
        const lines = favorites.map((p) => {
            const notes = [...(p.notes?.top || []), ...(p.notes?.heart || []), ...(p.notes?.base || [])].slice(0, 6).join(', ');
            const accords = (p.accords || []).slice(0, 4).join(', ');
            return `- ${p.name} by ${p.brand}${p.concentration ? ` (${p.concentration})` : ''}${notes ? `: notes ${notes}` : ''}${accords ? `; accords ${accords}` : ''}`;
        });
        favoritesBlock = `User's favourite perfumes (taste reference — do NOT re-recommend these):\n${lines.join('\n')}`;
    } else {
        favoritesBlock = 'The user has not saved any favourite perfumes yet.';
    }

    let catalogBlock = '';
    if (catalogFiltered.length > 0) {
        const entries = catalogFiltered.map(p =>
            `${p.name} | ${p.brand}${p.concentration ? ` | ${p.concentration}` : ''}`
        ).join('\n');
        catalogBlock = `\nOur perfume catalog (${catalogFiltered.length} fragrances${dbGender ? `, ${dbGender} only` : ''}) — prioritize recommending from this list:\n${entries}`;
    }

    const profileBlock = buildProfileBlock(profile);

    return `You are an expert perfume sommelier. Recommend exactly 5 perfumes this user would love.

RULES:
- Always return exactly 5 recommendations, no exceptions
- Never recommend a perfume already in the user's favourites list
- Prioritize perfumes from the catalog if one is provided; supplement with well-known fragrances if needed
- Tailor each recommendation to the user's profile (age, gender, occasions, seasons, intensity)
- Each entry must have: name, brand, a one-sentence personalized reason, and 2-3 key notes/accords

${favoritesBlock}
${profileBlock ? `\n${profileBlock}` : ''}
${catalogBlock}`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** GET /api/ai/providers — list all providers with status (admin only) */
router.get('/providers', requireSuperAdmin, async (req, res, next) => {
    try {
        const rows = await dataStore.getAIProviders();
        // Merge with provider definitions + env key fallback
        const result = Object.entries(PROVIDERS).map(([id, def]) => {
            const row = rows.find(r => r.provider === id) || {};
            const hasEnvKey = !!process.env[def.envKey];
            return {
                provider: id,
                label: def.label,
                models: def.models,
                defaultModel: def.defaultModel,
                hasKey: row.hasKey || hasEnvKey,
                keySource: row.hasKey ? 'database' : hasEnvKey ? 'env' : 'none',
                apiKeyMasked: row.apiKeyMasked || (hasEnvKey ? process.env[def.envKey].slice(0, 6) + '…' + process.env[def.envKey].slice(-4) : null),
                activeModel: row.activeModel || def.defaultModel,
                isActive: row.isActive ?? false,
                updatedAt: row.updatedAt || null,
            };
        });
        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
});

/** PUT /api/ai/providers/:provider/key — save API key */
router.put('/providers/:provider/key', requireSuperAdmin, async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS[provider]) return next(new ApiError('Unknown provider', 400));
        const { apiKey } = req.body;
        await dataStore.setAIProviderKey(provider, apiKey || null);
        console.log(`🔑 AI provider key updated: ${provider}`);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

/** PATCH /api/ai/providers/:provider/model — set active model */
router.patch('/providers/:provider/model', requireSuperAdmin, async (req, res, next) => {
    try {
        const { provider } = req.params;
        const def = PROVIDERS[provider];
        if (!def) return next(new ApiError('Unknown provider', 400));
        const { model } = req.body;
        if (!def.models.includes(model)) return next(new ApiError(`Invalid model for ${provider}`, 400));
        await dataStore.setAIProviderModel(provider, model);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

/** POST /api/ai/providers/:provider/activate — set as active provider */
router.post('/providers/:provider/activate', requireSuperAdmin, async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS[provider]) return next(new ApiError('Unknown provider', 400));
        await dataStore.setActiveAIProvider(provider);
        console.log(`🤖 Active AI provider set to: ${provider}`);
        res.json({ success: true, provider });
    } catch (err) {
        next(err);
    }
});

/** POST /api/ai/providers/:provider/test — verify API key works */
router.post('/providers/:provider/test', requireSuperAdmin, async (req, res, next) => {
    try {
        const { provider } = req.params;
        const def = PROVIDERS[provider];
        if (!def) return next(new ApiError('Unknown provider', 400));

        // Resolve key: DB first, then env
        const dbRow = await dataStore.getAIProviderKey(provider);
        const apiKey = dbRow?.api_key || process.env[def.envKey];
        if (!apiKey) return res.json({ success: false, error: 'No API key configured' });

        let message;
        try {
            if (provider === 'google_gemini') message = await testGemini(apiKey);
            else if (provider === 'openai')   message = await testOpenAI(apiKey);
            else if (provider === 'anthropic') message = await testAnthropic(apiKey);
        } catch (err) {
            return res.json({ success: false, error: err.message });
        }

        res.json({ success: true, message });
    } catch (err) {
        next(err);
    }
});

/** GET /api/ai/config — legacy endpoint (kept for compatibility) */
router.get('/config', requireSuperAdmin, async (_req, res) => {
    const active = await getActiveProvider();
    res.json({
        model: active?.model || 'gemini-2.5-flash',
        models: PROVIDERS.google_gemini.models,
        provider: active?.provider || 'google_gemini',
    });
});

/** PATCH /api/ai/config — legacy: set Gemini model */
router.patch('/config', requireSuperAdmin, async (req, res, next) => {
    const { model } = req.body;
    if (!model || !PROVIDERS.google_gemini.models.includes(model)) {
        return next(new ApiError(`Invalid model`, 400));
    }
    await dataStore.setAIProviderModel('google_gemini', model);
    res.json({ success: true, model });
});

/** GET /api/ai/models — for recommendation UI */
router.get('/models', requireAuth, (_req, res) => {
    res.json({ models: PROVIDERS.google_gemini.models, default: 'gemini-2.5-flash' });
});

/** POST /api/ai/recommendations */
router.post('/recommendations', requireAuth, async (req, res, next) => {
    try {
        const active = await getActiveProvider();
        if (!active) return next(new ApiError('No AI provider configured. Ask an admin to add an API key.', 503));

        const { provider, apiKey, model } = active;
        const profile = req.body?.profile || null;
        const dbGender = profile?.gender ? GENDER_MAP[profile.gender] : null;

        let catalogPerfumes = [];
        try {
            const catalogResult = await dataStore.getAll({
                page: 1, limit: 60,
                ...(dbGender ? { gender: dbGender } : {}),
                sortBy: 'rating',
            });
            catalogPerfumes = catalogResult?.data || [];
        } catch (err) {
            console.error('⚠️ Catalog fetch failed:', err.message);
        }

        const favorites = await dataStore.getUserFavorites(req.user.id);
        const favoriteIds = new Set((favorites || []).map(p => p.id));
        const catalogFiltered = catalogPerfumes.filter(p => !favoriteIds.has(p.id));

        const prompt = buildRecommendPrompt(favorites, catalogFiltered, profile, dbGender);
        console.log(`🤖 Calling ${provider} (${model}), prompt: ${prompt.length} chars`);

        let recommendations;
        if (provider === 'google_gemini')  recommendations = await recommendWithGemini(apiKey, model, prompt);
        else if (provider === 'openai')    recommendations = await recommendWithOpenAI(apiKey, model, prompt);
        else if (provider === 'anthropic') recommendations = await recommendWithAnthropic(apiKey, model, prompt);
        else throw new ApiError('Unknown active provider', 500);

        console.log(`✅ ${provider} returned ${recommendations.length} recommendations`);
        res.json({
            success: true,
            recommendations,
            basedOnFavorites: favorites?.length || 0,
            catalogSize: catalogFiltered.length,
            model,
            provider,
        });
    } catch (err) {
        next(err);
    }
});

export default router;
