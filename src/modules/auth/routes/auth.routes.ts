import { Router } from "express";

import { loginLimiter } from "@/shared/middleware/loginLimiter.js";
import {
  acceptPublicTeamInvitation,
  previewPublicTeamInvitation,
} from "@/modules/tenant-access/controllers/team-invitation.controller.js";
import { publicTenantLookupLimiter } from "@/modules/checkout/checkout.public-limiter.js";

import {
  login,
  loginCustomer,
  exchangeCustomerSessionHandoff,
  exchangeWorkspaceSessionHandoff,
  logout,
  logoutCustomer,
  refresh,
  refreshCustomer,
} from "../controllers/auth.controller.js";
import {
  registerCustomer,
  registerTenant,
} from "../controllers/register.controller.js";
import {
  requestCustomerEmailVerification,
  resendCustomerEmailVerification,
  verifyCustomerEmail,
} from "@/modules/verification/controllers/user-verification.controller.js";
import {
  emailVerificationRequestLimiter,
  emailVerificationVerifyLimiter,
} from "@/modules/verification/user-verification.limiter.js";
import {
  completeCustomerSocialSignIn,
  listCustomerSocialProviders,
  startCustomerSocialSignIn,
} from "../social/customer-social.controller.js";

export const authRouter = Router();

// Tokens travel in POST bodies, never API URLs or access logs. These endpoints
// establish no session; successful acceptance uses the existing login flow.
authRouter.post(
  "/team-invitations/preview",
  publicTenantLookupLimiter,
  previewPublicTeamInvitation,
);
authRouter.post(
  "/team-invitations/accept",
  loginLimiter,
  acceptPublicTeamInvitation,
);

/*
|--------------------------------------------------------------------------
| Authentication
|--------------------------------------------------------------------------
*/

authRouter.post("/", loginLimiter, login);
authRouter.post("/logout", logout);
authRouter.post("/refresh", refresh);
authRouter.post(
  "/session-handoff",
  loginLimiter,
  exchangeWorkspaceSessionHandoff,
);

// Explicit end-customer session. It uses an independent refresh cookie and
// never exposes workspace claims, even when the same account is owner/staff.
authRouter.post("/customer", loginLimiter, loginCustomer);
authRouter.post("/customer/login", loginLimiter, loginCustomer);
authRouter.post("/customer/logout", logoutCustomer);
authRouter.post("/customer/refresh", refreshCustomer);
authRouter.post(
  "/customer/session-handoff",
  loginLimiter,
  exchangeCustomerSessionHandoff,
);

/*
|--------------------------------------------------------------------------
| End-customer social authentication
|--------------------------------------------------------------------------
|
| These routes never create or resolve tenant/workspace privileges. Existing
| non-platform owner/staff identities may explicitly use customer mode, but
| the resulting session contains customer-only claims.
|
*/

authRouter.get(
  "/customer/social/providers",
  publicTenantLookupLimiter,
  listCustomerSocialProviders,
);
authRouter.get(
  "/customer/social/:provider/start",
  loginLimiter,
  startCustomerSocialSignIn,
);
authRouter
  .route("/customer/social/:provider/callback")
  .get(completeCustomerSocialSignIn)
  .post(completeCustomerSocialSignIn);

/*
|--------------------------------------------------------------------------
| Registration
|--------------------------------------------------------------------------
*/

// End-customer registration inside an existing tenant.
authRouter.post("/register", loginLimiter, registerCustomer);

// New tenant and owner registration.
authRouter.post("/tenant/register", loginLimiter, registerTenant);

/*
|--------------------------------------------------------------------------
| End-customer email verification
|--------------------------------------------------------------------------
*/

authRouter.post(
  "/customer/email-verification/request",
  emailVerificationRequestLimiter,
  requestCustomerEmailVerification,
);

authRouter.post(
  "/customer/email-verification/resend",
  emailVerificationRequestLimiter,
  resendCustomerEmailVerification,
);

authRouter.post(
  "/customer/email-verification/verify",
  emailVerificationVerifyLimiter,
  verifyCustomerEmail,
);

export default authRouter;
