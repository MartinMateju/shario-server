import { Router } from "express";
import { z } from "zod";
import { requireWorkspaceSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import {
  customOrderContext,
  customOrderOptions,
  customOrderService,
  findCustomOrderCustomer,
  loadCustomOrder,
} from "./custom-order.service.js";
import { customOrderUpload } from "./custom-order.media.js";
import {
  closeCustomOrderInput,
  customOrderCommentInput,
  customOrderId,
  customOrderRevision,
  listCustomOrdersInput,
  reopenCustomOrderInput,
} from "./custom-order.validators.js";

export const customOrderRouter = Router();
customOrderRouter.use(requireWorkspaceSession, (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});
const view = requirePermission(WORKSPACE_PERMISSION.ORDERS_VIEW);
const manage = requirePermission(WORKSPACE_PERMISSION.ORDERS_MANAGE);
const id = (value: unknown) => customOrderId.parse(value);
customOrderRouter.get(
  "/options",
  view,
  asyncHandler(async (req, res) => {
    const query = z
      .object({ locationId: customOrderId.optional() })
      .strict()
      .parse(req.query);
    res.json(
      await customOrderOptions(await customOrderContext(req), query.locationId),
    );
  }),
);
customOrderRouter.get(
  "/customers",
  manage,
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        identifier: z.string().trim().min(1).max(80),
        locationId: customOrderId.optional(),
      })
      .strict()
      .parse(req.query);
    res.json(
      await findCustomOrderCustomer(
        await customOrderContext(req, true),
        query.identifier,
        query.locationId,
      ),
    );
  }),
);
customOrderRouter.get(
  "/",
  view,
  asyncHandler(async (req, res) => {
    res.json(
      await customOrderService.list(
        await customOrderContext(req),
        listCustomOrdersInput.parse(req.query),
      ),
    );
  }),
);
customOrderRouter.post(
  "/",
  manage,
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(
        await customOrderService.create(
          await customOrderContext(req, true),
          req.body,
        ),
      );
  }),
);
customOrderRouter.get(
  "/:id",
  view,
  asyncHandler(async (req, res) => {
    res.json(
      await customOrderService.detail(
        await customOrderContext(req),
        id(req.params.id),
      ),
    );
  }),
);
customOrderRouter.get(
  "/:id/history",
  view,
  asyncHandler(async (req, res) => {
    const query = z
      .object({ page: z.coerce.number().int().min(1).max(100000).default(1) })
      .strict()
      .parse(req.query);
    res.json(
      await customOrderService.history(
        await customOrderContext(req),
        id(req.params.id),
        query.page,
      ),
    );
  }),
);
customOrderRouter.patch(
  "/:id",
  manage,
  asyncHandler(async (req, res) => {
    res.json(
      await customOrderService.update(
        await customOrderContext(req, true),
        id(req.params.id),
        req.body,
      ),
    );
  }),
);
customOrderRouter.post(
  "/:id/comments",
  manage,
  asyncHandler(async (req, res) => {
    const input = customOrderCommentInput.parse(req.body);
    res.json(
      await customOrderService.comment(
        await customOrderContext(req, true),
        id(req.params.id),
        input.revision,
        input.body,
      ),
    );
  }),
);
customOrderRouter.post(
  "/:id/close",
  manage,
  asyncHandler(async (req, res) => {
    const input = closeCustomOrderInput.parse(req.body);
    res.json(
      await customOrderService.close(
        await customOrderContext(req, true),
        id(req.params.id),
        input.revision,
        input.reason,
        input.note,
      ),
    );
  }),
);
customOrderRouter.post(
  "/:id/reopen",
  manage,
  asyncHandler(async (req, res) => {
    const input = reopenCustomOrderInput.parse(req.body);
    res.json(
      await customOrderService.reopen(
        await customOrderContext(req, true),
        id(req.params.id),
        input.revision,
        input.reason,
      ),
    );
  }),
);
// Authorize tenant and location before accepting any multipart buffers.
customOrderRouter.post(
  "/:id/attachments",
  manage,
  asyncHandler(async (req, _res, next) => {
    await loadCustomOrder(
      await customOrderContext(req, true),
      id(req.params.id),
    );
    next();
  }),
  customOrderUpload,
  asyncHandler(async (req, res) => {
    const input = customOrderRevision.parse(req.body);
    res.json(
      await customOrderService.attach(
        await customOrderContext(req, true),
        id(req.params.id),
        input.revision,
        (req.files as Express.Multer.File[]) || [],
      ),
    );
  }),
);
customOrderRouter.post(
  "/:id/attachments/:attachmentId/remove",
  manage,
  asyncHandler(async (req, res) => {
    const input = customOrderRevision.parse(req.body);
    res.json(
      await customOrderService.removeAttachment(
        await customOrderContext(req, true),
        id(req.params.id),
        id(req.params.attachmentId),
        input.revision,
      ),
    );
  }),
);
