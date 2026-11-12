import type { ClientSession, SortOrder, Types } from "mongoose";

import { CART_STATUS } from "./cart.constants.js";
import { Cart } from "./cart.model.js";
import type {
  AddCartItemInput,
  UpdateCartItemInput,
} from "./cart.types.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import { conflict } from "@/shared/http/httpErrors.js";
import {
  calculateCartItemTotal,
  normalizeSessionId,
  toObjectId,
} from "./cart.utils.js";

type IdLike = string | Types.ObjectId;
type CartQueryFilter = Record<string, unknown>;

type CartRepositoryOptions = {
  tenantId: IdLike;
  session?: ClientSession | null;
};

const applySession = <TQuery extends { session: (session: ClientSession | null) => TQuery }>(
  query: TQuery,
  session: ClientSession | null,
): TQuery => (session ? query.session(session) : query);

const toIdString = (value: IdLike): string => String(value);

export const createCartRepository = ({
  tenantId,
  session = null,
}: CartRepositoryOptions) => {
  if (!tenantId) throw new Error("CartRepository requires tenantId");

  const tenantIdString = toIdString(tenantId);
  const tenantObjectId = toObjectId(tenantIdString, "tenantId");

  const scope = (filter: CartQueryFilter = {}): CartQueryFilter => ({
    ...filter,
    tenant: tenantObjectId,
  });

  return {
    scope,

    findActiveCart({
      userId,
      sessionId,
    }: {
      userId?: string;
      sessionId?: string;
    }) {
      const filter: CartQueryFilter = {
        ...scope(),
        status: CART_STATUS.ACTIVE,
      };

      if (userId) {
        filter.user = toObjectId(userId, "userId");
      } else if (sessionId) {
        filter.sessionId = normalizeSessionId(sessionId);
      } else {
        return Promise.resolve(null);
      }

      const query = Cart.findOne(filter);
      applySession(query, session);
      return query.exec();
    },

    async findOrCreateActiveCart({
      userId,
      sessionId,
      currency,
    }: {
      userId?: string;
      sessionId?: string;
      currency: StudioCommerceCurrency;
    }) {
      const existingCart = await this.findActiveCart({ userId, sessionId });

      if (existingCart) {
        if (existingCart.currency === currency) {
          return existingCart;
        }

        if (existingCart.cartItems.length > 0) {
          conflict({
            message:
              "The active cart currency does not match this workspace. Clear the cart and try again.",
            code: "CART_CURRENCY_MISMATCH",
            details: {
              cartCurrency: existingCart.currency,
              tenantCurrency: currency,
            },
          });
        }

        // An empty legacy cart carries no financial value, so it is safe to
        // rebase its snapshot. Use the native collection because the field is
        // intentionally immutable for every non-empty/payment cart.
        await Cart.collection.updateOne(
          { _id: existingCart._id, tenant: tenantObjectId },
          { $set: { currency, expectedAmountMinor: 0 } },
          session ? { session } : undefined,
        );

        return Cart.findById(existingCart._id).session(session).orFail().exec();
      }

      const [cart] = await Cart.create(
        [
          {
            tenant: tenantObjectId,
            user: userId ? toObjectId(userId, "userId") : null,
            sessionId: normalizeSessionId(sessionId),
            cartItems: [],
            currency,
            expectedAmountMinor: 0,
            totalPrice: 0,
            status: CART_STATUS.ACTIVE,
          },
        ],
        session ? { session } : undefined,
      );

      return cart;
    },

    async addItemToCart({
      userId,
      sessionId,
      item,
      currency,
    }: {
      userId?: string;
      sessionId?: string;
      item: AddCartItemInput;
      currency: StudioCommerceCurrency;
    }) {
      const cart = await this.findOrCreateActiveCart({
        userId,
        sessionId,
        currency,
      });

      const productId = toObjectId(item.productId, "productId");
      const quantity = Math.max(1, Number(item.quantity || 1));
      const basePrice = Math.max(0, Number(item.basePrice || 0));
      const extraCharge = Math.max(0, Number(item.extraCharge || 0));
      const numberOfPeople = Math.max(1, Number(item.numberOfPeople || 1));

      const existingItem = cart.cartItems.find(
        (cartItem) => cartItem.product.toString() === productId.toString(),
      );

      if (existingItem) {
        existingItem.quantity += quantity;
        existingItem.basePrice = basePrice;
        existingItem.extraCharge = extraCharge;
        existingItem.numberOfPeople = numberOfPeople;
        existingItem.totalPrice = calculateCartItemTotal({
          basePrice,
          extraCharge,
          quantity: existingItem.quantity,
        });
      } else {
        cart.cartItems.push({
          product: productId,
          quantity,
          basePrice,
          extraCharge,
          numberOfPeople,
          totalPrice: calculateCartItemTotal({
            basePrice,
            extraCharge,
            quantity,
          }),
        });
      }

      return cart.save(session ? { session } : undefined);
    },

    async updateCartItem({
      cartId,
      itemId,
      userId,
      input,
    }: {
      cartId: string;
      itemId: string;
      userId: string;
      input: UpdateCartItemInput;
    }) {
      const itemObjectId = toObjectId(itemId, "itemId");

      const query = Cart.findOne({
        ...scope({ _id: toObjectId(cartId, "cartId") }),
        user: toObjectId(userId, "userId"),
        status: CART_STATUS.ACTIVE,
      });

      applySession(query, session);
      const cart = await query.exec();

      if (!cart) return null;

      const item = cart.cartItems.find(
        (cartItem) => cartItem._id?.toString() === itemObjectId.toString(),
      );

      if (!item) return null;

      if (input.quantity !== undefined) item.quantity = Math.max(1, Number(input.quantity));
      if (input.basePrice !== undefined) item.basePrice = Math.max(0, Number(input.basePrice));
      if (input.extraCharge !== undefined) item.extraCharge = Math.max(0, Number(input.extraCharge));
      if (input.numberOfPeople !== undefined) {
        item.numberOfPeople = Math.max(1, Number(input.numberOfPeople));
      }

      item.totalPrice = calculateCartItemTotal({
        basePrice: item.basePrice,
        extraCharge: item.extraCharge,
        quantity: item.quantity,
      });

      return cart.save(session ? { session } : undefined);
    },

    async removeCartItem({
      cartId,
      itemId,
      userId,
    }: {
      cartId: string;
      itemId: string;
      userId: string;
    }) {
      const itemObjectId = toObjectId(itemId, "itemId");

      const query = Cart.findOne({
        ...scope({ _id: toObjectId(cartId, "cartId") }),
        user: toObjectId(userId, "userId"),
        status: CART_STATUS.ACTIVE,
      });

      applySession(query, session);
      const cart = await query.exec();

      if (!cart) return null;

      cart.cartItems = cart.cartItems.filter(
        (cartItem) => cartItem._id?.toString() !== itemObjectId.toString(),
      );

      return cart.save(session ? { session } : undefined);
    },

    markCartConverted(cartId: string, userId: string) {
      return Cart.findOneAndUpdate(
        {
          ...scope({ _id: toObjectId(cartId, "cartId") }),
          user: toObjectId(userId, "userId"),
          status: CART_STATUS.ACTIVE,
        },
        { $set: { status: CART_STATUS.CONVERTED } },
        {
          returnDocument: "after",
          ...(session ? { session } : {}),
        },
      ).exec();
    },

    async clearActiveCart({
      userId,
      sessionId,
    }: {
      userId?: string;
      sessionId?: string;
    }) {
      const cart = await this.findActiveCart({ userId, sessionId });

      if (!cart) return null;

      cart.cartItems = [];
      cart.totalPrice = 0;

      return cart.save(session ? { session } : undefined);
    },

    async listCarts({
      page,
      limit,
      sortBy = "updatedAt",
      sortOrder = "desc",
    }: {
      page: number;
      limit: number;
      sortBy?: "createdAt" | "updatedAt" | "totalPrice" | "status";
      sortOrder?: "asc" | "desc";
    }) {
      const skip = (page - 1) * limit;

      const sort: Record<string, SortOrder> = {
        [sortBy]: sortOrder === "asc" ? 1 : -1,
      };

      const filter = scope();

      const [carts, totalCount] = await Promise.all([
        Cart.find(filter)
          .populate({
            path: "user",
            select: "firstname lastname customId email",
          })
          .populate({
            path: "cartItems.product",
            select: "name type price",
          })
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .lean()
          .session(session)
          .exec(),

        Cart.countDocuments(filter).session(session).exec(),
      ]);

      return {
        carts,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        currentPage: page,
        pageSize: limit,
      };
    },

    findCartIdsContainingProducts(productIds: Types.ObjectId[]) {
      return Cart.find({
        ...scope(),
        "cartItems.product": { $in: productIds },
      })
        .select("_id")
        .lean()
        .session(session)
        .exec();
    },
  };
};

