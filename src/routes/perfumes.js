import express from 'express';
import { dataStore } from '../services/dataStore.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = express.Router();

// GET /api/perfumes - Lista con paginación y filtros
router.get('/', (req, res) => {
  const { page = 1, limit = 12, brand, gender, search, sortBy } = req.query;
  
  const result = dataStore.getAll({
    page: parseInt(page),
    limit: parseInt(limit),
    brand,
    gender,
    search,
    sortBy
  });
  
  res.json({ success: true, ...result });
});

// GET /api/perfumes/stats - Estadísticas
router.get('/stats', (req, res) => {
  const stats = dataStore.getStats();
  res.json({ success: true, data: stats });
});

// GET /api/perfumes/brands - Lista de marcas
router.get('/brands', (req, res) => {
  const brands = dataStore.getBrands();
  res.json({ success: true, data: brands });
});

// GET /api/perfumes/search - Búsqueda
router.get('/search', (req, res) => {
  const { q, page = 1, limit = 12 } = req.query;
  
  if (!q) {
    throw new ApiError('Parámetro de búsqueda requerido', 400);
  }
  
  const result = dataStore.getAll({
    page: parseInt(page),
    limit: parseInt(limit),
    search: q
  });
  
  res.json({ success: true, ...result });
});

// GET /api/perfumes/brand/:brand - Por marca
router.get('/brand/:brand', (req, res) => {
  const perfumes = dataStore.getByBrand(req.params.brand);
  res.json({ success: true, data: perfumes });
});

// GET /api/perfumes/:id - Detalle
router.get('/:id', (req, res, next) => {
  const perfume = dataStore.getById(req.params.id);
  
  if (!perfume) {
    return next(new ApiError('Perfume no encontrado', 404));
  }
  
  res.json({ success: true, data: perfume });
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
