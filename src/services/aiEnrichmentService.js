/**
 * On-demand AI enrichment for perfumes.
 *
 * Algolia gives us name/brand/year/gender/image/rating but not notes/accords/
 * perfumer/description. When the Fragrantica HTML is blocked by Cloudflare,
 * this service uses Gemini to fill the gaps for well-known perfumes — and
 * explicitly returns nulls when confidence is low so we don't pollute the DB
 * with hallucinations on obscure niche releases.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function buildEnrichmentPrompt(perfume) {
    const ctx = [
        `Perfume: "${perfume.name}"`,
        `Brand: "${perfume.brand}"`,
        perfume.year ? `Year: ${perfume.year}` : null,
        perfume.gender && perfume.gender !== 'unisex' ? `Gender: ${perfume.gender}` : null,
    ].filter(Boolean).join('\n');

    return `${ctx}

You are a perfume expert. Provide olfactory pyramid notes, main accords, perfumer (nose), and a short editorial description for the perfume above.

Rules:
- Only provide values you are HIGHLY confident about (i.e. the perfume is well-documented in references like Fragrantica, Parfumo, Basenotes).
- If you are not confident about a field, return null or empty array for it. Do NOT guess.
- Notes must be common olfactory notes in English (e.g. "Bergamot", "Iso E Super", "Cedar"), not generic words.
- Accords are broad olfactory families (e.g. "Aromatic", "Woody", "Fresh Spicy", "Citrus"), max 8.
- Description: 1-3 sentences, factual and neutral. No marketing fluff. Spanish ("es") preferred when the perfume targets Latin/Spanish market, otherwise English.
- Concentration: one of "Eau de Parfum", "Eau de Toilette", "Eau de Cologne", "Parfum", "Extrait de Parfum", "Eau Fraiche", or null.
- confidence: 0.0 to 1.0 reflecting how well-documented this perfume is.
`;
}

const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        notes: {
            type: 'object',
            properties: {
                top:   { type: 'array', items: { type: 'string' } },
                heart: { type: 'array', items: { type: 'string' } },
                base:  { type: 'array', items: { type: 'string' } },
            },
            required: ['top', 'heart', 'base'],
        },
        accords:       { type: 'array', items: { type: 'string' } },
        perfumer:      { type: 'string', nullable: true },
        description:   { type: 'string', nullable: true },
        concentration: { type: 'string', nullable: true },
        confidence:    { type: 'number' },
    },
    required: ['notes', 'accords', 'confidence'],
};

async function callGemini(apiKey, model, prompt) {
    const resp = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.2,           // low — we want factual, not creative
                maxOutputTokens: 1024,
                responseMimeType: 'application/json',
                responseSchema: RESPONSE_SCHEMA,
            },
        }),
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Gemini ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error('Gemini returned non-JSON');
    }
}

/**
 * Enrich a perfume record with AI-inferred notes/accords/perfumer/description.
 * Only fills fields that are currently empty in the input record.
 * Returns a new perfume object — never mutates the input.
 * Adds aiEnriched: true and aiConfidence: <0..1>.
 */
export async function enrichPerfumeWithAI(perfume, opts = {}) {
    if (!perfume?.name || !perfume?.brand) {
        throw new Error('AI_ENRICH_INPUT: perfume must have name and brand');
    }
    const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_KEY_MISSING: configure GEMINI_API_KEY');

    const model = opts.model || 'gemini-2.0-flash';
    const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : 0.6;

    const prompt = buildEnrichmentPrompt(perfume);
    const result = await callGemini(apiKey, model, prompt);

    const confidence = typeof result.confidence === 'number' ? result.confidence : 0;
    const trust = confidence >= minConfidence;

    const out = { ...perfume };
    const empty = (v) => v == null || (Array.isArray(v) && v.length === 0);

    if (trust) {
        const notes = result.notes || {};
        const haveNotes = perfume.notes && (
            (perfume.notes.top?.length || 0) +
            (perfume.notes.heart?.length || 0) +
            (perfume.notes.base?.length || 0)
        ) > 0;
        if (!haveNotes) {
            out.notes = {
                top:   Array.isArray(notes.top)   ? notes.top   : [],
                heart: Array.isArray(notes.heart) ? notes.heart : [],
                base:  Array.isArray(notes.base)  ? notes.base  : [],
            };
        }
        if (empty(perfume.accords) && Array.isArray(result.accords)) {
            out.accords = result.accords;
        }
        if (empty(perfume.perfumer) && result.perfumer) {
            out.perfumer = result.perfumer;
        }
        if (empty(perfume.description) && result.description) {
            out.description = result.description;
        }
        if (empty(perfume.concentration) && result.concentration) {
            out.concentration = result.concentration;
        }
    }

    out.aiEnriched = trust;
    out.aiConfidence = confidence;
    out.updatedAt = new Date().toISOString();
    return out;
}
