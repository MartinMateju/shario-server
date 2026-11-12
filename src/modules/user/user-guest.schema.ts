// user-guest.schema.ts

import mongoose from "mongoose";

import { EMAIL_REGEX } from "./user.constants.js";

export const userGuestSchema = new mongoose.Schema(
    {
        tenant: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        firstname: {
            type: String,
            required: true,
            trim: true,
            maxlength: 80,
        },

        lastname: {
            type: String,
            required: true,
            trim: true,
            maxlength: 80,
        },

        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            match: EMAIL_REGEX,
            maxlength: 254,
        },

        phone: {
            type: String,
            trim: true,
            default: "",
            maxlength: 40,
        },

        note: {
            type: String,
            trim: true,
            default: "",
            maxlength: 1000,
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    },
);

userGuestSchema.virtual("fullName").get(function () {
    return `${this.firstname} ${this.lastname}`.trim();
});

userGuestSchema.index(
    {
        tenant: 1,
        owner: 1,
        email: 1,
    },
    {
        unique: true,
    },
);

userGuestSchema.index({
    tenant: 1,
    owner: 1,
    lastname: 1,
});