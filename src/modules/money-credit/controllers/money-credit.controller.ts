import type { Request, Response } from "express";

import { AUTH_CONTEXT } from "@/modules/auth/auth.constants.js";
import { assertAuthContext } from "@/modules/auth/middleware/requireAuthContext.js";
import {
  getAuthenticatedUserId,
  getAuthenticatedUserName,
} from "@/modules/auth/auth.utils.js";
import { badRequest, unauthorized } from "@/shared/http/httpErrors.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import { creditCheckoutService } from "../services/credit-checkout.service.js";
import { moneyCreditService } from "../services/money-credit.service.js";
import {
  addCreditsSchema,
  adminGrantCreditsSchema,
  purchaseCreditsSchema,
  refundCreditsSchema,
  transactionQuerySchema,
  useCreditsSchema,
  userIdParamsSchema,
} from "../money-credit.validators.js";
import { validateCreditIdempotencyKey } from "../money-credit.direct-idempotency.js";

const getCreditMutationContext = (req: Request) => ({
  actorUserId: getAuthenticatedUserId(req),
  idempotencyKey: validateCreditIdempotencyKey(req.get("Idempotency-Key")),
});

const assertCanAccessCreditOwner = async (
  req: Request,
  targetUserId: string,
): Promise<void> => {
  const currentUserId = getAuthenticatedUserId(req);

  if (currentUserId === targetUserId) return;

  // Never reinterpret the underlying membership of a customer-mode owner.
  assertAuthContext(req, AUTH_CONTEXT.WORKSPACE);

  const access = await resolveWorkspaceAccessForUser({
    tenantId: requireTenantId(req),
    userId: currentUserId,
  });

  if (hasWorkspacePermission(access, WORKSPACE_PERMISSION.CREDITS_VIEW)) {
    return;
  }

  unauthorized();
};

export const getMyCreditBalance = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const userId = getAuthenticatedUserId(req);
    const result = await moneyCreditService.getBalance(tenantId, userId);

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.json(result);
  },
);

export const getMyCreditTransactions = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const userId = getAuthenticatedUserId(req);
    const pagination = transactionQuerySchema.parse(req.query);
    const result = await moneyCreditService.getTransactions(
      tenantId,
      userId,
      pagination,
    );

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.json(result);
  },
);

export const getCreditBalance = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { userId } = userIdParamsSchema.parse(req.params);

    await assertCanAccessCreditOwner(req, userId);

    const result = await moneyCreditService.getBalance(tenantId, userId);

    res.json(result);
  },
);

export const getCreditTransactions = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { userId } = userIdParamsSchema.parse(req.params);

    const pagination = transactionQuerySchema.parse(req.query);

    await assertCanAccessCreditOwner(req, userId);

    const result = await moneyCreditService.getTransactions(
      tenantId,
      userId,
      pagination,
    );

    res.json(result);
  },
);

export const addCredits = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const input = addCreditsSchema.parse(req.body);

  const result = await moneyCreditService.addCredits(
    tenantId,
    getCreditMutationContext(req),
    input,
  );

  res.json(result);
});

export const useCredits = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const input = useCreditsSchema.parse(req.body);

  const result = await moneyCreditService.useCredits(
    tenantId,
    getCreditMutationContext(req),
    input,
  );

  res.json(result);
});

export const refundCredits = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = refundCreditsSchema.parse(req.body);

    const result = await moneyCreditService.refundCredits(
      tenantId,
      getCreditMutationContext(req),
      input,
    );

    res.json(result);
  },
);

export const purchaseCredits = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = purchaseCreditsSchema.parse(req.body);
    const currentUserId = getAuthenticatedUserId(req);

    const result = await creditCheckoutService.createCreditPurchaseCheckout(
      tenantId,
      currentUserId,
      {
        ...input,
        origin: req.get("origin") || input.origin,
      },
    );

    res.json(result);
  },
);

export const adminGrantCredits = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = adminGrantCreditsSchema.parse(req.body);
    const currentUserId = getAuthenticatedUserId(req);
    const idempotencyKey = validateCreditIdempotencyKey(
      req.get("Idempotency-Key"),
    );

    if (input.idempotencyKey && input.idempotencyKey !== idempotencyKey) {
      badRequest({
        message:
          "The body idempotency key must match the Idempotency-Key header.",
        code: "CREDIT_IDEMPOTENCY_KEY_MISMATCH",
      });
    }

    const result = await moneyCreditService.adminGrantCredits(
      tenantId,
      currentUserId,
      getAuthenticatedUserName(req),
      idempotencyKey,
      input,
    );

    res.json(result);
  },
);
