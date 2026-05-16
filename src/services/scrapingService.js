import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';
import { cacheService } from './cacheService.js';

const SCRAPE_DELAY = parseInt(process.env.SCRAPE_DELAY_MS) || 3000;

// Delay entre requests
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shared browser config — exported so routes/scraper.js can reuse it
export const BROWSER_CONFIG = {
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 60000, // CDP command timeout (Network.enable, etc.)
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
    ],
};

// Keep local alias for backward-compat within this file
const getBrowserConfig = () => BROWSER_CONFIG;

// Inject stealth scripts to evade headless browser detection (Cloudflare, etc.)
export async function addStealthScripts(page) {
    await page.evaluateOnNewDocument(() => {
        // Hide webdriver flag
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Fake plugins array
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const arr = [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }];
                arr.__proto__ = PluginArray.prototype;
                return arr;
            },
        });
        // Fake languages
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        // Fake platform
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        // Fake chrome runtime
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = {};
        // Fix permissions query for notifications
        if (navigator.permissions?.query) {
            const originalQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (params) =>
                params.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission, onchange: null })
                    : originalQuery(params);
        }
    });
}

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

        // Inject stealth scripts before any navigation
        await addStealthScripts(page);

        // Configurar viewport y user agent
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        // Configurar headers adicionales
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Upgrade-Insecure-Requests': '1',
        });

        // Navegar a la página — use domcontentloaded to avoid networkidle2 timeout
        // (Fragrantica has background analytics/polling that prevents networkidle2 from ever firing)
        console.log('📄 Navegando a:', url);
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        // Esperar a que cargue el contenido principal
        await page.waitForSelector('h1', { timeout: 15000 });

        // Give JS 2s to render dynamic content after DOM is ready
        await new Promise(r => setTimeout(r, 2000));

        // Also wait for the notes pyramid if present (it lazy-loads on some pages)
        await page.waitForSelector('#pyramid, [class*="pyramid"], a[href*="/notes/"]', { timeout: 8000 }).catch(() => {});

        // Scroll down to trigger lazy-loaded vote widgets
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await new Promise(r => setTimeout(r, 1500));
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 1000));

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
        const perfumerData = extractPerfumerData($);
        const perfume = {
            id: uuidv4(),
            name: extractName($),
            brand: extractBrand($),
            year: extractYear($),
            perfumer: perfumerData.name,
            perfumerImageUrl: perfumerData.imageUrl,
            gender: extractGender($),
            concentration: extractConcentration($),
            notes: extractNotes($),
            accords: extractAccords($),
            description: extractDescription($),
            imageUrl: extractImage($),
            rating: extractRating($),
            longevity: extractPerformanceMetric($, 'longevity'),
            sillage: extractPerformanceMetric($, 'sillage'),
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
        if (browser) await browser.close().catch(() => {});
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

// Extraer perfumista/nariz — returns { name: string|null, imageUrl: string|null }
function extractPerfumerData($) {
    const perfumerLinks = $('a[href*="/noses/"]');
    if (perfumerLinks.length) {
        const perfumers = [];
        let firstImageUrl = null;
        perfumerLinks.each((_, el) => {
            const $el = $(el);
            // Image may be inside the link or adjacent
            const img = $el.find('img').first();
            const imgSrc = img.attr('src') || img.attr('data-src') || null;
            const imgUrl = imgSrc
                ? (imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc)
                : null;
            const name = $el.clone().children('img').remove().end()
                .text().trim().replace(/^perfumers?[,:]?\s*/i, '');
            if (name && !perfumers.find(p => p === name)) {
                perfumers.push(name);
                if (!firstImageUrl && imgUrl) firstImageUrl = imgUrl;
            }
        });
        if (perfumers.length > 0) {
            return { name: perfumers.join(', '), imageUrl: firstImageUrl };
        }
    }

    // Fallback: buscar texto con "created by" o "nose"
    const text = $('body').text();
    const match = text.match(/(?:created\s+by|nose[s]?:?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i);
    if (match) return { name: match[1].trim(), imageUrl: null };

    return { name: null, imageUrl: null };
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
        // Try direct text first (excluding img alt), then img alt as fallback
        const clone = $el.clone();
        clone.find('img').remove();
        const text = clone.text().replace(/\s+/g, ' ').trim();
        const alt = $el.find('img').first().attr('alt')?.trim() || '';
        return (text || alt).replace(/\s+/g, ' ').trim();
    };

    const dedupeNotes = (n) => ({
        top: [...new Set(n.top)],
        heart: [...new Set(n.heart)],
        base: [...new Set(n.base)],
    });

    const hasNotes = (n) => n.top.length + n.heart.length + n.base.length > 0;

    // Classify a text string as a pyramid section key (English + Spanish)
    const classifyHeader = (raw) => {
        const txt = raw.toLowerCase().trim();
        if (/top\s+notes?|notas?\s+de\s+sal|salida/.test(txt)) return 'top';
        if (/heart\s+notes?|middle\s+notes?|coraz[oó]n|notas?\s+de\s+coraz/.test(txt)) return 'heart';
        if (/base\s+notes?|notas?\s+de\s+base|^base$/.test(txt)) return 'base';
        return null;
    };

    // ── Strategy 1: Walk children of #pyramid / .pyramid container ──────────
    // Handles any inline tag (<b>, <strong>, <span>, <p>, <h3>, <h4>) as header
    const pyramidContainer = $('[id="pyramid"], .pyramid, [class*="pyramid"]').first();
    if (pyramidContainer.length) {
        let currentSection = null;
        const HEADER_TAGS = new Set(['b', 'strong', 'span', 'p', 'h2', 'h3', 'h4', 'label', 'div']);
        pyramidContainer.find('*').each((_, el) => {
            const tag = el.tagName?.toLowerCase();
            if (!tag) return;

            if (HEADER_TAGS.has(tag)) {
                // Only use elements whose own text (not children) is the header label
                const ownText = $(el).clone().children().remove().end().text().trim();
                const key = classifyHeader(ownText);
                if (key) { currentSection = key; return; }
            }

            if (tag === 'a' && currentSection) {
                const href = $(el).attr('href') || '';
                if (href.includes('/notes/')) {
                    const noteText = getNoteText(el);
                    if (noteText && noteText.length < 80) notes[currentSection].push(noteText);
                }
            }
        });
        if (hasNotes(notes)) return dedupeNotes(notes);
    }

    // ── Strategy 2: Any element whose own text matches a header, then collect
    // note links from the parent or next sibling subtrees ─────────────────────
    const sectionLabels = [
        { key: 'top',   variants: ['Top Notes', 'Top notes', 'Notas de Salida', 'Notas de salida'] },
        { key: 'heart', variants: ['Heart Notes', 'Heart notes', 'Middle Notes', 'Corazón', 'Corazon'] },
        { key: 'base',  variants: ['Base Notes', 'Base notes', 'Base'] },
    ];

    for (const { key, variants } of sectionLabels) {
        for (const label of variants) {
            if (notes[key].length > 0) break;
            $('*').filter(function () {
                const own = $(this).clone().children().remove().end().text().trim();
                return own.toLowerCase() === label.toLowerCase();
            }).each((_, el) => {
                if (notes[key].length > 0) return;
                // Try parent's subtree, then next siblings up to 3 levels
                const $el = $(el);
                const candidates = [$el.parent(), $el.parent().next(), $el.next(), $el.next().next()];
                for (const $c of candidates) {
                    $c.find('a[href*="/notes/"]').each((_, a) => {
                        const noteText = getNoteText(a);
                        if (noteText && noteText.length < 80) notes[key].push(noteText);
                    });
                    if (notes[key].length) break;
                }
            });
        }
    }
    if (hasNotes(notes)) return dedupeNotes(notes);

    // ── Strategy 3: Walk ALL elements tracking any header tag ────────────────
    let currentSection = null;
    $('*').each((_, el) => {
        const tag = el.tagName?.toLowerCase();
        if (!tag || tag === 'html' || tag === 'body' || tag === 'head' || tag === 'script' || tag === 'style') return;

        // Check if element is a header (its own text only, no children text)
        const ownText = $(el).clone().children().remove().end().text().trim();
        const key = classifyHeader(ownText);
        if (key) { currentSection = key; return; }

        if (tag === 'a' && currentSection) {
            const href = $(el).attr('href') || '';
            if (href.includes('/notes/')) {
                const noteText = getNoteText(el);
                if (noteText && noteText.length < 80) notes[currentSection].push(noteText);
            }
        }
    });
    if (hasNotes(notes)) return dedupeNotes(notes);

    // ── Strategy 4: Positional — group /notes/ links by proximity to headers ─
    // Collect all note link positions and all header positions, then assign each
    // note to the nearest preceding header.
    const headers = [];
    $('*').each((_, el) => {
        const own = $(el).clone().children().remove().end().text().trim();
        const key = classifyHeader(own);
        if (key) headers.push({ key, el });
    });

    if (headers.length >= 2) {
        // For each note link, find the closest preceding header
        $('a[href*="/notes/"]').each((_, a) => {
            const noteText = getNoteText(a);
            if (!noteText || noteText.length >= 80) return;

            // Use DOM position: find the last header that appears before this link in document order
            let assignedKey = null;
            for (const h of headers) {
                // compareDocumentPosition: bit 4 = a follows h
                const pos = h.el.compareDocumentPosition?.(a);
                if (pos === undefined || (pos & 4)) assignedKey = h.key; // a comes after h
            }
            if (assignedKey) notes[assignedKey].push(noteText);
        });
        if (hasNotes(notes)) return dedupeNotes(notes);
    }

    // ── Final fallback: all /notes/ links, unclassified → heart ─────────────
    // Keeps notes visible in the UI while signalling the pyramid couldn't be parsed.
    const allNotes = new Set();
    $('a[href*="/notes/"]').each((_, el) => {
        const noteText = getNoteText(el);
        if (noteText && noteText.length < 80 && !/^notes?$/i.test(noteText)) {
            allNotes.add(noteText);
        }
    });
    if (allNotes.size > 0) notes.heart = [...allNotes];

    return notes;
}

// Extraer acordes principales — returns string[] ordered by prominence
function extractAccords($) {
    const clean = (text) =>
        text.replace(/\d[\d,.]*/g, '').replace(/votes?/gi, '').replace(/\s+/g, ' ').trim();

    // ── Strategy 1: .accord-bar elements with an inline width style ──────────
    const withWidth = [];
    const withoutWidth = [];
    $('.accord-bar, [class*="accord-bar"]').each((_, el) => {
        const $el = $(el);
        // Extract name: prefer direct span child, otherwise element text minus numbers
        const spanName = $el.children('span').first().text().trim();
        const rawName = spanName || clean($el.clone().children('[class*="vote"],[class*="count"],[class*="num"]').remove().end().text());
        if (!rawName || rawName.length < 2 || rawName.length > 60) return;
        const style = $el.attr('style') || '';
        const widthMatch = style.match(/width:\s*([\d.]+)%/);
        if (widthMatch) {
            withWidth.push({ name: rawName, pct: parseFloat(widthMatch[1]) });
        } else {
            withoutWidth.push(rawName);
        }
    });
    if (withWidth.length > 0) {
        withWidth.sort((a, b) => b.pct - a.pct);
        return [...new Set([...withWidth.map(a => a.name), ...withoutWidth])];
    }
    if (withoutWidth.length > 0) return [...new Set(withoutWidth)];

    // ── Strategy 2: <a href="/accords/..."> links (most reliable) ────────────
    const fromLinks = [];
    $('a[href*="/accords/"]').each((_, el) => {
        const name = $(el).text().trim();
        if (name && name.length > 1 && name.length < 60) fromLinks.push(name);
    });
    if (fromLinks.length > 0) return [...new Set(fromLinks)];

    // ── Strategy 3: "Main Accords" / "Acordes Principales" section header ────
    const sectionAccords = [];
    $('b, strong, h3, h4').each((_, el) => {
        const txt = $(el).text().trim().toLowerCase();
        if (txt.includes('accord') || txt.includes('acorde')) {
            $(el).closest('div, section, .cell').find('a[href*="/accords/"]').each((__, a) => {
                const name = $(a).text().trim();
                if (name && name.length > 1 && name.length < 60) sectionAccords.push(name);
            });
        }
    });
    if (sectionAccords.length > 0) return [...new Set(sectionAccords)];

    // ── Strategy 4: any element with class containing "accord" — text only ───
    const genericAccords = [];
    $('[class*="accord"]').each((_, el) => {
        const $el = $(el);
        if ($el.children('[class*="accord"]').length > 0) return; // skip containers
        const name = clean($el.text());
        if (name && name.length > 1 && name.length < 60) genericAccords.push(name);
    });
    return [...new Set(genericAccords)];
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

// ─── Extraer métricas de rendimiento (longevity / sillage) ───────────────────
// Fragrantica muestra secciones con vote-buttons para cada nivel.
// Mapas de etiquetas (EN + ES) → clave interna normalizada.
const LONGEVITY_LABELS = {
    // English
    'poor': 'poor', 'very weak': 'veryweak', 'weak': 'weak',
    'moderate': 'moderate', 'long lasting': 'longlasting',
    'very long lasting': 'verylong', 'very long': 'verylong', 'eternal': 'eternal',
    // Spanish (Fragrantica ES)
    'escasa': 'poor', 'muy débil': 'veryweak', 'muy debil': 'veryweak',
    'débil': 'weak', 'debil': 'weak',
    'moderada': 'moderate', 'duradera': 'longlasting',
    'muy duradera': 'verylong', 'eterna': 'eternal',
};
const SILLAGE_LABELS = {
    // English
    'intimate': 'intimate', 'moderate': 'moderate',
    'strong': 'strong', 'enormous': 'enormous',
    // Spanish
    'suave': 'intimate', 'moderada': 'moderate',
    'fuerte': 'strong', 'pesada': 'strong', 'enorme': 'enormous',
};

function extractPerformanceMetric($, metric) {
    const labelMap = metric === 'longevity' ? LONGEVITY_LABELS : SILLAGE_LABELS;
    const votes = {};

    // Helper: find a numeric vote count adjacent to a label element
    const extractCount = ($el) => {
        const candidates = [
            $el.next(),
            $el.prev(),
            $el.parent().children().not($el[0]),
            $el.parent().next(),
            $el.parent().prev(),
            $el.closest('[class*="vote"], [class*="bar"], [class*="chart"]').find('[class*="count"], [class*="num"], [class*="score"]'),
        ];
        for (const $c of candidates) {
            let found = null;
            $c.each((_, c) => {
                if (found !== null) return;
                const txt = $(c).text().trim().replace(/[,.\s]/g, '');
                const n = parseInt(txt, 10);
                if (!isNaN(n) && n >= 0 && txt.length < 8) found = n;
            });
            if (found !== null) return found;
        }
        return null;
    };

    // Strategy 1: scan ALL elements whose own text matches a known label
    $('span, div, p, td, li, b, strong, label').each((_, el) => {
        const $el = $(el);
        const ownText = $el.clone().children().remove().end().text().trim().toLowerCase();
        const key = labelMap[ownText];
        if (!key) return;
        const count = extractCount($el);
        if (count !== null) {
            votes[key] = Math.max(votes[key] || 0, count);
        } else {
            if (!votes[key]) votes[key] = 0;
        }
    });

    // Strategy 2: elements with "vote"/"chart"/"bar" in class — extract label+count from subtree
    if (Object.keys(votes).filter(k => votes[k] > 0).length === 0) {
        $('[class*="vote"], [class*="chart"], [class*="bar-item"], [class*="bar_item"]').each((_, el) => {
            const $el = $(el);
            const txt = $el.text().toLowerCase();
            for (const [label, key] of Object.entries(labelMap)) {
                if (txt.includes(label)) {
                    $el.find('*').each((__, c) => {
                        const childText = $(c).clone().children().remove().end().text().trim().replace(/,/g, '');
                        const n = parseInt(childText, 10);
                        if (!isNaN(n) && n >= 0 && childText.length < 8) {
                            votes[key] = Math.max(votes[key] || 0, n);
                        }
                    });
                }
            }
        });
    }

    // Strategy 3: regex scan on full page text near metric labels
    if (Object.keys(votes).filter(k => votes[k] > 0).length === 0) {
        const fullText = $('body').text().toLowerCase();
        for (const [label, key] of Object.entries(labelMap)) {
            const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(escaped + '[\\s\\S]{0,100}?([0-9][0-9,]*)', 'i');
            const m = fullText.match(re);
            if (m) {
                const n = parseInt(m[1].replace(/,/g, ''), 10);
                if (!isNaN(n) && n >= 0) votes[key] = Math.max(votes[key] || 0, n);
            }
        }
    }

    if (Object.keys(votes).length === 0) return null;

    // If we only have labels with 0 counts (no actual vote data), return null
    const hasRealVotes = Object.values(votes).some(v => v > 0);
    if (!hasRealVotes) return null;

    const sortedEntries = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    const dominant = sortedEntries[0][0];
    const maxVotes = sortedEntries[0][1];
    const totalVotes = Object.values(votes).reduce((s, v) => s + v, 0);
    const percentage = totalVotes > 0 ? Math.round((maxVotes / totalVotes) * 100) : 0;

    return { dominant, percentage, votes };
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

    // Strategy 1: vote-button/season elements with class or text matching keywords
    $('[class*="vote"], [class*="season"], [class*="accord"], [class*="bar"], [class*="chart"]').each((_, el) => {
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

    // Strategy 2: scan ALL elements whose own text is a season/time keyword,
    // then look for adjacent numeric values
    $('span, div, p, td, li, b, strong, label').each((_, el) => {
        const $el = $(el);
        const own = $el.clone().children().remove().end().text().trim().toLowerCase();
        const key = keyMap[own];
        if (!key) return;

        // Look for numeric value in siblings, parent siblings, parent children
        const candidates = [
            $el.next(),
            $el.prev(),
            $el.parent().children().not($el[0]),
            $el.parent().next(),
            $el.parent().prev(),
            $el.closest('[class*="vote"], [class*="bar"], [class*="chart"], [class*="season"]').find('[class*="count"], [class*="num"], [class*="score"]'),
        ];
        for (const $c of candidates) {
            let foundCount = null;
            $c.each((__, c) => {
                if (foundCount !== null) return;
                const txt = $(c).text().trim();
                const n = parseVotes(txt);
                if (n > 0 && txt.length < 10) foundCount = n;
            });
            if (foundCount !== null) {
                result[key] = Math.max(result[key], foundCount);
                found = true;
                break;
            }
        }
    });

    // Strategy 3: regex scan on full text for each season keyword → digits
    if (!found) {
        const fullText = $('body').text().toLowerCase();
        for (const [kw, key] of Object.entries(keyMap)) {
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(escaped + '[\\s\\S]{0,80}?([0-9][0-9,.]*k?)', 'i');
            const m = fullText.match(re);
            if (m) {
                const n = parseVotes(m[1]);
                if (n > 0) { result[key] = Math.max(result[key], n); found = true; }
            }
        }
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
