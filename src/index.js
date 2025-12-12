import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import perfumeRoutes from './routes/perfumes.js';
import scraperRoutes from './routes/scraper.js';
import { errorHandler } from './middleware/errorHandler.js';
import {
    initDatabase,
    dataStore,
    getConnectionError,
} from './services/dataStore.js';

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

// CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:5173',
];
console.log('🌐 Allowed origins:', allowedOrigins);

app.use(
    cors({
        origin: allowedOrigins,
        credentials: true,
    })
);

// Rate limiting global
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // máximo 100 requests por ventana
    message: { error: 'Demasiadas peticiones, intenta más tarde' },
});
app.use(limiter);

// Body parser
app.use(express.json());

// Import requireApiKey middleware
import { requireApiKey } from './middleware/auth.js';

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
            error: null,
        },
        memory: {
            used:
                Math.round(process.memoryUsage().heapUsed / 1024 / 1024) +
                ' MB',
            total:
                Math.round(process.memoryUsage().heapTotal / 1024 / 1024) +
                ' MB',
        },
    };

    // Test de conexión a la base de datos si está configurada
    if (process.env.DATABASE_URL && !dataStore.isConnected()) {
        health.database.error =
            getConnectionError() ||
            'Connection failed - check DATABASE_URL format and network access';
        health.status = 'degraded';
    }

    // Intentar obtener estadísticas si está conectado
    if (dataStore.isConnected()) {
        try {
            const stats = await dataStore.getStats();
            health.database.stats = {
                perfumes: stats.totalPerfumes,
                brands: stats.totalBrands,
            };
        } catch (error) {
            health.database.error = error.message;
            health.status = 'degraded';
        }
    }

    const statusCode = health.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(health);
});

// Endpoint simple para validar API key (sin dependencias complejas)
app.get('/api/auth/validate', requireApiKey, (req, res) => {
    res.json({ success: true, message: 'API key is valid' });
});

// Rutas
app.use('/api/perfumes', perfumeRoutes);
app.use('/api/scrape', scraperRoutes);

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
        console.log(
            `💾 Database: ${
                dataStore.isConnected() ? 'Connected' : 'In-memory mode'
            }`
        );
    });
};

startServer();
