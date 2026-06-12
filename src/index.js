import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import perfumeRoutes from './routes/perfumes.js';
import scraperRoutes from './routes/scraper.js';
import authRoutes from './routes/auth.js';
import favoritesRoutes from './routes/favorites.js';
import contentRoutes from './routes/content.js';
import aiRoutes from './routes/ai.js';
import activityRoutes from './routes/activity.js';
import backupRoutes from './routes/backup.js';
import perfumersRoutes from './routes/perfumers.js';
import algoliaRoutes, { refreshAlgoliaKey } from './routes/algolia.js';
import { algoliaKeyExpiry } from './services/algoliaService.js';
import docsRoutes from './routes/docs.js';
import { initScheduler } from './services/backupScheduler.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initDatabase, dataStore, getConnectionError } from './services/dataStore.js';
import { requireSuperAdmin } from './middleware/auth.js';
import { metricsMiddleware, getMetrics } from './services/metricsService.js';

dotenv.config();

// Global process error guards — prevent uncaught errors from killing the process
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception (process kept alive):', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled rejection (process kept alive):', reason);
});

console.log('🚀 Starting Perfume Catalog API...');
console.log('📍 Environment:', process.env.NODE_ENV || 'development');
console.log('🔌 Port:', process.env.PORT || 3000);

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for rate-limit behind reverse proxy (Traefik/Dokploy)
app.set('trust proxy', 1);

// Middleware de seguridad
app.use(helmet());

// CORS - Allow multiple origins or all if configured
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'];
const allowAllOrigins = process.env.CORS_ALLOW_ALL === 'true';
console.log('🌐 CORS mode:', allowAllOrigins ? 'Allow all origins' : `Allowed origins: ${allowedOrigins.join(', ')}`);

app.use(cors({
  origin: allowAllOrigins ? true : (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(allowed => origin.includes(allowed.replace('https://', '').replace('http://', '')))) {
      return callback(null, true);
    }
    console.warn(`⚠️ CORS blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Rate limiting global — generous limit; scrape routes have their own stricter limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Demasiadas peticiones, intenta más tarde' },
  skip: (req) => {
    // Skip rate limit for authenticated admin requests
    return !!req.headers.authorization;
  },
});
app.use(limiter);

// Body parser
app.use(express.json());

// Static files for uploaded logos
const uploadsBase = join(__dirname, '../uploads');
try { mkdirSync(join(uploadsBase, 'logos'), { recursive: true }); } catch { /* ignore */ }
app.use('/uploads', express.static(uploadsBase));

// Recolectar métricas de cada request
app.use(metricsMiddleware);

// Health check detallado
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    database: {
      configured: !!process.env.DATABASE_URL,
      connected: dataStore.isConnected(),
      error: null
    },
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
    }
  };

  if (process.env.DATABASE_URL && !dataStore.isConnected()) {
    health.database.error = getConnectionError() || 'Connection failed - check DATABASE_URL format and network access';
    health.status = 'degraded';
  }

  if (dataStore.isConnected()) {
    try {
      const stats = await dataStore.getStats();
      health.database.stats = {
        perfumes: stats.totalPerfumes,
        brands: stats.totalBrands
      };
    } catch (error) {
      health.database.error = error.message;
      health.status = 'degraded';
    }
  }

  // Always 200 — admin distinguishes reachable vs unreachable; body.status has detail
  res.status(200).json(health);
});

// Métricas del servidor (protegido con JWT superadmin)
app.get('/metrics', requireSuperAdmin, (req, res) => {
  res.json(getMetrics());
});

// Rutas
app.use('/api/perfumes', perfumeRoutes);
app.use('/api/scrape', scraperRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/perfumers', perfumersRoutes);
app.use('/api/algolia', algoliaRoutes);
app.use('/docs', docsRoutes);

// Error handler
app.use(errorHandler);

// Inicializar base de datos y arrancar servidor
const startServer = async () => {
  console.log('📊 Initializing database...');

  try {
    await initDatabase();
  } catch (error) {
    console.error('⚠️ Database initialization failed:', error.message);
    console.log('🔄 Server will start anyway with in-memory storage');
  }

  // Load runtime config persisted from the admin UI (survives restarts).
  // The Algolia search key rotates ~every 3 weeks; a DB-persisted value (pasted
  // in the admin UI) takes precedence over the env seed so refreshes stick.
  try {
    const persistedAlgoliaKey = await dataStore.getSetting('ALGOLIA_API_KEY');
    if (persistedAlgoliaKey) {
      process.env.ALGOLIA_API_KEY = persistedAlgoliaKey;
      console.log('🔑 Loaded persisted ALGOLIA_API_KEY from DB');
    }
  } catch (err) {
    console.warn('⚠️ Could not load persisted settings:', err.message);
  }

  // Auto-refresh the rotating Algolia key. It expires ~every 3 weeks; rather than
  // requiring a manual DevTools capture, we read a fresh one from Fragrantica's
  // public HTML. Runs at boot (if missing/near expiry) and daily thereafter. If
  // Cloudflare blocks the server IP on every mirror this just logs and leaves the
  // current key in place — refresh can then be triggered from a non-blocked IP.
  const REFRESH_IF_EXPIRES_WITHIN = 3 * 24 * 60 * 60; // 3 days
  const ensureFreshAlgoliaKey = async () => {
    const key = process.env.ALGOLIA_API_KEY || '';
    const exp = key ? algoliaKeyExpiry(key) : null;
    const soon = !key || !exp || exp - Math.floor(Date.now() / 1000) < REFRESH_IF_EXPIRES_WITHIN;
    if (!soon) return;
    try {
      await refreshAlgoliaKey();
    } catch (err) {
      console.warn('⚠️ Algolia key auto-refresh failed:', err.message);
    }
  };
  await ensureFreshAlgoliaKey();
  const algoliaKeyTimer = setInterval(ensureFreshAlgoliaKey, 24 * 60 * 60 * 1000);
  if (typeof algoliaKeyTimer.unref === 'function') algoliaKeyTimer.unref();

  // Initialize backup scheduler (reads config from DB, harmless if DB unavailable)
  await initScheduler();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`💾 Database: ${dataStore.isConnected() ? 'Connected' : 'In-memory mode'}`);
  });
};

startServer();
