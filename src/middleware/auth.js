import { ApiError } from './errorHandler.js';

export const requireApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const validApiKey = process.env.API_KEY;

    // Debug logging
    console.log(`🔐 Auth Check: API Key received: ${apiKey ? 'Yes' : 'No'}`);
    console.log(
        `🔐 Auth Check: API Key configured: ${validApiKey ? 'Yes' : 'No'}`
    );

    if (!validApiKey) {
        console.warn('⚠️ API_KEY no configurada en variables de entorno');
        return next(
            new ApiError(
                'Server not configured correctly - API_KEY missing',
                500
            )
        );
    }

    if (!apiKey) {
        console.warn('⚠️ No API key provided in x-api-key header');
        return next(
            new ApiError('API key is required in x-api-key header', 401)
        );
    }

    if (apiKey !== validApiKey) {
        console.warn(
            `⚠️ Invalid API key provided. Expected: ${validApiKey.substring(
                0,
                5
            )}..., Got: ${apiKey.substring(0, 5)}...`
        );
        return next(new ApiError('Invalid API key', 401));
    }

    console.log('✅ API Key validation successful');
    next();
};
