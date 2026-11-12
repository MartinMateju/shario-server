import { createHash } from "node:crypto";

import {
  configurePostmarkOutboundWebhook,
  provisionPostmarkServer,
} from "@/infrastructure/email/postmark.client.js";
import { decryptSecret, encryptSecret } from "@/shared/security/encryption.js";

const normalizedManagedDomain = () =>
  String(process.env.POSTMARK_FROM_DOMAIN || "notify.shario.io")
    .trim()
    .toLowerCase();

export const buildManagedSenderEmail = (tenantId: string): string => {
  const opaqueTenantKey = createHash("sha256")
    .update(`shario-managed-sender:${tenantId}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `studio-${opaqueTenantKey}@${normalizedManagedDomain()}`;
};

export const buildPostmarkTenantServerName = (tenantId: string): string =>
  `${String(
    process.env.POSTMARK_TENANT_SERVER_PREFIX ||
      `shario-${process.env.NODE_ENV || "development"}`,
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 24)}-${tenantId}`.slice(0, 50);

export const provisionManagedTenantServer = async (tenantId: string) => {
  const binding = await provisionPostmarkServer(
    buildPostmarkTenantServerName(tenantId),
  );
  return {
    providerServerId: binding.serverId,
    encryptedPostmarkServerToken: encryptSecret(binding.serverToken),
  };
};

export const configureStoredManagedTenantWebhook = async (
  encryptedPostmarkServerToken: string,
  provisioningAttemptId: string,
) =>
  configurePostmarkOutboundWebhook(
    decryptSecret(encryptedPostmarkServerToken),
    provisioningAttemptId,
  );
