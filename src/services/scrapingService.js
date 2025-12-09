import axios from 'axios';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';
import { cacheService } from './cacheService.js';

const SCRAPE_DELAY = parseInt(process.env.SCRAPE_DELAY_MS) || 3000;

// Delay entre requests
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Headers para evitar bloqueos
const getHeaders = () => ({
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
});

// Scraper optimizado para Fragrantica.com
export const scrapePerfume = async (url) => {
    // Verificar caché
    const cached = cacheService.get(url);
    if (cached) {
        console.log(`📦 Cache hit: ${url}`);
        return cached;
    }

    console.log(`🔍 Scraping: ${url}`);

    try {
        await delay(SCRAPE_DELAY);

        const response = await axios.get(url, {
            headers: getHeaders(),
            timeout: 15000,
        });

        const $ = cheerio.load(response.data);

        // Extraer datos usando selectores de Fragrantica
        const perfume = {
            id: uuidv4(),
            name: extractName($),
            brand: extractBrand($),
            year: extractYear($),
            perfumer: extractPerfumer($),
            gender: extractGender($),
            concentration: extractConcentration($),
            notes: extractNotes($),
            accords: extractAccords($),
            description: extractDescription($),
            imageUrl: extractImage($),
            rating: extractRating($),
            sourceUrl: url,
            scrapedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        // Guardar en caché
        cacheService.set(url, perfume, 86400); // 24 horas

        return perfume;
    } catch (error) {
        console.error(`❌ Error scraping ${url}:`, error.message);
        throw new Error(`Error al scrapear: ${error.message}`);
    }
};

// Extraer nombre del perfume
// Formato en Fragrantica: "Sauvage Dior for men" -> extraemos solo el nombre
function extractName($) {
    const h1Text = $('h1[itemprop="name"]').text().trim();
    if (h1Text) {
        // Remover el género (for men, for women) y la marca
        const cleanName = h1Text
            .replace(/\s+for\s+(men|women)\s*$/i, '')
            .trim();

        // La marca está al final, separar nombre de marca
        const brand =
            $('span[itemprop="name"]').first().text().trim() ||
            $('p[itemprop="brand"] span[itemprop="name"]').text().trim();

        if (brand && cleanName.endsWith(brand)) {
            return cleanName.slice(0, -brand.length).trim();
        }
        return cleanName;
    }
    return null;
}

// Extraer marca
function extractBrand($) {
    // Selector principal de Fragrantica
    const brand =
        $('p[itemprop="brand"] span[itemprop="name"]').text().trim() ||
        $('span[itemprop="name"]').first().text().trim() ||
        $('[itemprop="brand"] [itemprop="name"]').text().trim();

    if (brand) return brand;

    // Fallback: extraer del enlace del diseñador
    const designerLink = $('a[href*="/designers/"]').first();
    if (designerLink.length) {
        return designerLink.text().trim();
    }

    return null;
}

// Extraer año de lanzamiento
function extractYear($) {
    const bodyText = $('body').text();

    // Buscar patrones comunes en Fragrantica
    const patterns = [
        /launched\s+in\s+(\d{4})/i,
        /was\s+launched\s+in\s+(\d{4})/i,
        /from\s+(\d{4})/i,
        /\((\d{4})\)/,
    ];

    for (const pattern of patterns) {
        const match = bodyText.match(pattern);
        if (match) {
            const year = parseInt(match[1]);
            if (year >= 1900 && year <= new Date().getFullYear()) {
                return year;
            }
        }
    }

    return null;
}

// Extraer perfumista/nariz
function extractPerfumer($) {
    // En Fragrantica, los perfumistas aparecen en enlaces específicos
    const perfumerLink = $('a[href*="/noses/"]');
    if (perfumerLink.length) {
        const perfumers = [];
        perfumerLink.each((_, el) => {
            const name = $(el).text().trim();
            if (name && !perfumers.includes(name)) {
                perfumers.push(name);
            }
        });
        return perfumers.length > 0 ? perfumers.join(', ') : null;
    }

    // Fallback: buscar texto con "created by" o "nose"
    const text = $('body').text();
    const creatorMatch = text.match(
        /(?:created\s+by|nose[s]?:?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i
    );
    if (creatorMatch) {
        return creatorMatch[1].trim();
    }

    return null;
}

// Extraer género
function extractGender($) {
    const h1Text = $('h1[itemprop="name"]').text().toLowerCase();

    if (h1Text.includes('for women') || h1Text.includes('pour femme')) {
        return 'feminine';
    }
    if (h1Text.includes('for men') || h1Text.includes('pour homme')) {
        return 'masculine';
    }
    if (h1Text.includes('unisex') || h1Text.includes('for women and men')) {
        return 'unisex';
    }

    // Buscar en el cuerpo del texto
    const bodyText = $('body').text().toLowerCase();
    if (bodyText.includes('for women and men') || bodyText.includes('unisex')) {
        return 'unisex';
    }
    if (bodyText.includes('for women')) {
        return 'feminine';
    }
    if (bodyText.includes('for men')) {
        return 'masculine';
    }

    return 'unisex';
}

// Extraer concentración
function extractConcentration($) {
    const h1Text = $('h1').text();
    const bodyText = $('body').text();
    const fullText = (h1Text + ' ' + bodyText).toLowerCase();

    const concentrations = [
        {
            pattern: /\bextrait\b|\bextract\b|\bparfum\b/i,
            value: 'Extrait de Parfum',
        },
        { pattern: /\beau\s+de\s+parfum\b|\bedp\b/i, value: 'Eau de Parfum' },
        {
            pattern: /\beau\s+de\s+toilette\b|\bedt\b/i,
            value: 'Eau de Toilette',
        },
        { pattern: /\beau\s+de\s+cologne\b|\bedc\b/i, value: 'Eau de Cologne' },
        { pattern: /\beau\s+fraiche\b/i, value: 'Eau Fraiche' },
        { pattern: /\bparfum\b/i, value: 'Parfum' },
    ];

    for (const { pattern, value } of concentrations) {
        if (pattern.test(fullText)) {
            return value;
        }
    }

    return null;
}

// Extraer notas olfativas (pirámide)
function extractNotes($) {
    const notes = {
        top: [],
        heart: [],
        base: [],
    };

    // Fragrantica estructura las notas en pyramide-class
    // Las notas están en elementos con data-note o en spans dentro de divs específicos

    // Método 1: Buscar por estructura de acordes/notas
    const noteContainers = $('[id*="note"], [class*="note"]');

    // Método 2: Buscar enlaces a notas de perfume
    const topNotesSection = $(
        'b:contains("Top Notes"), b:contains("Top notes"), h4:contains("Top")'
    ).parent();
    const heartNotesSection = $(
        'b:contains("Middle Notes"), b:contains("Heart Notes"), b:contains("Heart notes"), h4:contains("Heart"), h4:contains("Middle")'
    ).parent();
    const baseNotesSection = $(
        'b:contains("Base Notes"), b:contains("Base notes"), h4:contains("Base")'
    ).parent();

    // Extraer notas de cada sección
    const extractNotesFromSection = ($section) => {
        const notesList = [];
        $section.find('a[href*="/notes/"], span').each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.length < 50 && !text.includes('Notes')) {
                notesList.push(text);
            }
        });
        return [...new Set(notesList)]; // Eliminar duplicados
    };

    if (topNotesSection.length) {
        notes.top = extractNotesFromSection(topNotesSection);
    }
    if (heartNotesSection.length) {
        notes.heart = extractNotesFromSection(heartNotesSection);
    }
    if (baseNotesSection.length) {
        notes.base = extractNotesFromSection(baseNotesSection);
    }

    // Método alternativo: buscar todos los enlaces de notas y clasificar por posición
    if (
        notes.top.length === 0 &&
        notes.heart.length === 0 &&
        notes.base.length === 0
    ) {
        const allNoteLinks = $('a[href*="/notes/"]');
        const allNotes = [];

        allNoteLinks.each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.length < 50) {
                allNotes.push(text);
            }
        });

        // Si no hay clasificación, poner todo en top
        if (allNotes.length > 0) {
            notes.top = [...new Set(allNotes)];
        }
    }

    return notes;
}

