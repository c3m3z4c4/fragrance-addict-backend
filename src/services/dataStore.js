import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

let pool = null;
let isDatabaseConnected = false;
let connectionError = null;

// Validar formato de DATABASE_URL
const validateDatabaseUrl = (url) => {
    if (!url) return { valid: false, error: 'DATABASE_URL not set' };

    try {
        // Verificar formato básico
        if (
            !url.startsWith('postgresql://') &&
            !url.startsWith('postgres://')
        ) {
            return {
                valid: false,
                error: 'URL must start with postgresql:// or postgres://',
            };
        }

        // Intentar parsear la URL
        const parsed = new URL(url);

        if (!parsed.hostname) {
            return { valid: false, error: 'Missing hostname in DATABASE_URL' };
        }

        console.log('📊 Database URL parsed:');
        console.log('   Host:', parsed.hostname);
        console.log('   Port:', parsed.port || '5432');
        console.log('   Database:', parsed.pathname.slice(1));
        console.log('   User:', parsed.username);
        console.log('   Password:', parsed.password ? '***' : '(empty)');

        return { valid: true };
    } catch (error) {
        return { valid: false, error: `Invalid URL format: ${error.message}` };
    }
};

// Crear pool de conexiones
const createPool = () => {
    console.log('🔧 Creating database pool...');
    console.log('📍 DATABASE_URL exists:', !!process.env.DATABASE_URL);

    const validation = validateDatabaseUrl(process.env.DATABASE_URL);
    if (!validation.valid) {
        console.error('❌ DATABASE_URL validation failed:', validation.error);
        connectionError = validation.error;
        return null;
    }

    try {
        const poolConfig = {
            connectionString: process.env.DATABASE_URL,
            ssl: false, // Dokploy internal network doesn't need SSL
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        };

        console.log('🔌 Pool config:', {
            ...poolConfig,
            connectionString: '***',
        });
        return new Pool(poolConfig);
    } catch (error) {
        console.error('❌ Error creating pool:', error.message);
        connectionError = error.message;
        return null;
    }
};

