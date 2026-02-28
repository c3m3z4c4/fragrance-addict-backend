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
            seasonUsage: extractSeasonUsage($),
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

// Extraer notas olfativas (pirámide) — extracción robusta multi-estrategia
function extractNotes($) {
    const notes = { top: [], heart: [], base: [] };

    // Helper: get clean note text from a link element
    const getNoteText = (el) => {
        const $el = $(el);
        // Note name can be in text content or in an img alt attribute
        const text = $el.clone().children('img').remove().end().text().trim();
        const alt = $el.find('img').attr('alt')?.trim() || '';
        return (text || alt).replace(/\s+/g, ' ').trim();
    };

    const dedupeNotes = (n) => ({
        top: [...new Set(n.top)],
        heart: [...new Set(n.heart)],
        base: [...new Set(n.base)],
    });

    const hasNotes = (n) => n.top.length + n.heart.length + n.base.length > 0;

    // ── Strategy 1: Walk children of #pyramid / .pyramid container ─────────
    const pyramidContainer = $('[id="pyramid"], .pyramid, [class*="pyramid"]').first();
    if (pyramidContainer.length) {
        let currentSection = null;
        pyramidContainer.find('b, strong, a[href*="/notes/"]').each((_, el) => {
            const tag = el.tagName?.toLowerCase();
            if (tag === 'b' || tag === 'strong') {
                const txt = $(el).text().trim().toLowerCase();
                if (/top\s+notes?/.test(txt)) currentSection = 'top';
                else if (/heart\s+notes?|middle\s+notes?/.test(txt)) currentSection = 'heart';
                else if (/base\s+notes?/.test(txt)) currentSection = 'base';
            } else if (tag === 'a' && currentSection) {
                const noteText = getNoteText(el);
                if (noteText && noteText.length < 80) notes[currentSection].push(noteText);
            }
        });
        if (hasNotes(notes)) return dedupeNotes(notes);
    }

    // ── Strategy 2: <b> or <strong> headers followed by sibling note links ─
    const sectionPatterns = [
        { key: 'top', re: /^top\s+notes?$/i },
        { key: 'heart', re: /^(heart|middle)\s+notes?$/i },
        { key: 'base', re: /^base\s+notes?$/i },
    ];

    $('b, strong').each((_, el) => {
        const txt = $(el).text().trim();
        for (const { key, re } of sectionPatterns) {
            if (re.test(txt)) {
                // Collect note links from next siblings until the next header
                let $next = $(el).next();
                while ($next.length && !$next.is('b, strong, h2, h3, h4')) {
                    $next.find('a[href*="/notes/"]').each((_, a) => {
                        const noteText = getNoteText(a);
                        if (noteText && noteText.length < 80) notes[key].push(noteText);
                    });
                    $next = $next.next();
                }

                // Also try the parent's next sibling (common in Fragrantica's structure)
                if (notes[key].length === 0) {
                    $(el).parent().next().find('a[href*="/notes/"]').each((_, a) => {
                        const noteText = getNoteText(a);
                        if (noteText && noteText.length < 80) notes[key].push(noteText);
                    });
                }
                break;
            }
        }
    });
    if (hasNotes(notes)) return dedupeNotes(notes);

    // ── Strategy 3: Walk ALL elements in order, track <b> section headers ──
    // This handles nested structures where notes are not direct siblings
    let currentSection = null;
    $('b, strong, a[href*="/notes/"]').each((_, el) => {
        const tag = el.tagName?.toLowerCase();
        if (tag === 'b' || tag === 'strong') {
            const txt = $(el).text().trim().toLowerCase();
            if (/top\s+notes?/.test(txt)) currentSection = 'top';
            else if (/heart\s+notes?|middle\s+notes?/.test(txt)) currentSection = 'heart';
            else if (/base\s+notes?/.test(txt)) currentSection = 'base';
        } else if (tag === 'a' && currentSection) {
            const href = $(el).attr('href') || '';
            if (href.includes('/notes/')) {
                const noteText = getNoteText(el);
                if (noteText && noteText.length < 80) notes[currentSection].push(noteText);
            }
        }
    });
    if (hasNotes(notes)) return dedupeNotes(notes);

    // ── Strategy 4: Text scan — find "Top Notes", "Heart Notes", "Base Notes"
    // as text nodes in any element, then harvest nearby note links
    const textSectionSearch = (labelText) => {
        const found = [];
        $('*').filter(function () {
            const own = $(this).clone().children().remove().end().text().trim();
            return own.toLowerCase() === labelText.toLowerCase();
        }).first().parent().find('a[href*="/notes/"]').each((_, a) => {
            const noteText = getNoteText(a);
            if (noteText && noteText.length < 80) found.push(noteText);
        });
        return found;
    };

    notes.top = textSectionSearch('Top Notes').length
        ? textSectionSearch('Top Notes')
        : textSectionSearch('Top notes');
    notes.heart = textSectionSearch('Heart Notes').length
        ? textSectionSearch('Heart Notes')
        : textSectionSearch('Middle Notes');
    notes.base = textSectionSearch('Base Notes').length
        ? textSectionSearch('Base Notes')
        : textSectionSearch('Base notes');

    if (hasNotes(notes)) return dedupeNotes(notes);

    // ── Final fallback: all /notes/ links, unclassified → put in heart ─────
    // Do NOT distribute evenly — keep them in heart to signal they exist but
    // the pyramid structure could not be parsed from this page.
    const allNotes = new Set();
    $('a[href*="/notes/"]').each((_, el) => {
        const noteText = getNoteText(el);
        if (noteText && noteText.length < 80 && !/^notes?$/i.test(noteText)) {
            allNotes.add(noteText);
        }
    });
    if (allNotes.size > 0) {
        notes.heart = [...allNotes];
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
function extractSeasonUsage($) {
    const result = { winter: 0, spring: 0, summer: 0, autumn: 0, day: 0, night: 0 };
    let found = false;

    // Fragrantica season/time keywords → internal key
    const keyMap = {
        winter: 'winter', invierno: 'winter',
        spring: 'spring', primavera: 'spring',
        summer: 'summer', verano: 'summer',
        fall: 'autumn', autumn: 'autumn', 'otoño': 'autumn', otono: 'autumn',
        day: 'day', daytime: 'day', 'día': 'day', dia: 'day',
        night: 'night', noche: 'night', evening: 'night',
    };

    const parseVotes = (str) => {
        const s = str.trim().replace(/,/g, '').toLowerCase();
        if (!s) return 0;
        if (s.endsWith('k')) return parseFloat(s) * 1000;
        const n = parseFloat(s);
        return isNaN(n) ? 0 : n;
    };

    // Strategy 1: vote-button elements with season/time in class or text
    $('[class*="vote-button"], [class*="season"], [class*="accord-season"]').each((_, el) => {
        const $el = $(el);
        const cls = ($el.attr('class') || '').toLowerCase();
        const txt = $el.text().toLowerCase();

        for (const [kw, key] of Object.entries(keyMap)) {
            if (cls.includes(kw) || txt.includes(kw)) {
                const numMatch = txt.match(/([\d]+(?:[.,]\d+)?k?)/i);
                if (numMatch) {
                    const n = parseVotes(numMatch[1]);
                    if (n > 0) { result[key] = Math.max(result[key], n); found = true; }
                }
            }
        }
    });

    // Strategy 2: look for any element whose direct text is a season keyword,
    // then find adjacent numeric text
    if (!found) {
        $('span, div, p, td, li').each((_, el) => {
            const $el = $(el);
            const own = $el.clone().children().remove().end().text().trim().toLowerCase();
            const key = keyMap[own];
            if (!key) return;

            // look for numeric value in parent or siblings
            [$el.next(), $el.prev(), $el.parent().children()].forEach($candidates => {
                $candidates.each((__, c) => {
                    const n = parseVotes($(c).text());
                    if (n > 0) { result[key] = Math.max(result[key], n); found = true; }
                });
            });
        });
    }

    if (!found) return null;

    // Convert raw counts to 0-100 scores (relative to max)
    const max = Math.max(...Object.values(result));
    if (max === 0) return null;
    const normalized = {};
    for (const [k, v] of Object.entries(result)) {
        normalized[k] = Math.round((v / max) * 100);
    }
    return normalized;
}

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
