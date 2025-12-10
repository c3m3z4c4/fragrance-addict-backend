import express from 'express';
import rateLimit from 'express-rate-limit';
import { scrapePerfume } from '../services/scrapingService.js';
import { dataStore } from '../services/dataStore.js';
import { cacheService } from '../services/cacheService.js';
import { requireApiKey } from '../middleware/auth.js';
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

// GET /api/scrape/perfume?url=... - Scrapear un perfume
router.get('/perfume', requireApiKey, scrapeLimiter, async (req, res, next) => {
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
router.post('/batch', requireApiKey, async (req, res, next) => {
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

// GET /api/scrape/cache/stats - Estadísticas del caché
router.get('/cache/stats', requireApiKey, (req, res) => {
    const stats = cacheService.stats();
    res.json({ success: true, data: stats });
});

// DELETE /api/scrape/cache - Limpiar caché
router.delete('/cache', requireApiKey, (req, res) => {
    cacheService.flush();
    res.json({ success: true, message: 'Caché limpiado' });
});

export default router;
