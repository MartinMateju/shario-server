import mongoose, { Schema } from "mongoose";

import type { DashboardReport } from "./dashboard-report.types.js";

export type DashboardReportRecord = Omit<DashboardReport, "id"> & {
  _id: mongoose.Types.ObjectId;
  tenant: mongoose.Types.ObjectId;
  creator: mongoose.Types.ObjectId;
  locationIds: string[];
  unrestricted: boolean;
  requiredReadPermissions: string[];
  aiRunId: string | null;
};

const schema = new Schema<DashboardReportRecord>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
    creator: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    generatedAt: { type: String, required: true, immutable: true },
    locale: { type: String, required: true, maxlength: 24, immutable: true },
    sourceLocale: { type: String, enum: ["cs", "en"], required: true, immutable: true },
    locationLabel: { type: String, required: true, maxlength: 300, immutable: true },
    locationIds: { type: [String], required: true, immutable: true },
    unrestricted: { type: Boolean, required: true, immutable: true },
    requiredReadPermissions: { type: [String], required: true, immutable: true },
    snapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
    narrative: { type: Schema.Types.Mixed, required: true, immutable: true },
    sections: { type: Schema.Types.Mixed, required: true, immutable: true },
    aiRunId: { type: String, default: null, immutable: true },
  },
  { strict: true, versionKey: false },
);

schema.index({ tenant: 1, creator: 1, generatedAt: -1 });

export const DashboardReportModel =
  (mongoose.models.DashboardReport as mongoose.Model<DashboardReportRecord> | undefined) ||
  mongoose.model<DashboardReportRecord>("DashboardReport", schema);
