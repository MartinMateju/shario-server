import mongoose, { Schema } from "mongoose";

import {
  DEFAULT_PLANNING_EXPECTED_UPDATE_TIME,
  DEFAULT_PLANNING_WEEKDAYS,
  MAX_MONTHLY_PRIORITIES,
  MAX_WEEKLY_OUTCOMES,
  STAFF_ATTENTION_STATUS,
  STAFF_ATTENTION_STATUSES,
} from "./staff.constants.js";

const objectId = Schema.Types.ObjectId;

const taskIdsField = {
  type: [{ type: objectId, ref: "StaffTask" }],
  default: [],
  validate: {
    validator: (ids: mongoose.Types.ObjectId[] = []) => {
      const values = ids.map(String);
      return values.length <= 20 && new Set(values).size === values.length;
    },
    message: "Linked task ids must be unique and are limited to 20.",
  },
};

const weeklyOutcomeSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 240 },
    completed: { type: Boolean, default: false },
    linkedTaskIds: taskIdsField,
  },
  { _id: true, strict: true },
);

const monthlyPrioritySchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 240 },
    ownerUserId: { type: objectId, ref: "User", default: null },
    completed: { type: Boolean, default: false },
    linkedTaskIds: taskIdsField,
  },
  { _id: true, strict: true },
);

export const staffPlanningSettingsSchema = new Schema(
  {
    tenantId: {
      type: objectId,
      ref: "Tenant",
      required: true,
      unique: true,
    },
    expectedUpdateTime: {
      type: String,
      default: DEFAULT_PLANNING_EXPECTED_UPDATE_TIME,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
    updatedBy: { type: objectId, ref: "User", default: null },
  },
  { timestamps: true, strict: true },
);

export const staffPlanningProfileSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    userId: { type: objectId, ref: "User", required: true, index: true },
    expectedWeekdays: {
      type: [Number],
      enum: [1, 2, 3, 4, 5, 6, 7],
      default: () => [...DEFAULT_PLANNING_WEEKDAYS],
      validate: {
        validator: (values: number[] = []) =>
          values.length <= 7 && new Set(values).size === values.length,
        message: "Expected weekdays must be unique.",
      },
    },
    updatedBy: { type: objectId, ref: "User", required: true },
  },
  { timestamps: true, strict: true },
);
staffPlanningProfileSchema.index(
  { tenantId: 1, userId: 1 },
  { unique: true },
);

export const staffDailyUpdateSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    userId: { type: objectId, ref: "User", required: true, index: true },
    dateKey: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    locationId: { type: objectId, ref: "Location", default: null, index: true },
    focusToday: { type: String, trim: true, default: "", maxlength: 4_000 },
    completedSinceLast: {
      type: String,
      trim: true,
      default: "",
      maxlength: 4_000,
    },
    blockers: { type: String, trim: true, default: "", maxlength: 4_000 },
    notWorkingToday: { type: Boolean, default: false },
    needsOwnerAttention: { type: Boolean, default: false, index: true },
    attentionStatus: {
      type: String,
      enum: STAFF_ATTENTION_STATUSES,
      default: STAFF_ATTENTION_STATUS.NONE,
      index: true,
    },
    attentionAcknowledgedAt: { type: Date, default: null },
    attentionAcknowledgedBy: { type: objectId, ref: "User", default: null },
    attentionResolvedAt: { type: Date, default: null },
    attentionResolvedBy: { type: objectId, ref: "User", default: null },
    linkedTaskIds: taskIdsField,
    submittedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, strict: true },
);
staffDailyUpdateSchema.index(
  { tenantId: 1, userId: 1, dateKey: 1 },
  { unique: true },
);
staffDailyUpdateSchema.index({ tenantId: 1, dateKey: 1, locationId: 1 });

export const staffWeeklyPlanSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    userId: { type: objectId, ref: "User", required: true, index: true },
    weekStartKey: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    // A null scope is private to the submitter. Team views only expose plans
    // explicitly scoped to a location that the reader can access.
    locationId: { type: objectId, ref: "Location", default: null, index: true },
    outcomes: {
      type: [weeklyOutcomeSchema],
      default: [],
      validate: {
        validator: (values: unknown[] = []) =>
          values.length <= MAX_WEEKLY_OUTCOMES,
        message: `A weekly plan is limited to ${MAX_WEEKLY_OUTCOMES} outcomes.`,
      },
    },
    submittedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, strict: true },
);
staffWeeklyPlanSchema.index(
  { tenantId: 1, userId: 1, weekStartKey: 1 },
  { unique: true },
);
staffWeeklyPlanSchema.index({ tenantId: 1, weekStartKey: 1, locationId: 1 });

export const staffMonthlyPrioritySetSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    monthKey: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}$/,
      index: true,
    },
    // null means an explicit all-location priority set.
    locationId: { type: objectId, ref: "Location", default: null, index: true },
    priorities: {
      type: [monthlyPrioritySchema],
      default: [],
      validate: {
        validator: (values: unknown[] = []) =>
          values.length <= MAX_MONTHLY_PRIORITIES,
        message: `A monthly plan is limited to ${MAX_MONTHLY_PRIORITIES} priorities.`,
      },
    },
    updatedBy: { type: objectId, ref: "User", required: true },
  },
  { timestamps: true, strict: true },
);
staffMonthlyPrioritySetSchema.index(
  { tenantId: 1, monthKey: 1, locationId: 1 },
  { unique: true },
);

export const StaffPlanningSettingsModel: mongoose.Model<any> =
  (mongoose.models.StaffPlanningSettings as mongoose.Model<any> | undefined) ??
  mongoose.model("StaffPlanningSettings", staffPlanningSettingsSchema);

export const StaffPlanningProfileModel: mongoose.Model<any> =
  (mongoose.models.StaffPlanningProfile as mongoose.Model<any> | undefined) ??
  mongoose.model("StaffPlanningProfile", staffPlanningProfileSchema);

export const StaffDailyUpdateModel: mongoose.Model<any> =
  (mongoose.models.StaffDailyUpdate as mongoose.Model<any> | undefined) ??
  mongoose.model("StaffDailyUpdate", staffDailyUpdateSchema);

export const StaffWeeklyPlanModel: mongoose.Model<any> =
  (mongoose.models.StaffWeeklyPlan as mongoose.Model<any> | undefined) ??
  mongoose.model("StaffWeeklyPlan", staffWeeklyPlanSchema);

export const StaffMonthlyPrioritySetModel: mongoose.Model<any> =
  (mongoose.models.StaffMonthlyPrioritySet as mongoose.Model<any> | undefined) ??
  mongoose.model("StaffMonthlyPrioritySet", staffMonthlyPrioritySetSchema);
