import express from 'express';
import { dataStore } from '../services/dataStore.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = express.Router();

// GET /api/perfumes - Lista con paginación y filtros
router.get('/', async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 12,
            brand,
            gender,
            search,
            sortBy,
        } = req.query;

        const result = await dataStore.getAll({
            page: parseInt(page),
            limit: parseInt(limit),
            brand,
            gender,
            search,
            sortBy,
        });

        res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
});

// GET /api/perfumes/stats - Estadísticas
router.get('/stats', (req, res) => {
    const stats = dataStore.getStats();
    res.json({ success: true, data: stats });
});

// GET /api/perfumes/brands - Lista de marcas con imagen y conteo
router.get('/brands', async (req, res, next) => {
    try {
        const brands = await dataStore.getBrands();
        res.json({ success: true, data: brands });
    } catch (error) {
        next(error);
    }
});

// GET /api/perfumes/search - Búsqueda
router.get('/search', async (req, res, next) => {
    try {
        const { q, page = 1, limit = 12 } = req.query;

        if (!q) {
            return res.status(400).json({
                success: false,
                error: 'Parámetro de búsqueda requerido',
            });
        }

        const result = await dataStore.getAll({
            page: parseInt(page),
            limit: parseInt(limit),
            search: q,
        });

        res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
});

// GET /api/perfumes/brand/:brand - Por marca
router.get('/brand/:brand', (req, res) => {
    const perfumes = dataStore.getByBrand(req.params.brand);
    res.json({ success: true, data: perfumes });
});

// GET /api/perfumes/:id - Detalle
router.get('/:id', async (req, res, next) => {
    try {
        const perfume = await dataStore.getById(req.params.id);

        if (!perfume) {
            return next(new ApiError('Perfume no encontrado', 404));
        }

        res.json({ success: true, data: perfume });
    } catch (error) {
        next(error);
    }
});

// POST /api/perfumes - Crear manualmente
router.post('/', (req, res, next) => {
    const { name, brand } = req.body;

    if (!name || !brand) {
        return next(new ApiError('Nombre y marca son requeridos', 400));
    }

    const perfume = dataStore.add(req.body);
    res.status(201).json({ success: true, data: perfume });
});

// PUT /api/perfumes/:id - Actualizar
router.put('/:id', (req, res, next) => {
    const perfume = dataStore.update(req.params.id, req.body);

    if (!perfume) {
        return next(new ApiError('Perfume no encontrado', 404));
    }

    res.json({ success: true, data: perfume });
});

// DELETE /api/perfumes/:id - Eliminar
router.delete('/:id', (req, res, next) => {
    const deleted = dataStore.delete(req.params.id);

    if (!deleted) {
        return next(new ApiError('Perfume no encontrado', 404));
    }

    res.json({ success: true, message: 'Perfume eliminado' });
});

export default router;
