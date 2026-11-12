# Money Credit Module

Production-ready TypeScript module for tenant-aware money credits.

## Includes

- `MoneyCredit` schema/model
- Transaction ledger embedded in credit record
- Balance and transaction endpoints
- Atomic add/use/refund/admin grant operations
- Stripe checkout helper for credit purchases
- Zod request validation
- Protected Express routes

## Notes

- Uses `tenant` on every query.
- Keeps `User.moneyCredits` in sync while maintaining a ledger in `MoneyCredit`.
- Admin-only endpoints use `verifyRoles()`.
- Credit purchase finalization should still be triggered from the Stripe webhook/order module by calling the credit service after payment confirmation.