// Extraer acordes principales
function extractAccords($) {
    const accords = [];

    // Fragrantica muestra acordes en divs con clase accord-bar
    $('.accord-bar').each((_, el) => {
        const accordName = $(el).text().trim();
        const style = $(el).attr('style') || '';

        // Extraer porcentaje del width del estilo
        const widthMatch = style.match(/width:\s*([\d.]+)%/);
        const percentage = widthMatch ? parseFloat(widthMatch[1]) : 0;

        // Extraer color de fondo
        const bgMatch = style.match(
            /background:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/
        );
        const color = bgMatch
            ? `rgb(${bgMatch[1]}, ${bgMatch[2]}, ${bgMatch[3]})`
            : null;

        if (accordName) {
            accords.push({
                name: accordName,
                percentage: Math.round(percentage),
                color,
            });
        }
    });

    return accords;
}

// Extraer descripción
function extractDescription($) {
    // Fragrantica tiene la descripción en varios posibles lugares
    const selectors = [
        '[itemprop="description"]',
        '.fragrantica-blockquote',
        'div[class*="description"]',
        '.accord-text',
        'p.description',
    ];

    for (const selector of selectors) {
        const text = $(selector).first().text().trim();
        if (text && text.length > 50) {
            return text;
        }
    }

    // Buscar el párrafo más largo que parezca una descripción
    let longestP = '';
    $('p').each((_, el) => {
        const text = $(el).text().trim();
        if (
            text.length > longestP.length &&
            text.length > 100 &&
            text.length < 2000
        ) {
            // Verificar que no sea navegación o texto irrelevante
            if (
                !text.includes('Login') &&
                !text.includes('Register') &&
                !text.includes('©')
            ) {
                longestP = text;
            }
        }
    });

    return longestP || null;
}

