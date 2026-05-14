import express from 'express';
import { dataStore } from '../services/dataStore.js';
import { requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();

// GET /api/backup/export
// Exports all perfumes (or filtered by brand) as a JSON attachment
router.get('/export', requireSuperAdmin, async (req, res, next) => {
    try {
        const brand = req.query.brand || null;
        const perfumes = await dataStore.exportAll({ brand: brand || undefined });

        const dateStr = new Date().toISOString().split('T')[0];
        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            brand: brand || 'all',
            count: perfumes.length,
            perfumes,
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=backup-${dateStr}.json`);
        res.json(payload);
    } catch (err) {
        next(err);
    }
});

// POST /api/backup/import
// Body: { perfumes: [...], mode: 'upsert' | 'replace' }
router.post('/import', requireSuperAdmin, async (req, res, next) => {
    try {
        const { perfumes, mode = 'upsert' } = req.body;

        if (!Array.isArray(perfumes)) {
            return res.status(400).json({ success: false, error: 'perfumes must be an array' });
        }

        let imported = 0;
        for (const perfume of perfumes) {
            if (!perfume || typeof perfume !== 'object') continue;
            await dataStore.add(perfume);
            imported++;
        }

        res.json({ success: true, imported, mode });
    } catch (err) {
        next(err);
    }
});

export default router;
