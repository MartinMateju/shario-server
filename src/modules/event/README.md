# Events module

Production-ready TypeScript module for managing private/corporate studio events.

## Files

- `event.constants.ts` - domain constants and enums
- `event.schema.ts` - Mongoose schema
- `event.model.ts` - Mongoose model
- `event.types.ts` - TypeScript model types
- `event.validators.ts` - Zod request validators
- `event.queries.ts` - query builder
- `event.repository.ts` - tenant-aware persistence
- `event.utils.ts` - small helpers
- `services/event.service.ts` - business logic
- `controllers/event.controller.ts` - Express handlers
- `routes/event.routes.ts` - Express router

## Notes

- All queries are tenant-aware.
- Validation is handled with Zod.
- No root `index.ts` is included.
- Requires shared helpers: `asyncHandler`, `httpErrors`, `tenantContext`, and `verifyJWT`.
