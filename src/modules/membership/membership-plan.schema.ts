import mongoose, { Schema } from "mongoose";

import { MEMBERSHIP_PLAN_STATUS } from "./membership.constants.js";

const membershipPlanImportMetadataSchema = new Schema(
  {
    source: { type: String, enum: ["csv", "xlsx"], required: true },
    importId: { type: String, required: true, maxlength: 64 },
    importKey: { type: String, required: true, maxlength: 160 },
    externalId: { type: String, default: undefined, maxlength: 120 },
    fingerprint: { type: String, required: true, maxlength: 64 },
    lastMutationKey: { type: String, default: undefined, maxlength: 160 },
    importedAt: { type: Date, required: true },
    importedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rolledBackAt: { type: Date, default: null },
    rolledBackBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    rollbackMutationKey: { type: String, default: undefined, maxlength: 200 },
  },
  { _id: false, strict: true },
);

/** Stable product identity. Commercial terms live only in version snapshots. */
export const membershipPlanSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(MEMBERSHIP_PLAN_STATUS),
      default: MEMBERSHIP_PLAN_STATUS.DRAFT,
      required: true,
      index: true,
    },
    currentPublishedVersion: {
      type: Schema.Types.ObjectId,
      ref: "MembershipPlanVersion",
      default: null,
      index: true,
    },
    currentDraftVersion: {
      type: Schema.Types.ObjectId,
      ref: "MembershipPlanVersion",
      default: null,
    },
    versionCounter: { type: Number, min: 0, default: 0, required: true },
    sortOrder: { type: Number, default: 0, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    publishedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    importMetadata: {
      type: membershipPlanImportMetadataSchema,
      default: undefined,
      select: false,
    },
  },
  { timestamps: true, strict: true, optimisticConcurrency: true },
);

membershipPlanSchema.index({
  tenant: 1,
  status: 1,
  sortOrder: 1,
  createdAt: -1,
});
for (const [field, name] of [
  ["importKey", "membership_plan_import_key_unique"],
  ["externalId", "membership_plan_import_external_id_unique"],
  ["fingerprint", "membership_plan_import_fingerprint_unique"],
] as const) {
  membershipPlanSchema.index(
    { tenant: 1, [`importMetadata.${field}`]: 1 },
    {
      unique: true,
      partialFilterExpression: {
        [`importMetadata.${field}`]: { $type: "string" },
      },
      name,
    },
  );
}
membershipPlanSchema.index(
  { tenant: 1, "importMetadata.lastMutationKey": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "importMetadata.lastMutationKey": { $type: "string" },
    },
    name: "membership_plan_last_mutation_unique",
  },
);
