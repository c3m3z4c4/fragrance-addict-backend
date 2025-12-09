import axios from 'axios';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';
import { cacheService } from './cacheService.js';

const SCRAPE_DELAY = parseInt(process.env.SCRAPE_DELAY_MS) || 3000;

// Delay entre requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Headers para evitar bloqueos
const getHeaders = () => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
});

// Scraper genérico - adaptar selectores según el sitio
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
      timeout: 15000
    });
    
    const $ = cheerio.load(response.data);
    
    // Selectores genéricos - ADAPTAR según el sitio web objetivo
    const perfume = {
      id: uuidv4(),
      name: extractText($, [
        'h1[itemprop="name"]',
        'h1.product-title',
        'h1.perfume-name',
        '.product-name h1',
        'h1'
      ]),
      brand: extractText($, [
        '[itemprop="brand"]',
        '.brand-name',
        '.designer-name',
        'a[href*="/brand/"]',
        '.manufacturer'
      ]),
      year: extractYear($),
      perfumer: extractText($, [
        '.perfumer-name',
        '[itemprop="author"]',
        '.nose-name'
      ]),
      gender: extractGender($),
      concentration: extractText($, [
        '.concentration',
        '.product-type',
        '[data-concentration]'
      ]),
      notes: extractNotes($),
      description: extractText($, [
        '[itemprop="description"]',
        '.product-description',
        '.fragrance-description',
        '.description p'
      ]),
      imageUrl: extractImage($),
      rating: extractRating($),
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // Guardar en caché
    cacheService.set(url, perfume, 86400); // 24 horas
    
    return perfume;
    
  } catch (error) {
    console.error(`❌ Error scraping ${url}:`, error.message);
    throw new Error(`Error al scrapear: ${error.message}`);
  }
};

// Funciones auxiliares de extracción
function extractText($, selectors) {
  for (const selector of selectors) {
    const text = $(selector).first().text().trim();
    if (text) return text;
  }
  return null;
}

function extractYear($) {
  const yearPatterns = [
    /\b(19|20)\d{2}\b/
  ];
  
  const yearSelectors = ['.year', '.launch-year', '[data-year]', '.release-date'];
  
  for (const selector of yearSelectors) {
    const text = $(selector).text();
    for (const pattern of yearPatterns) {
      const match = text.match(pattern);
      if (match) return parseInt(match[0]);
    }
  }
  
  // Buscar en el texto general
  const bodyText = $('body').text();
  const match = bodyText.match(/launched in (\d{4})|año (\d{4})|from (\d{4})/i);
  if (match) return parseInt(match[1] || match[2] || match[3]);
  
  return null;
}

function extractGender($) {
  const text = $('body').text().toLowerCase();
  
  if (text.includes('unisex') || text.includes('shared')) return 'unisex';
  if (text.includes('for women') || text.includes('femenino') || text.includes('mujer')) return 'feminine';
  if (text.includes('for men') || text.includes('masculino') || text.includes('hombre')) return 'masculine';
  
  return 'unisex';
}

function extractNotes($) {
  const notes = {
    top: [],
    heart: [],
    base: []
  };
  
  // Selectores comunes para notas
  const topSelectors = ['.top-notes', '.head-notes', '[data-notes="top"]'];
  const heartSelectors = ['.heart-notes', '.middle-notes', '[data-notes="heart"]'];
  const baseSelectors = ['.base-notes', '.bottom-notes', '[data-notes="base"]'];
  
  const extractNoteList = (selectors) => {
    for (const selector of selectors) {
      const $container = $(selector);
      if ($container.length) {
        const noteTexts = [];
        $container.find('a, span, li').each((_, el) => {
          const text = $(el).text().trim();
          if (text && text.length < 50) noteTexts.push(text);
        });
        if (noteTexts.length) return noteTexts;
      }
    }
    return [];
  };
  
  notes.top = extractNoteList(topSelectors);
  notes.heart = extractNoteList(heartSelectors);
  notes.base = extractNoteList(baseSelectors);
  
  return notes;
}

function extractImage($) {
  const imgSelectors = [
    'img[itemprop="image"]',
    '.product-image img',
    '.perfume-image img',
    '.main-image img',
    'img.product-img'
  ];
  
  for (const selector of imgSelectors) {
    const src = $(selector).first().attr('src') || $(selector).first().attr('data-src');
    if (src) {
      // Convertir a URL absoluta si es necesario
      if (src.startsWith('//')) return `https:${src}`;
      if (src.startsWith('/')) return src; // Se necesitará el dominio base
      return src;
    }
  }
  
  return null;
}

function extractRating($) {
  const ratingSelectors = [
    '[itemprop="ratingValue"]',
    '.rating-value',
    '.score',
    '[data-rating]'
  ];
  
  for (const selector of ratingSelectors) {
    const $el = $(selector);
    const value = $el.attr('content') || $el.attr('data-rating') || $el.text();
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 10) {
      return parsed;
    }
  }
  
  return null;
}
