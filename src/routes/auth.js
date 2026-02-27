import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import { dataStore } from '../services/dataStore.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const signToken = (user) =>
    jwt.sign(
        { sub: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

const safeUser = (user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    role: user.role,
    provider: user.provider,
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
// Email + password login (only for SUPERADMIN seeded from env or local provider)

router.post('/login', async (req, res, next) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return next(new ApiError('Email and password are required', 400));
    }

    try {
        const user = await dataStore.getUserByEmail(email);
        if (!user || user.provider !== 'local' || !user.password_hash) {
            return next(new ApiError('Invalid credentials', 401));
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return next(new ApiError('Invalid credentials', 401));
        }

        const token = signToken(user);
        return res.json({ token, user: safeUser(user) });
    } catch (err) {
        return next(err);
    }
});

// ─── GET /api/auth/google ─────────────────────────────────────────────────────
// Redirect to Google OAuth consent screen

router.get('/google', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_CALLBACK_URL,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ─── GET /api/auth/google/callback ───────────────────────────────────────────

router.get('/google/callback', async (req, res, next) => {
    const { code, error } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (error || !code) {
        return res.redirect(`${frontendUrl}/login?error=google_cancelled`);
    }

    try {
        // Exchange code for tokens
        const tokenRes = await axios.post(
            'https://oauth2.googleapis.com/token',
            new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: process.env.GOOGLE_CALLBACK_URL,
                grant_type: 'authorization_code',
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        // Get user info from Google
        const userInfoRes = await axios.get(
            'https://www.googleapis.com/oauth2/v3/userinfo',
            { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } }
        );

        const { sub: googleId, email, name, picture: avatarUrl } = userInfoRes.data;

        // Check if user exists by Google ID
        let user = await dataStore.getUserByGoogleId(googleId);

        if (!user) {
            // Check by email (might be the seeded superadmin upgrading to google)
            const existingByEmail = await dataStore.getUserByEmail(email);
            if (existingByEmail) {
                // Link Google account to existing user
                user = await dataStore.updateUser(existingByEmail.id, {
                    google_id: googleId,
                    avatar_url: avatarUrl,
                });
            } else {
                // Determine role: ADMIN_EMAIL auto-becomes SUPERADMIN
                const adminEmail = process.env.ADMIN_EMAIL;
                const role = adminEmail && email === adminEmail ? 'SUPERADMIN' : 'USER';

                user = await dataStore.createUser({
                    email,
                    name,
                    avatarUrl,
                    role,
                    provider: 'google',
                    googleId,
                });
            }
        } else {
            // Update avatar/name if changed
            user = await dataStore.updateUser(user.id, {
                avatar_url: avatarUrl,
                name,
            });
        }

        if (!user) {
            return res.redirect(`${frontendUrl}/login?error=user_creation_failed`);
        }

        const token = signToken(user);
        return res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
    } catch (err) {
        console.error('❌ Google OAuth error:', err.message);
        return res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────

router.get('/me', requireAuth, (req, res) => {
    res.json({ user: safeUser(req.user) });
});

// ─── GET /api/auth/users ──────────────────────────────────────────────────────

router.get('/users', requireSuperAdmin, async (req, res, next) => {
    try {
        const users = await dataStore.getAllUsers();
        res.json({ users });
    } catch (err) {
        next(err);
    }
});

// ─── PATCH /api/auth/users/:id/role ──────────────────────────────────────────

router.patch('/users/:id/role', requireSuperAdmin, async (req, res, next) => {
    const { id } = req.params;
    const { role } = req.body;

    if (!['SUPERADMIN', 'USER'].includes(role)) {
        return next(new ApiError('Role must be SUPERADMIN or USER', 400));
    }

    try {
        const updated = await dataStore.updateUserRole(id, role);
        if (!updated) {
            return next(new ApiError('User not found', 404));
        }
        res.json({ user: safeUser(updated) });
    } catch (err) {
        next(err);
    }
});

export default router;
