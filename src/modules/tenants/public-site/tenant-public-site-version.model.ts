import mongoose, { Schema } from "mongoose";

import type { TenantPublicSiteVersion } from "../tenant.types.js";
import { tenantPublicSiteSchema } from "./tenant-public-site.schema.js";

const tenantPublicSiteVersionSchema = new Schema<TenantPublicSiteVersion>(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },
    sourceDraftRevision: {
      type: Number,
      required: true,
      min: 0,
    },
    snapshot: {
      type: tenantPublicSiteSchema,
      required: true,
    },
    publishedAt: {
      type: Date,
      required: true,
    },
    publishedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
    },
    restoredFromVersion: {
      type: Schema.Types.ObjectId,
      ref: "TenantPublicSiteVersion",
      default: undefined,
    },
  },
  { timestamps: true },
);

tenantPublicSiteVersionSchema.index(
  { tenant: 1, sourceDraftRevision: 1 },
  { unique: true },
);
tenantPublicSiteVersionSchema.index({ tenant: 1, publishedAt: -1, _id: -1 });

export const TenantPublicSiteVersionModel: mongoose.Model<TenantPublicSiteVersion> =
  (mongoose.models.TenantPublicSiteVersion as
    mongoose.Model<TenantPublicSiteVersion> | undefined) ??
  mongoose.model<TenantPublicSiteVersion>(
    "TenantPublicSiteVersion",
    tenantPublicSiteVersionSchema,
  );

export default TenantPublicSiteVersionModel;
