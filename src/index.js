import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import perfumeRoutes from './routes/perfumes.js';
import scraperRoutes from './routes/scraper.js';
import authRoutes from './routes/auth.js';
import favoritesRoutes from './routes/favorites.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initDatabase, dataStore, getConnectionError } from './services/dataStore.js';
import { requireSuperAdmin } from './middleware/auth.js';
import { metricsMiddleware, getMetrics } from './services/metricsService.js';

dotenv.config();

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

// Rate limiting global
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas peticiones, intenta más tarde' }
});
app.use(limiter);

// Body parser
app.use(express.json());

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`💾 Database: ${dataStore.isConnected() ? 'Connected' : 'In-memory mode'}`);
  });
};

startServer();
