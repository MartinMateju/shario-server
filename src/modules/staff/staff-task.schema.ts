import {
  STAFF_TASK_CATEGORIES,
  STAFF_TASK_CATEGORY,
  STAFF_TASK_LINK_TYPES,
  STAFF_TASK_PRIORITIES,
  STAFF_TASK_PRIORITY,
  STAFF_TASK_STATUS,
  STAFF_TASK_STATUSES,
} from "./staff.constants.js";
// staff-task.schema.ts

import mongoose from "mongoose";

const staffTaskLinkSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: STAFF_TASK_LINK_TYPES,
      required: true,
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    label: {
      type: String,
      trim: true,
      default: "",
      maxlength: 180,
    },
  },
  { _id: false },
);

export const staffTaskSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },

    description: {
      type: String,
      trim: true,
      default: "",
      maxlength: 3000,
    },

    locationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      default: null,
      index: true,
    },

    appliesToAllLocations: {
      type: Boolean,
      default: false,
      index: true,
    },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    dueDate: {
      type: Date,
      default: null,
      index: true,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: STAFF_TASK_STATUSES,
      default: STAFF_TASK_STATUS.TODO,
      index: true,
    },

    priority: {
      type: String,
      enum: STAFF_TASK_PRIORITIES,
      default: STAFF_TASK_PRIORITY.NORMAL,
      index: true,
    },

    blockerReason: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },

    category: {
      type: String,
      enum: STAFF_TASK_CATEGORIES,
      default: STAFF_TASK_CATEGORY.GENERAL,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    source: {
      type: String,
      enum: ["manual", "communication", "ai"],
      default: "manual",
      index: true,
    },

    aiActionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiAction",
      default: null,
      index: true,
      select: false,
    },

    communicationConversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunicationConversation",
      default: null,
      index: true,
    },

    links: {
      type: [staffTaskLinkSchema],
      default: [],
      validate: {
        validator: (
          links: Array<{
            type?: string;
            resourceId?: mongoose.Types.ObjectId;
          }> = [],
        ) => {
          const keys = links.map(
            (link) => `${link.type || ""}:${String(link.resourceId || "")}`,
          );
          return keys.length <= 20 && new Set(keys).size === keys.length;
        },
        message: "Task links must be unique and are limited to 20.",
      },
    },
  },
  { timestamps: true },
);

staffTaskSchema.pre("validate", function normalizeTaskLocation() {
  if (this.appliesToAllLocations) {
    this.locationId = null;
  }

  if (this.status === STAFF_TASK_STATUS.DONE && !this.completedAt) {
    this.completedAt = new Date();
  }

  if (this.status !== STAFF_TASK_STATUS.DONE) {
    this.completedAt = null;
  }
});

staffTaskSchema.index({ tenantId: 1, dueDate: 1 });
staffTaskSchema.index({ tenantId: 1, status: 1, dueDate: 1 });
staffTaskSchema.index({ tenantId: 1, priority: 1, status: 1 });
staffTaskSchema.index({ tenantId: 1, category: 1, status: 1 });
staffTaskSchema.index({ tenantId: 1, assignedTo: 1, status: 1 });
staffTaskSchema.index({ tenantId: 1, locationId: 1, status: 1 });
staffTaskSchema.index({ tenantId: 1, createdBy: 1 });
staffTaskSchema.index({ tenantId: 1, communicationConversationId: 1 });
staffTaskSchema.index(
  { tenantId: 1, aiActionId: 1 },
  {
    unique: true,
    partialFilterExpression: { aiActionId: { $type: "objectId" } },
  },
);
staffTaskSchema.index({ tenantId: 1, "links.type": 1, "links.resourceId": 1 });
