# Coupon module

Production-ready TypeScript coupon module for SKAB.

## Includes

- `Coupon`
- `CouponOrder`
- tenant-aware schema/model/repository
- Zod validators
- Stripe checkout creation
- Stripe webhook finalization helper
- promo-code generation
- promo-code redemption
- manual admin promo-code creation
- coupon order filtering
- coupon order status auditing

## Notes

This module intentionally removes legacy `ROLES_LIST` checks. Authorization should be handled by the new JWT payload / tenant role middleware.

Expected shared dependencies:

- `shared/http/asyncHandler.ts`
- `shared/http/httpErrors.ts`
- `shared/tenant/tenantContext.ts`
- `shared/logger/logger.ts`
- `shared/utils/sendEmail.ts`
- `shared/utils/r2.ts`
- `shared/utils/modifyPdf.ts`

Expected modules:

- `products/product.model.ts`
- `users/user.model.ts`
- `money_credits/money-credit.model.ts`

If your project still keeps these models in legacy `/models`, update the imports in `coupon.repository.ts` and `coupon.service.ts`.

## Value snapshot migration

Voucher redemption prefers the immutable value stored on `Coupon`, then the
immutable `CouponOrder` value for legacy paid vouchers, and only falls back to
the current Product price for legacy codes that have no order. A partial or
invalid snapshot fails closed and does not redeem the code.
Coupon and CouponOrder snapshots remain redeemable if the mutable Product is
later deleted or changes kind; a valid Voucher Product is required only for
the legacy Product-price fallback.

Backfill old coupons before changing voucher Product prices. The migration is
dry-run by default:

```bash
npm run migration:coupon-value-snapshots
```

Review `wouldUpdate` and every entry in `errors`, then apply during a normal
maintenance window:

```bash
npm run migration:coupon-value-snapshots -- --apply
```

Optional controls are `--tenant=<tenantObjectId>` and `--batch-size=<1-1000>`.
The apply write only matches coupons where both snapshot fields are still
unset, so retries and concurrent runs cannot overwrite an existing liability.
The command exits non-zero when invalid coupons require manual remediation.
