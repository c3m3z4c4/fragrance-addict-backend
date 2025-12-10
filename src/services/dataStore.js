import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

// Conexión a PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
});

// Inicializar tabla si no existe
export const initDatabase = async () => {
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
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing database:', error.message);
        throw error;
    }
};

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
    // Obtener todos los perfumes con paginación
    getAll: async ({
        page = 1,
        limit = 12,
        brand,
        gender,
        search,
        sortBy = 'createdAt',
    }) => {
        let query = 'SELECT * FROM perfumes WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        // Filtrar por marca
        if (brand) {
            query += ` AND LOWER(brand) LIKE LOWER($${paramIndex})`;
            params.push(`%${brand}%`);
            paramIndex++;
        }

        // Filtrar por género
        if (gender) {
            query += ` AND gender = $${paramIndex}`;
            params.push(gender);
            paramIndex++;
        }

        // Búsqueda por texto
        if (search) {
            query += ` AND (LOWER(name) LIKE LOWER($${paramIndex}) OR LOWER(brand) LIKE LOWER($${paramIndex}) OR LOWER(description) LIKE LOWER($${paramIndex}))`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        // Contar total
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*)');
        const countResult = await pool.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        // Ordenar
        const orderMap = {
            name: 'name ASC',
            rating: 'rating DESC NULLS LAST',
            year: 'year DESC NULLS LAST',
            createdAt: 'created_at DESC',
        };
        query += ` ORDER BY ${orderMap[sortBy] || 'created_at DESC'}`;

        // Paginar
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

    // Obtener por ID
    getById: async (id) => {
        const result = await pool.query(
            'SELECT * FROM perfumes WHERE id = $1',
            [id]
        );
        return toCamelCase(result.rows[0]);
    },

    // Buscar por marca
    getByBrand: async (brand) => {
        const result = await pool.query(
            'SELECT * FROM perfumes WHERE LOWER(brand) = LOWER($1) ORDER BY name',
            [brand]
        );
        return result.rows.map(toCamelCase);
    },

    // Obtener todas las marcas
    getBrands: async () => {
        const result = await pool.query(
            'SELECT DISTINCT brand FROM perfumes WHERE brand IS NOT NULL ORDER BY brand'
        );
        return result.rows.map((row) => row.brand);
    },

    // Agregar perfume
    add: async (perfume) => {
        const id = perfume.id || uuidv4();
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
        const result = await pool.query(
            'DELETE FROM perfumes WHERE id = $1 RETURNING id',
            [id]
        );
        return result.rowCount > 0;
    },

    // Estadísticas
    getStats: async () => {
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
        };
    },
};
