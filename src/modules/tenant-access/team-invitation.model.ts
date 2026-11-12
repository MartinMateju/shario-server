import mongoose, { Schema } from "mongoose";

import {
  LOCATION_ACCESS_MODE,
  WORKSPACE_ROLE,
} from "./tenant-access.constants.js";

const schema = new Schema(
  {
    tenant: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    mode: { type: String, enum: ["join", "sign_in"], required: true },
    membership: {
      type: Schema.Types.ObjectId,
      ref: "TenantMembership",
      default: null,
    },
    roleKey: {
      type: String,
      enum: Object.values(WORKSPACE_ROLE),
      required: true,
    },
    customRoleId: {
      type: Schema.Types.ObjectId,
      ref: "TenantCustomRole",
      default: null,
    },
    locationAccess: {
      mode: {
        type: String,
        enum: Object.values(LOCATION_ACCESS_MODE),
        required: true,
      },
      locationIds: { type: [Schema.Types.ObjectId], default: [] },
    },
    workspaceProfile: {
      jobTitle: { type: String, default: "" },
      displayName: { type: String, default: "" },
      calendarColor: { type: String, default: "#74869a" },
    },
    locale: { type: String, enum: ["cs", "en"], default: "en" },
    status: {
      type: String,
      enum: ["pending", "accepted", "revoked"],
      default: "pending",
      required: true,
    },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    deliveryStatus: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },
    lastSentAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, required: true },
  },
  { timestamps: true },
);

schema.index({ tokenHash: 1 }, { unique: true });
schema.index(
  { tenant: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);
schema.index({ tenant: 1, createdAt: -1 });

export type TeamInvitation = mongoose.InferSchemaType<typeof schema>;
export type TeamInvitationDocument = mongoose.HydratedDocument<TeamInvitation>;
export default mongoose.model("TeamInvitation", schema);
