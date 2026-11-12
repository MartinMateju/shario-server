import mongoose from "mongoose";

export const userMemberNumberCounterSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
      default: "member-number",
    },
    value: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "Member-number counter must be a safe integer.",
      },
    },
    allocationEpoch: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "Member-number allocation epoch must be a safe integer.",
      },
    },
    allocationPausedUntil: {
      type: Date,
      default: null,
    },
    // A repair token fails closed even after its deadline. Only the repair
    // operator may release it after confirming whether the repair committed.
    repairLock: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

userMemberNumberCounterSchema.index(
  { tenant: 1, key: 1 },
  { unique: true, name: "tenant_1_member_number_key_1" },
);
