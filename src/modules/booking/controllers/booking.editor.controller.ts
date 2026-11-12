import type { Request, Response } from "express";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  getBookingEditor,
  saveBookingEditor,
  findBookingEditorCustomer,
} from "../booking.editor.service.js";

const context = (req: Request) => ({
  tenantId: requireTenantId(req),
  bookingId: String(req.params.id),
});
export const readBookingEditor = asyncHandler(
  async (req: Request, res: Response) => {
    const editor = await getBookingEditor(context(req));
    const mayUpdate = hasWorkspacePermission(
      getResolvedWorkspaceAccess(req),
      WORKSPACE_PERMISSION.BOOKINGS_UPDATE,
    );
    res.json(
      mayUpdate
        ? editor
        : {
            ...editor,
            capabilities: {
              ...editor.capabilities,
              canEdit: false,
              canEditParticipants: false,
              canAddParticipants: false,
              canReschedule: false,
            },
          },
    );
  },
);
export const writeBookingEditor = asyncHandler(
  async (req: Request, res: Response) => {
    res.json(
      await saveBookingEditor({
        ...context(req),
        actorUserId: getAuthenticatedUserId(req),
        input: req.body,
      }),
    );
  },
);
export const lookupBookingEditorCustomer = asyncHandler(
  async (req: Request, res: Response) => {
    res.json(
      await findBookingEditorCustomer({
        ...context(req),
        identifier:
          typeof req.query.identifier === "string" ? req.query.identifier : "",
      }),
    );
  },
);
