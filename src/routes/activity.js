import { Router } from 'express';
import { dataStore } from '../services/dataStore.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

// ─── POST /api/activity/log ───────────────────────────────────────────────────
// Log a user activity event. Auth is optional — anonymous sessions are tracked too.

router.post('/log', async (req, res) => {
    const { sessionId, eventType, entityId, entityName, metadata } = req.body;

    if (!sessionId || !eventType) {
        return res.status(400).json({ error: 'sessionId and eventType are required' });
    }

    const validTypes = ['perfume_view', 'brand_search', 'search_query'];
    if (!validTypes.includes(eventType)) {
        return res.status(400).json({ error: `eventType must be one of: ${validTypes.join(', ')}` });
    }

    // Attempt to resolve user from token if present (best-effort, not required)
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        try {
            const { default: jwt } = await import('jsonwebtoken');
            const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
            userId = decoded.sub;
        } catch {
            // Anonymous — ignore
        }
    }

    await dataStore.logActivity({ userId, sessionId, eventType, entityId, entityName, metadata });
    res.json({ success: true });
});

// ─── GET /api/activity/stats ──────────────────────────────────────────────────
// Activity dashboard for superadmin.

router.get('/stats', requireSuperAdmin, async (req, res, next) => {
    try {
        const { eventType, limit } = req.query;
        const stats = await dataStore.getActivityStats({
            eventType: eventType || undefined,
            limit: limit ? parseInt(limit, 10) : 200,
        });
        res.json({ success: true, ...stats });
    } catch (err) {
        next(err);
    }
});

export default router;
