import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { badRequest, unauthorized } from "../../../shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { productService } from "@/modules/product/services/product.service.js";
import { couponService } from "../coupon.service.js";
import { voucherLifecycleService } from "../voucher-lifecycle.service.js";
import {
  couponCheckoutSchema,
  couponFilterSchema,
  couponOrderFilterSchema,
  manualPromoCodeSchema,
  redeemCouponSchema,
  updateCouponOrderStatusSchema,
  revokeVoucherSchema,
  objectIdSchema,
} from "../coupon.validators.js";

type AuthenticatedRequest = Request & {
  userInfo?: {
    id?: string;
    email?: string;
    firstname?: string;
    lastname?: string;
    tenantRole?: string;
    platformRole?: string;
  };
};

const requireCurrentUser = (req: AuthenticatedRequest) => {
  const user = req.userInfo;

  if (!user?.id) {
    unauthorized("Authenticated user is required.");
  }

  return user;
};

export const revokeVoucher = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = requireTenantId(req);
  const currentUser = requireCurrentUser(req);
  const couponId = objectIdSchema("voucher id").parse(req.params.couponId);
  const input = revokeVoucherSchema.parse(req.body);
  const coupon = await voucherLifecycleService.revoke({ tenantId, couponId, actorId: currentUser.id, ...input });
  res.json({ message: "Voucher revoked", coupon });
});

export const getCoupons = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);

  const coupons = await productService.listPublicVoucherProducts({
    tenantId,
    limit: 100,
  });

  res.set("Cache-Control", "no-store, max-age=0");
  res.json(coupons);
});

export const sendCouponCheckout = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    const requestOrigin = req.get("origin");
    const parsed = couponCheckoutSchema.safeParse({
      ...body,
      ...(requestOrigin ? { origin: requestOrigin } : {}),
    });

    if (!parsed.success) {
      badRequest({
        code: "VOUCHER_CHECKOUT_INPUT_INVALID",
        message: "Invalid voucher checkout input.",
        details: parsed.error.flatten(),
      });
    }

    const input = parsed.data;

    const result = await couponService.createCheckout(tenantId, input);

    res.status(200).json(result);
  },
);

export const applyCouponPromoCode = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = requireTenantId(req);
    const currentUser = requireCurrentUser(req);
    const input = redeemCouponSchema.parse(req.body);

    const result = await couponService.redeemPromoCode({
      tenantId,
      userId: currentUser.id,
      input,
    });

    res.status(200).json(result);
  },
);

export const getUserRedeemedCoupons = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = requireTenantId(req);
    const currentUser = requireCurrentUser(req);

    const coupons = await couponService.getUserRedeemedCoupons(
      tenantId,
      currentUser.id,
    );

    res.json(coupons);
  },
);

export const getCouponOrdersWithFilters = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = couponOrderFilterSchema.parse(req.body);

    const result = await couponService.listCouponOrders({
      ...filters,
      tenantId,
    });

    res.json(result);
  },
);

export const getCouponsWithFilters = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = couponFilterSchema.parse(req.body);

    const result = await couponService.listCoupons({
      ...filters,
      tenantId,
    });

    res.json(result);
  },
);

export const createManualPromoCode = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = requireTenantId(req);
    const currentUser = requireCurrentUser(req);
    const input = manualPromoCodeSchema.parse(req.body);

    const result = await couponService.createManualPromoCode({
      tenantId,
      input,
      createdBy: currentUser.id,
    });

    res.status(201).json(result);
  },
);

export const updateCouponOrderStatus = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = requireTenantId(req);
    const currentUser = requireCurrentUser(req);
    const input = updateCouponOrderStatusSchema.parse(req.body);

    const result = await couponService.updateCouponOrderStatus({
      tenantId,
      input,
      admin: {
        id: currentUser.id,
        firstname: currentUser.firstname,
        lastname: currentUser.lastname,
        email: currentUser.email || "",
        tenantRole: currentUser.tenantRole,
        platformRole: currentUser.platformRole,
      },
    });

    res.json(result);
  },
);
