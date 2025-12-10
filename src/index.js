import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import perfumeRoutes from './routes/perfumes.js';
import scraperRoutes from './routes/scraper.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initDatabase } from './services/dataStore.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware de seguridad
app.use(helmet());

// CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:5173',
];
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

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rutas
app.use('/api/perfumes', perfumeRoutes);
app.use('/api/scrape', scraperRoutes);

// Error handler
app.use(errorHandler);

// Inicializar base de datos y arrancar servidor
const startServer = async () => {
    try {
        await initDatabase();
        app.listen(PORT, () => {
            console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
        });
    } catch (error) {
        console.error('❌ Error starting server:', error.message);
        process.exit(1);
    }
};

startServer();