export type CartRepository = ReturnType<typeof createCartRepository>;

export const findActiveCart = ({
  tenantId,
  userId,
  sessionId,
}: {
  tenantId: string;
  userId?: string;
  sessionId?: string;
}) => createCartRepository({ tenantId }).findActiveCart({ userId, sessionId });

export const findOrCreateActiveCart = ({
  tenantId,
  userId,
  sessionId,
  currency,
}: {
  tenantId: string;
  userId?: string;
  sessionId?: string;
  currency: StudioCommerceCurrency;
}) =>
  createCartRepository({ tenantId }).findOrCreateActiveCart({
    userId,
    sessionId,
    currency,
  });

export const addItemToCart = ({
  tenantId,
  userId,
  sessionId,
  item,
  currency,
}: {
  tenantId: string;
  userId?: string;
  sessionId?: string;
  item: AddCartItemInput;
  currency: StudioCommerceCurrency;
}) =>
  createCartRepository({ tenantId }).addItemToCart({
    userId,
    sessionId,
    item,
    currency,
  });

export const updateCartItem = ({
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
}) =>
  createCartRepository({ tenantId }).updateCartItem({
    cartId,
    itemId,
    userId,
    input,
  });

export const removeCartItem = ({
  tenantId,
  cartId,
  itemId,
  userId,
}: {
  tenantId: string;
  cartId: string;
  itemId: string;
  userId: string;
}) =>
  createCartRepository({ tenantId }).removeCartItem({ cartId, itemId, userId });

export const markCartConverted = ({
  tenantId,
  cartId,
  userId,
}: {
  tenantId: string;
  cartId: string;
  userId: string;
}) => createCartRepository({ tenantId }).markCartConverted(cartId, userId);

export const clearActiveCart = ({
  tenantId,
  userId,
  sessionId,
}: {
  tenantId: string;
  userId?: string;
  sessionId?: string;
}) => createCartRepository({ tenantId }).clearActiveCart({ userId, sessionId });

export const listCarts = ({
  tenantId,
  page,
  limit,
  sortBy = "updatedAt",
  sortOrder = "desc",
}: {
  tenantId: string;
  page: number;
  limit: number;
  sortBy?: "createdAt" | "updatedAt" | "totalPrice" | "status";
  sortOrder?: "asc" | "desc";
}) => createCartRepository({ tenantId }).listCarts({ page, limit, sortBy, sortOrder });
