import { notFound } from "../../shared/http/httpErrors.js";
import UserModel from "@/modules/user/user.model.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";

import {
  addItemToCart,
  clearActiveCart,
  findActiveCart,
  findOrCreateActiveCart,
  listCarts,
  markCartConverted,
  removeCartItem,
  updateCartItem,
} from "@/modules/cart/cart.repository.js";
import type { AddCartItemInput, CheckCreditsInput, UpdateCartItemInput } from "./cart.types.js";
import { toObjectId } from "./cart.utils.js";

export const getActiveCart = async ({
  tenantId,
  userId,
  sessionId,
}: {
  tenantId: string;
  userId?: string;
  sessionId?: string;
}) => {
  const tenant = await getTenantOrThrow(tenantId);
  const currency = normalizeStudioCommerceCurrency(tenant.settings.currency);

  return findOrCreateActiveCart({
    tenantId,
    userId,
    sessionId,
    currency,
  });
};

export const getUserCartSummary = async ({
  tenantId,
  userId,
}: {
  tenantId: string;
  userId: string;
}) => {
  const user = await UserModel.findOne({
    _id: toObjectId(userId, "userId"),
    tenant: toObjectId(tenantId, "tenantId"),
  })
    .select("_id moneyCredits membershipCredits")
    .lean()
    .exec();

  if (!user) {
    notFound("User not found.");
  }

  const cart = await findActiveCart({ tenantId, userId });

  return {
    userId: user._id,
    moneyCredits: user.moneyCredits || 0,
    membershipCredits: user.membershipCredits || 0,
    cart: cart || null,
  };
};

export const checkCreditsForCart = async ({
  tenantId,
  userId,
  cartTotal,
}: CheckCreditsInput) => {
  const user = await UserModel.findOne({
    _id: toObjectId(userId, "userId"),
    tenant: toObjectId(tenantId, "tenantId"),
  })
    .select("moneyCredits")
    .lean()
    .exec();

  if (!user) {
    notFound("User not found.");
  }

  const availableCredits = Math.max(0, Number(user.moneyCredits || 0));
  const requiredAmount = Math.max(0, Number(cartTotal || 0));
  const canAfford = availableCredits >= requiredAmount;

  return {
    canAfford,
    availableCredits,
    requiredAmount,
    deficit: canAfford ? 0 : requiredAmount - availableCredits,
  };
};

export const addActiveCartItem = async ({
  tenantId,
  userId,
  sessionId,
  item,
}: {
  tenantId: string;
  userId?: string;
  sessionId?: string;
  item: AddCartItemInput;
}) => {
  const tenant = await getTenantOrThrow(tenantId);
  const currency = normalizeStudioCommerceCurrency(tenant.settings.currency);

  return addItemToCart({
    tenantId,
    userId,
    sessionId,
    item,
    currency,
  });
};

export const updateActiveCartItem = async ({
  tenantId,
  cartId,
  itemId,
  userId,
  input,
}: {
  tenantId: string;
  cartId: string;
  itemId: string;
  userId: string;
  input: UpdateCartItemInput;
}) => {
  const cart = await updateCartItem({ tenantId, cartId, itemId, userId, input });

  if (!cart) {
    notFound("Cart item not found.");
  }

  return cart;
};

export const removeActiveCartItem = async ({
  tenantId,
  cartId,
  itemId,
  userId,
}: {
  tenantId: string;
  cartId: string;
  itemId: string;
  userId: string;
}) => {
  const cart = await removeCartItem({ tenantId, cartId, itemId, userId });

  if (!cart) {
    notFound("Cart item not found.");
  }

  return cart;
};

export const clearCart = async ({
  tenantId,
  userId,
  sessionId,
}: {
  tenantId: string;
  userId?: string;
  sessionId?: string;
}) => {
  return clearActiveCart({ tenantId, userId, sessionId });
};

export const convertCart = async ({
  tenantId,
  cartId,
  userId,
}: {
  tenantId: string;
  cartId: string;
  userId: string;
}) => {
  const cart = await markCartConverted({ tenantId, cartId, userId });

  if (!cart) {
    notFound("Active cart not found.");
  }

  return cart;
};

export const listTenantCarts = listCarts;
