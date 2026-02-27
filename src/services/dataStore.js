import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';

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
      sillage JSONB,
      longevity JSONB,
      projection VARCHAR(50),
      similar_perfumes JSONB DEFAULT '[]',
      source_url TEXT,
      scraped_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_perfumes_brand ON perfumes(brand);
    CREATE INDEX IF NOT EXISTS idx_perfumes_gender ON perfumes(gender);
    CREATE INDEX IF NOT EXISTS idx_perfumes_name ON perfumes(name);
    
    -- Add new columns if they don't exist (for existing tables)
    DO $$ 
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfumes' AND column_name='sillage') THEN
        ALTER TABLE perfumes ADD COLUMN sillage JSONB;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfumes' AND column_name='longevity') THEN
        ALTER TABLE perfumes ADD COLUMN longevity JSONB;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfumes' AND column_name='projection') THEN
        ALTER TABLE perfumes ADD COLUMN projection VARCHAR(50);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='perfumes' AND column_name='similar_perfumes') THEN
        ALTER TABLE perfumes ADD COLUMN similar_perfumes JSONB DEFAULT '[]';
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      device_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      created_by VARCHAR(255),
      metadata JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
    CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);
    CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys(created_by);

    -- ===== USERS TABLE =====
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      avatar_url TEXT,
      role VARCHAR(50) NOT NULL DEFAULT 'USER',
      provider VARCHAR(50) NOT NULL DEFAULT 'local',
      password_hash VARCHAR(255),
      google_id VARCHAR(255) UNIQUE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    -- ===== FAVORITES TABLE =====
    CREATE TABLE IF NOT EXISTS favorites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      perfume_id UUID NOT NULL REFERENCES perfumes(id) ON DELETE CASCADE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE(user_id, perfume_id)
    );

    CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_favorites_perfume_id ON favorites(perfume_id);
  `;

    try {
        await pool.query(createTableQuery);
        isDatabaseConnected = true;
        connectionError = null;
        console.log('✅ Database tables initialized successfully');

        // Seed superadmin from environment variables
        await seedSuperAdmin();

        return { connected: true, error: null };
    } catch (error) {
        console.error('❌ Error creating tables:', error.message);
        connectionError = `Table creation failed: ${error.message}`;
        isDatabaseConnected = false;
        console.warn('⚠️ Continuing without database - using in-memory storage');
        return { connected: false, error: connectionError };
    }
};

// Seed the initial superadmin user from env vars
const seedSuperAdmin = async () => {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
        console.log('ℹ️ ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping superadmin seed');
        return;
    }

    try {
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [adminEmail]
        );
        if (existing.rows.length > 0) {
            // Ensure role is SUPERADMIN
            await pool.query(
                "UPDATE users SET role = 'SUPERADMIN' WHERE email = $1",
                [adminEmail]
            );
            console.log(`ℹ️ Superadmin already exists: ${adminEmail}`);
            return;
        }

        const hash = await bcrypt.hash(adminPassword, 12);
        await pool.query(
            `INSERT INTO users (email, name, role, provider, password_hash)
             VALUES ($1, $2, 'SUPERADMIN', 'local', $3)`,
            [adminEmail, 'Superadmin', hash]
        );
        console.log(`✅ Superadmin seeded: ${adminEmail}`);
    } catch (err) {
        console.error('❌ Error seeding superadmin:', err.message);
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
        sillage: row.sillage,
        longevity: row.longevity,
        projection: row.projection,
        similarPerfumes: row.similar_perfumes || [],
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

    // Obtener todas las marcas con imagen representativa y conteo
    getBrands: async () => {
        if (!isDatabaseConnected) {
            const brandNames = [...new Set(memoryStore.map((p) => p.brand).filter(Boolean))].sort();
            return brandNames.map((name) => {
                const brandPerfumes = memoryStore.filter((p) => p.brand === name);
                const withImage = brandPerfumes.find((p) => p.image_url);
                return { name, count: brandPerfumes.length, imageUrl: withImage?.image_url || null };
            });
        }
        const result = await pool.query(`
            SELECT
                brand AS name,
                COUNT(*) AS count,
                (SELECT image_url FROM perfumes p2 WHERE p2.brand = p.brand AND p2.image_url IS NOT NULL AND p2.image_url != '' ORDER BY p2.rating DESC NULLS LAST LIMIT 1) AS image_url
            FROM perfumes p
            WHERE brand IS NOT NULL
            GROUP BY brand
            ORDER BY brand
        `);
        return result.rows.map((row) => ({
            name: row.name,
            count: parseInt(row.count),
            imageUrl: row.image_url || null,
        }));
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
      INSERT INTO perfumes (id, name, brand, year, perfumer, gender, concentration, notes, accords, description, image_url, rating, sillage, longevity, projection, similar_perfumes, source_url, scraped_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
            JSON.stringify(perfume.sillage || null),
            JSON.stringify(perfume.longevity || null),
            perfume.projection || null,
            JSON.stringify(perfume.similarPerfumes || []),
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
            sillage: 'sillage',
            longevity: 'longevity',
            projection: 'projection',
            similarPerfumes: 'similar_perfumes',
            sourceUrl: 'source_url',
            scrapedAt: 'scraped_at',
        };

        const jsonFields = [
            'notes',
            'accords',
            'sillage',
            'longevity',
            'similarPerfumes',
        ];

        for (const [key, column] of Object.entries(fieldMap)) {
            if (data[key] !== undefined) {
                fields.push(`${column} = $${paramIndex}`);
                values.push(
                    jsonFields.includes(key)
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

    // Obtener perfumes que necesitan re-scrape (sin notas, acordes, sillage o longevity)
    getIncomplete: async ({ limit = 50 }) => {
        if (!isDatabaseConnected) {
            return memoryStore
                .filter(
                    (p) =>
                        !p.sillage || !p.longevity || !p.similarPerfumes?.length ||
                        !p.accords?.length ||
                        (!p.notes?.top?.length && !p.notes?.heart?.length && !p.notes?.base?.length)
                )
                .slice(0, limit);
        }

        const query = `
      SELECT * FROM perfumes
      WHERE (
        sillage IS NULL
        OR longevity IS NULL
        OR similar_perfumes IS NULL OR similar_perfumes = '[]'
        OR accords IS NULL OR accords = '[]'
        OR (
          (notes IS NULL OR notes = '{}')
          OR (notes->>'top' = '[]' AND notes->>'heart' = '[]' AND notes->>'base' = '[]')
        )
      )
        AND source_url IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $1
    `;
        const result = await pool.query(query, [limit]);
        return result.rows.map(toCamelCase);
    },

    // Contar perfumes incompletos
    countIncomplete: async () => {
        if (!isDatabaseConnected) {
            return memoryStore.filter(
                (p) =>
                    !p.sillage || !p.longevity || !p.similarPerfumes?.length ||
                    !p.accords?.length ||
                    (!p.notes?.top?.length && !p.notes?.heart?.length && !p.notes?.base?.length)
            ).length;
        }

        const query = `
      SELECT COUNT(*) as count FROM perfumes
      WHERE (
        sillage IS NULL
        OR longevity IS NULL
        OR similar_perfumes IS NULL OR similar_perfumes = '[]'
        OR accords IS NULL OR accords = '[]'
        OR (
          (notes IS NULL OR notes = '{}')
          OR (notes->>'top' = '[]' AND notes->>'heart' = '[]' AND notes->>'base' = '[]')
        )
      )
        AND source_url IS NOT NULL
    `;
        const result = await pool.query(query);
        return parseInt(result.rows[0].count);
    },

    // ===== API KEYS METHODS =====

    // Convertir fila de base de datos a camelCase para API keys
    apiKeyToCamelCase: (row) => {
        if (!row) return null;
        return {
            id: row.id,
            key: row.key,
            name: row.name,
            deviceName: row.device_name,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
            isActive: row.is_active,
            createdBy: row.created_by,
            metadata: row.metadata,
        };
    },

    // Agregar nueva clave API
    addApiKey: async (keyData) => {
        if (!isDatabaseConnected) {
            console.warn(
                '⚠️ Database not connected - API key operations not available'
            );
            return null;
        }

        const query = `
            INSERT INTO api_keys (key, name, device_name, created_by, metadata, is_active)
            VALUES ($1, $2, $3, $4, $5, TRUE)
            RETURNING *
        `;

        const values = [
            keyData.key,
            keyData.name,
            keyData.deviceName || null,
            keyData.createdBy || null,
            JSON.stringify(keyData.metadata || {}),
        ];

        try {
            const result = await pool.query(query, values);
            return dataStore.apiKeyToCamelCase(result.rows[0]);
        } catch (error) {
            console.error('❌ Error adding API key:', error.message);
            return null;
        }
    },

    // Obtener clave API por su valor
    getApiKeyByKey: async (key) => {
        if (!isDatabaseConnected) {
            console.warn(
                '⚠️ Database not connected - API key operations not available'
            );
            return null;
        }

        const query = `
            SELECT * FROM api_keys 
            WHERE key = $1 AND is_active = TRUE
            LIMIT 1
        `;

        try {
            const result = await pool.query(query, [key]);
            return result.rows.length > 0
                ? dataStore.apiKeyToCamelCase(result.rows[0])
                : null;
        } catch (error) {
            console.error('❌ Error getting API key:', error.message);
            return null;
        }
    },

    // Actualizar último uso de clave API
    updateApiKeyLastUsed: async (keyId) => {
        if (!isDatabaseConnected) return false;

        const query = `
            UPDATE api_keys 
            SET last_used_at = NOW()
            WHERE id = $1
            RETURNING *
        `;

        try {
            const result = await pool.query(query, [keyId]);
            return result.rowCount > 0;
        } catch (error) {
            console.error(
                '❌ Error updating API key last used:',
                error.message
            );
            return false;
        }
    },

    // Obtener todas las claves API (admin)
    getAllApiKeys: async () => {
        if (!isDatabaseConnected) {
            console.warn(
                '⚠️ Database not connected - API key operations not available'
            );
            return [];
        }

        const query = `
            SELECT * FROM api_keys 
            ORDER BY created_at DESC
        `;

        try {
            const result = await pool.query(query);
            return result.rows.map(dataStore.apiKeyToCamelCase);
        } catch (error) {
            console.error('❌ Error getting all API keys:', error.message);
            return [];
        }
    },

    // Obtener claves API de un usuario específico
    getApiKeysByUser: async (createdBy) => {
        if (!isDatabaseConnected) {
            console.warn(
                '⚠️ Database not connected - API key operations not available'
            );
            return [];
        }

        const query = `
            SELECT * FROM api_keys 
            WHERE created_by = $1
            ORDER BY created_at DESC
        `;

        try {
            const result = await pool.query(query, [createdBy]);
            return result.rows.map(dataStore.apiKeyToCamelCase);
        } catch (error) {
            console.error('❌ Error getting user API keys:', error.message);
            return [];
        }
    },

    // Desactivar clave API
    deactivateApiKey: async (keyId) => {
        if (!isDatabaseConnected) return false;

        const query = `
            UPDATE api_keys 
            SET is_active = FALSE
            WHERE id = $1
            RETURNING *
        `;

        try {
            const result = await pool.query(query, [keyId]);
            return result.rowCount > 0;
        } catch (error) {
            console.error('❌ Error deactivating API key:', error.message);
            return false;
        }
    },

    // Eliminar clave API
    deleteApiKey: async (keyId) => {
        if (!isDatabaseConnected) return false;

        const query = `
            DELETE FROM api_keys 
            WHERE id = $1
        `;

        try {
            const result = await pool.query(query, [keyId]);
            return result.rowCount > 0;
        } catch (error) {
            console.error('❌ Error deleting API key:', error.message);
            return false;
        }
    },

    // Obtener estadísticas de claves API
    getApiKeyStats: async () => {
        if (!isDatabaseConnected) {
            return { total: 0, active: 0, inactive: 0, databaseConnected: false };
        }
        const query = `
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE is_active = TRUE) as active,
                COUNT(*) FILTER (WHERE is_active = FALSE) as inactive
            FROM api_keys
        `;
        try {
            const result = await pool.query(query);
            const row = result.rows[0];
            return {
                total: parseInt(row.total),
                active: parseInt(row.active),
                inactive: parseInt(row.inactive),
                databaseConnected: true,
            };
        } catch (error) {
            console.error('❌ Error getting API key stats:', error.message);
            return { total: 0, active: 0, inactive: 0, databaseConnected: false };
        }
    },

    // ===== USER METHODS =====

    getUserByEmail: async (email) => {
        if (!isDatabaseConnected) return null;
        try {
            const result = await pool.query(
                'SELECT * FROM users WHERE email = $1 AND is_active = TRUE LIMIT 1',
                [email]
            );
            return result.rows[0] || null;
        } catch (err) {
            console.error('❌ getUserByEmail:', err.message);
            return null;
        }
    },

    getUserById: async (id) => {
        if (!isDatabaseConnected) return null;
        try {
            const result = await pool.query(
                'SELECT * FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1',
                [id]
            );
            return result.rows[0] || null;
        } catch (err) {
            console.error('❌ getUserById:', err.message);
            return null;
        }
    },

    getUserByGoogleId: async (googleId) => {
        if (!isDatabaseConnected) return null;
        try {
            const result = await pool.query(
                'SELECT * FROM users WHERE google_id = $1 AND is_active = TRUE LIMIT 1',
                [googleId]
            );
            return result.rows[0] || null;
        } catch (err) {
            console.error('❌ getUserByGoogleId:', err.message);
            return null;
        }
    },

    createUser: async ({ email, name, avatarUrl, role = 'USER', provider = 'google', passwordHash = null, googleId = null }) => {
        if (!isDatabaseConnected) return null;
        try {
            const result = await pool.query(
                `INSERT INTO users (email, name, avatar_url, role, provider, password_hash, google_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING *`,
                [email, name, avatarUrl || null, role, provider, passwordHash, googleId]
            );
            return result.rows[0];
        } catch (err) {
            console.error('❌ createUser:', err.message);
            return null;
        }
    },

    updateUser: async (id, fields) => {
        if (!isDatabaseConnected) return null;
        const allowed = ['name', 'avatar_url', 'google_id', 'role', 'is_active'];
        const setClauses = [];
        const values = [];
        let idx = 1;
        for (const [key, val] of Object.entries(fields)) {
            if (allowed.includes(key)) {
                setClauses.push(`${key} = $${idx++}`);
                values.push(val);
            }
        }
        if (setClauses.length === 0) return null;
        setClauses.push(`updated_at = NOW()`);
        values.push(id);
        try {
            const result = await pool.query(
                `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
                values
            );
            return result.rows[0] || null;
        } catch (err) {
            console.error('❌ updateUser:', err.message);
            return null;
        }
    },

    updateUserRole: async (userId, role) => {
        if (!isDatabaseConnected) return null;
        try {
            const result = await pool.query(
                "UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
                [role, userId]
            );
            return result.rows[0] || null;
        } catch (err) {
            console.error('❌ updateUserRole:', err.message);
            return null;
        }
    },

    getAllUsers: async () => {
        if (!isDatabaseConnected) return [];
        try {
            const result = await pool.query(
                'SELECT id, email, name, avatar_url, role, provider, is_active, created_at FROM users ORDER BY created_at DESC'
            );
            return result.rows;
        } catch (err) {
            console.error('❌ getAllUsers:', err.message);
            return [];
        }
    },

    // ===== FAVORITES METHODS =====

    getUserFavorites: async (userId) => {
        if (!isDatabaseConnected) return [];
        try {
            const result = await pool.query(
                `SELECT p.*, f.created_at as favorited_at
                 FROM favorites f
                 JOIN perfumes p ON f.perfume_id = p.id
                 WHERE f.user_id = $1
                 ORDER BY f.created_at DESC`,
                [userId]
            );
            return result.rows.map(toCamelCase);
        } catch (err) {
            console.error('❌ getUserFavorites:', err.message);
            return [];
        }
    },

    addFavorite: async (userId, perfumeId) => {
        if (!isDatabaseConnected) return null;
        try {
            const result = await pool.query(
                `INSERT INTO favorites (user_id, perfume_id)
                 VALUES ($1, $2)
                 ON CONFLICT (user_id, perfume_id) DO NOTHING
                 RETURNING *`,
                [userId, perfumeId]
            );
            return result.rows[0] || null;
        } catch (err) {
            console.error('❌ addFavorite:', err.message);
            return null;
        }
    },

    removeFavorite: async (userId, perfumeId) => {
        if (!isDatabaseConnected) return false;
        try {
            const result = await pool.query(
                'DELETE FROM favorites WHERE user_id = $1 AND perfume_id = $2',
                [userId, perfumeId]
            );
            return result.rowCount > 0;
        } catch (err) {
            console.error('❌ removeFavorite:', err.message);
            return false;
        }
    },

    isFavorite: async (userId, perfumeId) => {
        if (!isDatabaseConnected) return false;
        try {
            const result = await pool.query(
                'SELECT 1 FROM favorites WHERE user_id = $1 AND perfume_id = $2',
                [userId, perfumeId]
            );
            return result.rows.length > 0;
        } catch (err) {
            return false;
        }
    },
};
