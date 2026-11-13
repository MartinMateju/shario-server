import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEnv = resolve(root, '.env');
const clientRoot = resolve(root, '../shario-client');
const clientEnv = resolve(clientRoot, '.env.local');
if (existsSync(serverEnv) || existsSync(clientEnv)) {
  throw new Error('Local configuration already exists. Nothing was overwritten. Edit the existing Shario files to change configuration.');
}
let server = readFileSync(resolve(root, '.env.example'), 'utf8');
const keys = ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'AUTH_FIRST_PARTY_PROXY_SECRET', 'AUTH_SESSION_HANDOFF_SECRET', 'BOOKING_INTENT_SECRET', 'EMAIL_SECRET_KEY', 'COMMUNICATION_SECRET_KEY', 'ACCESS_CODE_ENCRYPTION_KEY', 'POSTMARK_OUTBOUND_WEBHOOK_PASSWORD'];
const secrets = Object.fromEntries(keys.map(key => [key, randomBytes(32).toString('hex')]));
for (const [key, value] of Object.entries(secrets)) server = server.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
// The current frontend calls the API directly. Backend signing/encryption
// keys must remain in the API environment, including optional proxy keys.
const client = readFileSync(resolve(clientRoot, '.env.example'), 'utf8');
writeFileSync(serverEnv, server, { flag: 'wx', mode: 0o600 });
writeFileSync(clientEnv, client, { flag: 'wx', mode: 0o600 });
console.log('Created isolated Shario .env and client .env.local with fresh secrets. Provider values are placeholders. Start local infrastructure with npm run infra:up.');
