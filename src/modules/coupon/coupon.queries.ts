export const COUPON_POPULATE = {
  product: {
    path: "product",
    select: "name price type imageSrc voucherTemplate",
  },
  order: {
    path: "order",
    select: "email firstname lastname status createdAt",
  },
} as const;
