#!/usr/bin/env node
/**
 * Bulk backfill of missing perfume data from a static Fragrantica dataset CSV.
 *
 * WHY: ~83% of the catalogue was mass-imported via Algolia, which does NOT carry
 * notes / accords / perfumer / concentration. Re-scraping 24k HTML pages is slow
 * and needs a paid proxy. A one-time JOIN against a pre-scraped dataset fills
 * notes, accords, perfumer, year and concentration for the whole catalogue in
 * minutes — matched by the Fragrantica objectID we already store in source_url.
 *
 * This is the "dataset" half of the hybrid strategy. Vote-based fields
 * (sillage / longevity / seasonUsage) are NOT in datasets — those still come from
 * the HTML/proxy path for the perfumes where they matter.
 *
 * SOURCES (any CSV with a Fragrantica id + note/accord columns works):
 *   • FragDB  — fragdb.net / github.com/FragDB/fragrance-database  (pid = objectID)
 *               Note: FragDB stores notes compactly (note_id,opacity,weight) and
 *               needs a pre-JOIN with its notes.csv to resolve names first.
 *   • Kaggle  — kaggle.com/datasets/olgagmiufana1/fragrantica-com-fragrance-dataset
 *               (free; plain note names; match by url or brand+name)
 *
 * USAGE:
 *   DATABASE_URL=postgres://... node scripts/backfill-from-dataset.js \
 *       --file ./fragrances.csv [--delimiter '|'] [--limit 0] [--dry-run]
 *
 * The column names below are configurable via env or the CONFIG block — adjust
 * them to match whichever dataset you feed in. Matching strategy:
 *   1. by Fragrantica objectID  (dataset PID column  ↔  id parsed from source_url)
 *   2. fallback by normalized  brand + name
 * Only fields that are CURRENTLY EMPTY in the DB are written (idempotent, safe to
 * re-run). Run with --dry-run first to preview counts.
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

// ─── CONFIG — adjust column names to your dataset ────────────────────────────
const CONFIG = {
    // Column holding the Fragrantica numeric id (a.k.a. objectID / pid). Optional.
    pidColumn: process.env.DS_PID_COL || 'pid',
    // Column holding the full Fragrantica URL (used to derive the id if no pid). Optional.
    urlColumn: process.env.DS_URL_COL || 'url',
    // Name + brand columns (fallback matching)
    nameColumn: process.env.DS_NAME_COL || 'name',
    brandColumn: process.env.DS_BRAND_COL || 'brand',
    // Note columns. Either 3 pyramid columns OR a single combined list column.
    topColumn: process.env.DS_TOP_COL || 'top',
    heartColumn: process.env.DS_HEART_COL || 'middle',
    baseColumn: process.env.DS_BASE_COL || 'base',
    notesColumn: process.env.DS_NOTES_COL || 'notes',       // combined fallback
    accordsColumn: process.env.DS_ACCORDS_COL || 'accords', // main_accords / mainaccords
    perfumerColumn: process.env.DS_PERFUMER_COL || 'perfumer',
    yearColumn: process.env.DS_YEAR_COL || 'year',
    concentrationColumn: process.env.DS_CONC_COL || 'concentration',
    // Delimiter inside a multi-value cell (notes/accords)
    listSeparator: /[;,|]/,
};

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const FILE = getArg('--file', getArg('-f', null));
const DELIMITER = getArg('--delimiter', null); // auto-detect if null
const LIMIT = parseInt(getArg('--limit', '0')) || 0; // 0 = all
const DRY_RUN = args.includes('--dry-run');

if (!FILE) { console.error('❌ --file <dataset.csv> is required'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('❌ DATABASE_URL env is required'); process.exit(1); }

// ─── Minimal, dependency-free CSV parser (RFC-4180-ish, quoted fields) ───────
function parseCsv(text, delimiter) {
    const rows = [];
    let field = '', row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === delimiter) { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

const extractObjectId = (s) => {
    if (!s) return null;
    const m = String(s).match(/-(\d+)\.html/) || String(s).match(/^(\d+)$/);
    return m ? m[1] : null;
};
const norm = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const toList = (v) => !v ? [] :
    String(v).split(CONFIG.listSeparator).map(x => x.trim()).filter(Boolean);

async function main() {
    // 1. Load dataset
    console.log(`📂 Reading dataset: ${FILE}`);
    const raw = fs.readFileSync(path.resolve(FILE), 'utf-8');
    const delim = DELIMITER || (raw.slice(0, 5000).includes('|') ? '|' : ',');
    console.log(`   delimiter: "${delim}"`);
    const rows = parseCsv(raw, delim);
    const header = rows.shift().map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    const col = (name) => header.indexOf(String(name).toLowerCase());
    console.log(`   ${rows.length} dataset rows, ${header.length} columns`);

    const cPid = col(CONFIG.pidColumn), cUrl = col(CONFIG.urlColumn);
    const cName = col(CONFIG.nameColumn), cBrand = col(CONFIG.brandColumn);
    const cTop = col(CONFIG.topColumn), cHeart = col(CONFIG.heartColumn), cBase = col(CONFIG.baseColumn);
    const cNotes = col(CONFIG.notesColumn), cAcc = col(CONFIG.accordsColumn);
    const cPerf = col(CONFIG.perfumerColumn), cYear = col(CONFIG.yearColumn), cConc = col(CONFIG.concentrationColumn);

    const byPid = new Map(), byKey = new Map();
    for (const r of rows) {
        const rec = {
            top: cTop >= 0 ? toList(r[cTop]) : [],
            heart: cHeart >= 0 ? toList(r[cHeart]) : [],
            base: cBase >= 0 ? toList(r[cBase]) : [],
            notes: cNotes >= 0 ? toList(r[cNotes]) : [],
            accords: cAcc >= 0 ? toList(r[cAcc]) : [],
            perfumer: cPerf >= 0 ? (r[cPerf] || '').trim() : '',
            year: cYear >= 0 ? parseInt(r[cYear]) || null : null,
            concentration: cConc >= 0 ? (r[cConc] || '').trim() : '',
        };
        const pid = cPid >= 0 ? extractObjectId(r[cPid]) : (cUrl >= 0 ? extractObjectId(r[cUrl]) : null);
        if (pid) byPid.set(pid, rec);
        if (cName >= 0 && cBrand >= 0) byKey.set(`${norm(r[cBrand])}|${norm(r[cName])}`, rec);
    }
    console.log(`   indexed ${byPid.size} by objectID, ${byKey.size} by brand+name`);

    // 2. Stream DB perfumes
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
    const { rows: perfumes } = await pool.query(
        `SELECT id, name, brand, source_url, year, concentration, perfumer, notes, accords
         FROM perfumes ${LIMIT ? `LIMIT ${LIMIT}` : ''}`
    );
    console.log(`🗄️  ${perfumes.length} DB perfumes to check\n`);

    let matched = 0, updated = 0, skipped = 0;
    const stat = { notes: 0, accords: 0, perfumer: 0, year: 0, concentration: 0 };

    for (const p of perfumes) {
        const pid = extractObjectId(p.source_url);
        const rec = (pid && byPid.get(pid)) || byKey.get(`${norm(p.brand)}|${norm(p.name)}`);
        if (!rec) { skipped++; continue; }
        matched++;

        const patch = {};
        // notes — only if DB currently has none
        const dbNotes = p.notes || {};
        const dbNoteCount = (dbNotes.top?.length || 0) + (dbNotes.heart?.length || 0) + (dbNotes.base?.length || 0);
        if (dbNoteCount === 0) {
            let notes = null;
            if (rec.top.length || rec.heart.length || rec.base.length) {
                notes = { top: rec.top, heart: rec.heart, base: rec.base };
            } else if (rec.notes.length) {
                notes = { top: [], heart: rec.notes, base: [] }; // flat list → heart
            }
            if (notes) { patch.notes = notes; stat.notes++; }
        }
        // accords
        if ((!p.accords || p.accords.length === 0) && rec.accords.length) {
            patch.accords = rec.accords; stat.accords++;
        }
        // perfumer / year / concentration — only fill when empty
        if (!p.perfumer && rec.perfumer) { patch.perfumer = rec.perfumer; stat.perfumer++; }
        if (!p.year && rec.year) { patch.year = rec.year; stat.year++; }
        if (!p.concentration && rec.concentration) { patch.concentration = rec.concentration; stat.concentration++; }

        if (Object.keys(patch).length === 0) { skipped++; continue; }

        if (!DRY_RUN) {
            const sets = [], vals = [];
            let i = 1;
            for (const [k, v] of Object.entries(patch)) {
                const colName = { notes: 'notes', accords: 'accords', perfumer: 'perfumer', year: 'year', concentration: 'concentration' }[k];
                const isJson = k === 'notes' || k === 'accords';
                sets.push(`${colName} = $${i++}`);
                vals.push(isJson ? JSON.stringify(v) : v);
            }
            sets.push('updated_at = NOW()');
            vals.push(p.id);
            await pool.query(`UPDATE perfumes SET ${sets.join(', ')} WHERE id = $${i}`, vals);
        }
        updated++;
        if (updated % 500 === 0) console.log(`  …${updated} updated`);
    }

    console.log(`\n${DRY_RUN ? '🔍 DRY RUN — nothing written' : '✅ Backfill complete'}`);
    console.log(`   matched: ${matched}  updated: ${updated}  skipped: ${skipped}`);
    console.log(`   filled → notes: ${stat.notes}, accords: ${stat.accords}, perfumer: ${stat.perfumer}, year: ${stat.year}, concentration: ${stat.concentration}`);
    await pool.end();
}

main().catch(err => { console.error('❌', err); process.exit(1); });
