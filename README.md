# Perfume Catalog API

API REST para catálogo de perfumes con web scraping.

## Despliegue con Dokploy

### 1. Crear repositorio Git
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <tu-repo>
git push -u origin main
```

### 2. En Dokploy

1. **Crear nueva aplicación**
   - Ir a "Applications" → "Create Application"
   - Seleccionar "Docker" o "Git"

2. **Configurar repositorio**
   - Conectar tu repositorio de GitHub/GitLab
   - Branch: `main`
   - Dockerfile path: `./Dockerfile`

3. **Variables de entorno**
   - Ir a "Environment Variables"
   - Agregar:
     ```
     PORT=3000
     API_KEY=tu-clave-secreta-muy-larga
     ALLOWED_ORIGINS=https://tu-frontend.com
     SCRAPE_DELAY_MS=3000
     ```

4. **Configurar dominio**
   - Ir a "Domains"
   - Agregar: `api.tudominio.com`
   - Habilitar SSL automático

5. **Deploy**
   - Click en "Deploy"
   - Dokploy construirá y desplegará automáticamente

### 3. Base de datos (opcional)

Para persistencia real, crear PostgreSQL en Dokploy:
1. Ir a "Databases" → "Create Database" → PostgreSQL
2. Copiar connection string
3. Agregar `DATABASE_URL` a las variables de entorno

## Endpoints

### Públicos
- `GET /health` - Estado del servidor
- `GET /api/perfumes` - Lista de perfumes (paginado)
- `GET /api/perfumes/:id` - Detalle de perfume
- `GET /api/perfumes/search?q=query` - Búsqueda
- `GET /api/perfumes/brand/:brand` - Por marca
- `GET /api/perfumes/brands` - Lista de marcas
- `GET /api/perfumes/stats` - Estadísticas

### Protegidos (requieren header `x-api-key`)
- `GET /api/scrape/perfume?url=...&save=true` - Scrapear URL
- `POST /api/scrape/batch` - Scrapear múltiples URLs
- `GET /api/scrape/cache/stats` - Stats del caché
- `DELETE /api/scrape/cache` - Limpiar caché

### Admin
- `POST /api/perfumes` - Crear perfume
- `PUT /api/perfumes/:id` - Actualizar
- `DELETE /api/perfumes/:id` - Eliminar

## Ejemplo de uso del scraper

```bash
# Scrapear y guardar
curl -X GET "https://api.tudominio.com/api/scrape/perfume?url=https://sitio.com/perfume&save=true" \
  -H "x-api-key: tu-clave-secreta"

# Batch scraping
curl -X POST "https://api.tudominio.com/api/scrape/batch" \
  -H "x-api-key: tu-clave-secreta" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://sitio.com/perfume1", "https://sitio.com/perfume2"], "save": true}'
```

## Personalizar el scraper

El archivo `src/services/scrapingService.js` contiene selectores genéricos.
Debes adaptarlos según el sitio web objetivo:

```javascript
// Ejemplo para Fragrantica
const selectors = {
  name: 'h1[itemprop="name"]',
  brand: 'span[itemprop="name"] a',
  notes: '.notes-box .cell'
};
```

## Desarrollo local

```bash
# Instalar dependencias
npm install

# Copiar variables de entorno
cp .env.example .env

# Editar .env con tus valores

# Iniciar servidor
npm run dev
```

El servidor estará en `http://localhost:3000`
