import { Router } from 'express';
import { dataStore } from '../services/dataStore.js';
import { requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

const DEFAULT_ABOUT = {
    hero: {
        eyebrow: 'About Parfumería',
        title: 'The Poetry of',
        titleAccent: 'Scent',
        subtitle: 'We believe that fragrance is one of the most intimate and powerful forms of self-expression. Our mission is to connect you with the world\'s finest perfumes, each one a masterpiece of olfactory artistry.',
    },
    story: {
        title: 'Our Story',
        paragraphs: [
            'Founded by passionate fragrance enthusiasts, Parfumería began as a dream to create the ultimate destination for perfume lovers. We spent years traveling the world, visiting legendary perfume houses, meeting master perfumers, and curating a collection that represents the pinnacle of fragrance craftsmanship.',
            'Today, our catalog features hundreds of carefully selected fragrances from the most prestigious brands. Each perfume in our collection has been personally evaluated for its quality, creativity, and ability to evoke emotion.',
            'We\'re more than just a catalog—we\'re a community of scent enthusiasts dedicated to helping you discover your signature fragrance.',
        ],
        imageUrl: 'https://images.unsplash.com/photo-1595535873420-a599195b3f4a?w=800',
        imageAlt: 'Perfume craftsmanship',
    },
    values: {
        title: 'Our Values',
        items: [
            { title: 'Authenticity', description: 'Every fragrance in our collection is 100% authentic, sourced directly from authorized distributors.' },
            { title: 'Expertise', description: 'Our team includes certified fragrance specialists who can guide you to your perfect scent.' },
            { title: 'Passion', description: 'We\'re driven by a genuine love for perfumery and a desire to share that passion with you.' },
        ],
    },
};

// GET /api/content/about — public
router.get('/about', async (req, res) => {
    try {
        const stored = await dataStore.getContent('about');
        res.json({ content: stored ?? DEFAULT_ABOUT });
    } catch (err) {
        res.json({ content: DEFAULT_ABOUT });
    }
});

// PUT /api/content/about — superadmin only
router.put('/about', requireSuperAdmin, async (req, res, next) => {
    try {
        const ok = await dataStore.setContent('about', req.body);
        if (!ok) {
            return res.status(503).json({ error: 'Database unavailable — content not saved' });
        }
        res.json({ success: true, content: req.body });
    } catch (err) {
        next(err);
    }
});

export default router;
