# Staff module

Production-ready TypeScript module for staff members and staff tasks.

## Files

- `staff.constants.ts`
- `staff-member.schema.ts`
- `staff-member.model.ts`
- `staff-task.schema.ts`
- `staff-task.model.ts`
- `staff.types.ts`
- `staff.validators.ts`
- `staff.repository.ts`
- `staff.queries.ts`
- `staff.utils.ts`
- `controllers/staff-member.controller.ts`
- `controllers/staff-task.controller.ts`
- `services/staff-member.service.ts`
- `services/staff-task.service.ts`
- `routes/staff.routes.ts`

## Route mounting

```ts
import staffRoutes from "./modules/staff/routes/staff.routes.js";

apiRouter.use("/staff", staffRoutes);
```

## Notes

- Tenant-aware queries.
- Zod validation.
- No root barrel `index.ts`.
- Staff members and staff tasks are kept in one bounded context.
