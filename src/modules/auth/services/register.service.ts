import { createAuthRepository } from "@/modules/auth/auth.repository.js";
import { PLATFORM_ROLE, TENANT_ROLE } from "@/modules/user/user.constants.js";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";
import mongoose from "mongoose";

import type {
  AuthTenantForToken,
  RegisterInput,
} from "@/modules/auth/auth.types.js";
import { normalizeEmail } from "@/modules/auth/auth.utils.js";
import {
  createTenantWithPlan,
  getTenantByHostname,
  getTenantBySlug,
} from "@/modules/tenants/services/tenant.service.js";
import { createPendingTenantSubscription } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import {
  createOwnerMembership,
  type ResolvedWorkspaceAccess,
} from "@/modules/tenant-access/index.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import {
  resolveRegistrationPreferences,
  type RegistrationPreferences,
} from "../registration-preferences.js";

const toId = (value: unknown): string => String(value ?? "");

const buildCustomId = (): string => {
  return `U-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
};

const isTenantAddressDuplicateKeyError = (
  error: unknown,
): error is { code: number; keyPattern: Record<string, unknown> } => {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== 11000 ||
    !("keyPattern" in error) ||
    !error.keyPattern ||
    typeof error.keyPattern !== "object"
  ) {
    return false;
  }

  const keyPattern = error.keyPattern as Record<string, unknown>;

  return ["slug", "hostname", "domains.hostname"].some(
    (field) => field in keyPattern,
  );
};

export type RegisterTenantInput = RegisterInput & RegistrationPreferences & {
  tenantName: string;
  slug: string;
  hostname?: string;
  plan?: TenantPlan;
};

export const registerUser = async ({
  input,
  tenant,
}: {
  input: RegisterInput;
  tenant: AuthTenantForToken;
}) => {
  const tenantId = toId(tenant._id || tenant.id);

  if (!tenantId) {
    badRequest("Tenant context is required for registration.");
  }

  const email = normalizeEmail(input.email);
  const repository = createAuthRepository({ tenantId });

  const existingUser = await repository.findByEmailWithSecrets(email);

  if (existingUser) {
    conflict("User with this email already exists.");
  }

  return repository.createTenantUser({
    firstname: input.firstname.trim(),
    lastname: input.lastname.trim(),
    email,
    phone: input.phone?.trim() || "",
    password: input.password,
    customId: buildCustomId(),
    tenantRole: TENANT_ROLE.CUSTOMER,
    platformRole: PLATFORM_ROLE.NONE,
    roles: [],
    isAccessGranted: true,
    isEmailVerified: false,
  });
};

export const registerTenant = async ({
  input,
}: {
  input: RegisterTenantInput;
}) => {
  const tenantName = input.tenantName.trim();
  const slug = input.slug.trim().toLowerCase();
  const hostname = input.hostname?.trim().toLowerCase() || "";
  const email = normalizeEmail(input.email);

  if (!tenantName) {
    badRequest("Tenant name is required.");
  }

  if (!slug) {
    badRequest("Tenant slug is required.");
  }

  const existingSlug = await getTenantBySlug(slug);

  if (existingSlug) {
    conflict("Tenant with this slug already exists.");
  }

  if (hostname) {
    const existingHostname = await getTenantByHostname(hostname);

    if (existingHostname) {
      conflict("Tenant with this hostname already exists.");
    }
  }

  const preferences = resolveRegistrationPreferences(input);
  const session = await mongoose.startSession();

  try {
    let result:
      | {
        tenant: Awaited<ReturnType<typeof createTenantWithPlan>>;
        owner: Awaited<
          ReturnType<
            ReturnType<typeof createAuthRepository>["createTenantUser"]
          >
        >;
        workspaceAccess: ResolvedWorkspaceAccess;
      }
      | undefined;

    await session.withTransaction(async () => {
      const tenant = await createTenantWithPlan({
        name: tenantName,
        slug,
        hostname: hostname || undefined,
        plan: input.plan,
        settings: {
          currency: preferences.currency,
          timezone: preferences.timezone,
          adminLanguage: preferences.locale,
          publicDefaultLanguage: preferences.locale,
          supportedPublicLanguages: [preferences.locale],
        },
        country: preferences.country,
      }, { session });

      const tenantId = toId(tenant._id);

      /*
       * Billing bootstrap is part of the same transaction, but the 14-day
       * trial deliberately starts only when onboarding is completed. This
       * preserves the agreed no-card signup flow without consuming trial time
       * while the owner is still configuring the workspace.
       */
      await createPendingTenantSubscription({
        tenantId,
        session,
      });

      const repository = createAuthRepository({
        tenantId,
        session,
      });

      const existingUser = await repository.findByEmailWithSecrets(email);

      if (existingUser) {
        conflict("User with this email already exists.");
      }

      const owner = await repository.createTenantUser({
        firstname: input.firstname.trim(),
        lastname: input.lastname.trim(),
        email,
        phone: input.phone?.trim() || "",
        password: input.password,
        customId: buildCustomId(),
        tenantRole: TENANT_ROLE.OWNER,
        platformRole: PLATFORM_ROLE.NONE,
        roles: [],
        isAccessGranted: true,
        isEmailVerified: false,
      });

      const workspaceAccess = await createOwnerMembership({
        tenantId,
        userId: String(owner._id),
        session,
      });

      result = {
        tenant,
        owner,
        workspaceAccess,
      };
    });

    if (!result) {
      throw new Error(
        "Tenant registration transaction completed without a result.",
      );
    }

    return result;
  } catch (error) {
    /*
     * The preflight lookup gives the normal fast path, while the unique
     * database index remains authoritative under concurrent registrations.
     * Convert that race into the same stable API conflict instead of leaking a
     * MongoDB error as a 500 response.
     */
    if (isTenantAddressDuplicateKeyError(error)) {
      conflict({
        message: "Tenant with this slug or hostname already exists.",
        code: "TENANT_ADDRESS_TAKEN",
      });
    }

    throw error;
  } finally {
    await session.endSession();
  }
};
