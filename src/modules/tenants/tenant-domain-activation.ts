import {
  isValidTenantCustomHostname,
  type TenantUrlContext,
} from "@/modules/checkout/checkout.urls.js";
import { isTenantDomainEntitled } from "./tenant-domain-entitlement.js";
import { mongo } from "mongoose";

// Domain subdocuments may contain ObjectIds and verification dates. Ordinary
// JSON or structuredClone would change their BSON types and break exact CAS.
export const serializeDomainActivationSnapshot = (value: unknown): string =>
  mongo.BSON.EJSON.stringify(value, undefined, 2, { relaxed: false });

export type DomainActivationTenant = TenantUrlContext & {
  _id: unknown;
  status: string;
};

/** Plans only. DNS/hosting ownership and BFF readiness must be checked separately. */
export const planTenantDomainActivation = ({
  tenant,
  expectedTenantId,
  expectedSlug,
  hostname,
}: {
  tenant: DomainActivationTenant;
  expectedTenantId: string;
  expectedSlug: string;
  hostname: string;
}) => {
  if (String(tenant._id) !== expectedTenantId || tenant.slug !== expectedSlug) {
    throw new Error("Tenant ID and slug do not match the requested workspace.");
  }
  if (tenant.status !== "active")
    throw new Error("Only active workspaces can activate a domain.");
  if (!Array.isArray(tenant.domains))
    throw new Error(
      "Tenant domain records must be reviewed before activation.",
    );
  if (
    !isValidTenantCustomHostname(hostname) ||
    hostname !== hostname.trim().toLowerCase()
  ) {
    throw new Error(
      "Use a lowercase DNS hostname without a scheme, path, port, or trailing dot.",
    );
  }
  if (!isTenantDomainEntitled({ tenant, domain: { type: "custom" } })) {
    throw new Error("The workspace plan does not include a custom domain.");
  }
  if (
    tenant.domains.filter((domain) => domain.hostname === hostname).length > 1
  ) {
    throw new Error(
      "Duplicate hostname records must be reviewed before activation.",
    );
  }

  const previousDomains = mongo.BSON.EJSON.parse(
    serializeDomainActivationSnapshot(tenant.domains),
    { relaxed: false },
  ) as typeof tenant.domains;
  const nextDomains = previousDomains
    .filter((domain) => domain.hostname !== hostname)
    .map((domain) => ({ ...domain, isPrimary: false }));
  const existing = previousDomains.find(
    (domain) => domain.hostname === hostname,
  );
  nextDomains.push({
    ...existing,
    hostname,
    type: "custom",
    status: "active",
    isPrimary: true,
  });

  return {
    tenantId: expectedTenantId,
    tenantSlug: expectedSlug,
    hostname,
    previousDomains,
    nextDomains,
    changed: JSON.stringify(previousDomains) !== JSON.stringify(nextDomains),
  };
};
