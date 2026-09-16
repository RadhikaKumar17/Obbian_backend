import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const backendRoot = fileURLToPath(new URL('../', import.meta.url));
try {
  for (const line of readFileSync(resolve(backendRoot, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

export const settings = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '127.0.0.1',
  origins: (process.env.FRONTEND_ORIGINS || 'http://localhost:3000,http://localhost:3100').split(',').map(value => value.trim()),
  mongoUri: process.env.MONGODB_URI || '',
  adminToken: process.env.ADMIN_TOKEN || '',
  secureCookie: process.env.COOKIE_SECURE === 'true',
  sameSite: process.env.COOKIE_SAME_SITE || 'Lax',
};
if (!['Lax', 'Strict', 'None'].includes(settings.sameSite)) throw new Error('Invalid COOKIE_SAME_SITE');
if (settings.sameSite === 'None' && !settings.secureCookie) throw new Error('SameSite=None requires COOKIE_SECURE=true');
