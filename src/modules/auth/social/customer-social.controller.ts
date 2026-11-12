import type { Request, Response } from "express";

import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { AppError, badRequest } from "@/shared/http/httpErrors.js";

import {
  getRefreshCookieCleanupOptions,
  getRefreshCookieOptions,
  requiresFirstPartyRefreshProxy,
} from "../auth.utils.js";
import { resolveAuthRequestContext } from "../auth-first-party-proxy.js";
import {
  createSessionHandoff,
  isSessionHandoffConfigured,
} from "../auth-session-handoff.js";
import {
  CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
} from "../auth.constants.js";
import {
  customerSocialCallbackSchema,
  customerSocialProviderSchema,
  customerSocialProvidersQuerySchema,
  customerSocialStartQuerySchema,
} from "./customer-social.validators.js";
import {
  beginCustomerSocialSignIn,
  finishCustomerSocialSignIn,
  getCustomerSocialProviders,
} from "./customer-social.service.js";

const noStore = (res: Response): void => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
};

export const listCustomerSocialProviders = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { tenantSlug } =
      customerSocialProvidersQuerySchema.parse(req.query);
    noStore(res);
    res.status(200).json(
      await getCustomerSocialProviders(tenantSlug),
    );
  },
);

export const startCustomerSocialSignIn = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const requestContext = await resolveAuthRequestContext(req);
    const provider = customerSocialProviderSchema.parse(
      req.params.provider,
    );
    const query = customerSocialStartQuerySchema.parse(req.query);
    const requestedReturnOrigin =
      query.returnOrigin || requestContext.origin || undefined;

    if (
      requestedReturnOrigin &&
      requiresFirstPartyRefreshProxy(requestedReturnOrigin) &&
      !isSessionHandoffConfigured()
    ) {
      throw new AppError({
        statusCode: 503,
        message: "Custom-domain social authentication is not configured.",
        code: "AUTH_SESSION_HANDOFF_NOT_CONFIGURED",
      });
    }

    const authorizationUrl = await beginCustomerSocialSignIn({
      provider,
      ...query,
      returnOrigin: requestedReturnOrigin,
    });

    noStore(res);
    res.redirect(302, authorizationUrl);
  },
);

export const completeCustomerSocialSignIn = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const provider = customerSocialProviderSchema.parse(
      req.params.provider,
    );
    const input = customerSocialCallbackSchema.parse({
      ...(req.query ?? {}),
      ...(req.body ?? {}),
    });
    const oldRefreshToken = req.cookies?.[
      CUSTOMER_REFRESH_TOKEN_COOKIE_NAME
    ] as string | undefined;
    const legacyRefreshToken = req.cookies?.[
      REFRESH_TOKEN_COOKIE_NAME
    ] as string | undefined;
    const result = await finishCustomerSocialSignIn({
      provider,
      state: input.state,
      code: input.code,
      providerError: input.error,
      appleUser:
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>).user
          : undefined,
      oldRefreshToken,
      legacyRefreshToken,
    });

    noStore(res);
    let redirectUrl = result.redirectUrl;

    if (result.session) {
      const cookieOrigin = new URL(result.redirectUrl).origin;
      const requiresHandoff = requiresFirstPartyRefreshProxy(cookieOrigin);

      if (oldRefreshToken) {
        for (
          const options of getRefreshCookieCleanupOptions(
            cookieOrigin,
          )
        ) {
          res.clearCookie(
            CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
            options,
          );
        }
      }

      if (requiresHandoff) {
        if (!isSessionHandoffConfigured()) {
          throw new AppError({
            statusCode: 503,
            message: "Custom-domain social authentication is not configured.",
            code: "AUTH_SESSION_HANDOFF_NOT_CONFIGURED",
          });
        }

        const redirect = new URL(result.redirectUrl);
        const fragment = new URLSearchParams(redirect.hash.slice(1));

        fragment.set(
          "sessionHandoff",
          createSessionHandoff({
            refreshToken: result.session.refreshToken,
            authContext: result.session.authContext,
            origin: cookieOrigin,
          }),
        );
        redirect.hash = fragment.toString();
        redirectUrl = redirect.toString();
      } else {
        res.cookie(
          CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
          result.session.refreshToken,
          getRefreshCookieOptions(cookieOrigin),
        );
      }

      if (result.session.migratedLegacyCustomerSession) {
        for (const options of getRefreshCookieCleanupOptions(cookieOrigin)) {
          res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, options);
        }
      }
    }

    if (!redirectUrl) {
      badRequest("Customer social sign-in redirect is missing.");
    }

    // Apple callbacks use form_post. 303 deliberately converts the browser's
    // next request into a GET and prevents form resubmission.
    res.redirect(303, redirectUrl);
  },
);