// Inicializar tabla si no existe
export const initDatabase = async () => {
    console.log('🚀 Initializing database...');
    console.log('🌍 NODE_ENV:', process.env.NODE_ENV || 'development');

    pool = createPool();

    if (!pool) {
        console.warn('⚠️ No database pool available - using in-memory storage');
        isDatabaseConnected = false;
        return { connected: false, error: connectionError };
    }

    // Primero probar conexión simple
    console.log('🔍 Testing database connection...');
    try {
        const testResult = await pool.query(
            'SELECT NOW() as time, current_database() as db'
        );
        console.log('✅ Database connection successful!');
        console.log('   Server time:', testResult.rows[0].time);
        console.log('   Database:', testResult.rows[0].db);
    } catch (error) {
        console.error('❌ Database connection test failed:', error.message);
        console.error('   Error code:', error.code);
        connectionError = `Connection test failed: ${error.message}`;
        isDatabaseConnected = false;
        pool = null;
        return { connected: false, error: connectionError };
    }

    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS perfumes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      brand VARCHAR(255) NOT NULL,
      year INTEGER,
      perfumer TEXT,
      gender VARCHAR(50),
      concentration VARCHAR(100),
      notes JSONB DEFAULT '{"top": [], "heart": [], "base": []}',
      accords JSONB DEFAULT '[]',
      description TEXT,
      image_url TEXT,
      rating DECIMAL(3,2),
      source_url TEXT,
      scraped_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_perfumes_brand ON perfumes(brand);
    CREATE INDEX IF NOT EXISTS idx_perfumes_gender ON perfumes(gender);
    CREATE INDEX IF NOT EXISTS idx_perfumes_name ON perfumes(name);
  `;

    try {
        await pool.query(createTableQuery);
        isDatabaseConnected = true;
        connectionError = null;
        console.log('✅ Database tables initialized successfully');
        return { connected: true, error: null };
    } catch (error) {
        console.error('❌ Error creating tables:', error.message);
        connectionError = `Table creation failed: ${error.message}`;
        isDatabaseConnected = false;
        console.warn(
            '⚠️ Continuing without database - using in-memory storage'
        );
        return { connected: false, error: connectionError };
    }
};

// Obtener error de conexión
export const getConnectionError = () => connectionError;

// In-memory fallback storage
let memoryStore = [];

// Convertir snake_case a camelCase
const toCamelCase = (row) => {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        brand: row.brand,
        year: row.year,
        perfumer: row.perfumer,
        gender: row.gender,
        concentration: row.concentration,
        notes: row.notes,
        accords: row.accords,
        description: row.description,
        imageUrl: row.image_url,
        rating: row.rating ? parseFloat(row.rating) : null,
        sourceUrl: row.source_url,
        scrapedAt: row.scraped_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
};

export const dataStore = {
    // Estado de conexión
    isConnected: () => isDatabaseConnected,

    // Obtener todos los perfumes con paginación
    getAll: async ({
        page = 1,
        limit = 12,
        brand,
        gender,
        search,
        sortBy = 'createdAt',
    }) => {
        if (!isDatabaseConnected) {
            // Fallback a memoria
            let filtered = [...memoryStore];
            if (brand)
                filtered = filtered.filter((p) =>
                    p.brand?.toLowerCase().includes(brand.toLowerCase())
                );
            if (gender) filtered = filtered.filter((p) => p.gender === gender);
            if (search)
                filtered = filtered.filter(
                    (p) =>
                        p.name?.toLowerCase().includes(search.toLowerCase()) ||
                        p.brand?.toLowerCase().includes(search.toLowerCase())
                );
            const total = filtered.length;
            const offset = (page - 1) * limit;
            return {
                data: filtered.slice(offset, offset + limit),
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            };
        }

        let query = 'SELECT * FROM perfumes WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        if (brand) {
            query += ` AND LOWER(brand) LIKE LOWER($${paramIndex})`;
            params.push(`%${brand}%`);
            paramIndex++;
        }

        if (gender) {
            query += ` AND gender = $${paramIndex}`;
            params.push(gender);
            paramIndex++;
        }

        if (search) {
            query += ` AND (LOWER(name) LIKE LOWER($${paramIndex}) OR LOWER(brand) LIKE LOWER($${paramIndex}) OR LOWER(description) LIKE LOWER($${paramIndex}))`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*)');
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        const orderMap = {
            name: 'name ASC',
            rating: 'rating DESC NULLS LAST',
            year: 'year DESC NULLS LAST',
            createdAt: 'created_at DESC',
        };
        query += ` ORDER BY ${orderMap[sortBy] || 'created_at DESC'}`;

        const offset = (page - 1) * limit;
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        return {
            data: result.rows.map(toCamelCase),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    },

    // Get all source URLs (for duplicate checking)
    getAllSourceUrls: async () => {
        if (!isDatabaseConnected) {
            return memoryStore.map((p) => p.sourceUrl).filter(Boolean);
        }
        const result = await pool.query(
            'SELECT source_url FROM perfumes WHERE source_url IS NOT NULL'
        );
        return result.rows.map((row) => row.source_url);
    },

    // Obtener por ID
    getById: async (id) => {
        if (!isDatabaseConnected) {
            return memoryStore.find((p) => p.id === id) || null;
        }
        const result = await pool.query(
            'SELECT * FROM perfumes WHERE id = $1',
            [id]
        );
        return toCamelCase(result.rows[0]);
    },

    // Buscar por marca
    getByBrand: async (brand) => {
        if (!isDatabaseConnected) {
            return memoryStore.filter(
                (p) => p.brand?.toLowerCase() === brand.toLowerCase()
            );
        }
        const result = await pool.query(
            'SELECT * FROM perfumes WHERE LOWER(brand) = LOWER($1) ORDER BY name',
            [brand]
        );
        return result.rows.map(toCamelCase);
    },

    // Obtener todas las marcas
    getBrands: async () => {
        if (!isDatabaseConnected) {
            return [
                ...new Set(memoryStore.map((p) => p.brand).filter(Boolean)),
            ].sort();
        }
        const result = await pool.query(
            'SELECT DISTINCT brand FROM perfumes WHERE brand IS NOT NULL ORDER BY brand'
        );
        return result.rows.map((row) => row.brand);
    },

    // Agregar perfume
    add: async (perfume) => {
        const id = perfume.id || uuidv4();
        const now = new Date().toISOString();

        if (!isDatabaseConnected) {
            const newPerfume = {
                ...perfume,
                id,
                createdAt: now,
                updatedAt: now,
            };
            memoryStore.push(newPerfume);
            return newPerfume;
        }

        const query = `
      INSERT INTO perfumes (id, name, brand, year, perfumer, gender, concentration, notes, accords, description, image_url, rating, source_url, scraped_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;
        const values = [
            id,
            perfume.name,
            perfume.brand,
            perfume.year || null,
            perfume.perfumer || null,
            perfume.gender || null,
            perfume.concentration || null,
            JSON.stringify(perfume.notes || { top: [], heart: [], base: [] }),
            JSON.stringify(perfume.accords || []),
            perfume.description || null,
            perfume.imageUrl || null,
            perfume.rating || null,
            perfume.sourceUrl || null,
            perfume.scrapedAt || null,
        ];

        const result = await pool.query(query, values);
        return toCamelCase(result.rows[0]);
    },

    // Actualizar perfume
    update: async (id, data) => {
        if (!isDatabaseConnected) {
            const index = memoryStore.findIndex((p) => p.id === id);
            if (index === -1) return null;
            memoryStore[index] = {
                ...memoryStore[index],
                ...data,
                updatedAt: new Date().toISOString(),
            };
            return memoryStore[index];
        }

        const fields = [];
        const values = [];
        let paramIndex = 1;

        const fieldMap = {
            name: 'name',
            brand: 'brand',
            year: 'year',
            perfumer: 'perfumer',
            gender: 'gender',
            concentration: 'concentration',
            notes: 'notes',
            accords: 'accords',
            description: 'description',
            imageUrl: 'image_url',
            rating: 'rating',
            sourceUrl: 'source_url',
            scrapedAt: 'scraped_at',
        };

        for (const [key, column] of Object.entries(fieldMap)) {
            if (data[key] !== undefined) {
                fields.push(`${column} = $${paramIndex}`);
                values.push(
                    key === 'notes' || key === 'accords'
                        ? JSON.stringify(data[key])
                        : data[key]
                );
                paramIndex++;
            }
        }

        if (fields.length === 0) return null;

        fields.push(`updated_at = NOW()`);
        values.push(id);

        const query = `UPDATE perfumes SET ${fields.join(
            ', '
        )} WHERE id = $${paramIndex} RETURNING *`;
        const result = await pool.query(query, values);

        return result.rows[0] ? toCamelCase(result.rows[0]) : null;
    },

    // Eliminar perfume
    delete: async (id) => {
        if (!isDatabaseConnected) {
            const index = memoryStore.findIndex((p) => p.id === id);
            if (index === -1) return false;
            memoryStore.splice(index, 1);
            return true;
        }
        const result = await pool.query(
            'DELETE FROM perfumes WHERE id = $1 RETURNING id',
            [id]
        );
        return result.rowCount > 0;
    },

    // Estadísticas
    getStats: async () => {
        if (!isDatabaseConnected) {
            return {
                totalPerfumes: memoryStore.length,
                totalBrands: [...new Set(memoryStore.map((p) => p.brand))]
                    .length,
                byGender: {
                    masculine: memoryStore.filter(
                        (p) => p.gender === 'masculine'
                    ).length,
                    feminine: memoryStore.filter((p) => p.gender === 'feminine')
                        .length,
                    unisex: memoryStore.filter((p) => p.gender === 'unisex')
                        .length,
                },
                databaseConnected: false,
            };
        }

        const statsQuery = `
      SELECT 
        COUNT(*) as total_perfumes,
        COUNT(DISTINCT brand) as total_brands,
        COUNT(*) FILTER (WHERE gender = 'masculine') as masculine,
        COUNT(*) FILTER (WHERE gender = 'feminine') as feminine,
        COUNT(*) FILTER (WHERE gender = 'unisex') as unisex
      FROM perfumes
    `;
        const result = await pool.query(statsQuery);
        const row = result.rows[0];

        return {
            totalPerfumes: parseInt(row.total_perfumes),
            totalBrands: parseInt(row.total_brands),
            byGender: {
                masculine: parseInt(row.masculine),
                feminine: parseInt(row.feminine),
                unisex: parseInt(row.unisex),
            },
            databaseConnected: true,
        };
    },
};
