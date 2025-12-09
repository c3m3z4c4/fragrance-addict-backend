import { ApiError } from './errorHandler.js';

export const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.API_KEY;
  
  if (!validApiKey) {
    console.warn('⚠️ API_KEY no configurada en variables de entorno');
    return next(new ApiError('Servidor no configurado correctamente', 500));
  }
  
  if (!apiKey || apiKey !== validApiKey) {
    return next(new ApiError('API key inválida o no proporcionada', 401));
  }
  
  next();
};
