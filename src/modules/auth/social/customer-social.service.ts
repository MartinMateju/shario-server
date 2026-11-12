import { randomBytes } from "node:crypto";

import type { Types } from "mongoose";

import { logger } from "@/config/logger.js";
import {
  buildAccessToken,
  buildRefreshToken,
  normalizeEmail,
  verifyRefreshToken,
} from "@/modules/auth/auth.utils.js";
import { AUTH_CONTEXT } from "@/modules/auth/auth.constants.js";
import { createAuthRepository } from "@/modules/auth/auth.repository.js";
import { findPublishedTenantBySlug } from "@/modules/setup-center/setup-publication.service.js";
import { getTenantBySlug } from "@/modules/tenants/services/tenant.service.js";
import { TENANT_STATUS } from "@/modules/tenants/tenant.constants.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import { resolveTenantCommerceOrigin } from "@/modules/checkout/checkout.urls.js";
import type { AuthTenantForToken } from "@/modules/auth/auth.types.js";
import UserModel from "@/modules/user/user.model.js";
import { PLATFORM_ROLE, TENANT_ROLE } from "@/modules/user/user.constants.js";
import { isPlatformHost } from "@/modules/tenants/tenant.utils.js";
import { badRequest, forbidden, notFound } from "@/shared/http/httpErrors.js";
import type { RolloutEligibleAppLocale } from "@/shared/i18n/locales.js";

import CustomerSocialIdentityModel from "./customer-social-identity.schema.js";
import {
  CUSTOMER_SOCIAL_ERROR,
  CUSTOMER_SOCIAL_PROVIDER,
  type CustomerSocialProvider,
} from "./customer-social.constants.js";
import {
  getCustomerSocialProviderAvailability,
  getCustomerSocialProviderConfig,
} from "./customer-social.config.js";
import {
  buildCustomerSocialAuthorizationUrl,
  verifyCustomerSocialCode,
  type VerifiedCustomerSocialProfile,
} from "./customer-social.provider.js";
import {
  consumeCustomerSocialState,
  createCustomerSocialState,
  type CustomerSocialStatePayload,
} from "./customer-social.state.js";

type SocialUser = InstanceType<typeof UserModel>;

const toId = (value: unknown): string => String(value ?? "").trim();

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 11000,
  );

const buildCustomId = (): string =>
  `U-${Date.now().toString(36).toUpperCase()}-${randomBytes(5)
    .toString("hex")
    .toUpperCase()}`;

/**
 * Accepts only the tenant's standard subdomain, one of its active custom
 * domains. Arbitrary and platform-root origins fall back to the tenant's
 * standard origin so customer completion never loses tenant context.
 */
export const resolveCustomerSocialReturnOrigin = ({
  tenant,
  requestedOrigin,
}: {
  tenant: {
    slug: string;
    domains?: Array<{
      hostname?: string;
      status?: string;
    }>;
  };
  requestedOrigin?: unknown;
}): string => {
  const standard = resolveTenantCommerceOrigin({ tenant });

  if (typeof requestedOrigin !== "string" || !requestedOrigin.trim()) {
    return standard;
  }

  let candidate = "";

  try {
    const parsed = new URL(requestedOrigin);

    if (
      parsed.username ||
      parsed.password ||
      isPlatformHost(parsed.hostname) ||
      (process.env.NODE_ENV === "production" &&
        (parsed.protocol !== "https:" || parsed.port))
    ) {
      return standard;
    }

    candidate = parsed.origin;
  } catch {
    return standard;
  }

  const resolved = resolveTenantCommerceOrigin({
    tenant,
    requestedOrigin: candidate,
  });

  return resolved === candidate ? candidate : standard;
};

const buildCompletionRedirect = ({
  state,
  error,
}: {
  state: CustomerSocialStatePayload;
  error?: string;
}): string => {
  const url = new URL(`/${state.locale}/login/complete`, state.returnOrigin);
  url.searchParams.set("next", state.next);

  if (error) {
    url.searchParams.set("socialError", error);
  } else {
    url.searchParams.set("socialProvider", state.provider);
  }

  return url.toString();
};

