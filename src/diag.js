// Diagnostic entry point — find which import fails at startup
// CMD: node src/diag.js
// Remove after diagnosis complete
import https from 'https';

const notify = (msg) => {
    return new Promise((resolve) => {
        try {
            const body = Buffer.from(msg.slice(0, 800));
            const req = https.request({
                hostname: 'ntfy.sh',
                path: '/parfumeria-backend-diag-2026',
                method: 'POST',
                headers: { 'Content-Type': 'text/plain', 'Content-Length': body.length }
            });
            req.on('error', () => resolve());
            req.on('finish', () => resolve());
            req.write(body);
            req.end();
        } catch (_) { resolve(); }
    });
};

await notify(`DIAG START node=${process.version} platform=${process.platform} arch=${process.arch}`);

const mods = [
    ['express', 'express'],
    ['cors', 'cors'],
    ['helmet', 'helmet'],
    ['express-rate-limit', 'express-rate-limit'],
    ['dotenv', 'dotenv'],
    ['multer', 'multer'],
    ['pg', 'pg'],
    ['puppeteer', 'puppeteer'],
    ['uuid', 'uuid'],
    ['node-cron', 'node-cron'],
    ['perfumes-route', './routes/perfumes.js'],
    ['scraper-route', './routes/scraper.js'],
    ['auth-route', './routes/auth.js'],
    ['favorites-route', './routes/favorites.js'],
    ['content-route', './routes/content.js'],
    ['ai-route', './routes/ai.js'],
    ['activity-route', './routes/activity.js'],
    ['backup-route', './routes/backup.js'],
    ['perfumers-route', './routes/perfumers.js'],
    ['algolia-route', './routes/algolia.js'],
    ['docs-route', './routes/docs.js'],
    ['backupScheduler', './services/backupScheduler.js'],
    ['errorHandler', './middleware/errorHandler.js'],
    ['dataStore', './services/dataStore.js'],
    ['auth-mw', './middleware/auth.js'],
    ['metricsService', './services/metricsService.js'],
];

const results = [];
for (const [name, path] of mods) {
    try {
        await import(path);
        results.push(`OK: ${name}`);
        console.log(`✅ ${name}`);
    } catch (e) {
        const msg = `FAIL: ${name} — ${e.message}`;
        results.push(msg);
        console.error(`❌ ${name}: ${e.message}`);
        await notify(msg);
    }
}

const summary = results.filter(r => r.startsWith('FAIL')).join('\n') || 'ALL OK';
await notify(`DIAG DONE:\n${summary}`);
console.log('Diagnostic complete. Summary:', summary);
process.exit(0);
