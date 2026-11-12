import type { ClientSession } from "mongoose";

import { TENANT_DOMAIN_STATUS, TENANT_STATUS } from "./tenant.constants.js";
import { isTenantDomainEntitled } from "./tenant-domain-entitlement.js";
import TenantModel from "./tenant.model.js";
import type { TenantDocument, TenantPlan, TenantSettings } from "./tenant.types.js";

export type TenantRepositoryOptions = {
  session?: ClientSession | null;
};

export type CreateTenantInput = {
  name: string;
  slug: string;
  plan?: TenantPlan;
  hostname?: string;
  settings?: Partial<Pick<TenantSettings,
    "currency" | "timezone" | "adminLanguage" | "publicDefaultLanguage" | "supportedPublicLanguages"
  >>;
  country?: string;
};

const normalizeSlug = (slug: string): string => {
  return slug.toLowerCase().trim();
};

const normalizeHostname = (hostname: string): string => {
  return hostname.toLowerCase().trim();
};

export const findTenantById = async (
  tenantId: string,
  options: TenantRepositoryOptions = {},
): Promise<TenantDocument | null> => {
  return TenantModel.findById(tenantId)
    .session(options.session ?? null)
    .exec();
};

export const findTenantBySlug = async (
  slug: string,
  options: TenantRepositoryOptions = {},
): Promise<TenantDocument | null> => {
  return TenantModel.findOne({
    slug: normalizeSlug(slug),
  })
    .session(options.session ?? null)
    .exec();
};

export const findActiveTenantByHostname = async (
  hostname: string,
  options: TenantRepositoryOptions = {},
): Promise<TenantDocument | null> => {
  const normalizedHostname = normalizeHostname(hostname);
  const tenant = await TenantModel.findOne({
      domains: {
        $elemMatch: {
          hostname: normalizedHostname,
          status: TENANT_DOMAIN_STATUS.ACTIVE,
        },
      },
      status: {
        $nin: [TENANT_STATUS.SUSPENDED, TENANT_STATUS.CANCELED],
      },
    })
      .session(options.session ?? null)
      // Hostname resolution sits in the credentialed CORS path, before normal
      // route limiters. Bound server-side execution so a slow lookup cannot hold
      // one of the deliberately small CORS lookup slots indefinitely.
      .maxTimeMS(2_000)
      .exec();

  if (!tenant) return null;

  const domain = tenant.domains.find(
    (candidate) =>
      normalizeHostname(candidate.hostname) === normalizedHostname &&
      candidate.status === TENANT_DOMAIN_STATUS.ACTIVE,
  );

  return domain && isTenantDomainEntitled({ tenant, domain }) ? tenant : null;
};

export const createTenant = async (
  input: CreateTenantInput,
  options: TenantRepositoryOptions = {},
): Promise<TenantDocument> => {
  const hostname = input.hostname ? normalizeHostname(input.hostname) : "";

  const [tenant] = await TenantModel.create(
    [
      {
        name: input.name.trim(),
        slug: normalizeSlug(input.slug),
        plan: input.plan,
        voucherQuotaVersion: 1,
        ...(input.settings ? { settings: input.settings } : {}),
        ...(input.country ? {
          onboarding: { businessDetails: { country: input.country } },
        } : {}),
        domains: hostname
          ? [
              {
                hostname,
                status: TENANT_DOMAIN_STATUS.ACTIVE,
                isPrimary: true,
              },
            ]
          : [],
      },
    ],
    options.session ? { session: options.session } : undefined,
  );

  return tenant;
};