const assertCustomerPortalIdentity = async ({
  user,
  allowGuestClaim = false,
}: {
  user: SocialUser;
  allowGuestClaim?: boolean;
}): Promise<void> => {
  const platformRole =
    String(user.platformRole ?? PLATFORM_ROLE.NONE).toLowerCase();

  // An owner or staff identity may deliberately enter the customer portal,
  // just like the dedicated password flow. The issued token contains no
  // workspace claims and platform identities remain ineligible.
  if (platformRole !== PLATFORM_ROLE.NONE) {
    forbidden({
      message: "Platform accounts cannot enter a customer portal session.",
      code: "CUSTOMER_SOCIAL_PLATFORM_ACCOUNT_FORBIDDEN",
    });
  }

  const isGeneratedGuest =
    allowGuestClaim &&
    user.isAccessGranted === false &&
    /^G-[a-f0-9]{20}$/i.test(String(user.customId ?? ""));

  if (user.isAccessGranted === false && !isGeneratedGuest) {
    forbidden({
      message: "This customer account is not active.",
      code: "CUSTOMER_SOCIAL_ACCOUNT_DISABLED",
    });
  }
};

const loadSocialUser = async ({
  tenantId,
  userId,
}: {
  tenantId: string;
  userId: unknown;
}): Promise<SocialUser> => {
  const user = await UserModel.findOne({
    _id: userId,
    tenant: tenantId,
  })
    .select("+tenantRole +platformRole +sessionVersion")
    .exec();

  if (!user) {
    forbidden({
      message: "This customer identity is no longer available.",
      code: "CUSTOMER_SOCIAL_IDENTITY_ORPHANED",
    });
  }

  await assertCustomerPortalIdentity({ user });
  return user;
};

