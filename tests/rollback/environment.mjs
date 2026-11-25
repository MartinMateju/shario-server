import { delimiter, dirname, join } from 'node:path';

export function rehearsalEnvironment({ mongoUri, directory, guard, apiPort = 4311, clientPort = 4310 }) {
  const mongo = new URL(mongoUri);
  if (mongo.protocol !== 'mongodb:' || mongo.hostname !== '127.0.0.1' || !mongo.pathname.startsWith('/shario-rollback-test-') || mongo.username || mongo.password) {
    throw new Error('Rehearsal requires a freshly allocated loopback test Mongo database.');
  }
  // Deliberate allowlist: never spread the caller environment, read .env, or
  // inherit credentials, NODE_OPTIONS, URLs, proxies or provider configuration.
  return {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/local/bin'].join(delimiter),
    TMPDIR: process.env.TMPDIR || '/tmp',
    NODE_ENV: 'test', TZ: 'UTC', NEXT_TELEMETRY_DISABLED: '1',
    DOTENV_CONFIG_PATH: join(directory, 'nonexistent.env'),
    NODE_OPTIONS: `--require=${guard} --max-old-space-size=4096`,
    REHEARSAL_MODE: 'loopback-only', REHEARSAL_DIRECTORY: directory,
    REHEARSAL_BLOCKED_FILE: join(directory, 'blocked-network.jsonl'),
    MONGO_URI: mongoUri, REDIS_URL: 'redis://127.0.0.1:6379/15',
    PORT: String(apiPort), SERVER_URL: `http://127.0.0.1:${apiPort}`,
    CLIENT_URL: `http://127.0.0.1:${clientPort}`, DEVELOPMENT_ROOT_DOMAIN: 'shario.localhost',
    NEXT_PUBLIC_SITE_URL: `http://shario.localhost:${clientPort}`,
    NEXT_PUBLIC_ROOT_DOMAIN: 'shario.localhost', TENANT_ROOT_DOMAIN: 'shario.localhost',
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`,
    CUSTOM_DOMAIN_TENANTS: '{"studio-alpha.test":"studio-alpha"}',
    ACCESS_TOKEN_SECRET: 'rehearsal-access-secret-at-least-32-characters',
    REFRESH_TOKEN_SECRET: 'rehearsal-refresh-secret-at-least-32-characters',
    WAITLIST_TOKEN_PEPPER: 'rehearsal-waitlist-secret-at-least-32-characters',
    ACCESS_CODE_ENCRYPTION_KEY: 'rehearsal-code-key-at-least-32-characters',
    AUTH_EMAIL: 'auth@shario-e2e.test', EMAIL_USER: 'mail@shario-e2e.test',
    EMAIL_PASSWORD: 'e2e-no-smtp', EMAIL_HOST: '127.0.0.1', EMAIL_PORT: '1025',
    EMAIL_SECURE: 'false', EMAIL_ALLOW_SELF_SIGNED: 'false',
    EMAIL_SECRET_KEY: 'rehearsal-email-secret-key',
    COMMUNICATION_SECRET_KEY: 'rehearsal-communication-secret-key-at-least-32',
    COMMUNICATION_DELIVERY_MODE: 'local', COMMUNICATION_SCHEDULER_INTERVAL_MS: '10000',
    STRIPE_KEY: 'sk_test_rehearsal_no_external_requests',
    WEBHOOK_SECRET: 'whsec_rehearsal', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_rehearsal',
    STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_rehearsal_billing',
    LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED: 'false', TENANT_BILLING_EMAILS_ENABLED: 'false',
    POSTMARK_API_URL: 'http://127.0.0.1:4100',
    POSTMARK_SYSTEM_SERVER_TOKEN: 'e2e-postmark-system-server-token',
    POSTMARK_SYSTEM_FROM_EMAIL: 'system@notify.shario.io', POSTMARK_FROM_DOMAIN: 'notify.shario.io',
    R2_ACCOUNT_ID: '00000000000000000000000000000000',
    R2_ACCESS_KEY_ID: 'rehearsal-fake-key', R2_SECRET_ACCESS_KEY: 'rehearsal-fake-secret',
    R2_BUCKET: 'rehearsal-test', R2_PUBLIC_URL: 'https://127.0.0.1',
    E2E_TEST_KEY: 'rehearsal-loopback-control',
    SHUTDOWN_DRAIN_TIMEOUT_MS: '10000', SHUTDOWN_CLEANUP_TIMEOUT_MS: '10000',
    LOG_LEVEL: 'info',
    OPS_MONITOR_TOKEN: 'rehearsal-operations-token-at-least-32-characters',
    OPS_MONITOR_NAMESPACE: 'rollback_rehearsal',
  };
}
