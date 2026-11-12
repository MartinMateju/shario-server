import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import {
  createCustomerImportSession,
  getTenantImportSession,
  listImportRows,
  listTenantImportSessions,
  serializeImportSession,
  validateCustomerImportSession,
} from "./services/data-import.service.js";
import {
  queueDataImportSession,
  queueImportRollbackSession,
} from "./services/data-import-queue.service.js";
import {
  createProductImportSession,
  validateProductImportSession,
} from "./services/product-import.service.js";
import {
  createBookingImportSession,
  validateBookingImportSession,
} from "./services/booking-import.service.js";
import {
  createMembershipPlanImportSession,
  validateMembershipPlanImportSession,
} from "./services/membership-plan-import.service.js";
import {
  createMembershipImportSession,
  validateMembershipImportSession,
} from "./services/membership-import.service.js";
import {
  createCreditImportSession,
  validateCreditImportSession,
} from "./services/credit-import.service.js";
import {
  createVoucherProductImportSession,
  validateVoucherProductImportSession,
} from "./services/voucher-product-import.service.js";
import {
  createVoucherImportSession,
  validateVoucherImportSession,
} from "./services/voucher-import.service.js";
import {
  buildBookingImportTemplateCsv,
  buildCreditImportTemplateCsv,
  buildCustomerImportReportCsv,
  buildImportRollbackReportCsv,
  buildCustomerImportTemplateCsv,
  buildMembershipImportTemplateCsv,
  buildMembershipPlanImportTemplateCsv,
  buildProductImportTemplateCsv,
  buildVoucherImportTemplateCsv,
  buildVoucherProductImportTemplateCsv,
} from "./services/data-import-report.service.js";
import { DATA_IMPORT_ENTITY } from "./data-import.constants.js";
import { previewImportRollback } from "./services/data-import-rollback.service.js";

const privateNoStore = (res: Response): void => {
  res.set({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
};

const routeParam = (value: string | string[] | undefined): string => {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (!normalized) {
    badRequest({
      message: "Import session id is required.",
      code: "IMPORT_ID_REQUIRED",
    });
  }
  return normalized;
};

export const listImports = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const data = await listTenantImportSessions({
    tenantId,
    entityType: String(
      req.query.entity ?? req.query.entityType ?? DATA_IMPORT_ENTITY.CUSTOMERS,
    ) as never,
    page: Number(req.query.page),
    limit: Number(req.query.limit),
    status: req.query.status ? String(req.query.status) : undefined,
    rollbackStatus: req.query.rollbackStatus
      ? String(req.query.rollbackStatus)
      : undefined,
    createdFrom: req.query.createdFrom
      ? String(req.query.createdFrom)
      : undefined,
    createdTo: req.query.createdTo ? String(req.query.createdTo) : undefined,
    search: req.query.search ? String(req.query.search) : undefined,
  });
  privateNoStore(res);
  res.json({ data });
});

export const uploadCustomerImport = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.file) {
      badRequest({
        message: "Select a CSV or XLSX file.",
        code: "IMPORT_FILE_REQUIRED",
      });
    }
    const data = await createCustomerImportSession({
      tenantId: requireTenantId(req),
      actorId: getAuthenticatedUserId(req),
      file: req.file,
    });
    privateNoStore(res);
    res.status(201).json({ data });
  },
);

const requireUploadFile = (req: Request): Express.Multer.File => {
  if (!req.file) {
    badRequest({
      message: "Select a CSV or XLSX file.",
      code: "IMPORT_FILE_REQUIRED",
    });
  }
  return req.file;
};

export const uploadProductImport = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await createProductImportSession({
      tenantId: requireTenantId(req),
      actorId: getAuthenticatedUserId(req),
      file: requireUploadFile(req),
    });
    privateNoStore(res);
    res.status(201).json({ data });
  },
);

export const uploadBookingImport = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await createBookingImportSession({
      tenantId: requireTenantId(req),
      actorId: getAuthenticatedUserId(req),
      file: requireUploadFile(req),
    });
    privateNoStore(res);
    res.status(201).json({ data });
  },
);

const step3Upload = (
  createSession: (args: {
    tenantId: string;
    actorId: string;
    file: Express.Multer.File;
  }) => Promise<unknown>,
) =>
  asyncHandler(async (req: Request, res: Response) => {
    const data = await createSession({
      tenantId: requireTenantId(req),
      actorId: getAuthenticatedUserId(req),
      file: requireUploadFile(req),
    });
    privateNoStore(res);
    res.status(201).json({ data });
  });

