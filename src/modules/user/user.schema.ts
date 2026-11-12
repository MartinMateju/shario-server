import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { portalAppearanceSchema } from "@/shared/appearance/portal-appearance.schema.js";
import {
  normalizeRolloutEligibleAppLocale,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
} from "@/shared/i18n/locales.js";

import {
  EMAIL_REGEX,
  LEGACY_ROLE,
  PASSWORD_MIN_LENGTH,
  PLATFORM_ROLE,
  TENANT_ROLE,
} from "./user.constants.js";
import {
  allocateUserMemberNumber,
  assertUserMemberNumberAllocationEpoch,
  withUserMemberNumberAllocationEpoch,
  ensureUserMemberNumberCounterAtLeast,
  isInactiveGeneratedGuest,
  USER_MEMBER_NUMBER_HISTORY_REASON,
} from "./user-member-number.service.js";

import { tenantMemberNumberHighWaterMark } from "./user-member-number-high-water.js";

const BCRYPT_SALT_ROUNDS = 12;

const userMemberNumberHistorySchema = new mongoose.Schema(
  {
    number: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Previous member number must be a positive safe integer.",
      },
    },
    replacedAt: {
      type: Date,
      required: true,
    },
    reason: {
      type: String,
      enum: Object.values(USER_MEMBER_NUMBER_HISTORY_REASON),
      required: true,
    },
    importSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DataImportSession",
      default: null,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    _id: false,
    versionKey: false,
  },
);

export const userSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },

    firstname: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 80,
    },

    lastname: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
    },

    /*
     * Email is not globally unique.
     *
     * Uniqueness is enforced per tenant through the compound index:
     * { tenant: 1, email: 1 }
     */
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
      match: EMAIL_REGEX,
      maxlength: 254,
    },

    // Guest purchase contact is deliberately separate from authentication email.
    // Staff and notification readers must explicitly opt in to this private field.
    guestContact: {
      type: new mongoose.Schema(
        {
          email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            match: EMAIL_REGEX,
            maxlength: 254,
          },
          locale: { type: String, maxlength: 10, default: "en" },
          checkoutOrderId: {
            type: mongoose.Schema.Types.ObjectId,
            immutable: true,
            default: undefined,
          },
        },
        { _id: false },
      ),
      select: false,
      default: undefined,
    },

    phone: {
      type: String,
      trim: true,
      default: "",
      maxlength: 40,
    },

    // Customer-site preference only; workspace language belongs to the
    // tenant membership. Null follows the studio's current primary language.
    customerDefaultLanguage: {
      type: String,
      enum: [...ROLLOUT_ELIGIBLE_APP_LOCALES, null],
      set: (value: unknown) =>
        typeof value === "string"
          ? (normalizeRolloutEligibleAppLocale(value) ?? value)
          : value,
      default: null,
    },

    // Private, tenant-scoped customer colors; never part of studio branding.
    portalAppearance: {
      type: portalAppearanceSchema,
      select: false,
      default: () => ({}),
    },

    /*
     * The password must be explicitly selected by authentication queries:
     *
     * .select("+password")
     */
    password: {
      type: String,
      select: false,
      minlength: PASSWORD_MIN_LENGTH,
    },

    tenantRole: {
      type: String,
      enum: Object.values(TENANT_ROLE),
      default: TENANT_ROLE.CUSTOMER,
      select: false,
    },

    platformRole: {
      type: String,
      enum: Object.values(PLATFORM_ROLE),
      default: PLATFORM_ROLE.NONE,
      select: false,
    },

    /*
     * Temporary legacy roles.
     * Remove after all authorization code uses tenantRole/platformRole.
     */
    roles: {
      type: [String],
      enum: Object.values(LEGACY_ROLE),
      default: [LEGACY_ROLE.CUSTOMER],
      select: false,
    },

    customId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    /*
     * Short tenant-scoped number customers write on physical pottery.
     *
     * customId remains the opaque legacy/QR identifier. Keeping the two
     * fields separate preserves old QR payloads and historical snapshots.
     */
    memberNumber: {
      type: Number,
      default: undefined,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Member number must be a positive safe integer.",
      },
    },

    /*
     * Permanent traceability for the exceptional, explicitly confirmed
     * import flow that can replace an already assigned pottery ID. This field
     * is private by default but remains indexed for staff-side historical
     * lookups.
     */
    memberNumberHistory: {
      type: [userMemberNumberHistorySchema],
      default: [],
      select: false,
    },

    isAccessGranted: {
      type: Boolean,
      default: true,
    },

    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    emailToken: {
      type: String,
      default: undefined,
      select: false,
    },

    refreshToken: {
      type: [String],
      default: [],
      select: false,
    },

    /*
     * Incremented whenever a security event must invalidate every active
     * session (for example, a password change or password reset).
     *
     * Version 0 is intentionally compatible with access and refresh tokens
     * issued before this field existed. Once the value is incremented, those
     * legacy versionless tokens no longer match and are rejected.
     */
    sessionVersion: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },

    passwordResetOtpHash: {
      type: String,
      default: undefined,
      select: false,
    },

    passwordResetOtpExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },

    moneyCredits: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Integer minor units are authoritative once populated. moneyCredits is
    // retained as a backwards-compatible major-unit mirror during rollout.
    moneyCreditsMinor: {
      type: Number,
      default: null,
      min: 0,
    },

    membershipCredits: {
      type: Number,
      default: 0,
      min: 0,
    },

    membershipCreditsExpireAt: {
      type: Date,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    importMetadata: {
      type: new mongoose.Schema(
        {
          source: {
            type: String,
            enum: ["csv", "xlsx"],
            required: true,
          },
          importId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "DataImportSession",
            required: true,
          },
          importKey: {
            type: String,
            default: undefined,
            maxlength: 160,
          },
          externalId: {
            type: String,
            default: "",
            maxlength: 120,
          },
          importedAt: {
            type: Date,
            required: true,
          },
          importedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          rolledBackAt: { type: Date, default: null },
          rolledBackBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
          },
          rollbackMutationKey: {
            type: String,
            default: undefined,
            maxlength: 200,
          },
        },
        { _id: false },
      ),
      default: undefined,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

