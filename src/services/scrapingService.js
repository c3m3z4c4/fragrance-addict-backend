import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';
import { cacheService } from './cacheService.js';

const SCRAPE_DELAY = parseInt(process.env.SCRAPE_DELAY_MS) || 3000;

// Delay entre requests
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Configuración del navegador
const getBrowserConfig = () => ({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
    ],
});

// Scraper con Puppeteer para Fragrantica.com
export const scrapePerfume = async (url) => {
    // Verificar caché
    const cached = cacheService.get(url);
    if (cached) {
        console.log(`📦 Cache hit: ${url}`);
        return cached;
    }

    console.log(`🔍 Scraping con Puppeteer: ${url}`);

    let browser = null;

    try {
        await delay(SCRAPE_DELAY);

        browser = await puppeteer.launch(getBrowserConfig());
        const page = await browser.newPage();

        // Configurar viewport y user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        );

        // Configurar headers adicionales
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        });

        // Navegar a la página
        console.log('📄 Navegando a:', url);
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // Esperar a que cargue el contenido principal
        await page.waitForSelector('h1', { timeout: 30000 });

        // Obtener el HTML de la página
        const html = await page.content();
        const $ = cheerio.load(html);

        // Check for rate limiting or error pages
        const pageTitle = $('title').text().toLowerCase();
        const h1Text = $('h1').first().text().toLowerCase();
        const bodyText = $('body').text().toLowerCase().substring(0, 1000);

        // Detect rate limiting or error pages
        if (
            pageTitle.includes('too many requests') ||
            pageTitle.includes('429') ||
            pageTitle.includes('error') ||
            pageTitle.includes('blocked') ||
            h1Text.includes('too many requests') ||
            h1Text.includes('access denied') ||
            bodyText.includes('too many requests') ||
            bodyText.includes('rate limit') ||
            bodyText.includes('please try again later')
        ) {
            throw new Error(
                'RATE_LIMITED: Fragrantica ha bloqueado temporalmente las peticiones. Intenta más tarde.'
            );
        }

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

        console.log('✅ Datos extraídos:', {
            name: perfume.name,
            brand: perfume.brand,
            year: perfume.year,
            gender: perfume.gender,
            notesCount: {
                top: perfume.notes?.top?.length || 0,
                heart: perfume.notes?.heart?.length || 0,
                base: perfume.notes?.base?.length || 0,
            },
        });

        // Validate required fields before saving
        if (
            !perfume.name ||
            perfume.name.toLowerCase().includes('too many requests')
        ) {
            throw new Error(
                'INVALID_DATA: No se pudo extraer el nombre del perfume. La página puede estar bloqueada.'
            );
        }

        if (!perfume.brand) {
            throw new Error(
                'INVALID_DATA: No se pudo extraer la marca del perfume. La página puede estar incompleta o bloqueada.'
            );
        }

        // Guardar en caché
        cacheService.set(url, perfume, 86400); // 24 horas

        return perfume;
    } catch (error) {
        console.error(`❌ Error scraping ${url}:`, error.message);
        throw new Error(`Error al scrapear: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};

// Extraer nombre del perfume
function extractName($) {
    const h1Text = $('h1[itemprop="name"]').text().trim();
    if (h1Text) {
        // Remover el género (for men, for women) y la marca
        const cleanName = h1Text
            .replace(/\s+for\s+(men|women|women and men)\s*$/i, '')
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

    // Fallback: buscar en el título
    const title = $('title').text().trim();
    if (title) {
        const match = title.match(/^([^|]+)/);
        return match ? match[1].trim() : title;
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

    if (h1Text.includes('for women and men')) {
        return 'unisex';
    }
    if (h1Text.includes('for women') || h1Text.includes('pour femme')) {
        return 'feminine';
    }
    if (h1Text.includes('for men') || h1Text.includes('pour homme')) {
        return 'masculine';
    }
    if (h1Text.includes('unisex')) {
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
        { pattern: /\bextrait\b|\bextract\b/i, value: 'Extrait de Parfum' },
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

    // Buscar secciones de notas por texto
    const extractNotesFromSection = (sectionText) => {
        const notesList = [];
        const $section = $(`*:contains("${sectionText}")`)
            .filter(function () {
                return $(this).text().trim().startsWith(sectionText);
            })
            .first()
            .parent();

        $section.find('a[href*="/notes/"]').each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.length < 50) {
                notesList.push(text);
            }
        });

        return [...new Set(notesList)];
    };

    // Método principal: buscar por estructura de Fragrantica
    const pyramidContainer = $('.pyramid, #pyramid, [class*="pyramid"]');

    if (pyramidContainer.length) {
        // Buscar notas dentro de la pirámide
        pyramidContainer.find('a[href*="/notes/"]').each((_, el) => {
            const text = $(el).text().trim();
            const parent = $(el).closest(
                '[class*="top"], [class*="heart"], [class*="middle"], [class*="base"]'
            );

            if (text && text.length < 50) {
                const parentClass = parent.attr('class') || '';
                if (parentClass.includes('top')) {
                    notes.top.push(text);
                } else if (
                    parentClass.includes('heart') ||
                    parentClass.includes('middle')
                ) {
                    notes.heart.push(text);
                } else if (parentClass.includes('base')) {
                    notes.base.push(text);
                }
            }
        });
    }

    // Método alternativo: buscar por headers
    if (notes.top.length === 0) {
        notes.top =
            extractNotesFromSection('Top Notes') ||
            extractNotesFromSection('Top notes');
    }
    if (notes.heart.length === 0) {
        notes.heart =
            extractNotesFromSection('Heart Notes') ||
            extractNotesFromSection('Middle Notes');
    }
    if (notes.base.length === 0) {
        notes.base =
            extractNotesFromSection('Base Notes') ||
            extractNotesFromSection('Base notes');
    }

    // Fallback: obtener todas las notas sin clasificar
    if (
        notes.top.length === 0 &&
        notes.heart.length === 0 &&
        notes.base.length === 0
    ) {
        const allNotes = [];
        $('a[href*="/notes/"]').each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.length < 50 && !text.includes('Notes')) {
                allNotes.push(text);
            }
        });

        if (allNotes.length > 0) {
            const uniqueNotes = [...new Set(allNotes)];
            // Distribuir notas equitativamente si no hay clasificación
            const third = Math.ceil(uniqueNotes.length / 3);
            notes.top = uniqueNotes.slice(0, third);
            notes.heart = uniqueNotes.slice(third, third * 2);
            notes.base = uniqueNotes.slice(third * 2);
        }
    }

    return notes;
}

// Extraer acordes principales
function extractAccords($) {
    const accords = [];

    // Fragrantica muestra acordes en divs con clase accord-bar o similar
    $('.accord-bar, [class*="accord"]').each((_, el) => {
        const $el = $(el);
        const accordName = $el.text().trim();
        const style = $el.attr('style') || '';

        // Extraer porcentaje del width del estilo
        const widthMatch = style.match(/width:\s*([\d.]+)%/);
        const percentage = widthMatch ? parseFloat(widthMatch[1]) : 0;

        // Extraer color de fondo
        const bgMatch = style.match(
            /background(?:-color)?:\s*(?:rgb\((\d+),\s*(\d+),\s*(\d+)\)|#([a-fA-F0-9]{6})|#([a-fA-F0-9]{3}))/
        );
        let color = null;
        if (bgMatch) {
            if (bgMatch[1]) {
                color = `rgb(${bgMatch[1]}, ${bgMatch[2]}, ${bgMatch[3]})`;
            } else if (bgMatch[4]) {
                color = `#${bgMatch[4]}`;
            } else if (bgMatch[5]) {
                color = `#${bgMatch[5]}`;
            }
        }

        if (accordName && accordName.length < 50 && !accordName.includes('%')) {
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
        'img[src*="perfume"]',
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
