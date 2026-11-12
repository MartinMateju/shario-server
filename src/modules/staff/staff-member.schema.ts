import { DEFAULT_STAFF_COLOR, EMPLOYMENT_TYPE, EMPLOYMENT_TYPES, STAFF_ROLE, STAFF_ROLES } from "./staff.constants.js";
// staff-member.schema.ts

import mongoose from "mongoose";

export const staffMemberSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      default: "",
    },

    phone: {
      type: String,
      trim: true,
      maxlength: 50,
      default: "",
    },

    role: {
      type: String,
      enum: STAFF_ROLES,
      default: STAFF_ROLE.OTHER,
      index: true,
    },

    employmentType: {
      type: String,
      enum: EMPLOYMENT_TYPES,
      default: EMPLOYMENT_TYPE.EMPLOYEE,
      index: true,
    },

    locationIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Location",
      },
    ],

    color: {
      type: String,
      trim: true,
      default: DEFAULT_STAFF_COLOR,
      maxlength: 20,
    },

    bio: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },

    avatarUrl: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },

    skills: {
      type: [String],
      default: [],
    },

    hourlyRate: {
      type: Number,
      min: 0,
      default: null,
    },

    note: {
      type: String,
      trim: true,
      default: "",
      maxlength: 3000,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    isBookable: {
      type: Boolean,
      default: false,
      index: true,
    },

    visibleOnWebsite: {
      type: Boolean,
      default: false,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

staffMemberSchema.index({ tenantId: 1, email: 1 });
staffMemberSchema.index({ tenantId: 1, userId: 1 }, { sparse: true });
staffMemberSchema.index({ tenantId: 1, role: 1, isActive: 1 });
staffMemberSchema.index({ tenantId: 1, isBookable: 1, isActive: 1 });
staffMemberSchema.index({ tenantId: 1, visibleOnWebsite: 1, isActive: 1 });
staffMemberSchema.index({ tenantId: 1, locationIds: 1, isActive: 1 });
