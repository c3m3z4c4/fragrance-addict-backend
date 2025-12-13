import crypto from 'crypto';
import { dataStore } from './dataStore.js';

/**
 * API Key Service - Manages generation, validation, and tracking of API keys
 */

export const apiKeyService = {
    /**
     * Generate a new API key
     * @param {string} name - Descriptive name for the key (e.g., "Mobile App", "Desktop Client")
     * @param {string} deviceName - Optional device identifier
     * @param {string} createdBy - User/identifier who created the key
     * @returns {Promise<{key: string, id: string, name: string, deviceName: string}>}
     */
    generateKey: async (name, deviceName, createdBy) => {
        try {
            // Generate secure random key
            const key = `frag_${crypto.randomBytes(32).toString('hex')}`;
            const id = crypto.randomUUID();

            // Store in database
            await dataStore.addApiKey({
                id,
                key,
                name,
                deviceName,
                createdBy,
                isActive: true,
                createdAt: new Date().toISOString(),
                metadata: {
                    userAgent: 'auto-generated',
                    ipAddress: 'system',
                },
            });

            console.log(`✅ API Key generated: ${name} (${deviceName})`);

            return {
                key,
                id,
                name,
                deviceName,
                message:
                    "Save this key securely. You won't be able to see it again.",
            };
        } catch (error) {
            console.error('❌ Error generating API key:', error.message);
            throw error;
        }
    },

    /**
     * Validate an API key
     * @param {string} key - The API key to validate
     * @returns {Promise<{valid: boolean, id: string, name: string, deviceName: string, lastUsedAt: Date}>}
     */
    validateKey: async (key) => {
        try {
            if (!key) {
                return { valid: false, reason: 'No key provided' };
            }

            // Check if key exists and is active
            const apiKey = await dataStore.getApiKeyByKey(key);

            if (!apiKey) {
                console.warn(
                    `⚠️ Invalid API key attempt: ${key.substring(0, 10)}...`
                );
                return { valid: false, reason: 'Key not found' };
            }

            if (!apiKey.is_active) {
                console.warn(`⚠️ Inactive API key used: ${apiKey.name}`);
                return { valid: false, reason: 'Key is inactive' };
            }

            // Update last used timestamp
            await dataStore.updateApiKeyLastUsed(apiKey.id);

            console.log(`✅ API Key validated: ${apiKey.name}`);

            return {
                valid: true,
                id: apiKey.id,
                name: apiKey.name,
                deviceName: apiKey.device_name,
                createdBy: apiKey.created_by,
                lastUsedAt: apiKey.last_used_at,
            };
        } catch (error) {
            console.error('❌ Error validating API key:', error.message);
            return { valid: false, reason: error.message };
        }
    },

    /**
     * List all API keys (admin only)
     * @returns {Promise<Array>}
     */
    listAllKeys: async () => {
        try {
            return await dataStore.getAllApiKeys();
        } catch (error) {
            console.error('❌ Error listing API keys:', error.message);
            throw error;
        }
    },

    /**
     * List API keys for a specific user/device
     * @param {string} createdBy - User identifier
     * @returns {Promise<Array>}
     */
    listUserKeys: async (createdBy) => {
        try {
            return await dataStore.getApiKeysByUser(createdBy);
        } catch (error) {
            console.error('❌ Error listing user API keys:', error.message);
            throw error;
        }
    },

    /**
     * Deactivate an API key
     * @param {string} keyId - The API key ID
     * @returns {Promise<boolean>}
     */
    deactivateKey: async (keyId) => {
        try {
            await dataStore.deactivateApiKey(keyId);
            console.log(`✅ API Key deactivated: ${keyId}`);
            return true;
        } catch (error) {
            console.error('❌ Error deactivating API key:', error.message);
            throw error;
        }
    },

    /**
     * Delete an API key
     * @param {string} keyId - The API key ID
     * @returns {Promise<boolean>}
     */
    deleteKey: async (keyId) => {
        try {
            await dataStore.deleteApiKey(keyId);
            console.log(`✅ API Key deleted: ${keyId}`);
            return true;
        } catch (error) {
            console.error('❌ Error deleting API key:', error.message);
            throw error;
        }
    },
};
