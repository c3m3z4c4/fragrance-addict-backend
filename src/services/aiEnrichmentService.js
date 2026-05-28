/**
 * On-demand AI enrichment for perfumes — multi-provider.
 *
 * Algolia gives us name/brand/year/gender/image/rating but not notes/accords/
 * perfumer/description. When the Fragrantica HTML is blocked by Cloudflare,
 * this service uses the configured AI provider (Gemini / OpenAI / Anthropic)
 * to fill the gaps for well-known perfumes — and explicitly returns nulls when
 * confidence is low so we don't pollute the DB with hallucinations.
 *
 * The provider/model is whatever is set active in the AI Settings UI
 * (getActiveProvider). Callers may override per-request.
 */

import { getActiveProvider } from '../routes/ai.js';

// Which perfume fields this service is allowed to fill.
export const ENRICHABLE_FIELDS = ['notes', 'accords', 'perfumer', 'description', 'concentration'];

export const DEFAULT_MIN_CONFIDENCE = parseFloat(process.env.AI_ENRICH_MIN_CONFIDENCE) || 0.6;

function buildPrompt(perfume, fields) {
    const ctx = [
        `Perfume: "${perfume.name}"`,
        `Brand: "${perfume.brand}"`,
        perfume.year ? `Year: ${perfume.year}` : null,
        perfume.gender && perfume.gender !== 'unisex' ? `Gender: ${perfume.gender}` : null,
    ].filter(Boolean).join('\n');

    const wanted = fields.join(', ');

    return `${ctx}

You are a perfume expert. Provide the following fields for the perfume above: ${wanted}.

Rules:
- Only provide values you are HIGHLY confident about (perfume well-documented on Fragrantica/Parfumo/Basenotes).
- If unsure about a field, return null or empty array. Do NOT guess.
- Notes: common olfactory notes in English (e.g. "Bergamot", "Iso E Super", "Cedar"), not generic words.
- Accords: broad olfactory families (e.g. "Aromatic", "Woody", "Fresh Spicy", "Citrus"), max 8.
- Description: 1-3 sentences, factual, neutral, no marketing fluff.
- Concentration: one of "Eau de Parfum", "Eau de Toilette", "Eau de Cologne", "Parfum", "Extrait de Parfum", "Eau Fraiche", or null.
- confidence: 0.0 to 1.0 — how well-documented this perfume is.

Respond with JSON only:
{"notes":{"top":[],"heart":[],"base":[]},"accords":[],"perfumer":null,"description":null,"concentration":null,"confidence":0.0}`;
}

// ─── Provider callers ─────────────────────────────────────────────────────────

async function callGemini(apiKey, model, prompt) {
    const base = 'https://generativelanguage.googleapis.com/v1beta/models';
    const resp = await fetch(`${base}/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 1024,
                responseMimeType: 'application/json',
            },
        }),
    });
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 180)}`);
    const data = await resp.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAI(apiKey, model, prompt) {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'You are an expert perfumer. Respond with valid JSON only.' },
                { role: 'user', content: prompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 1024,
        }),
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 180)}`);
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
}

async function callAnthropic(apiKey, model, prompt) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt + '\n\nReturn JSON only, no prose.' }],
        }),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 180)}`);
    const data = await resp.json();
    return data?.content?.[0]?.text || '';
}

function parseJson(rawText) {
    try {
        return JSON.parse(rawText);
    } catch {
        const match = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || rawText.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[1] ?? match[0]);
        throw new Error('AI returned non-JSON');
    }
}

async function runProvider({ provider, apiKey, model }, prompt) {
    switch (provider) {
        case 'openai':        return parseJson(await callOpenAI(apiKey, model, prompt));
        case 'anthropic':     return parseJson(await callAnthropic(apiKey, model, prompt));
        case 'google_gemini':
        default:              return parseJson(await callGemini(apiKey, model, prompt));
    }
}

/**
 * Enrich a perfume with AI-inferred fields. Uses the active AI provider unless
 * overridden. Only fills currently-empty fields among `fields`. Never mutates input.
 *
 * opts:
 *   provider, apiKey, model  — override active provider
 *   minConfidence            — discard results below this (default env or 0.6)
 *   fields                   — subset of ENRICHABLE_FIELDS to fill
 */
export async function enrichPerfumeWithAI(perfume, opts = {}) {
    if (!perfume?.name || !perfume?.brand) {
        throw new Error('AI_ENRICH_INPUT: perfume must have name and brand');
    }

    let active;
    if (opts.apiKey && opts.provider) {
        active = { provider: opts.provider, apiKey: opts.apiKey, model: opts.model };
    } else {
        active = await getActiveProvider();
        if (!active) throw new Error('AI_PROVIDER_MISSING: no active AI provider configured');
        if (opts.model) active = { ...active, model: opts.model };
    }
    if (!active.model) {
        const defaults = { google_gemini: 'gemini-2.0-flash', openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5-20251001' };
        active.model = defaults[active.provider] || 'gemini-2.0-flash';
    }

    const fields = Array.isArray(opts.fields) && opts.fields.length
        ? opts.fields.filter(f => ENRICHABLE_FIELDS.includes(f))
        : ENRICHABLE_FIELDS;
    const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : DEFAULT_MIN_CONFIDENCE;

    const result = await runProvider(active, buildPrompt(perfume, fields));

    const confidence = typeof result.confidence === 'number' ? result.confidence : 0;
    const trust = confidence >= minConfidence;

    const out = { ...perfume };
    const empty = (v) => v == null || (Array.isArray(v) && v.length === 0);

    if (trust) {
        if (fields.includes('notes')) {
            const haveNotes = perfume.notes && (
                (perfume.notes.top?.length || 0) +
                (perfume.notes.heart?.length || 0) +
                (perfume.notes.base?.length || 0)
            ) > 0;
            const n = result.notes || {};
            if (!haveNotes) {
                out.notes = {
                    top:   Array.isArray(n.top)   ? n.top   : [],
                    heart: Array.isArray(n.heart) ? n.heart : [],
                    base:  Array.isArray(n.base)  ? n.base  : [],
                };
            }
        }
        if (fields.includes('accords') && empty(perfume.accords) && Array.isArray(result.accords)) {
            out.accords = result.accords;
        }
        if (fields.includes('perfumer') && empty(perfume.perfumer) && result.perfumer) {
            out.perfumer = result.perfumer;
        }
        if (fields.includes('description') && empty(perfume.description) && result.description) {
            out.description = result.description;
        }
        if (fields.includes('concentration') && empty(perfume.concentration) && result.concentration) {
            out.concentration = result.concentration;
        }
    }

    out.aiEnriched = trust;
    out.aiConfidence = confidence;
    out.aiProvider = active.provider;
    out.aiModel = active.model;
    out.updatedAt = new Date().toISOString();
    return out;
}
