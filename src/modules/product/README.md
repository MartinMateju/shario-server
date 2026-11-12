# Product Module

Tenant-scoped product and public catalog module for the SKAB backend.

## Contents

```txt
products/
├── product.constants.ts
├── product.model.ts
├── product.queries.ts        # optional, add if you split query builders later
├── product.repository.ts
├── product.schema.ts
├── product.types.ts
├── product.utils.ts
├── product.validators.ts
├── controllers/
│   └── product.controller.ts
├── middleware/
│   ├── productUpload.middleware.ts
│   └── requireProductManager.middleware.ts
├── routes/
│   └── product.routes.ts
└── services/
    └── product.service.ts
```

No root `index.ts` is included intentionally.

## Notes

- Uses Zod for request validation.
- Workspace reads require `products.view` (or `courses.view` for the course
  shortcut); writes require `products.manage`.
- The authenticated tenant is taken from the verified access token. The global
  subscription guard hydrates the authoritative tenant document before module
  checks run.
- Public product reads use an explicit, published tenant slug and never accept
  a caller-supplied tenant ID.
- Coupon products can upload a PDF template through multipart field name `file`.
- PDF validation checks file size, mime/extension, and magic bytes.
- System products are visible to authorized workspace users but immutable
  through tenant CRUD.
- R2 upload uses `uploadBufferToR2` from the infrastructure storage client.

## Routes

```txt
GET    /products
GET    /products/courses
POST   /products
PATCH  /products
DELETE /products

GET /public/tenants/:tenantSlug/products
GET /public/tenants/:tenantSlug/products/courses
```

The public DTO deliberately omits SKU, internal labels, voucher-template keys,
related-product identifiers, sort metadata and timestamps. Only active,
customer-facing types are returned; private and operational legacy types are
excluded.

## Required dependency

```bash
npm install zod
```

## Route mounting example

```ts
import productRoutes from "./modules/products/routes/product.routes.js";

app.use("/products", productRoutes);
```

Make sure tenant resolution middleware runs before product routes.

## Course capacity migration

`maxNumberOfParticipants` is a persisted integer from 1 through 500. It is
required when creating a canonical or legacy course product and is returned in
the public product DTO.

Existing course documents created before this field was persisted must be
edited/backfilled before accepting checkout traffic. Course checkout fails
closed with `CHECKOUT_COURSE_CAPACITY_NOT_CONFIGURED` when the field is absent;
it never guesses a capacity. This prevents an old or malformed product from
silently overselling a course.
