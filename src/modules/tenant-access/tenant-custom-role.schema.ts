import { Schema } from "mongoose";

import { ALL_WORKSPACE_PERMISSIONS } from "./tenant-access.permissions.js";

export const normalizeCustomRoleName = (name: unknown): string => {
  return String(name ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
};

export const tenantCustomRoleSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    normalizedName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    description: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },
    permissions: {
      type: [String],
      enum: ALL_WORKSPACE_PERMISSIONS,
      default: [],
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
    strict: true,
  },
);

tenantCustomRoleSchema.index(
  { tenant: 1, normalizedName: 1 },
  {
    unique: true,
    name: "tenant_1_normalizedName_1",
  },
);

tenantCustomRoleSchema.index(
  { tenant: 1, isActive: 1, name: 1 },
  { name: "tenant_1_isActive_1_name_1" },
);

tenantCustomRoleSchema.pre("validate", function normalizeRole() {
  this.name = String(this.name ?? "").trim().replace(/\s+/g, " ");
  this.normalizedName = normalizeCustomRoleName(this.name);
  this.permissions = [...new Set(this.permissions)].sort();
});

