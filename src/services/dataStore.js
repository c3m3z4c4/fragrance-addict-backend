import { v4 as uuidv4 } from 'uuid';

// Almacenamiento en memoria (reemplazar con PostgreSQL para producción)
let perfumes = [];

export const dataStore = {
  // Obtener todos los perfumes con paginación
  getAll: ({ page = 1, limit = 12, brand, gender, search, sortBy = 'createdAt' }) => {
    let filtered = [...perfumes];
    
    // Filtrar por marca
    if (brand) {
      filtered = filtered.filter(p => 
        p.brand?.toLowerCase().includes(brand.toLowerCase())
      );
    }
    
    // Filtrar por género
    if (gender) {
      filtered = filtered.filter(p => p.gender === gender);
    }
    
    // Búsqueda por texto
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(p => 
        p.name?.toLowerCase().includes(searchLower) ||
        p.brand?.toLowerCase().includes(searchLower) ||
        p.description?.toLowerCase().includes(searchLower)
      );
    }
    
    // Ordenar
    filtered.sort((a, b) => {
      if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
      if (sortBy === 'rating') return (b.rating || 0) - (a.rating || 0);
      if (sortBy === 'year') return (b.year || 0) - (a.year || 0);
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    
    // Paginar
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);
    
    return {
      data: paginated,
      pagination: {
        page,
        limit,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / limit)
      }
    };
  },
  
  // Obtener por ID
  getById: (id) => {
    return perfumes.find(p => p.id === id) || null;
  },
  
  // Buscar por marca
  getByBrand: (brand) => {
    return perfumes.filter(p => 
      p.brand?.toLowerCase() === brand.toLowerCase()
    );
  },
  
  // Obtener todas las marcas
  getBrands: () => {
    const brands = [...new Set(perfumes.map(p => p.brand).filter(Boolean))];
    return brands.sort();
  },
  
  // Agregar perfume
  add: (perfume) => {
    const newPerfume = {
      ...perfume,
      id: perfume.id || uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    perfumes.push(newPerfume);
    return newPerfume;
  },
  
  // Actualizar perfume
  update: (id, data) => {
    const index = perfumes.findIndex(p => p.id === id);
    if (index === -1) return null;
    
    perfumes[index] = {
      ...perfumes[index],
      ...data,
      id, // mantener ID original
      updatedAt: new Date().toISOString()
    };
    
    return perfumes[index];
  },
  
  // Eliminar perfume
  delete: (id) => {
    const index = perfumes.findIndex(p => p.id === id);
    if (index === -1) return false;
    
    perfumes.splice(index, 1);
    return true;
  },
  
  // Estadísticas
  getStats: () => ({
    totalPerfumes: perfumes.length,
    totalBrands: new Set(perfumes.map(p => p.brand).filter(Boolean)).size,
    byGender: {
      masculine: perfumes.filter(p => p.gender === 'masculine').length,
      feminine: perfumes.filter(p => p.gender === 'feminine').length,
      unisex: perfumes.filter(p => p.gender === 'unisex').length
    }
  })
};
