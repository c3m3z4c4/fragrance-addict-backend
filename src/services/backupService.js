import {
    writeFileSync,
    readFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    unlinkSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dataStore } from './dataStore.js';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_BACKUP_DIR = join(__dirname, '../../backups');
try { mkdirSync(LOCAL_BACKUP_DIR, { recursive: true }); } catch {}

// Encryption for sensitive credentials
const ENCRYPT_KEY = process.env.BACKUP_ENCRYPT_KEY || 'fragrance-backup-default-key-32!';
const KEY = crypto.scryptSync(ENCRYPT_KEY, 'salt', 32);

export function encryptCredential(text) {
    if (!text) return text;
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
        const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch {
        return text;
    }
}

export function decryptCredential(text) {
    if (!text) return text;
    try {
        const parts = text.split(':');
        // Must have exactly 2 parts: iv + encrypted
        if (parts.length !== 2) return text;
        const iv = Buffer.from(parts[0], 'hex');
        if (iv.length !== 16) return text;
        const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(parts[1], 'hex')),
            decipher.final(),
        ]);
        return decrypted.toString('utf8');
    } catch {
        return text; // already plaintext or invalid
    }
}

// Create backup JSON buffer (all or by brand)
export async function createBackupBuffer({ brand } = {}) {
    const perfumes = await dataStore.exportAll({ brand: brand || undefined });
    const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        brand: brand || 'all',
        count: perfumes.length,
        perfumes,
    };
    return Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
}

// Save buffer to local disk; prune to keep newest 30 files
export function saveLocalBackup(buffer, filename) {
    const path = join(LOCAL_BACKUP_DIR, filename);
    writeFileSync(path, buffer);

    // Prune old files — keep newest 30
    try {
        const files = readdirSync(LOCAL_BACKUP_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => ({ name: f, mtime: statSync(join(LOCAL_BACKUP_DIR, f)).mtime }))
            .sort((a, b) => b.mtime - a.mtime);
        files.slice(30).forEach(f => {
            try { unlinkSync(join(LOCAL_BACKUP_DIR, f.name)); } catch {}
        });
    } catch {}

    return path;
}

// List all local backup files, newest first
export function listLocalBackups() {
    try {
        return readdirSync(LOCAL_BACKUP_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const stat = statSync(join(LOCAL_BACKUP_DIR, f));
                return {
                    name: f,
                    size: stat.size,
                    createdAt: stat.mtime.toISOString(),
                    path: join(LOCAL_BACKUP_DIR, f),
                };
            })
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch {
        return [];
    }
}

// Read a local backup file and return parsed JSON
export function readLocalBackup(filename) {
    const path = join(LOCAL_BACKUP_DIR, filename);
    if (!existsSync(path)) throw new Error(`Backup file not found: ${filename}`);
    return JSON.parse(readFileSync(path, 'utf8'));
}

// Upload via WebDAV (Asustor NAS, Nextcloud, ownCloud, etc.)
export async function uploadWebDAV(buffer, filename, config) {
    const { createClient } = await import('webdav');
    const { url, username, password, remotePath = '/' } = config;
    const client = createClient(url, { username, password });

    // Ensure remote directory exists
    try { await client.createDirectory(remotePath, { recursive: true }); } catch {}

    const remoteFile = remotePath.replace(/\/$/, '') + '/' + filename;
    await client.putFileContents(remoteFile, buffer, { overwrite: true });
    return remoteFile;
}

// Upload to Google Drive using a service account
export async function uploadGoogleDrive(buffer, filename, config) {
    const { google } = await import('googleapis');
    const { Readable } = await import('stream');

    const credentials = JSON.parse(decryptCredential(config.credentials));
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const folderId = config.folderId || 'root';

    const stream = Readable.from(buffer);
    const res = await drive.files.create({
        requestBody: {
            name: filename,
            parents: [folderId],
            mimeType: 'application/json',
        },
        media: { mimeType: 'application/json', body: stream },
        fields: 'id, name, webViewLink',
    });
    return res.data;
}

// Upload via SFTP (Asustor NAS or any SSH server)
export async function uploadSFTP(buffer, filename, config) {
    const SFTPClient = (await import('ssh2-sftp-client')).default;
    const sftp = new SFTPClient();
    const { host, port = 22, username, password, remotePath = '/backups' } = config;

    try {
        await sftp.connect({
            host,
            port: parseInt(port),
            username,
            password,
            readyTimeout: 20000,
        });
        try { await sftp.mkdir(remotePath, true); } catch {}
        const remoteFile = remotePath.replace(/\/$/, '') + '/' + filename;
        await sftp.put(buffer, remoteFile);
        return remoteFile;
    } finally {
        await sftp.end().catch(() => {});
    }
}

// Decrypt the sensitive config fields of a destination
export function decryptDestinationConfig(dest) {
    const c = { ...(dest.config || {}) };
    if (c.password) c.password = decryptCredential(c.password);
    if (c.credentials) c.credentials = decryptCredential(c.credentials);
    return c;
}

// Upload to all enabled destinations, return per-destination results
export async function uploadToDestinations(buffer, filename, destinations = []) {
    const results = [];
    for (const dest of destinations) {
        if (!dest.enabled) continue;
        try {
            const decryptedConfig = decryptDestinationConfig(dest);
            let remotePath;
            if (dest.type === 'webdav') {
                remotePath = await uploadWebDAV(buffer, filename, decryptedConfig);
            } else if (dest.type === 'gdrive') {
                remotePath = await uploadGoogleDrive(buffer, filename, decryptedConfig);
            } else if (dest.type === 'sftp' || dest.type === 'tailscale') {
                // Tailscale is a transparent VPN layer — standard SFTP works over it
                remotePath = await uploadSFTP(buffer, filename, decryptedConfig);
            }
            results.push({ id: dest.id, name: dest.name, type: dest.type, success: true, remotePath });
        } catch (err) {
            results.push({ id: dest.id, name: dest.name, type: dest.type, success: false, error: err.message });
        }
    }
    return results;
}

// Restore perfumes from a parsed backup JSON object
export async function restoreFromBackup(backupJson) {
    const { perfumes = [] } = backupJson;
    let imported = 0;
    for (const p of perfumes) {
        try {
            await dataStore.add(p);
            imported++;
        } catch {}
    }
    return imported;
}
