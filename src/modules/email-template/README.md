# Email Templates Module

Production-ready TypeScript module for tenant-aware email templates.

## Includes

- `email-template.constants.ts`
- `email-template.schema.ts`
- `email-template.model.ts`
- `email-template.types.ts`
- `email-template.validators.ts` using Zod
- `email-template.repository.ts`
- `email-template.queries.ts`
- `email-template.utils.ts`
- `controllers/email-template.controller.ts`
- `services/email-template.service.ts`
- `email-template.routes.ts`

## Notes

- No module-root `index.ts` is included.
- All reads/writes are tenant-scoped.
- Zod validates external input.
- Mongoose handles persistence constraints and the single-default-per-category rule.
- Layout templates require `headerHtml` and `footerHtml`.
- Non-layout templates require `htmlContent`.
- Variables are extracted automatically from `{{variable}}` placeholders.