/*
|--------------------------------------------------------------------------
| Unique tenant-scoped indexes
|--------------------------------------------------------------------------
*/

userSchema.index(
  {
    tenant: 1,
    email: 1,
  },
  {
    unique: true,
    partialFilterExpression: { email: { $type: "string" } },
    name: "tenant_1_email_1_partial",
  },
);

userSchema.index(
  {
    tenant: 1,
    "memberNumberHistory.number": 1,
  },
  {
    name: "tenant_1_memberNumberHistory.number_1",
  },
);

userSchema.index(
  {
    tenant: 1,
    "importMetadata.importKey": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "importMetadata.importKey": { $type: "string" },
    },
    name: "tenant_1_importMetadata.importKey_1",
  },
);

userSchema.index(
  {
    tenant: 1,
    "importMetadata.externalId": 1,
  },
  {
    partialFilterExpression: {
      "importMetadata.externalId": { $type: "string" },
    },
    name: "tenant_1_importMetadata.externalId_1",
  },
);

userSchema.index(
  {
    tenant: 1,
    customId: 1,
  },
  {
    unique: true,
    name: "tenant_1_customId_1",
  },
);

userSchema.index(
  {
    tenant: 1,
    memberNumber: 1,
  },
  {
    unique: true,
    partialFilterExpression: { memberNumber: { $type: "number" } },
    name: "tenant_1_memberNumber_1_partial",
  },
);

/*
|--------------------------------------------------------------------------
| Query indexes
|--------------------------------------------------------------------------
*/

userSchema.index(
  {
    tenant: 1,
    createdAt: -1,
  },
  {
    name: "tenant_1_createdAt_-1",
  },
);

userSchema.index(
  {
    tenant: 1,
    tenantRole: 1,
    createdAt: -1,
  },
  {
    name: "tenant_1_tenantRole_1_createdAt_-1",
  },
);

userSchema.index(
  {
    tenant: 1,
    isAccessGranted: 1,
    createdAt: -1,
  },
  {
    name: "tenant_1_isAccessGranted_1_createdAt_-1",
  },
);

/*
|--------------------------------------------------------------------------
| Methods
|--------------------------------------------------------------------------
*/

userSchema.methods.matchPassword = async function matchPassword(
  enteredPassword: string,
): Promise<boolean> {
  if (!this.password) {
    return false;
  }

  return bcrypt.compare(enteredPassword, this.password);
};

/*
|--------------------------------------------------------------------------
| Password hashing
|--------------------------------------------------------------------------
|
| Services must pass the plain validated password.
| Do not hash passwords manually before creating or saving the user.
|
*/

