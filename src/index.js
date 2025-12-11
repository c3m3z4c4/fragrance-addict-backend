import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import perfumeRoutes from './routes/perfumes.js';
import scraperRoutes from './routes/scraper.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initDatabase, dataStore } from './services/dataStore.js';

dotenv.config();

console.log('🚀 Starting Perfume Catalog API...');
console.log('📍 Environment:', process.env.NODE_ENV || 'development');
console.log('🔌 Port:', process.env.PORT || 3000);

const app = express();
const PORT = process.env.PORT || 3000;

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

// Health check - siempre disponible
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        databaseConnected: dataStore.isConnected(),
        environment: process.env.NODE_ENV || 'development',
    });
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
