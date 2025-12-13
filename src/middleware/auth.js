import { ApiError } from './errorHandler.js';
import { apiKeyService } from '../services/apiKeyService.js';

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
