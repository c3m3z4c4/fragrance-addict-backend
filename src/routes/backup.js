import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync } from 'fs';
import { dataStore } from '../services/dataStore.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import {
    createBackupBuffer,
    saveLocalBackup,
    listLocalBackups,
    readLocalBackup,
    uploadToDestinations,
    restoreFromBackup,
    encryptCredential,
    uploadWebDAV,
    uploadGoogleDrive,
    uploadSFTP,
} from '../services/backupService.js';
import { startScheduler, stopScheduler } from '../services/backupScheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// GET /api/backup/config — return current backup config (passwords masked)
router.get('/config', requireSuperAdmin, async (req, res, next) => {
    try {
        const config = await dataStore.getBackupConfig() || {};
        const safe = { ...config };
        if (safe.destinations) {
            safe.destinations = safe.destinations.map(d => ({
                ...d,
                config: {
                    ...d.config,
                    password: d.config?.password ? '••••••••' : undefined,
                    credentials: d.config?.credentials ? '••••••••' : undefined,
                },
            }));
        }
        res.json({ success: true, config: safe });
    } catch (err) {
        next(err);
    }
});

// POST /api/backup/config — save destinations + schedule config
router.post('/config', requireSuperAdmin, async (req, res, next) => {
    try {
        const { destinations = [], scheduleEnabled, scheduleType, scheduleTime, scheduleDay } = req.body;

        // Load existing config to preserve already-encrypted secrets when values are masked
        const existing = await dataStore.getBackupConfig() || {};
        const existingDestsMap = (existing.destinations || []).reduce((m, d) => {
            m[d.id] = d;
            return m;
        }, {});

        const processedDests = destinations.map(dest => {
            const ex = existingDestsMap[dest.id];
            const config = { ...dest.config };

            // Password: encrypt new values, keep existing encrypted if masked
            if (config.password && config.password !== '••••••••') {
                config.password = encryptCredential(config.password);
            } else if (config.password === '••••••••' && ex?.config?.password) {
                config.password = ex.config.password;
            } else if (config.password === '••••••••') {
                delete config.password; // masked but no existing — remove
            }

            // Credentials JSON: same pattern
            if (config.credentials && config.credentials !== '••••••••') {
                config.credentials = encryptCredential(config.credentials);
            } else if (config.credentials === '••••••••' && ex?.config?.credentials) {
                config.credentials = ex.config.credentials;
            } else if (config.credentials === '••••••••') {
                delete config.credentials;
            }

            return { ...dest, config };
        });

        const newConfig = {
            destinations: processedDests,
            scheduleEnabled: !!scheduleEnabled,
            scheduleType,
            scheduleTime,
            scheduleDay,
        };

        await dataStore.saveBackupConfig(newConfig);

        // Restart or stop the scheduler based on new config
        if (scheduleEnabled) {
            await startScheduler(newConfig);
        } else {
            stopScheduler();
        }

        res.json({ success: true, message: 'Backup configuration saved' });
    } catch (err) {
        next(err);
    }
});

// POST /api/backup/create — create a backup now and optionally upload to destinations
router.post('/create', requireSuperAdmin, async (req, res, next) => {
    try {
        const { brand, upload = true } = req.body;
        const buffer = await createBackupBuffer({ brand: brand || undefined });

        const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const brandSlug = brand ? brand.replace(/\s+/g, '_') + '-' : '';
        const filename = `backup-${brandSlug}${dateStr}.json`;

        const localPath = saveLocalBackup(buffer, filename);

        let uploadResults = [];
        if (upload) {
            const config = await dataStore.getBackupConfig();
            const destinations = (config?.destinations || []).filter(d => d.enabled);
            if (destinations.length > 0) {
                uploadResults = await uploadToDestinations(buffer, filename, destinations);
            }
        }

        await dataStore.updateBackupTimestamp();

        res.json({
            success: true,
            filename,
            size: buffer.length,
            localPath,
            uploads: uploadResults,
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/backup/list — list local backup files
router.get('/list', requireSuperAdmin, async (req, res, next) => {
    try {
        const backups = listLocalBackups();
        const config = await dataStore.getBackupConfig();
        res.json({
            success: true,
            backups,
            lastBackupAt: config?.lastBackupAt || null,
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/backup/restore — restore from local file OR from inline JSON body
router.post('/restore', requireSuperAdmin, async (req, res, next) => {
    try {
        const { filename, data } = req.body;
        let backupJson;

        if (filename) {
            backupJson = readLocalBackup(filename);
        } else if (data?.perfumes) {
            backupJson = data;
        } else {
            return res.status(400).json({
                success: false,
                error: 'Provide filename or data.perfumes',
            });
        }

        const imported = await restoreFromBackup(backupJson);
        res.json({
            success: true,
            imported,
            total: backupJson.perfumes?.length,
        });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/backup/local/:filename — delete a specific local backup file
router.delete('/local/:filename', requireSuperAdmin, async (req, res, next) => {
    try {
        const { filename } = req.params;
        // Prevent path traversal attacks
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ success: false, error: 'Invalid filename' });
        }
        const filePath = join(__dirname, '../../backups', filename);
        unlinkSync(filePath);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// POST /api/backup/test-destination — test connectivity to a destination
router.post('/test-destination', requireSuperAdmin, async (req, res, next) => {
    try {
        const { type, config: rawConfig } = req.body;

        // Strip masked values — they can't be used for testing without the real value
        const config = {};
        for (const [k, v] of Object.entries(rawConfig || {})) {
            config[k] = (v === '••••••••') ? '' : v;
        }

        const testBuffer = Buffer.from(
            JSON.stringify({ test: true, ts: new Date().toISOString() }),
            'utf8'
        );
        const testFilename = `.fragrance-backup-test-${Date.now()}.json`;

        if (type === 'webdav') {
            await uploadWebDAV(testBuffer, testFilename, config);
        } else if (type === 'gdrive') {
            await uploadGoogleDrive(testBuffer, testFilename, config);
        } else if (type === 'sftp') {
            await uploadSFTP(testBuffer, testFilename, config);
        } else {
            return res.status(400).json({ success: false, error: 'Unknown destination type' });
        }

        res.json({ success: true, message: `Conexión a ${type} exitosa` });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// GET /api/backup/export — download JSON directly (backward compat)
router.get('/export', requireSuperAdmin, async (req, res, next) => {
    try {
        const brand = req.query.brand || null;
        const buffer = await createBackupBuffer({ brand: brand || undefined });
        const dateStr = new Date().toISOString().split('T')[0];
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=backup-${dateStr}.json`);
        res.send(buffer);
    } catch (err) {
        next(err);
    }
});

// POST /api/backup/import — import from uploaded JSON body (backward compat)
router.post('/import', requireSuperAdmin, async (req, res, next) => {
    try {
        const { perfumes, mode = 'upsert' } = req.body;
        if (!Array.isArray(perfumes)) {
            return res.status(400).json({ success: false, error: 'perfumes must be an array' });
        }
        let imported = 0;
        for (const p of perfumes) {
            if (!p || typeof p !== 'object') continue;
            try { await dataStore.add(p); imported++; } catch {}
        }
        res.json({ success: true, imported, mode });
    } catch (err) {
        next(err);
    }
});

export default router;