export const uploadMembershipPlanImport = step3Upload(
  createMembershipPlanImportSession,
);
export const uploadMembershipImport = step3Upload(
  createMembershipImportSession,
);
export const uploadCreditImport = step3Upload(createCreditImportSession);
export const uploadVoucherProductImport = step3Upload(
  createVoucherProductImportSession,
);
export const uploadVoucherImport = step3Upload(createVoucherImportSession);

export const validateCustomerImport = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await validateCustomerImportSession({
      tenantId: requireTenantId(req),
      sessionId: routeParam(req.params.id),
      mapping: req.body?.mapping,
      duplicateStrategy: req.body?.duplicateStrategy,
      actorId: getAuthenticatedUserId(req),
      confirmPasswordHashImport: req.body?.confirmPasswordHashImport === true,
      preserveImportedMemberNumbers:
        req.body?.preserveImportedMemberNumbers === true,
    });
    privateNoStore(res);
    res.json({ data });
  },
);

export const validateImport = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const sessionId = routeParam(req.params.id);
    const attached = (req as Request & { dataImportSession?: any })
      .dataImportSession;
    const session =
      attached || (await getTenantImportSession({ tenantId, sessionId }));
    const common = {
      tenantId,
      sessionId,
      mapping: req.body?.mapping,
      duplicateStrategy: req.body?.duplicateStrategy,
      actorId: getAuthenticatedUserId(req),
      confirmPasswordHashImport: req.body?.confirmPasswordHashImport === true,
      preserveImportedMemberNumbers:
        req.body?.preserveImportedMemberNumbers === true,
    };
    const tenant = (req as Request & { tenant?: any }).tenant;
    const tenantCurrency = String(tenant?.settings?.currency || "CZK");
    const data =
      session.entityType === DATA_IMPORT_ENTITY.PRODUCTS
        ? await validateProductImportSession({
            ...common,
            tenantCurrency,
            enabledModules: new Set(
              Object.entries(tenant?.modules || {})
                .filter(([, enabled]) => enabled)
                .map(([moduleName]) => moduleName),
            ),
          })
        : session.entityType === DATA_IMPORT_ENTITY.BOOKINGS
          ? await validateBookingImportSession({
              ...common,
              tenantLanguage: String(tenant?.settings?.defaultLanguage || "cs"),
            })
          : session.entityType === DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS
            ? await validateMembershipPlanImportSession({
                ...common,
                tenantCurrency,
              })
            : session.entityType === DATA_IMPORT_ENTITY.MEMBERSHIPS
              ? await validateMembershipImportSession({
                  ...common,
                  tenantCurrency,
                })
              : session.entityType === DATA_IMPORT_ENTITY.CREDITS
                ? await validateCreditImportSession({
                    ...common,
                    tenantCurrency,
                  })
                : session.entityType === DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS
                  ? await validateVoucherProductImportSession({
                      ...common,
                      tenantCurrency,
                    })
                  : session.entityType === DATA_IMPORT_ENTITY.VOUCHERS
                    ? await validateVoucherImportSession({
                        ...common,
                        tenantCurrency,
                      })
                    : await validateCustomerImportSession(common);
    privateNoStore(res);
    res.json({ data });
  },
);

export const getImport = asyncHandler(async (req: Request, res: Response) => {
  const session = await getTenantImportSession({
    tenantId: requireTenantId(req),
    sessionId: routeParam(req.params.id),
  });
  privateNoStore(res);
  res.json({ data: serializeImportSession(session) });
});

export const getImportRows = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await listImportRows({
      tenantId: requireTenantId(req),
      sessionId: routeParam(req.params.id),
      page: Number(req.query.page),
      limit: Number(req.query.limit),
    });
    privateNoStore(res);
    res.json({ data });
  },
);

export const getImportRollbackPreview = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await previewImportRollback({
      tenantId: requireTenantId(req),
      sessionId: routeParam(req.params.id),
    });
    privateNoStore(res);
    res.json({ data });
  },
);

