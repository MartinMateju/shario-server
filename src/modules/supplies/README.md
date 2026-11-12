# Supply Orders module

Production-ready TypeScript module for studio/supply order management and suppliers.

## Contains

- `SupplyOrder` model (renamed from legacy `StudioOrder`)
- `Supplier` model
- Tenant-aware repositories
- Zod validators
- Services
- Controllers
- Protected routes

## Suggested mount

```ts
import supplyOrderRoutes from "./modules/supply_orders/routes/supply-order.routes.js";

app.use("/api/supply", supplyOrderRoutes);
```

Routes:

- `GET /api/supply/orders`
- `POST /api/supply/orders`
- `GET /api/supply/orders/:id`
- `PATCH /api/supply/orders/:id`
- `DELETE /api/supply/orders/:id`
- `GET /api/supply/suppliers`
- `POST /api/supply/suppliers`
- `PATCH /api/supply/suppliers/:id`
- `DELETE /api/supply/suppliers/:id`

## Notes

- No root `index.ts`, matching the project convention.
- `internalNote` is `select: false` and explicitly selected in admin repository calls.
- Suppliers are soft-deleted by setting `isActive: false`.