export const resolveCustomerIdentity = async ({
  tenantId,
  profile,
}: {
  tenantId: string;
  profile: VerifiedCustomerSocialProfile;
}): Promise<SocialUser> => {
  const existingIdentity = await CustomerSocialIdentityModel.findOne({
    tenant: tenantId,
    provider: profile.provider,
    subject: profile.subject,
  })
    .lean()
    .exec();

  if (existingIdentity) {
    const user = await loadSocialUser({
      tenantId,
      userId: existingIdentity.user,
    });

    await CustomerSocialIdentityModel.updateOne(
      { _id: existingIdentity._id },
      {
        $set: {
          providerEmail: profile.email,
          emailVerified: true,
          lastAuthenticatedAt: new Date(),
        },
      },
    ).exec();

    return user;
  }

  const email = normalizeEmail(profile.email);
  let user = await UserModel.findOne({
    tenant: tenantId,
    email,
  })
    .select("+tenantRole +platformRole +sessionVersion")
    .exec();

  if (user) {
    await assertCustomerPortalIdentity({
      user,
      allowGuestClaim: true,
    });
  } else {
    try {
      user = await UserModel.create({
        tenant: tenantId,
        firstname: profile.firstname,
        lastname: profile.lastname,
        email,
        phone: "",
        // The value is never disclosed and exists only because historical
        // User records require a password. Social authentication never sends
        // it through the password-login endpoint.
        password: randomBytes(48).toString("base64url"),
        customId: buildCustomId(),
        tenantRole: TENANT_ROLE.CUSTOMER,
        platformRole: PLATFORM_ROLE.NONE,
        roles: [],
        isAccessGranted: true,
        isEmailVerified: true,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      user = await UserModel.findOne({
        tenant: tenantId,
        email,
      })
        .select("+tenantRole +platformRole +sessionVersion")
        .exec();

      if (!user) throw error;
      await assertCustomerPortalIdentity({ user });
    }
  }

  // A verified provider may claim the explicit guest record created by
  // one-off course checkout, preserving its order and booking history. An
  // ordinary disabled/suspended customer is rejected above and never
  // reactivated implicitly.
  user.isAccessGranted = true;
  user.isEmailVerified = true;
  await user.save();

  try {
    await CustomerSocialIdentityModel.create({
      tenant: tenantId,
      user: user._id,
      provider: profile.provider,
      subject: profile.subject,
      providerEmail: email,
      emailVerified: true,
      lastAuthenticatedAt: new Date(),
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const winner = await CustomerSocialIdentityModel.findOne({
      tenant: tenantId,
      provider: profile.provider,
      subject: profile.subject,
    })
      .lean()
      .exec();

    if (!winner) throw error;

    return loadSocialUser({
      tenantId,
      userId: winner.user,
    });
  }

  return user;
};

const issueCustomerSession = async ({
  tenant,
  user,
  oldRefreshToken,
  legacyRefreshToken,
}: {
  tenant: AuthTenantForToken;
  user: SocialUser;
  oldRefreshToken?: string;
  legacyRefreshToken?: string;
}) => {
  const tenantId = toId(tenant._id ?? tenant.id);
  const userId = toId(user._id);
  const repository = createAuthRepository({ tenantId });
  let previousToken = oldRefreshToken;
  let migratedLegacyCustomerSession = false;

  if (!previousToken && legacyRefreshToken) {
    try {
      const decoded = verifyRefreshToken(legacyRefreshToken);
      const matchesLegacyIdentity =
        decoded.authContext === undefined &&
        toId(decoded.tenant) === tenantId &&
        toId(decoded.id) === userId;
      const isPureLegacyCustomer =
        String(user.tenantRole) === TENANT_ROLE.CUSTOMER &&
        String(user.platformRole ?? PLATFORM_ROLE.NONE).toLowerCase() ===
          PLATFORM_ROLE.NONE;

      if (matchesLegacyIdentity && isPureLegacyCustomer) {
        const hasWorkspaceMembership = await TenantMembershipModel.exists({
          tenant: tenantId,
          user: user._id,
        });

        if (!hasWorkspaceMembership) {
          previousToken = legacyRefreshToken;
          migratedLegacyCustomerSession = true;
        }
      }
    } catch {
      // Ignore unrelated or expired workspace cookies during social sign-in.
    }
  }

  const accessToken = buildAccessToken(
    user,
    tenant,
    null,
    AUTH_CONTEXT.CUSTOMER,
  );
  const refreshToken = buildRefreshToken(
    user,
    tenant,
    AUTH_CONTEXT.CUSTOMER,
  );

  await repository.rotateRefreshToken({
    userId: user._id as Types.ObjectId,
    oldRefreshToken: previousToken,
    newRefreshToken: refreshToken,
  });

  return {
    accessToken,
    refreshToken,
    user,
    tenant,
    workspaceAccess: null,
    authContext: AUTH_CONTEXT.CUSTOMER,
    migratedLegacyCustomerSession,
  };
};

const safeErrorCode = (error: unknown): string => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";

  if (
    code.includes("WORKSPACE_ACCOUNT") ||
    code.includes("PLATFORM_ACCOUNT") ||
    code.includes("ACCOUNT_DISABLED") ||
    code.includes("IDENTITY_ORPHANED")
  ) {
    return CUSTOMER_SOCIAL_ERROR.ACCOUNT_CONFLICT;
  }

  if (code.includes("PROVIDER_UNAVAILABLE")) {
    return CUSTOMER_SOCIAL_ERROR.PROVIDER_UNAVAILABLE;
  }

  return CUSTOMER_SOCIAL_ERROR.AUTHENTICATION_FAILED;
};

export const getCustomerSocialProviders = async (tenantSlug: string) => {
  const publishedTenant = await findPublishedTenantBySlug(tenantSlug);
  const tenant = publishedTenant || (await getTenantBySlug(tenantSlug));

  if (!tenant || tenant.status !== TENANT_STATUS.ACTIVE) {
    notFound({
      message: "Workspace not found.",
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });
  }

  /*
   * The shared login page is also used by an owner immediately after tenant
   * creation, before the public studio has been published. Provider discovery
   * must therefore be a harmless 200 instead of a noisy public-workspace 404.
   *
   * Social authentication itself remains publication-gated in
   * beginCustomerSocialSignIn() and finishCustomerSocialSignIn(). Returning
   * every provider as unavailable here prevents an unpublished studio from
   * exposing or starting customer-only OAuth while ordinary owner/staff login
   * and onboarding remain usable.
   */
  const available = publishedTenant
    ? getCustomerSocialProviderAvailability()
    : {
        google: false,
        apple: false,
      };

  return {
    tenant: {
      id: String(tenant._id),
      slug: tenant.slug,
    },
    providers: {
      google: {
        available: available.google,
      },
      apple: {
        available: available.apple,
      },
    },
  };
};

export const beginCustomerSocialSignIn = async ({
  provider,
  tenantSlug,
  locale,
  next,
  returnOrigin,
}: {
  provider: CustomerSocialProvider;
  tenantSlug: string;
  locale: RolloutEligibleAppLocale;
  next: string;
  returnOrigin?: string;
}): Promise<string> => {
  const config = getCustomerSocialProviderConfig(provider);
  const tenant = await findPublishedTenantBySlug(tenantSlug);

  if (!tenant) {
    notFound({
      message: "Workspace not found.",
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });
  }

  const resolvedOrigin = resolveCustomerSocialReturnOrigin({
    tenant,
    requestedOrigin: returnOrigin,
  });
  const socialState = await createCustomerSocialState({
    provider,
    tenantId: String(tenant._id),
    tenantSlug: tenant.slug,
    locale,
    next,
    returnOrigin: resolvedOrigin,
  });

  return buildCustomerSocialAuthorizationUrl({
    config,
    state: socialState.state,
    nonce: socialState.nonce,
    codeChallenge: socialState.codeChallenge,
  });
};

export const finishCustomerSocialSignIn = async ({
  provider,
  state: encryptedState,
  code,
  providerError,
  appleUser,
  oldRefreshToken,
  legacyRefreshToken,
}: {
  provider: CustomerSocialProvider;
  state: string;
  code?: string;
  providerError?: string;
  appleUser?: unknown;
  oldRefreshToken?: string;
  legacyRefreshToken?: string;
}): Promise<
  | {
      redirectUrl: string;
      session: Awaited<ReturnType<typeof issueCustomerSession>>;
    }
  | {
      redirectUrl: string;
      session: null;
    }
> => {
  const state = await consumeCustomerSocialState({
    state: encryptedState,
    provider,
  });

  if (providerError || !code) {
    return {
      redirectUrl: buildCompletionRedirect({
        state,
        error: CUSTOMER_SOCIAL_ERROR.ACCESS_DENIED,
      }),
      session: null,
    };
  }

  try {
    const tenant = await findPublishedTenantBySlug(state.tenantSlug);

    if (!tenant || String(tenant._id) !== state.tenantId) {
      badRequest({
        message: "The customer workspace is no longer available.",
        code: "CUSTOMER_SOCIAL_TENANT_UNAVAILABLE",
      });
    }

    const revalidatedOrigin = resolveCustomerSocialReturnOrigin({
      tenant,
      requestedOrigin: state.returnOrigin,
    });

    if (revalidatedOrigin !== state.returnOrigin) {
      state.returnOrigin = revalidatedOrigin;
    }

    const profile = await verifyCustomerSocialCode({
      provider,
      code,
      nonce: state.nonce,
      codeVerifier: state.codeVerifier,
      appleUser,
    });
    const user = await resolveCustomerIdentity({
      tenantId: state.tenantId,
      profile,
    });
    const session = await issueCustomerSession({
      tenant,
      user,
      oldRefreshToken,
      legacyRefreshToken,
    });

    return {
      redirectUrl: buildCompletionRedirect({ state }),
      session,
    };
  } catch (error) {
    logger.warn(
      {
        provider,
        tenantId: state.tenantId,
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "UNKNOWN",
      },
      "Customer social sign-in failed.",
    );

    return {
      redirectUrl: buildCompletionRedirect({
        state,
        error: safeErrorCode(error),
      }),
      session: null,
    };
  }
};

export const isCustomerSocialProvider = (
  value: unknown,
): value is CustomerSocialProvider =>
  value === CUSTOMER_SOCIAL_PROVIDER.GOOGLE ||
  value === CUSTOMER_SOCIAL_PROVIDER.APPLE;