userSchema.pre("save", async function assignMemberNumber() {
  // Partial updates (for example, credit refunds) do not load memberNumber.
  // An unselected field is not evidence that this existing user needs a number.
  if (
    !this.isNew &&
    !this.isSelected("memberNumber") &&
    !this.isModified("memberNumber")
  ) {
    return;
  }

  if (this.memberNumber !== undefined && this.memberNumber !== null) {
    return;
  }

  // Historical anonymous-course placeholders become numbered when they are
  // claimed and activated, not while they are still anonymous records.
  if (isInactiveGeneratedGuest(this)) {
    return;
  }

  const model = this.constructor as mongoose.Model<unknown>;
  const session = this.$session();

  // Rollback keeps imported records as private audit archives and unsets
  // their member number. A later maintenance save must not reactivate such a
  // record in the tenant sequence, even when importMetadata was not selected
  // on the Mongoose document that is being saved.
  if (!this.isNew) {
    const persistedImportState = await model.collection.findOne(
      { _id: this._id, tenant: this.tenant },
      {
        projection: { "importMetadata.rolledBackAt": 1 },
        ...(session ? { session } : {}),
      },
    );
    if (
      (
        persistedImportState as {
          importMetadata?: { rolledBackAt?: Date | null };
        } | null
      )?.importMetadata?.rolledBackAt
    ) {
      return;
    }
  }

  const assignment = await withUserMemberNumberAllocationEpoch(
    { tenantId: this.tenant, session },
    async (expectedEpoch) => {
      const tenantHighWaterMark = await tenantMemberNumberHighWaterMark({
        collection: model.collection,
        tenantId: this.tenant,
        session,
      });

      const legacyCandidateText = String(this.customId ?? "").trim();
      const legacyCandidate = /^\d+$/.test(legacyCandidateText)
        ? Number(legacyCandidateText)
        : null;

      if (
        legacyCandidate !== null &&
        Number.isSafeInteger(legacyCandidate) &&
        legacyCandidate > 0
      ) {
        const conflictingMemberOwner = await model.collection.findOne(
          {
            _id: { $ne: this._id },
            tenant: this.tenant,
            $or: [
              { memberNumber: legacyCandidate },
              { "memberNumberHistory.number": legacyCandidate },
            ],
          },
          {
            projection: { _id: 1 },
            ...(session ? { session } : {}),
          },
        );
        const conflictingLegacyOwners = await model.collection
          .aggregate(
            [
              {
                $match: {
                  _id: { $ne: this._id },
                  tenant: this.tenant,
                  customId: { $type: "string", $regex: /^\d+$/ },
                },
              },
              {
                $project: {
                  numericCustomId: {
                    $convert: {
                      input: "$customId",
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                },
              },
              { $match: { numericCustomId: legacyCandidate } },
              { $limit: 1 },
            ],
            {
              ...(session ? { session } : {}),
            },
          )
          .toArray();

        if (conflictingMemberOwner || conflictingLegacyOwners.length > 0) {
          throw new Error(
            `Legacy numeric member ID ${legacyCandidate} belongs to more than one user. Run the member-number migration preflight.`,
          );
        }

        await ensureUserMemberNumberCounterAtLeast({
          tenantId: this.tenant,
          minimum: tenantHighWaterMark,
          session,
          expectedEpoch,
        });
        return { memberNumber: legacyCandidate, expectedEpoch };
      }

      const memberNumber = await allocateUserMemberNumber({
        tenantId: this.tenant,
        minimum: tenantHighWaterMark,
        session,
        expectedEpoch,
      });
      return { memberNumber, expectedEpoch };
    },
  );
  this.memberNumber = assignment.memberNumber;
  this.$locals.memberNumberAllocationEpoch = assignment.expectedEpoch;
});

userSchema.pre("save", async function protectAssignedMemberNumber() {
  if (this.isNew || !this.isModified("memberNumber")) return;

  const model = this.constructor as mongoose.Model<unknown>;
  const session = this.$session();
  const persisted = await model.collection.findOne(
    { _id: this._id },
    {
      projection: { memberNumber: 1 },
      ...(session ? { session } : {}),
    },
  );
  const previous = Number(
    (persisted as { memberNumber?: unknown } | null)?.memberNumber,
  );

  if (
    Number.isSafeInteger(previous) &&
    previous > 0 &&
    previous !== this.memberNumber
  ) {
    throw new Error("Member number cannot be changed once assigned.");
  }
});

userSchema.pre("save", async function hashPassword() {
  if (!this.isModified("password") || !this.password) {
    return;
  }

  this.password = await bcrypt.hash(this.password, BCRYPT_SALT_ROUNDS);
});

// Password hashing and earlier hooks can yield after allocation. Check again
// immediately before persistence so a repair can drain outstanding saves.
userSchema.pre("save", async function guardAllocatedMemberNumber() {
  const expectedEpoch = this.$locals.memberNumberAllocationEpoch;
  if (typeof expectedEpoch !== "number") return;
  try {
    await assertUserMemberNumberAllocationEpoch({
      tenantId: this.tenant,
      session: this.$session(),
      expectedEpoch,
    });
  } catch (error) {
    this.memberNumber = undefined;
    delete this.$locals.memberNumberAllocationEpoch;
    throw error;
  }
});

userSchema.post("save", function clearMemberNumberAllocationEpoch() {
  delete this.$locals.memberNumberAllocationEpoch;
});
