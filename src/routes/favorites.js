import { Router } from 'express';
import { dataStore } from '../services/dataStore.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/favorites — list user's favorites
router.get('/', requireAuth, async (req, res, next) => {
    try {
        const favorites = await dataStore.getUserFavorites(req.user.id);
        res.json({ favorites });
    } catch (err) {
        next(err);
    }
});

// POST /api/favorites/:id — add to favorites
router.post('/:id', requireAuth, async (req, res, next) => {
    try {
        const result = await dataStore.addFavorite(req.user.id, req.params.id);
        if (result === null) {
            // addFavorite returns null if DB not connected or on error; check if already exists
            const exists = await dataStore.isFavorite(req.user.id, req.params.id);
            if (!exists) {
                return next(new ApiError('Could not add favorite', 500));
            }
        }
        res.status(201).json({ success: true });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/favorites/:id — remove from favorites
router.delete('/:id', requireAuth, async (req, res, next) => {
    try {
        const removed = await dataStore.removeFavorite(req.user.id, req.params.id);
        if (!removed) {
            return next(new ApiError('Favorite not found', 404));
        }
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

export default router;
