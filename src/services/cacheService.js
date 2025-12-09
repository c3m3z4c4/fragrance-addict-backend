import NodeCache from 'node-cache';

// Cache con TTL de 1 hora por defecto
const cache = new NodeCache({ 
  stdTTL: 3600,
  checkperiod: 600,
  useClones: false
});

export const cacheService = {
  get: (key) => cache.get(key),
  
  set: (key, value, ttl = 3600) => cache.set(key, value, ttl),
  
  del: (key) => cache.del(key),
  
  flush: () => cache.flushAll(),
  
  stats: () => cache.getStats()
};
