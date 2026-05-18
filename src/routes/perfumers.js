import express from 'express';
import { dataStore } from '../services/dataStore.js';
import { requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();

// GET /api/perfumers — list all (with verified data merged)
router.get('/', async (req, res, next) => {
    try {
        const perfumers = await dataStore.getPerfumers();
        res.json({ success: true, data: perfumers });
    } catch (error) {
        next(error);
    }
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
        const { imageUrl, bio, nationality } = req.body;
        await dataStore.upsertPerfumer({ name, imageUrl, bio, nationality });
        res.json({ success: true });
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
