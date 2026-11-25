import type { Request, Response } from "express";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import {
  listCustomerDirectory,
  getCustomerDirectorySummary,
  exportCustomerDirectory,
} from "../services/user.directory.service.js";

const context = (req: Request) => ({
  tenantId: requireTenantId(req),
  access: getResolvedWorkspaceAccess(req),
});
export const readCustomerDirectory = asyncHandler(async (req, res) => {
  res.json(await listCustomerDirectory({ ...context(req), input: req.query }));
});
export const readCustomerDirectorySummary = asyncHandler(async (req, res) => {
  res.json(
    await getCustomerDirectorySummary({ ...context(req), input: req.query }),
  );
});
const write = async (res: Response, text: string) => {
  if (res.destroyed) throw new Error("Customer export connection closed.");
  if (!res.write(text)) {
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        res.off("drain", drained);
        res.off("close", closed);
        res.off("error", failed);
      };
      const drained = () => {
        clean();
        resolve();
      };
      const closed = () => {
        clean();
        reject(new Error("Customer export connection closed."));
      };
      const failed = (error: Error) => {
        clean();
        reject(error);
      };
      res.once("drain", drained);
      res.once("close", closed);
      res.once("error", failed);
      if (res.destroyed) closed();
    });
  }
};
export const downloadCustomerDirectory = asyncHandler(async (req, res) => {
  const batches = exportCustomerDirectory({ ...context(req), input: req.body });
  try {
    // Validate scope/selection and hydrate the first bounded batch before
    // opening the response, so ordinary errors retain their HTTP status.
    let next = await batches.next();
    res.type("application/json");
    res.setHeader("Cache-Control", "no-store");
    await write(res, '{"data":[');
    let count = 0;
    while (next.done === false) {
      for (const row of next.value) {
        await write(res, `${count ? "," : ""}${JSON.stringify(row)}`);
        count += 1;
      }
      if (res.destroyed) throw new Error("Customer export connection closed.");
      next = await batches.next();
    }
    res.end(`],"totalCount":${count},"complete":true}`);
  } catch (error) {
    if (res.headersSent)
      res.destroy(error instanceof Error ? error : undefined);
    else throw error;
  } finally {
    await batches.return(undefined);
  }
});