// Extraer imagen principal
function extractImage($) {
    // Imagen principal del perfume en Fragrantica
    const imgSelectors = [
        'img[itemprop="image"]',
        'picture source[type="image/avif"]',
        'picture source[type="image/webp"]',
        'picture img',
        'img[alt*="perfume"]',
        '.perfume-image img',
    ];

    for (const selector of imgSelectors) {
        const $el = $(selector).first();
        let src = $el.attr('src') || $el.attr('srcset') || $el.attr('data-src');

        if (src) {
            // Limpiar srcset si tiene múltiples URLs
            if (src.includes(' ')) {
                src = src.split(' ')[0].split(',')[0].trim();
            }

            // Convertir a URL absoluta
            if (src.startsWith('//')) {
                return `https:${src}`;
            }
            if (src.startsWith('/')) {
                return `https://www.fragrantica.com${src}`;
            }
            if (src.startsWith('http')) {
                return src;
            }
        }
    }

    return null;
}

// Extraer rating
function extractRating($) {
    // Fragrantica muestra ratings de diferentes formas
    const ratingSelectors = [
        '[itemprop="ratingValue"]',
        '.rating-value',
        '.vote-button-legend',
        '[data-rating]',
    ];

    for (const selector of ratingSelectors) {
        const $el = $(selector).first();
        const value =
            $el.attr('content') || $el.attr('data-rating') || $el.text();
        const parsed = parseFloat(value);

        if (!isNaN(parsed)) {
            // Normalizar a escala 0-5 si está en escala 0-10
            if (parsed > 5) {
                return Math.round((parsed / 2) * 10) / 10;
            }
            return Math.round(parsed * 10) / 10;
        }
    }

    return null;
}