export const rollbackImport = asyncHandler(
  async (req: Request, res: Response) => {
    const revision = Number(req.body?.revision);
    const previewToken = String(req.body?.previewToken || "").trim();
    if (!Number.isSafeInteger(revision) || revision < 1)
      badRequest({
        message: "A valid rollback preview revision is required.",
        code: "IMPORT_ROLLBACK_REVISION_INVALID",
      });
    if (!/^[a-f0-9]{64}$/.test(previewToken))
      badRequest({
        message: "A valid rollback preview token is required.",
        code: "IMPORT_ROLLBACK_PREVIEW_TOKEN_INVALID",
      });
    const rawIdempotencyKey = String(req.get("Idempotency-Key") || "").trim();
    if (
      rawIdempotencyKey &&
      (rawIdempotencyKey.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/.test(rawIdempotencyKey))
    )
      badRequest({
        message: "The rollback idempotency key is invalid.",
        code: "IMPORT_ROLLBACK_IDEMPOTENCY_KEY_INVALID",
      });
    const idempotencyKey = rawIdempotencyKey || `preview:${previewToken}`;
    const data = await queueImportRollbackSession({
      tenantId: requireTenantId(req),
      sessionId: routeParam(req.params.id),
      revision,
      previewToken,
      idempotencyKey,
      actorId: getAuthenticatedUserId(req),
    });
    privateNoStore(res);
    res.status(202).json({ data });
  },
);

export const executeCustomerImport = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await queueDataImportSession({
      tenantId: requireTenantId(req),
      sessionId: routeParam(req.params.id),
      validationRevision: String(req.body?.validationRevision || ""),
      actorId: getAuthenticatedUserId(req),
    });
    privateNoStore(res);
    res.status(202).json({ data });
  },
);

export const executeImport = asyncHandler(
  async (req: Request, res: Response) => {
    const data = await queueDataImportSession({
      tenantId: requireTenantId(req),
      sessionId: routeParam(req.params.id),
      validationRevision: String(req.body?.validationRevision || ""),
      actorId: getAuthenticatedUserId(req),
    });
    privateNoStore(res);
    res.status(202).json({ data });
  },
);

export const downloadCustomerImportTemplate = asyncHandler(
  async (_req: Request, res: Response) => {
    privateNoStore(res);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="shario-customer-import.csv"',
    });
    res.send(buildCustomerImportTemplateCsv());
  },
);

export const downloadProductImportTemplate = asyncHandler(
  async (_req: Request, res: Response) => {
    privateNoStore(res);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="shario-product-service-import.csv"',
    });
    res.send(buildProductImportTemplateCsv());
  },
);

export const downloadBookingImportTemplate = asyncHandler(
  async (_req: Request, res: Response) => {
    privateNoStore(res);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="shario-booking-import.csv"',
    });
    res.send(buildBookingImportTemplateCsv());
  },
);

const step3Template = (fileName: string, build: () => string) =>
  asyncHandler(async (_req: Request, res: Response) => {
    privateNoStore(res);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    });
    res.send(build());
  });

export const downloadMembershipPlanImportTemplate = step3Template(
  "shario-membership-plan-import.csv",
  buildMembershipPlanImportTemplateCsv,
);
export const downloadMembershipImportTemplate = step3Template(
  "shario-membership-import.csv",
  buildMembershipImportTemplateCsv,
);
export const downloadCreditImportTemplate = step3Template(
  "shario-credit-import.csv",
  buildCreditImportTemplateCsv,
);
export const downloadVoucherProductImportTemplate = step3Template(
  "shario-voucher-product-import.csv",
  buildVoucherProductImportTemplateCsv,
);
export const downloadVoucherImportTemplate = step3Template(
  "shario-voucher-import.csv",
  buildVoucherImportTemplateCsv,
);

export const downloadCustomerImportReport = asyncHandler(
  async (req: Request, res: Response) => {
    const csv = await buildCustomerImportReportCsv({
      tenantId: requireTenantId(req),
      sessionId: routeParam(req.params.id),
    });
    privateNoStore(res);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="shario-customer-import-report.csv"',
    });
    res.send(csv);
  },
);

export const downloadImportReport = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const sessionId = routeParam(req.params.id);
    const session =
      (req as Request & { dataImportSession?: any }).dataImportSession ||
      (await getTenantImportSession({ tenantId, sessionId }));
    const csv = await buildCustomerImportReportCsv({ tenantId, sessionId });
    privateNoStore(res);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shario-${String(session.entityType).replaceAll("_", "-")}-import-report.csv"`,
    });
    res.send(csv);
  },
);

export const downloadImportRollbackReport = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const sessionId = routeParam(req.params.id);
    const session =
      (req as Request & { dataImportSession?: any }).dataImportSession ||
      (await getTenantImportSession({ tenantId, sessionId }));
    const csv = await buildImportRollbackReportCsv({ tenantId, sessionId });
    privateNoStore(res);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shario-${String(session.entityType).replace(/[^a-z0-9-]/gi, "-")}-rollback-report.csv"`,
    });
    res.send(csv);
  },
);
