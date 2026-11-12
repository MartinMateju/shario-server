import mongoose, { type Types } from "mongoose";

export interface CustomOrderAttachment {
  _id: Types.ObjectId;
  name: string;
  kind: "image" | "document";
  key: string;
  secret: string;
  contentType: string;
  size: number;
  createdAt: Date;
}
export interface CustomOrderRecord {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  location: Types.ObjectId;
  reference: string;
  title: string;
  description: string;
  pieceCount: number;
  materials: string;
  finish: string;
  startDate: string;
  deadline: string;
  timeZone: string;
  deadlineAt: Date;
  reminderCycle: number;
  dueSoonReminderAt: Date | null;
  overdueReminderAt: Date | null;
  customer: { name: string; email: string; phone: string };
  customerId: Types.ObjectId | null;
  assignee: Types.ObjectId | null;
  quotedAmount: number | null;
  currency: string;
  status: "active" | "closed";
  closeReason: "completed" | "cancelled" | null;
  closedAt: Date | null;
  revision: number;
  attachments: CustomOrderAttachment[];
  createdAt: Date;
  updatedAt: Date;
}
export interface CustomOrderEventRecord {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  order: Types.ObjectId;
  action: string;
  actor: Types.ObjectId;
  actorName: string;
  createdAt: Date;
  body: string;
  changes: Array<{ field: string; from: string; to: string }>;
}

const id = mongoose.Schema.Types.ObjectId;
const contactSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", maxlength: 160 },
    email: { type: String, default: "", maxlength: 254 },
    phone: { type: String, default: "", maxlength: 40 },
  },
  { _id: false },
);
const attachmentSchema = new mongoose.Schema<CustomOrderAttachment>({
  name: { type: String, required: true },
  kind: { type: String, enum: ["image", "document"], required: true },
  key: { type: String, required: true },
  secret: { type: String, required: true },
  contentType: { type: String, required: true },
  size: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});
const historySchema = new mongoose.Schema<CustomOrderEventRecord>(
  {
    tenant: { type: id, required: true, immutable: true },
    order: { type: id, ref: "CustomOrder", required: true, immutable: true },
    action: { type: String, required: true },
    actor: { type: id, required: true },
    actorName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    body: { type: String, default: "", maxlength: 4000 },
    changes: {
      type: [
        new mongoose.Schema(
          {
            field: { type: String, required: true },
            from: { type: String, default: "" },
            to: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { collection: "customorderevents", strict: "throw" },
);
historySchema.index({ tenant: 1, order: 1, createdAt: -1, _id: -1 });
export const customOrderSchema = new mongoose.Schema<CustomOrderRecord>(
  {
    tenant: { type: id, ref: "Tenant", required: true, immutable: true },
    location: { type: id, ref: "Location", required: true },
    reference: { type: String, required: true, immutable: true },
    title: { type: String, required: true, maxlength: 160 },
    description: { type: String, required: true, maxlength: 10000 },
    pieceCount: { type: Number, required: true, min: 1, max: 1000000 },
    materials: { type: String, required: true, maxlength: 4000 },
    finish: { type: String, default: "", maxlength: 4000 },
    startDate: { type: String, required: true },
    deadline: { type: String, required: true },
    timeZone: { type: String, required: true },
    deadlineAt: { type: Date, required: true },
    reminderCycle: { type: Number, default: 0 },
    dueSoonReminderAt: { type: Date, default: null },
    overdueReminderAt: { type: Date, default: null },
    customer: { type: contactSchema, default: () => ({}) },
    customerId: { type: id, ref: "User", default: null },
    assignee: { type: id, ref: "User", default: null },
    quotedAmount: { type: Number, default: null, min: 0 },
    currency: { type: String, required: true },
    status: { type: String, enum: ["active", "closed"], default: "active" },
    closeReason: {
      type: String,
      enum: ["completed", "cancelled", null],
      default: null,
    },
    closedAt: { type: Date, default: null },
    revision: { type: Number, default: 0 },
    attachments: { type: [attachmentSchema], default: [] },
  },
  { timestamps: true, collection: "customorders", strict: "throw" },
);
customOrderSchema.index({ tenant: 1, reference: 1 }, { unique: true });
customOrderSchema.index({ tenant: 1, location: 1, status: 1, updatedAt: -1 });
customOrderSchema.index({
  status: 1,
  deadlineAt: 1,
  dueSoonReminderAt: 1,
  overdueReminderAt: 1,
});
export const CustomOrder =
  (mongoose.models.CustomOrder as mongoose.Model<CustomOrderRecord>) ||
  mongoose.model<CustomOrderRecord>("CustomOrder", customOrderSchema);
export const CustomOrderEvent =
  (mongoose.models
    .CustomOrderEvent as mongoose.Model<CustomOrderEventRecord>) ||
  mongoose.model<CustomOrderEventRecord>("CustomOrderEvent", historySchema);
