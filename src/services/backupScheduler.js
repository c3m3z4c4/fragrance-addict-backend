import cron from 'node-cron';
import { createBackupBuffer, saveLocalBackup, uploadToDestinations } from './backupService.js';
import { dataStore } from './dataStore.js';

let currentTask = null;

// Build a valid cron expression from schedule settings
function buildCronExpression(type, time, day) {
    const [hour, minute] = (time || '02:00').split(':').map(Number);
    if (type === 'daily') {
        return `${minute} ${hour} * * *`;
    }
    if (type === 'weekly') {
        // day = 0-6 (0=Sunday, 1=Monday, …, 6=Saturday)
        return `${minute} ${hour} * * ${day ?? 0}`;
    }
    if (type === 'monthly') {
        // day = 1-31
        return `${minute} ${hour} ${day ?? 1} * *`;
    }
    return null;
}

export async function startScheduler(config) {
    stopScheduler();

    if (!config?.scheduleEnabled) return;

    const expr = buildCronExpression(config.scheduleType, config.scheduleTime, config.scheduleDay);
    if (!expr || !cron.validate(expr)) {
        console.error('❌ Invalid cron expression for backup schedule:', expr);
        return;
    }

    console.log(`⏰ Backup scheduler started: ${expr} (${config.scheduleType})`);

    currentTask = cron.schedule(
        expr,
        async () => {
            console.log('⏰ Running scheduled backup...');
            try {
                const buffer = await createBackupBuffer();
                const filename = `backup-scheduled-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
                saveLocalBackup(buffer, filename);

                const destinations = (config.destinations || []).filter(d => d.enabled);
                if (destinations.length > 0) {
                    const results = await uploadToDestinations(buffer, filename, destinations);
                    const failed = results.filter(r => !r.success);
                    if (failed.length > 0) {
                        console.warn('⚠️ Some upload destinations failed:', failed.map(r => `${r.name}: ${r.error}`).join(', '));
                    }
                }

                await dataStore.updateBackupTimestamp();
                console.log(`✅ Scheduled backup complete: ${filename}`);
            } catch (err) {
                console.error('❌ Scheduled backup failed:', err.message);
            }
        },
        { timezone: 'UTC' }
    );
}

export function stopScheduler() {
    if (currentTask) {
        currentTask.destroy();
        currentTask = null;
        console.log('⏹ Backup scheduler stopped');
    }
}

export async function initScheduler() {
    try {
        const config = await dataStore.getBackupConfig();
        if (config?.scheduleEnabled) {
            await startScheduler(config);
        } else {
            console.log('ℹ️ Backup scheduler disabled — skipping');
        }
    } catch (err) {
        console.error('⚠️ Could not init backup scheduler:', err.message);
    }
}
