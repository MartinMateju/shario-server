import express from "express";

import {
  requestCustomerEmailVerification,
  resendCustomerEmailVerification,
  verifyCustomerEmail,
} from "../controllers/user-verification.controller.js";
import {
  emailVerificationRequestLimiter,
  emailVerificationVerifyLimiter,
} from "../user-verification.limiter.js";

const router = express.Router();

router.post(
  "/request",
  emailVerificationRequestLimiter,
  requestCustomerEmailVerification,
);
router.post(
  "/resend",
  emailVerificationRequestLimiter,
  resendCustomerEmailVerification,
);
router.post(
  "/verify",
  emailVerificationVerifyLimiter,
  verifyCustomerEmail,
);

export default router;
