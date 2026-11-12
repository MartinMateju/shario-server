import mongoose from "mongoose";

import { notFound } from "@/shared/http/httpErrors.js";
import type { AllowedWorkspaceLocationIds } from "@/modules/tenant-access/services/location-scope.service.js";

export const canAccessInvoiceLocations = (
  invoiceLocationIds: readonly unknown[],
  allowedLocationIds: AllowedWorkspaceLocationIds,
): boolean => {
  if (allowedLocationIds === null) return true;

  const locations = [...new Set(invoiceLocationIds.map(String).filter(Boolean))];
  if (!locations.length) return false;

  const allowed = new Set(allowedLocationIds.map(String));
  return locations.every((locationId) => allowed.has(locationId));
};

export const assertInvoiceLocationAccess = (
  invoiceLocationIds: readonly unknown[],
  allowedLocationIds: AllowedWorkspaceLocationIds,
): void => {
  if (!canAccessInvoiceLocations(invoiceLocationIds, allowedLocationIds)) {
    notFound({
      message: "Invoice not found.",
      code: "INVOICE_NOT_FOUND",
    });
  }
};

export const buildInvoiceLocationScopeFilter = (
  allowedLocationIds: AllowedWorkspaceLocationIds,
): Record<string, unknown> => {
  if (allowedLocationIds === null) return {};

  const allowed = allowedLocationIds
    .filter(mongoose.isValidObjectId)
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  if (!allowed.length) return { _id: { $exists: false } };

  return {
    "locationIds.0": { $exists: true },
    locationIds: {
      $not: {
        $elemMatch: { $nin: allowed },
      },
    },
  };
};
