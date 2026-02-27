import jwt from 'jsonwebtoken';
import { ApiError } from './errorHandler.js';
import { apiKeyService } from '../services/apiKeyService.js';
import { dataStore } from '../services/dataStore.js';

export const requireApiKey = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const fallbackApiKey = process.env.API_KEY;

    // Debug logging
    console.log(`🔐 Auth Check: API Key received: ${apiKey ? 'Yes' : 'No'}`);

    if (!apiKey) {
        console.warn('⚠️ No API key provided in x-api-key header');
        return next(
            new ApiError('API key is required in x-api-key header', 401)
        );
    }

    try {
        // First try to validate against database keys
        const keyData = await apiKeyService.validateKey(apiKey);

        if (keyData && keyData.valid) {
            console.log(`✅ API Key validation successful: ${keyData.name}`);
            // Attach key metadata to request for later use
            req.apiKey = keyData;
            return next();
        }

        // Fallback to environment variable for backwards compatibility
        if (fallbackApiKey && apiKey === fallbackApiKey) {
            console.log(
                '✅ API Key validation successful (fallback to env variable)'
            );
            req.apiKey = {
                id: 'system',
                name: 'System',
                deviceName: 'System',
                createdBy: 'system',
            };
            return next();
        }

        console.warn(
            `⚠️ Invalid API key provided: ${apiKey.substring(0, 5)}...`
        );
        return next(new ApiError('Invalid API key', 401));
    } catch (error) {
        console.error('❌ Error validating API key:', error.message);
        return next(new ApiError('Error validating API key', 500));
    }
};

// ─── JWT-based auth ────────────────────────────────────────────────────────────

export const requireAuth = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next(new ApiError('Authentication required', 401));
    }

    const token = authHeader.slice(7);
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const user = await dataStore.getUserById(payload.sub);
        if (!user || !user.is_active) {
            return next(new ApiError('User not found or inactive', 401));
        }
        req.user = user;
        return next();
    } catch (err) {
        return next(new ApiError('Invalid or expired token', 401));
    }
};

export const requireSuperAdmin = async (req, res, next) => {
    await requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (req.user?.role !== 'SUPERADMIN') {
            return next(new ApiError('Superadmin access required', 403));
        }
        return next();
    });
};
