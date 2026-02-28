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

/** Returns true if the user is eligible for Gemini features (Gmail or Google OAuth) */
function isGmailUser(user) {
    return user.provider === 'google' || (user.email && user.email.toLowerCase().endsWith('@gmail.com'));
}

/**
 * GET /api/ai/models
 * Returns the list of supported models.
 */
router.get('/models', requireAuth, (_req, res) => {
    res.json({ models: ALLOWED_MODELS, default: DEFAULT_MODEL });
});

/**
 * GET /api/ai/recommendations?model=gemini-2.5-flash
 * Requires JWT auth + Gmail/Google account.
 */
router.get('/recommendations', requireAuth, async (req, res, next) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return next(new ApiError('Gemini API key not configured on this server', 503));
        }

        if (!isGmailUser(req.user)) {
            return next(new ApiError('Gemini recommendations are available for Google/Gmail users only', 403));
        }

        // Validate requested model
        const requestedModel = req.query.model;
        const model = (requestedModel && ALLOWED_MODELS.includes(requestedModel))
            ? requestedModel
            : DEFAULT_MODEL;

        // Fetch user's favourites from DB
        const favorites = await dataStore.getUserFavorites(req.user.id);

        let contextBlock;
        if (favorites && favorites.length > 0) {
            const lines = favorites.map((p) => {
                const notes = [
                    ...(p.notes?.top || []),
                    ...(p.notes?.heart || []),
                    ...(p.notes?.base || []),
                ].slice(0, 6).join(', ');
                const accords = (p.accords || []).slice(0, 4).join(', ');
                return `- ${p.name} by ${p.brand}${p.concentration ? ` (${p.concentration})` : ''}${notes ? `: notes of ${notes}` : ''}${accords ? `; accords: ${accords}` : ''}`;
            });
            contextBlock = `The user's favourite perfumes are:\n${lines.join('\n')}`;
        } else {
            contextBlock = 'The user has not yet saved any favourite perfumes.';
        }

        const prompt = `You are an expert perfume sommelier. Based on the information below, suggest exactly 5 perfumes the user would love that are NOT already in their favourites list. For each suggestion provide: name, brand, a one-sentence reason why it suits this user, and 2-3 key accords/notes. Respond in JSON with this shape: {"recommendations":[{"name":"...","brand":"...","reason":"...","keyNotes":["...","..."]}]}. Do not include markdown fences, only raw JSON.

${contextBlock}

User email: ${req.user.email}`;

        const geminiRes = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
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
            model,
        });
    } catch (err) {
        next(err);
    }
});

export default router;
