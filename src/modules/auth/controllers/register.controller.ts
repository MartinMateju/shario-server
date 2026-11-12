import type { Request, Response } from "express";

import { logger } from "@/config/logger.js";
import {
  findPublishedTenantBySlug,
  requirePublishedTenantId,
} from "@/modules/setup-center/setup-publication.service.js";
import { serializeWorkspaceAccess } from "@/modules/tenant-access/index.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import { verificationService } from "@/modules/verification/services/user-verification.service.js";
import type { VerificationTenant } from "@/modules/verification/user-verification.types.js";

import { REFRESH_TOKEN_COOKIE_NAME } from "../auth.constants.js";
import type { AuthenticatedRequest } from "../auth.types.js";
import {
  getRefreshCookieOptions,
  requiresFirstPartyRefreshProxy,
} from "../auth.utils.js";
import { resolveAuthRequestContext } from "../auth-first-party-proxy.js";
import {
  registerSchema,
  registerTenantSchema,
  validateBody,
} from "../auth.validators.js";
import {
  registerNewTenant,
} from "../services/auth.service.js";
import {
  registerUser,
} from "../services/register.service.js";

/*
|--------------------------------------------------------------------------
| Register customer
|--------------------------------------------------------------------------
|
| Creates a customer inside an existing tenant.
| Current clients send a tenant slug because they call the central API host.
| A pre-resolved tenant remains supported for trusted hostname middleware.
|
*/

export const registerCustomer = asyncHandler(
  async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    const requestContext = await resolveAuthRequestContext(req);
    const input = validateBody(registerSchema, req.body);
    const {
      tenantSlug,
      next,
      locale,
      ...registrationInput
    } = input;

    const tenant = tenantSlug
      ? await findPublishedTenantBySlug(tenantSlug)
      : req.tenant;

    if (!tenant) {
      notFound({
        message: "Workspace not found.",
        code: "PUBLIC_WORKSPACE_NOT_FOUND",
      });
    }

    if (!tenantSlug) {
      await requirePublishedTenantId(tenant._id ?? tenant.id);
    }

    const user = await registerUser({
      input: registrationInput,
      tenant,
    });

    try {
      await verificationService.sendVerificationEmail(
        {
          tenant:
            tenant as unknown as VerificationTenant,
          userId: user._id,
          email: user.email,
          requestedOrigin:
            requestContext.origin ||
            undefined,
          next,
          locale,
        },
      );
    } catch (error) {
      /*
       * The account already exists at this point. Returning a registration
       * error would strand the customer on a duplicate-email retry, so email
       * delivery remains recoverable through the generic resend endpoint.
       */
      logger.error(
        {
          err: error,
          tenantId: String(
            tenant._id ??
              tenant.id,
          ),
          userId: String(
            user._id,
          ),
        },
        "Initial verification email delivery failed.",
      );
    }

    res.status(201).json({
      verificationRequired: true,
      user: {
        id: String(user._id),
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        customId: user.customId,
        memberNumber: user.memberNumber ?? null,
        tenant: String(user.tenant),
        tenantRole: user.tenantRole,
        isEmailVerified:
          user.isEmailVerified ===
          true,
      },
    });
  },
);

/*
|--------------------------------------------------------------------------
| Register tenant
|--------------------------------------------------------------------------
|
| Creates:
| - the new tenant,
| - its owner,
| - access and refresh tokens,
| - the refresh-token cookie.
|
| This endpoint must not require an existing tenant context.
|
*/

export const registerTenant = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const requestContext = await resolveAuthRequestContext(req);

    if (
      !requestContext.firstPartyProxy &&
      requestContext.origin &&
      requiresFirstPartyRefreshProxy(requestContext.origin)
    ) {
      forbidden({
        message: "Custom-domain tenant registration must use the first-party authentication proxy.",
        code: "AUTH_FIRST_PARTY_PROXY_REQUIRED",
      });
    }

    const input = validateBody(
      registerTenantSchema,
      req.body,
    );

    const {
      accessToken,
      refreshToken,
      authContext,
      user,
      tenant,
      workspaceAccess,
    } = await registerNewTenant({
      input,
    });

    res.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      refreshToken,
      getRefreshCookieOptions(requestContext.origin, {
        firstPartyProxy: requestContext.firstPartyProxy,
      }),
    );

    res.status(201).json({
      accessToken,
      authContext,

      user: {
        authContext,
        id: String(user._id),
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        customId: user.customId,
        memberNumber: user.memberNumber ?? null,
        tenant: String(user.tenant),
        tenantRole: user.tenantRole,
        platformRole: user.platformRole,
        isAccessGranted: user.isAccessGranted,
        isEmailVerified: user.isEmailVerified,
      },

      tenant: {
        id: String(tenant._id),
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        plan: tenant.plan,
        planVersion: tenant.planVersion,
        domains: tenant.domains,
        modules: tenant.modules,
        limits: tenant.limits,
        settings: tenant.settings,
        onboarding: tenant.onboarding,
      },

      workspaceAccess: serializeWorkspaceAccess(
        workspaceAccess,
      ),
    });
  },
);

