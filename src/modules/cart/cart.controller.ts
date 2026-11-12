import type { Request, Response } from "express";

import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";

import {
  addActiveCartItem,
  checkCreditsForCart as checkCreditsForCartService,
  clearCart,
  convertCart,
  getActiveCart,
  getUserCartSummary,
  listTenantCarts,
  removeActiveCartItem,
  updateActiveCartItem,
} from "./cart.service.js";

import {
  requirePositiveInteger,
  requirePositiveNumber,
  requireString,
} from "./cart.validators.js";

export const getCart = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const userId = getAuthenticatedUserId(req);

  const cart = await getActiveCart({ tenantId, userId });

  res.json(cart);
});

export const getUserCart = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const userId = requireString(req.params.userId, "userId");

  const result = await getUserCartSummary({ tenantId, userId });

  res.json(result);
});

export const checkCreditsForCart = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const userId = getAuthenticatedUserId(req);
    const cartTotal = requirePositiveNumber(req.body.cartTotal, "cartTotal");

    const result = await checkCreditsForCartService({
      tenantId,
      userId,
      cartTotal,
    });

    res.json(result);
  },
);

export const addCartItem = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const userId = getAuthenticatedUserId(req);

  const cart = await addActiveCartItem({
    tenantId,
    userId,
    item: {
      productId: requireString(req.body.productId, "productId"),
      quantity:
        req.body.quantity === undefined
          ? 1
          : requirePositiveInteger(req.body.quantity, "quantity"),
      basePrice: requirePositiveNumber(req.body.basePrice, "basePrice"),
      extraCharge:
        req.body.extraCharge === undefined
          ? 0
          : requirePositiveNumber(req.body.extraCharge, "extraCharge"),
      numberOfPeople:
        req.body.numberOfPeople === undefined
          ? 1
          : requirePositiveInteger(req.body.numberOfPeople, "numberOfPeople"),
    },
  });

  res.status(201).json(cart);
});

export const updateCartItem = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const cartId = requireString(req.params.cartId, "cartId");
    const itemId = requireString(req.params.itemId, "itemId");
    const userId = getAuthenticatedUserId(req);

    const cart = await updateActiveCartItem({
      tenantId,
      cartId,
      itemId,
      userId,
      input: {
        quantity:
          req.body.quantity === undefined
            ? undefined
            : requirePositiveInteger(req.body.quantity, "quantity"),
        basePrice:
          req.body.basePrice === undefined
            ? undefined
            : requirePositiveNumber(req.body.basePrice, "basePrice"),
        extraCharge:
          req.body.extraCharge === undefined
            ? undefined
            : requirePositiveNumber(req.body.extraCharge, "extraCharge"),
        numberOfPeople:
          req.body.numberOfPeople === undefined
            ? undefined
            : requirePositiveInteger(req.body.numberOfPeople, "numberOfPeople"),
      },
    });

    res.json(cart);
  },
);

export const removeCartItem = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const cartId = requireString(req.params.cartId, "cartId");
    const itemId = requireString(req.params.itemId, "itemId");
    const userId = getAuthenticatedUserId(req);

    const cart = await removeActiveCartItem({
      tenantId,
      cartId,
      itemId,
      userId,
    });

    res.json(cart);
  },
);

export const clearActiveCart = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const userId = getAuthenticatedUserId(req);

    const cart = await clearCart({
      tenantId,
      userId,
    });

    res.json(cart);
  },
);

export const convertActiveCart = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const cartId = requireString(req.params.cartId, "cartId");
    const userId = getAuthenticatedUserId(req);

    const cart = await convertCart({
      tenantId,
      cartId,
      userId,
    });

    res.json(cart);
  },
);

export const getCartsWithFilters = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);

    const page = Math.max(1, Number(req.body.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.body.limit || 20)));

    const result = await listTenantCarts({
      tenantId,
      page,
      limit,
      sortBy: req.body.sortBy,
      sortOrder: req.body.sortOrder === "asc" ? "asc" : "desc",
    });

    res.json(result);
  },
);
