import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

const mocks = vi.hoisted(() => ({
  tenantFindById: vi.fn(),
  tenantCreate: vi.fn(),
  tenantUpdateOne: vi.fn(),
  publishPublicSiteDraft: vi.fn(),
  locationFind: vi.fn(),
  locationCount: vi.fn(),
  locationCreate: vi.fn(),
  locationUpdateOne: vi.fn(),
  productFind: vi.fn(),
  productCreate: vi.fn(),
  productUpdateOne: vi.fn(),
  bookingFindOne: vi.fn(),
  bookingCreate: vi.fn(),
  bookingUpdateOne: vi.fn(),
  getTenantSubscriptionAccess: vi.fn(),
  paymentFindOne: vi.fn(),
  paymentCreate: vi.fn(),
  paymentUpdateOne: vi.fn(),
  communicationSettingsFindOne: vi.fn(),
  communicationSettingsUpdateOne: vi.fn(),
  resolveManagedSender: vi.fn(),
  senderCreate: vi.fn(),
  teamCount: vi.fn(),
  membershipPlanCount: vi.fn(),
  membershipPlanCreate: vi.fn(),
  automationCount: vi.fn(),
  automationCreate: vi.fn(),
  customerCount: vi.fn(),
  firingProfileCount: vi.fn(),
  piecePricingProfileCount: vi.fn(),
  piecePricingProfileFind: vi.fn(),
  kilnCount: vi.fn(),
  inventoryItemCount: vi.fn(),
  userCreate: vi.fn(),
  stateFindOne: vi.fn(),
  stateFindOneAndUpdate: vi.fn(),
  auditCreate: vi.fn(),
  launchEventUpdateOne: vi.fn(),
  cacheDelete: vi.fn(),
}));

vi.mock("@/infrastructure/redis/cache.js", () => ({
  deleteCache: mocks.cacheDelete,
}));

vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: {
    findById: mocks.tenantFindById,
    create: mocks.tenantCreate,
    updateOne: mocks.tenantUpdateOne,
  },
}));
vi.mock("@/modules/tenants/settings/tenant-settings.service.js", () => ({
  publishTenantPublicSiteDraft: mocks.publishPublicSiteDraft,
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: {
    find: mocks.locationFind,
    countDocuments: mocks.locationCount,
    create: mocks.locationCreate,
    updateOne: mocks.locationUpdateOne,
  },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: {
    find: mocks.productFind,
    create: mocks.productCreate,
    updateOne: mocks.productUpdateOne,
  },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    findOne: mocks.bookingFindOne,
    create: mocks.bookingCreate,
    updateOne: mocks.bookingUpdateOne,
  },
}));
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);
vi.mock("@/modules/tenant-payments/tenant-payment-account.schema.js", () => ({
  default: {
    findOne: mocks.paymentFindOne,
    create: mocks.paymentCreate,
    updateOne: mocks.paymentUpdateOne,
  },
}));
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationSettingsModel: {
    findOne: mocks.communicationSettingsFindOne,
    updateOne: mocks.communicationSettingsUpdateOne,
  },
}));
vi.mock(
  "@/modules/registered-sender-email/registered-sender-email.model.js",
  () => ({
    RegisteredSenderEmailModel: {
      create: mocks.senderCreate,
    },
  }),
);
vi.mock(
  "@/modules/registered-sender-email/services/managed-sender-resolver.service.js",
  () => ({
    ManagedSenderNotReadyError: class ManagedSenderNotReadyError extends Error {},
    resolveManagedSender: mocks.resolveManagedSender,
  }),
);
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: {
    countDocuments: mocks.teamCount,
  },
}));
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  MembershipPlanModel: {
    countDocuments: mocks.membershipPlanCount,
    create: mocks.membershipPlanCreate,
  },
}));
vi.mock(
  "@/modules/communication-automations/communication-automation.model.js",
  () => ({
    CommunicationAutomation: {
      countDocuments: mocks.automationCount,
      create: mocks.automationCreate,
    },
  }),
);
vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    countDocuments: mocks.customerCount,
    create: mocks.userCreate,
  },
}));
vi.mock("@/modules/firing-profile/firing-profile.model.js", () => ({
  FiringProfileModel: { countDocuments: mocks.firingProfileCount },
}));
vi.mock("@/modules/piece-pricing/piece-pricing-profile.model.js", () => ({
  PiecePricingProfileModel: {
    countDocuments: mocks.piecePricingProfileCount,
    find: mocks.piecePricingProfileFind,
  },
}));
vi.mock("@/modules/kiln/kiln.model.js", () => ({
  default: { countDocuments: mocks.kilnCount },
}));
vi.mock("@/modules/inventory/inventory-item.schema.js", () => ({
  InventoryItem: { countDocuments: mocks.inventoryItemCount },
}));
vi.mock("@/modules/setup-center/setup-center.model.js", () => ({
  SetupCenterStateModel: {
    findOne: mocks.stateFindOne,
    findOneAndUpdate: mocks.stateFindOneAndUpdate,
  },
  SetupAuditEventModel: {
    create: mocks.auditCreate,
  },
  SetupLaunchEventModel: {
    updateOne: mocks.launchEventUpdateOne,
  },
}));

import {
  COMMUNICATION_AUTOMATION_PURPOSE,
  COMMUNICATION_AUTOMATION_STATUS,
  COMMUNICATION_SCHEDULE_TYPE,
} from "@/modules/communication-automations/communication-automation.constants.js";
import {
  SETUP_CENTER_DEFINITION_VERSION,
  SETUP_LAUNCH_EVENT,
  SETUP_PRACTICE_ACTION,
  SETUP_PRACTICE_ACTION_ORDER,
  SETUP_PRACTICE_STATUS,
  SETUP_PUBLICATION_STATUS,
  SETUP_STEP,
  SETUP_STEP_REQUIREMENT,
  SETUP_STEP_STATUS,
} from "@/modules/setup-center/setup-center.constants.js";
import { ManagedSenderNotReadyError } from "@/modules/registered-sender-email/services/managed-sender-resolver.service.js";
import {
  applySetupPracticeAction,
  buildSetupCenterSnapshot,
  confirmSetupPractice,
  clearSetupPracticeConfirmation,
  getSetupDiagnosticFallback,
  publishStudio,
  recordSetupLaunchEvent,
  startSetupPractice,
  unpublishStudio,
} from "@/modules/setup-center/setup-center.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const OTHER_USER_ID = "507f1f77bcf86cd799439013";
const LOCATION_ID = "507f1f77bcf86cd799439014";
const PRODUCT_ID = "507f1f77bcf86cd799439015";
const SECOND_LOCATION_ID = "507f1f77bcf86cd799439016";
const SECOND_PRODUCT_ID = "507f1f77bcf86cd799439017";
const PIECE_PRICING_PROFILE_ID = "507f1f77bcf86cd799439018";
const SECOND_PIECE_PRICING_PROFILE_ID = "507f1f77bcf86cd799439019";
const NOW = new Date("2026-07-23T09:00:00.000Z");

const domainWriteMocks = [
  mocks.tenantCreate,
  mocks.tenantUpdateOne,
  mocks.publishPublicSiteDraft,
  mocks.locationCreate,
  mocks.locationUpdateOne,
  mocks.productCreate,
  mocks.productUpdateOne,
  mocks.bookingCreate,
  mocks.bookingUpdateOne,
  mocks.paymentCreate,
  mocks.paymentUpdateOne,
  mocks.communicationSettingsUpdateOne,
  mocks.senderCreate,
  mocks.membershipPlanCreate,
  mocks.automationCreate,
  mocks.userCreate,
];

const selectedLean = (value: unknown) => ({
  select: vi.fn(() => ({
    lean: vi.fn().mockResolvedValue(value),
  })),
});

const selectedSortedLean = (value: unknown) => ({
  select: vi.fn(() => ({
    sort: vi.fn(() => ({
      lean: vi.fn().mockResolvedValue(value),
    })),
  })),
});

const lean = (value: unknown) => ({
  lean: vi.fn().mockResolvedValue(value),
});

const tenantFixture = {
  _id: TENANT_ID,
  name: "Safe Studio",
  slug: "safe-studio",
  status: "active",
  settings: {
    currency: "CZK",
    timezone: "Europe/Prague",
  },
  publicSiteEditor: {
    draftRevision: 2,
    publishedRevision: 0,
    draftUpdatedAt: NOW,
    publishedAt: null,
  },
  onboarding: {
    completed: true,
    businessType: "coworking_space",
    teamSize: "just_me",
    businessDetails: {
      country: "CZ",
      address: "Studio Street 1",
    },
    bookingSetup: {
      confirmationMode: "instant",
    },
  },
};

const locationFixture = {
  _id: LOCATION_ID,
  name: "Main studio",
  isActive: true,
  isPrimary: true,
  booking: { enabled: true },
  updatedAt: NOW,
};

const productFixture = {
  _id: PRODUCT_ID,
  name: "Wheel class",
  type: "course",
  kind: "class",
  kindContractVersion: 2,
  price: 1_200,
  currency: "CZK",
  maxNumberOfParticipants: 8,
  isActive: true,
  updatedAt: NOW,
};

const secondLocationFixture = {
  ...locationFixture,
  _id: SECOND_LOCATION_ID,
  name: "Second studio",
  isPrimary: false,
};

const secondProductFixture = {
  ...productFixture,
  _id: SECOND_PRODUCT_ID,
  name: "Glazing workshop",
  type: "workshop",
  kind: "open-studio",
  kindContractVersion: 2,
  bookingMode: "public",
};

const separateBillingOpenStudioFixture = {
  ...secondProductFixture,
  studioFlow: {
    registrationPolicy: "optional",
    firingBilling: "separate",
    piecePricingProfileId: null,
  },
};

const prepareCompletedPiecePricing = () => {
  mocks.productFind.mockReturnValue(
    selectedSortedLean([
      {
        ...separateBillingOpenStudioFixture,
        studioFlow: {
          ...separateBillingOpenStudioFixture.studioFlow,
          piecePricingProfileId: PIECE_PRICING_PROFILE_ID,
        },
      },
    ]),
  );
  mocks.piecePricingProfileCount.mockResolvedValue(1);
};

const paymentFixture = {
  stripeAccountId: "acct_safe_studio",
  onboardingStatus: "complete",
  detailsSubmitted: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  requirements: {
    currentlyDue: [],
    pastDue: [],
  },
  lastSyncedAt: NOW,
};

const communicationFixture = {
  businessHoursConfiguredAt: NOW,
  inbox: {
    forwardingLocalPart: "",
  },
  channels: {
    email: {
      enabled: true,
      inboundEnabled: false,
    },
    whatsapp: {
      enabled: false,
    },
    instagram: {
      enabled: false,
    },
  },
  businessHours: {
    monday: {
      enabled: true,
    },
  },
};

let stateDocument: {
  publication: {
    status: string;
    publishedAt?: Date | null;
    publishedBy?: string | null;
    unpublishedAt?: Date | null;
    unpublishedBy?: string | null;
  };
  practice: any;
  practiceConfirmation?: any;
  analytics?: Record<string, any>;
  save: ReturnType<typeof vi.fn>;
};

const activePractice = ({
  actor = USER_ID,
  completedActions = [],
  readinessFingerprint = "fingerprint",
  expiresAt = new Date(Date.now() + 60_000),
}: {
  actor?: string;
  completedActions?: string[];
  readinessFingerprint?: string;
  expiresAt?: Date;
} = {}) => ({
  runId: "practice_1234567890",
  idempotencyKey: "setup-run-0001",
  actor,
  status: SETUP_PRACTICE_STATUS.IN_PROGRESS,
  locationId: LOCATION_ID,
  productId: PRODUCT_ID,
  readinessFingerprint,
  completedActions: [...completedActions],
  artifacts: [],
  startedAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
  expiresAt,
});

const configureStateUpdates = () => {
  mocks.stateFindOneAndUpdate.mockImplementation(
    async (filter: any, update: any) => {
      if (update?.$setOnInsert) return stateDocument;

      const previousFingerprint =
        filter?.["practiceConfirmation.readinessFingerprint"];
      if (
        previousFingerprint?.$ne &&
        stateDocument.practiceConfirmation?.readinessFingerprint ===
          previousFingerprint.$ne
      )
        return null;
      if (
        filter?.practiceConfirmation?.$ne === null &&
        !stateDocument.practiceConfirmation
      )
        return null;

      if (Array.isArray(filter?.$or)) {
        const practice = stateDocument.practice;
        const canStart =
          !practice ||
          practice.status === SETUP_PRACTICE_STATUS.ABANDONED ||
          practice.status === SETUP_PRACTICE_STATUS.EXPIRED ||
          (practice.status === SETUP_PRACTICE_STATUS.IN_PROGRESS &&
            new Date(practice.expiresAt).getTime() <= Date.now());

        if (!canStart) return null;
      }

      const expectedRunId = filter?.["practice.runId"];
      if (expectedRunId && stateDocument.practice?.runId !== expectedRunId) {
        return null;
      }
      const expectedActor = filter?.["practice.actor"];
      if (
        expectedActor &&
        String(stateDocument.practice?.actor) !== String(expectedActor)
      ) {
        return null;
      }
      const expectedPracticeStatus = filter?.["practice.status"];
      if (
        typeof expectedPracticeStatus === "string" &&
        stateDocument.practice?.status !== expectedPracticeStatus
      ) {
        return null;
      }
      const expectedExpiry = filter?.["practice.expiresAt"];
      if (expectedExpiry?.$gt) {
        if (
          !stateDocument.practice ||
          new Date(stateDocument.practice.expiresAt).getTime() <=
            new Date(expectedExpiry.$gt).getTime()
        ) {
          return null;
        }
      }
      if (expectedExpiry?.$lte) {
        if (
          !stateDocument.practice ||
          new Date(stateDocument.practice.expiresAt).getTime() >
            new Date(expectedExpiry.$lte).getTime()
        ) {
          return null;
        }
      }
      const expectedActions = filter?.["practice.completedActions"];
      if (
        Array.isArray(expectedActions) &&
        JSON.stringify(stateDocument.practice?.completedActions ?? []) !==
          JSON.stringify(expectedActions)
      ) {
        return null;
      }

      const expectedStatus = filter?.["publication.status"];
      const currentStatus = stateDocument.publication.status;
      if (
        expectedStatus &&
        typeof expectedStatus === "object" &&
        "$ne" in expectedStatus &&
        currentStatus === expectedStatus.$ne
      ) {
        return null;
      }
      if (
        typeof expectedStatus === "string" &&
        currentStatus !== expectedStatus
      ) {
        return null;
      }

      for (const [path, value] of Object.entries(update?.$set ?? {})) {
        switch (path) {
          case "practiceConfirmation":
            stateDocument.practiceConfirmation = value;
            break;
          case "practice":
            stateDocument.practice = value;
            break;
          case "practice.status":
            stateDocument.practice.status = value;
            break;
          case "practice.updatedAt":
            stateDocument.practice.updatedAt = value;
            break;
          case "practice.completedAt":
            stateDocument.practice.completedAt = value;
            break;
          case "publication.status":
            stateDocument.publication.status = String(value);
            break;
          case "publication.publishedAt":
            stateDocument.publication.publishedAt = value as Date;
            break;
          case "publication.publishedBy":
            stateDocument.publication.publishedBy = String(value);
            break;
          case "publication.unpublishedAt":
            stateDocument.publication.unpublishedAt = value as Date;
            break;
          case "publication.unpublishedBy":
            stateDocument.publication.unpublishedBy = String(value);
            break;
        }
      }
      for (const [path, value] of Object.entries(update?.$push ?? {})) {
        switch (path) {
          case "practice.completedActions":
            stateDocument.practice.completedActions.push(value);
            break;
          case "practice.artifacts":
            stateDocument.practice.artifacts.push(value);
            break;
        }
      }
      for (const path of Object.keys(update?.$unset ?? {})) {
        switch (path) {
          case "publication.publishedAt":
            delete stateDocument.publication.publishedAt;
            break;
          case "publication.publishedBy":
            delete stateDocument.publication.publishedBy;
            break;
          case "publication.unpublishedAt":
            delete stateDocument.publication.unpublishedAt;
            break;
          case "publication.unpublishedBy":
            delete stateDocument.publication.unpublishedBy;
            break;
        }
      }
      return stateDocument;
    },
  );
};

const preparePublishedBothPricingWithIncludedFiring = () => {
  mocks.tenantFindById.mockReturnValue(
    selectedLean({
      ...tenantFixture,
      modules: {
        bookings: true,
        courses: false,
        payments: true,
        firing: true,
        inventory: false,
        communications: true,
        memberships: false,
      },
      publicSiteEditor: {
        ...tenantFixture.publicSiteEditor,
        publishedRevision: 2,
        publishedAt: NOW,
      },
      workspaceIntent: {
        definitionVersion: 2,
        pricingMode: "both",
        answers: {
          sharedStudio: true,
          classes: false,
          memberships: false,
          vouchers: false,
          inventory: false,
        },
      },
    }),
  );
  mocks.productFind.mockReturnValue(
    selectedSortedLean([
      {
        ...secondProductFixture,
        studioFlow: {
          registrationPolicy: "optional",
          firingBilling: "included",
          piecePricingProfileId: null,
        },
      },
    ]),
  );
  mocks.piecePricingProfileCount.mockResolvedValue(1);
  stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
  stateDocument.practice = activePractice({
    expiresAt: new Date(Date.now() - 60_000),
  });
};

describe("Setup Center Practice Mode isolation and transitions", () => {
  beforeEach(() => {
    vi.stubEnv("NATIVE_INVOICES_ENABLED", "true");
    vi.clearAllMocks();

    stateDocument = {
      publication: {
        status: SETUP_PUBLICATION_STATUS.DRAFT,
      },
      practice: null,
      save: vi.fn().mockResolvedValue(undefined),
    };

    mocks.tenantFindById.mockReturnValue(selectedLean(tenantFixture));
    mocks.locationFind.mockReturnValue(selectedSortedLean([locationFixture]));
    mocks.locationCount.mockResolvedValue(1);
    mocks.productFind.mockReturnValue(selectedSortedLean([productFixture]));
    mocks.paymentFindOne.mockReturnValue(lean(paymentFixture));
    mocks.communicationSettingsFindOne.mockReturnValue(
      selectedLean(communicationFixture),
    );
    mocks.resolveManagedSender.mockResolvedValue({ id: "sender-1" });
    mocks.teamCount.mockResolvedValue(1);
    mocks.membershipPlanCount.mockResolvedValue(0);
    mocks.automationCount.mockResolvedValue(0);
    mocks.customerCount.mockResolvedValue(0);
    mocks.firingProfileCount.mockResolvedValue(0);
    mocks.piecePricingProfileCount.mockResolvedValue(0);
    mocks.piecePricingProfileFind.mockReturnValue(selectedLean([]));
    mocks.kilnCount.mockResolvedValue(0);
    mocks.inventoryItemCount.mockResolvedValue(0);
    mocks.bookingFindOne.mockReturnValue(
      selectedLean({
        bookingProduct: PRODUCT_ID,
        location: LOCATION_ID,
      }),
    );
    mocks.getTenantSubscriptionAccess.mockResolvedValue({
      access: {
        canUseFeatures: true,
        mode: "full",
      },
    });
    mocks.stateFindOne.mockImplementation(() => lean(stateDocument));
    configureStateUpdates();
    mocks.auditCreate.mockResolvedValue({ _id: "audit-1" });
    mocks.publishPublicSiteDraft.mockResolvedValue({
      draftRevision: 2,
      publishedRevision: 2,
    });
    mocks.launchEventUpdateOne.mockResolvedValue({
      upsertedCount: 1,
      upsertedId: "launch-event-1",
    });
  });

  it("moves unselected work to all tasks and preserves completed setup data", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        modules: {
          bookings: true,
          courses: true,
          firing: true,
          inventory: true,
        },
        workspaceIntent: {
          pricingMode: "time",
          answers: {
            sharedStudio: false,
            classes: false,
            memberships: false,
            vouchers: false,
            inventory: false,
          },
        },
      }),
    );
    mocks.productFind.mockReturnValue(selectedSortedLean([]));
    mocks.kilnCount.mockResolvedValue(1);
    mocks.piecePricingProfileCount.mockResolvedValue(1);
    mocks.firingProfileCount.mockResolvedValue(1);
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    expect(snapshot.stepGroups.availableLater).toEqual(
      expect.arrayContaining([
        SETUP_STEP.BOOKABLE_OFFER,
        SETUP_STEP.PRACTICE_BOOKING,
        SETUP_STEP.INVENTORY,
      ]),
    );
    expect(
      new Set([
        ...snapshot.stepGroups.required,
        ...snapshot.stepGroups.launchChecklist,
        ...snapshot.stepGroups.availableLater,
      ]).size,
    ).toBe(snapshot.steps.length);
  });

  it("treats the launch essentials as a complete studio profile", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        onboarding: {
          completed: true,
          businessType: "coworking_space",
          businessDetails: { country: "CZ", city: "", address: "" },
        },
      }),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const studio = snapshot.steps.find((item) => item.id === SETUP_STEP.STUDIO);

    expect(studio).toMatchObject({
      status: SETUP_STEP_STATUS.COMPLETE,
      actions: [
        {
          key: "edit_studio",
          enabled: true,
          href: "/app/settings?setupStep=studio",
        },
      ],
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "business_type", complete: true }),
        expect.objectContaining({ id: "country", complete: true }),
      ]),
    });
    expect(studio?.checks.some((check) => check.id === "address")).toBe(false);
  });

  it("reports missing business type and country as launch essentials", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        onboarding: {
          completed: false,
          businessDetails: {},
        },
      }),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const studio = snapshot.steps.find((item) => item.id === SETUP_STEP.STUDIO);

    expect(studio).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      actions: [
        {
          key: "complete_studio_profile",
          enabled: true,
          href: "/app/onboarding",
        },
      ],
    });
    expect(studio?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "business_type",
          reasonCode: "business_type_missing",
        }),
        expect.objectContaining({
          id: "country",
          reasonCode: "country_missing",
        }),
      ]),
    );
  });

  it("repairs completed legacy profile details in guided workspace settings", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        onboarding: {
          completed: true,
          businessDetails: {},
        },
      }),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.STUDIO),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      actions: [
        {
          key: "edit_studio",
          enabled: true,
          href: "/app/settings?setupStep=studio",
        },
      ],
    });
  });

  it("opens an existing location instead of suggesting a duplicate", async () => {
    mocks.locationFind.mockReturnValue(
      selectedSortedLean([{ ...locationFixture, booking: { enabled: false } }]),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.LOCATION),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      actions: [
        {
          key: "review_location",
          enabled: true,
          href: "/app/settings/locations?setupStep=location",
        },
      ],
    });
  });

  it("opens inactive existing locations instead of suggesting a duplicate", async () => {
    mocks.locationFind.mockReturnValue(selectedSortedLean([]));
    mocks.locationCount.mockResolvedValue(1);

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(mocks.locationCount).toHaveBeenCalledWith({ tenant: TENANT_ID });
    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.LOCATION),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      actions: [
        {
          key: "review_location",
          enabled: true,
          href: "/app/settings/locations?setupStep=location",
        },
      ],
    });
  });

  it("uses the actual managed delivery gate for communication readiness", async () => {
    mocks.resolveManagedSender.mockRejectedValueOnce(
      new ManagedSenderNotReadyError("Managed sender is not ready."),
    );

    const missingSender = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const missingCommunications = missingSender.steps.find(
      (item) => item.id === SETUP_STEP.COMMUNICATIONS,
    );

    expect(missingCommunications).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      checks: [
        {
          id: "sender_verified",
          complete: false,
          optional: false,
          reasonCode: "sender_email_not_verified",
        },
      ],
      actions: [
        {
          key: "verify_sender",
          enabled: true,
          href: "/app/communications?section=setup&setupStep=communications",
        },
      ],
    });
    expect(missingCommunications?.checks).toHaveLength(1);

    const readySender = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const readyCommunications = readySender.steps.find(
      (item) => item.id === SETUP_STEP.COMMUNICATIONS,
    );

    expect(readyCommunications).toMatchObject({
      status: SETUP_STEP_STATUS.COMPLETE,
      checks: [
        {
          id: "sender_verified",
          complete: true,
          optional: false,
          reasonCode: "complete",
        },
      ],
      actions: [
        {
          key: "configure_communications",
          enabled: true,
          href: "/app/communications?section=setup&setupStep=communications",
        },
      ],
    });
    expect(readyCommunications?.checks).toHaveLength(1);
  });

  it("does not hide unexpected managed sender resolution failures", async () => {
    mocks.resolveManagedSender.mockRejectedValueOnce(
      new Error("Managed sender database lookup failed."),
    );

    await expect(
      buildSetupCenterSnapshot({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
      }),
    ).rejects.toThrow("Managed sender database lookup failed.");
  });

  it("returns only live, actionable post-launch recommendations", async () => {
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(SETUP_CENTER_DEFINITION_VERSION).toBe(10);
    expect(snapshot.recommendations).toEqual([
      {
        id: "reminders",
        complete: false,
        action: {
          key: "configure_reminders",
          href: "/app/communications?section=automations",
          enabled: true,
        },
      },
      {
        id: "customers",
        complete: false,
        action: {
          key: "import_customers",
          href: "/app/settings/migration?entity=customers",
          enabled: true,
        },
      },
    ]);
  });

  it("completes reminders only for an active non-marketing booking reminder", async () => {
    mocks.automationCount.mockResolvedValueOnce(0);

    const unrelatedAutomation = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    expect(
      unrelatedAutomation.recommendations.find(
        (item) => item.id === "reminders",
      ),
    ).toMatchObject({ complete: false });
    expect(mocks.automationCount).toHaveBeenLastCalledWith({
      tenant: TENANT_ID,
      isActive: true,
      automationStatus: COMMUNICATION_AUTOMATION_STATUS.ACTIVE,
      scheduleType: {
        $in: [
          COMMUNICATION_SCHEDULE_TYPE.BEFORE_BOOKING,
          COMMUNICATION_SCHEDULE_TYPE.BEFORE_PURCHASE,
        ],
      },
      purpose: { $ne: COMMUNICATION_AUTOMATION_PURPOSE.MARKETING },
    });

    mocks.automationCount.mockResolvedValueOnce(1);
    const bookingReminder = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    expect(
      bookingReminder.recommendations.find((item) => item.id === "reminders"),
    ).toMatchObject({ complete: true });
  });

  it("does not recommend booking reminders without a booking workflow", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        modules: {
          bookings: false,
          courses: false,
          communications: true,
          automations: true,
          customers: false,
          memberships: false,
          payments: false,
          firing: false,
          inventory: false,
        },
      }),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.recommendations.some((item) => item.id === "reminders"),
    ).toBe(false);
  });

  it("requires a published plan for a membership-only workspace", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        modules: {
          bookings: false,
          courses: false,
          memberships: true,
          payments: false,
          communications: false,
          firing: false,
          inventory: false,
        },
      }),
    );

    const incomplete = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      incomplete.steps.find((item) => item.id === SETUP_STEP.MEMBERSHIP),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      requirement: SETUP_STEP_REQUIREMENT.RECOMMENDED,
      reasonCode: "membership_missing",
      checks: [
        expect.objectContaining({
          id: "published_membership",
          complete: false,
          reasonCode: "membership_missing",
        }),
      ],
      actions: [
        {
          key: "create_membership",
          enabled: true,
          href: "/app/memberships?action=create&setupStep=membership",
        },
      ],
    });
    expect(incomplete.nextAction).toMatchObject({ key: "create_membership" });
    expect(incomplete.ready).toBe(false);
    expect(
      incomplete.recommendations.some((item) => item.id === "membership"),
    ).toBe(false);

    mocks.membershipPlanCount.mockResolvedValue(1);
    const complete = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      complete.steps.find((item) => item.id === SETUP_STEP.MEMBERSHIP),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.COMPLETE,
      requirement: SETUP_STEP_REQUIREMENT.RECOMMENDED,
    });
    expect(complete.ready).toBe(true);
  });

  it("recommends membership setup when bookings are also enabled", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        modules: {
          bookings: true,
          courses: false,
          memberships: true,
          payments: false,
          communications: false,
          firing: false,
          inventory: false,
        },
      }),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.MEMBERSHIP),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      requirement: SETUP_STEP_REQUIREMENT.RECOMMENDED,
      reasonCode: "membership_missing",
    });
  });

  it("reviews an existing membership draft instead of creating a duplicate", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        modules: {
          bookings: false,
          courses: false,
          memberships: true,
          payments: false,
          communications: false,
          firing: false,
          inventory: false,
        },
      }),
    );
    mocks.membershipPlanCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.MEMBERSHIP),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      actions: [
        {
          key: "review_membership",
          href: "/app/memberships?setupStep=membership",
          enabled: true,
        },
      ],
    });
  });

  it("requires the first inventory item for an inventory-only workspace", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        modules: {
          bookings: false,
          courses: false,
          memberships: false,
          payments: false,
          communications: false,
          firing: false,
          inventory: true,
          customers: false,
          automations: false,
        },
      }),
    );
    mocks.locationFind.mockReturnValue(
      selectedSortedLean([{ ...locationFixture, booking: { enabled: false } }]),
    );
    mocks.productFind.mockReturnValue(selectedSortedLean([]));

    const incomplete = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    expect(incomplete.stepGroups.required).toEqual([SETUP_STEP.STUDIO]);
    expect(incomplete.stepGroups.launchChecklist).toEqual([
      SETUP_STEP.LOCATION,
      SETUP_STEP.INVENTORY,
    ]);
    expect(incomplete.launchReview).toMatchObject({
      status: "in_progress",
      launchComplete: false,
      required: { incompleteStepIds: [SETUP_STEP.INVENTORY] },
      publicSite: { applicable: false },
    });

    mocks.inventoryItemCount.mockResolvedValue(1);
    const complete = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    expect(complete.ready).toBe(true);
    expect(complete.launchReview.status).toBe("launched");
  });

  it("reviews inactive inventory instead of sending the operator to create a duplicate", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        modules: {
          bookings: false,
          courses: false,
          memberships: false,
          payments: false,
          communications: false,
          firing: false,
          inventory: true,
          customers: false,
          automations: false,
        },
      }),
    );
    mocks.locationFind.mockReturnValue(
      selectedSortedLean([{ ...locationFixture, booking: { enabled: false } }]),
    );
    mocks.productFind.mockReturnValue(selectedSortedLean([]));
    mocks.inventoryItemCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const result = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      result.steps.find((item) => item.id === SETUP_STEP.INVENTORY),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      actions: [
        expect.objectContaining({
          key: "review_inventory",
          href: "/app/operations?section=inventory&action=review&setupStep=inventory",
          enabled: true,
        }),
      ],
    });
    expect(result.nextAction).toMatchObject({ key: "review_inventory" });
    expect(mocks.inventoryItemCount).toHaveBeenNthCalledWith(1, {
      tenant: TENANT_ID,
      isActive: true,
    });
    expect(mocks.inventoryItemCount).toHaveBeenNthCalledWith(2, {
      tenant: TENANT_ID,
    });
  });

  it("keeps payment readiness separate from launch readiness", async () => {
    mocks.productFind.mockReturnValue(selectedSortedLean([]));
    mocks.paymentFindOne.mockReturnValue(lean(null));

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.BOOKABLE_OFFER),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      requirement: SETUP_STEP_REQUIREMENT.RECOMMENDED,
    });
    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.PAYMENTS),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      requirement: SETUP_STEP_REQUIREMENT.REQUIRED,
    });
    expect(snapshot.paymentReadiness).toMatchObject({
      applicable: true,
      ready: false,
    });
    expect(snapshot.ready).toBe(false);
    expect(snapshot.launchReview.readyToPublish).toBe(false);
    expect(snapshot.nextAction).toMatchObject({ key: "connect_payments" });
  });

  it("never reports a studio with zero products as ready to publish", async () => {
    mocks.productFind.mockReturnValue(selectedSortedLean([]));

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(snapshot.paymentReadiness).toMatchObject({
      applicable: true,
      ready: true,
    });
    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.BOOKABLE_OFFER),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: "bookable_offer_incomplete",
    });
    expect(snapshot.ready).toBe(false);
    expect(snapshot.launchReview).toMatchObject({
      readyToPublish: false,
      launchComplete: false,
      required: { incompleteStepIds: [SETUP_STEP.BOOKABLE_OFFER] },
    });
    expect(snapshot.nextAction).toMatchObject({ key: "create_offer" });
  });

  it("requires the public site editor to be reviewed before publication", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({ ...tenantFixture, publicSiteEditor: undefined }),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.PUBLIC_SITE),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: "public_site_review_required",
      checks: [
        expect.objectContaining({
          id: "public_site_reviewed",
          complete: false,
        }),
      ],
      actions: [
        {
          key: "customize_public_site",
          href: "/app/settings/public-site?setupStep=public_site",
          enabled: true,
        },
      ],
    });
    expect(snapshot.launchReview).toMatchObject({
      readyToPublish: false,
      required: { incompleteStepIds: [SETUP_STEP.PUBLIC_SITE] },
      publicSite: { reviewed: false, canPublish: false },
    });
    expect(snapshot.nextAction).toMatchObject({
      key: "customize_public_site",
    });
  });

  it("reviews an inactive existing offer instead of encouraging a duplicate", async () => {
    mocks.productFind.mockReturnValue(
      selectedSortedLean([{ ...productFixture, isActive: false }]),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.BOOKABLE_OFFER),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      actions: [
        {
          key: "review_offer",
          href:
            "/app/products?setupStep=bookable_offer&category=classes" +
            `&productId=${PRODUCT_ID}`,
          enabled: true,
        },
        expect.objectContaining({ key: "schedule_offer", enabled: false }),
      ],
    });
    expect(snapshot.nextAction).toMatchObject({
      key: "review_offer",
      href:
        "/app/products?setupStep=bookable_offer&category=classes" +
        `&productId=${PRODUCT_ID}`,
    });
  });

  it("requires payments after a paid booking offer is configured", async () => {
    mocks.paymentFindOne.mockReturnValue(lean(null));

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.BOOKABLE_OFFER),
    ).toMatchObject({ status: SETUP_STEP_STATUS.COMPLETE });
    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.PAYMENTS),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      requirement: SETUP_STEP_REQUIREMENT.REQUIRED,
    });
    expect(snapshot.nextAction).toMatchObject({ key: "connect_payments" });
  });

  it("puts customization and publication before the final customer journey test", async () => {
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.PRACTICE_BOOKING),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.BLOCKED,
      reasonCode: "public_site_publication_required",
      requirement: SETUP_STEP_REQUIREMENT.RECOMMENDED,
      actions: [
        {
          key: "practice_booking",
          enabled: false,
          href: "/app/setup?step=practice_booking",
        },
      ],
    });
    expect(snapshot.ready).toBe(true);
    expect(snapshot.stepGroups.required).toEqual([
      SETUP_STEP.STUDIO,
      SETUP_STEP.PAYMENTS,
    ]);
    expect(snapshot.paymentReadiness).toEqual({
      applicable: true,
      ready: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsClear: true,
    });
    expect(snapshot.progress.payment).toEqual({
      completed: 2,
      total: 2,
      percentage: 100,
    });
    expect(snapshot.launchReview).toMatchObject({
      status: "ready_to_publish",
      readyToPublish: true,
      launchComplete: false,
      publicSite: {
        applicable: true,
        reviewed: true,
        published: false,
        tenantSlug: "safe-studio",
        canPublish: true,
        publicPath: "/",
      },
      testBooking: {
        applicable: true,
        complete: false,
        canStart: false,
        action: {
          key: "practice_booking",
          href: "/app/setup?step=practice_booking",
          enabled: false,
        },
      },
    });
    expect(snapshot.nextAction).toMatchObject({
      key: "publish_studio",
      href: "/app/setup?step=publish",
      enabled: true,
    });
    expect(snapshot.stepGroups.launchChecklist).toEqual([
      SETUP_STEP.LOCATION,
      SETUP_STEP.BOOKABLE_OFFER,
      SETUP_STEP.PUBLIC_SITE,
      SETUP_STEP.PUBLISH,
      SETUP_STEP.PRACTICE_BOOKING,
    ]);
    expect(snapshot.stepGroups.recommended).toEqual(
      snapshot.stepGroups.launchChecklist,
    );
    expect(snapshot.stepGroups.launchChecklist.at(-1)).toBe(
      SETUP_STEP.PRACTICE_BOOKING,
    );
    expect(snapshot.stepGroups.availableLater).toEqual(
      expect.arrayContaining([
        SETUP_STEP.INVENTORY,
        SETUP_STEP.COMMUNICATIONS,
        SETUP_STEP.TEAM,
      ]),
    );
  });

  it("blocks the final customer journey when a live studio loses launch readiness", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
    mocks.paymentFindOne.mockReturnValue(lean(null));

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(snapshot.health).toBe("needs_attention");
    expect(snapshot.launchReview.required).toMatchObject({
      complete: false,
      incompleteStepIds: [SETUP_STEP.PAYMENTS],
    });
    expect(snapshot.launchReview.testBooking).toMatchObject({
      canStart: false,
      action: expect.objectContaining({ enabled: false }),
    });
    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.PRACTICE_BOOKING),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.BLOCKED,
      reasonCode: "required_setup_incomplete",
    });
  });

  it("refuses to start the customer journey test before publication", async () => {
    await expect(
      startSetupPractice({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        idempotencyKey: "setup-run-before-publication",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_PRACTICE_PUBLICATION_REQUIRED",
    });

    expect(stateDocument.practice).toBeNull();
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.publishPublicSiteDraft).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses to start or advance the customer journey after readiness regresses", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
    mocks.paymentFindOne.mockReturnValue(lean(null));

    await expect(
      startSetupPractice({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        idempotencyKey: "setup-run-regressed-readiness",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_PRACTICE_LAUNCH_REQUIREMENTS_REQUIRED",
      details: { blockers: [SETUP_STEP.PAYMENTS] },
    });

    stateDocument.practice = activePractice();
    await expect(
      applySetupPracticeAction({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        runId: stateDocument.practice.runId,
        actionKey: SETUP_PRACTICE_ACTION.CREATE_BOOKING,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_PRACTICE_LAUNCH_REQUIREMENTS_REQUIRED",
      details: { blockers: [SETUP_STEP.PAYMENTS] },
    });

    expect(stateDocument.practice.completedActions).toEqual([]);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("records a manual confirmation without fabricating or replacing a stale simulated run", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
    stateDocument.practice = {
      ...activePractice({ actor: OTHER_USER_ID }),
      status: SETUP_PRACTICE_STATUS.COMPLETE,
      completedAt: NOW,
      completedActions: [...SETUP_PRACTICE_ACTION_ORDER],
      artifacts: [{ kind: "booking", title: "Original simulation" }],
    };
    const original = structuredClone(stateDocument.practice);
    const before = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    expect(before.practice.retestRecommended).toBe(true);
    expect(before.launchReview.testBooking.complete).toBe(false);
    const result = await confirmSetupPractice({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      expectedReadinessFingerprint: before.diagnostics.readinessFingerprint,
    });
    expect(stateDocument.practice).toEqual(original);
    expect(result.practice.retestRecommended).toBe(true);
    expect(result.practice.manualConfirmation).toEqual({
      confirmedAt: expect.any(Date),
      confirmedBy: USER_ID,
      current: true,
    });
    expect(result.launchReview).toMatchObject({
      launchComplete: true,
      testBooking: {
        complete: true,
        retestRecommended: false,
        completionSource: "manual",
        completedAt: result.practice.manualConfirmation?.confirmedAt,
      },
    });
    expect(
      result.steps.find(({ id }) => id === SETUP_STEP.PRACTICE_BOOKING),
    ).toMatchObject({ complete: true, reasonCode: "complete" });
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        actor: USER_ID,
        event: "practice_manually_confirmed",
        practiceRunId: "",
        metadata: {
          readinessFingerprint: before.diagnostics.readinessFingerprint,
        },
      }),
    );
    expect(mocks.stateFindOneAndUpdate).toHaveBeenCalledWith(
      {
        tenant: TENANT_ID,
        "practiceConfirmation.readinessFingerprint": {
          $ne: before.diagnostics.readinessFingerprint,
        },
      },
      expect.objectContaining({
        $set: {
          practiceConfirmation: expect.objectContaining({
            confirmedBy: USER_ID,
          }),
        },
      }),
      { returnDocument: "after", runValidators: true },
    );
    for (const write of domainWriteMocks) expect(write).not.toHaveBeenCalled();
  });

  it("preserves the original actor and timestamp on repeated confirmation and survives a fresh snapshot", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const input = {
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      expectedReadinessFingerprint: snapshot.diagnostics.readinessFingerprint,
    };
    await confirmSetupPractice(input);
    const stored = structuredClone(stateDocument.practiceConfirmation);
    await confirmSetupPractice({ ...input, actorUserId: OTHER_USER_ID });
    const reloaded = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: OTHER_USER_ID,
    });
    expect(stateDocument.practiceConfirmation).toEqual(stored);
    expect(reloaded.practice.manualConfirmation).toMatchObject({
      confirmedBy: USER_ID,
      current: true,
    });
    expect(reloaded.practice.status).toBe(SETUP_PRACTICE_STATUS.NOT_STARTED);
    expect(reloaded.practice.artifacts).toEqual([]);
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
  });

  it.each(["product", "location"])(
    "requires explicit reconfirmation after a %s configuration change",
    async (entity) => {
      stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
      const before = await buildSetupCenterSnapshot({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
      });
      const input = {
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedReadinessFingerprint: before.diagnostics.readinessFingerprint,
      };
      await confirmSetupPractice(input);
      const changedAt = new Date("2026-08-01T09:00:00Z");
      if (entity === "product")
        mocks.productFind.mockReturnValue(
          selectedSortedLean([{ ...productFixture, updatedAt: changedAt }]),
        );
      else
        mocks.locationFind.mockReturnValue(
          selectedSortedLean([{ ...locationFixture, updatedAt: changedAt }]),
        );
      const stale = await buildSetupCenterSnapshot({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
      });
      expect(stale.practice.manualConfirmation?.current).toBe(false);
      expect(stale.launchReview).toMatchObject({
        launchComplete: false,
        testBooking: {
          complete: false,
          retestRecommended: true,
          completionSource: null,
        },
      });
      expect(
        stale.steps.find(({ id }) => id === SETUP_STEP.PRACTICE_BOOKING)
          ?.reasonCode,
      ).toBe("configuration_changed_retest");
      await expect(confirmSetupPractice(input)).rejects.toMatchObject({
        statusCode: 409,
        code: "SETUP_PRACTICE_CONFIGURATION_CHANGED",
      });
      expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
      const renewed = await confirmSetupPractice({
        ...input,
        expectedReadinessFingerprint: stale.diagnostics.readinessFingerprint,
      });
      expect(renewed.launchReview.testBooking).toMatchObject({
        complete: true,
        completionSource: "manual",
        retestRecommended: false,
      });
      expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["unpublished", "payments", "offer"])(
    "does not confirm around the existing %s launch prerequisite",
    async (missing) => {
      if (missing !== "unpublished")
        stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
      if (missing === "payments")
        mocks.paymentFindOne.mockReturnValue(
          lean({ ...paymentFixture, chargesEnabled: false }),
        );
      if (missing === "offer")
        mocks.productFind.mockReturnValue(selectedSortedLean([]));
      const snapshot = await buildSetupCenterSnapshot({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
      });
      await expect(
        confirmSetupPractice({
          tenantId: TENANT_ID,
          actorUserId: USER_ID,
          expectedReadinessFingerprint:
            snapshot.diagnostics.readinessFingerprint,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(stateDocument.practiceConfirmation).toBeUndefined();
      expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "undoes only manual evidence, retaining a valid simulated completion=%s",
    async (validSimulation) => {
      stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
      const before = await buildSetupCenterSnapshot({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
      });
      if (validSimulation)
        stateDocument.practice = {
          ...activePractice({
            readinessFingerprint: before.diagnostics.readinessFingerprint,
          }),
          status: SETUP_PRACTICE_STATUS.COMPLETE,
          completedAt: NOW,
        };
      const original = structuredClone(stateDocument.practice);
      await confirmSetupPractice({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedReadinessFingerprint: before.diagnostics.readinessFingerprint,
      });
      const result = await clearSetupPracticeConfirmation({
        tenantId: TENANT_ID,
        actorUserId: OTHER_USER_ID,
      });
      await clearSetupPracticeConfirmation({
        tenantId: TENANT_ID,
        actorUserId: OTHER_USER_ID,
      });
      expect(stateDocument.practice).toEqual(original);
      expect(result.practice.manualConfirmation).toBeNull();
      expect(result.launchReview.testBooking).toMatchObject({
        complete: validSimulation,
        completionSource: validSimulation ? "practice" : null,
        completedAt: validSimulation ? NOW : null,
      });
      expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
      expect(mocks.auditCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tenant: TENANT_ID,
          actor: OTHER_USER_ID,
          event: "practice_manual_confirmation_cleared",
        }),
      );
      for (const write of domainWriteMocks)
        expect(write).not.toHaveBeenCalled();
    },
  );

  it("starts a tenant-and-actor-scoped synthetic run without writing any business domain", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;

    const result = await startSetupPractice({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      idempotencyKey: "setup-run-0001",
    });

    expect(stateDocument.practice).toMatchObject({
      actor: USER_ID,
      idempotencyKey: "setup-run-0001",
      status: SETUP_PRACTICE_STATUS.IN_PROGRESS,
      locationId: LOCATION_ID,
      productId: PRODUCT_ID,
      completedActions: [],
      artifacts: [],
    });
    expect(stateDocument.practice.runId).toMatch(/^practice_/);
    expect(stateDocument.save).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        actor: USER_ID,
        event: "practice_started",
        stepId: SETUP_STEP.PRACTICE_BOOKING,
        practiceRunId: stateDocument.practice.runId,
      }),
    );
    expect(result.practice.status).toBe(SETUP_PRACTICE_STATUS.IN_PROGRESS);

    for (const write of domainWriteMocks) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("does not overwrite another actor's active Practice Mode session", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
    stateDocument.practice = activePractice({
      actor: OTHER_USER_ID,
    });
    const originalRunId = stateDocument.practice.runId;

    await expect(
      startSetupPractice({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        idempotencyKey: "setup-run-0002",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_PRACTICE_ALREADY_ACTIVE",
    });

    expect(stateDocument.practice).toMatchObject({
      runId: originalRunId,
      actor: OTHER_USER_ID,
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("hides a run from another actor before changing state", async () => {
    stateDocument.practice = activePractice();

    await expect(
      applySetupPracticeAction({
        tenantId: TENANT_ID,
        actorUserId: OTHER_USER_ID,
        runId: stateDocument.practice.runId,
        actionKey: SETUP_PRACTICE_ACTION.CREATE_BOOKING,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(stateDocument.save).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    for (const write of domainWriteMocks) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("rejects an out-of-order action without creating an artifact", async () => {
    stateDocument.practice = activePractice();

    await expect(
      applySetupPracticeAction({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        runId: stateDocument.practice.runId,
        actionKey: SETUP_PRACTICE_ACTION.PREVIEW_INVOICE,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_PRACTICE_INVALID_TRANSITION",
      details: {
        expectedAction: SETUP_PRACTICE_ACTION.CREATE_BOOKING,
      },
    });

    expect(stateDocument.practice.completedActions).toEqual([]);
    expect(stateDocument.practice.artifacts).toEqual([]);
    expect(stateDocument.save).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("advances exactly through the safe action order and completes using previews only", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    stateDocument.practice = activePractice({
      readinessFingerprint: snapshot.diagnostics.readinessFingerprint,
    });
    stateDocument.save.mockClear();
    mocks.auditCreate.mockClear();

    let result: Awaited<ReturnType<typeof applySetupPracticeAction>> | null =
      null;
    for (const actionKey of SETUP_PRACTICE_ACTION_ORDER) {
      result = await applySetupPracticeAction({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        runId: stateDocument.practice.runId,
        actionKey,
      });
    }

    expect(stateDocument.practice.completedActions).toEqual(
      SETUP_PRACTICE_ACTION_ORDER,
    );
    expect(
      stateDocument.practice.artifacts.map((artifact: any) => artifact.kind),
    ).toEqual([
      "booking",
      "invoice",
      "confirmation",
      "membership",
      "check_in",
      "cancellation",
    ]);
    expect(stateDocument.practice.status).toBe(SETUP_PRACTICE_STATUS.COMPLETE);
    expect(stateDocument.practice.completedAt).toBeInstanceOf(Date);
    expect(result?.practice).toMatchObject({
      status: SETUP_PRACTICE_STATUS.COMPLETE,
      retestRecommended: false,
    });
    expect(stateDocument.save).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledTimes(
      SETUP_PRACTICE_ACTION_ORDER.length,
    );
    expect(mocks.auditCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "practice_completed",
        metadata: {
          action: SETUP_PRACTICE_ACTION.CANCEL_BOOKING,
        },
      }),
    );

    for (const write of domainWriteMocks) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "finishes practice without invoices, preserving old invoice artifacts (legacy=%s)",
    async (legacy) => {
      vi.stubEnv("NATIVE_INVOICES_ENABLED", "false");
      stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
      stateDocument.practice = activePractice({
        completedActions: legacy
          ? [
              SETUP_PRACTICE_ACTION.CREATE_BOOKING,
              SETUP_PRACTICE_ACTION.PREVIEW_INVOICE,
            ]
          : [],
      });
      stateDocument.practice.artifacts = legacy
        ? [{ kind: "invoice", title: "Old invoice preview" }]
        : [];
      const actions = SETUP_PRACTICE_ACTION_ORDER.filter(
        (action) => action !== SETUP_PRACTICE_ACTION.PREVIEW_INVOICE,
      );
      let result: Awaited<ReturnType<typeof applySetupPracticeAction>> | null =
        null;
      for (const actionKey of actions) {
        result = await applySetupPracticeAction({
          tenantId: TENANT_ID,
          actorUserId: USER_ID,
          runId: stateDocument.practice.runId,
          actionKey,
        });
      }
      expect(result?.practice.status).toBe(SETUP_PRACTICE_STATUS.COMPLETE);
      expect(result?.practice.completedActions).toEqual(actions);
      expect(
        result?.practice.artifacts.some(
          (artifact: any) => artifact.kind === "invoice",
        ),
      ).toBe(false);
      expect(
        stateDocument.practice.artifacts.some(
          (artifact: any) => artifact.kind === "invoice",
        ),
      ).toBe(legacy);
    },
  );

  it("rejects invoice practice requests before creating or changing state", async () => {
    vi.stubEnv("NATIVE_INVOICES_ENABLED", "false");
    await expect(
      applySetupPracticeAction({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        runId: "existing-run",
        actionKey: SETUP_PRACTICE_ACTION.PREVIEW_INVOICE,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "INVOICE_FEATURE_DISABLED",
    });
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("makes a repeated completed action idempotent", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
    stateDocument.practice = activePractice();

    await applySetupPracticeAction({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      runId: stateDocument.practice.runId,
      actionKey: SETUP_PRACTICE_ACTION.CREATE_BOOKING,
    });
    stateDocument.save.mockClear();
    mocks.auditCreate.mockClear();

    await applySetupPracticeAction({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      runId: stateDocument.practice.runId,
      actionKey: SETUP_PRACTICE_ACTION.CREATE_BOOKING,
    });

    expect(stateDocument.practice.completedActions).toEqual([
      SETUP_PRACTICE_ACTION.CREATE_BOOKING,
    ]);
    expect(stateDocument.practice.artifacts).toHaveLength(1);
    expect(stateDocument.save).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("treats a concurrently completed identical action as an idempotent replay", async () => {
    stateDocument.publication.status = SETUP_PUBLICATION_STATUS.LIVE;
    stateDocument.practice = activePractice();
    mocks.stateFindOneAndUpdate.mockImplementation(
      async (_filter: any, update: any) => {
        if (update?.$setOnInsert) return stateDocument;
        if (update?.$push?.["practice.completedActions"]) {
          stateDocument.practice.completedActions.push(
            SETUP_PRACTICE_ACTION.CREATE_BOOKING,
          );
          stateDocument.practice.artifacts.push({
            kind: "booking",
            title: "Practice booking",
            summary: "Created by the winning concurrent request.",
            createdAt: new Date(),
          });
          return null;
        }
        return stateDocument;
      },
    );

    const result = await applySetupPracticeAction({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      runId: stateDocument.practice.runId,
      actionKey: SETUP_PRACTICE_ACTION.CREATE_BOOKING,
    });

    expect(result.practice.completedActions).toEqual([
      SETUP_PRACTICE_ACTION.CREATE_BOOKING,
    ]);
    expect(stateDocument.practice.artifacts).toHaveLength(1);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("marks an expired run before refusing further actions", async () => {
    stateDocument.practice = activePractice({
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(
      applySetupPracticeAction({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        runId: stateDocument.practice.runId,
        actionKey: SETUP_PRACTICE_ACTION.CREATE_BOOKING,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_PRACTICE_EXPIRED",
    });

    expect(stateDocument.practice.status).toBe(SETUP_PRACTICE_STATUS.EXPIRED);
    expect(stateDocument.save).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("guides a valid course to the modern session composer instead of creating another product", async () => {
    mocks.bookingFindOne.mockReturnValue(selectedLean(null));

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const offerStep = snapshot.steps.find(
      (item) => item.id === SETUP_STEP.BOOKABLE_OFFER,
    );

    expect(offerStep).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      checks: [
        { id: "activity", complete: true },
        { id: "capacity", complete: true },
        { id: "price", complete: true },
        {
          id: "availability",
          complete: false,
          reasonCode: "upcoming_schedule_missing",
        },
        { id: "location", complete: true },
      ],
    });
    expect(
      offerStep?.actions.find((item) => item.key === "create_offer"),
    ).toMatchObject({
      enabled: false,
    });
    expect(
      offerStep?.actions.find((item) => item.key === "schedule_offer"),
    ).toEqual({
      key: "schedule_offer",
      enabled: true,
      href:
        `/app/bookings/new?setupStep=bookable_offer` +
        `&productId=${PRODUCT_ID}` +
        `&locationId=${LOCATION_ID}&isRoot=true`,
    });
  });

  it("offers product creation only while no valid bookable product exists", async () => {
    mocks.productFind.mockReturnValue(selectedSortedLean([]));

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const offerStep = snapshot.steps.find(
      (item) => item.id === SETUP_STEP.BOOKABLE_OFFER,
    );

    expect(mocks.bookingFindOne).not.toHaveBeenCalled();
    expect(offerStep).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      actions: [
        expect.objectContaining({ key: "create_offer", enabled: true }),
        expect.objectContaining({ key: "schedule_offer", enabled: false }),
      ],
    });
  });

  it.each([
    ["canonical Open Studio", { type: "workshop", kind: "open-studio" }],
    ["legacy workshop", { type: "workshop", kind: undefined }],
  ])(
    "treats a valid timed %s as ready and selects it ahead of an unscheduled Class",
    async (_label, taxonomy) => {
      mocks.productFind.mockReturnValue(
        selectedSortedLean([
          productFixture,
          {
            ...secondProductFixture,
            ...taxonomy,
          },
        ]),
      );
      mocks.bookingFindOne.mockReturnValue(selectedLean(null));

      const snapshot = await buildSetupCenterSnapshot({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
      });
      const offerStep = snapshot.steps.find(
        (item) => item.id === SETUP_STEP.BOOKABLE_OFFER,
      );

      expect(mocks.bookingFindOne).not.toHaveBeenCalled();
      expect(snapshot.diagnostics).toMatchObject({
        bookableProductId: SECOND_PRODUCT_ID,
        activeLocationId: LOCATION_ID,
      });
      expect(offerStep?.status).toBe(SETUP_STEP_STATUS.COMPLETE);
      expect(
        offerStep?.checks.find((item) => item.id === "availability"),
      ).toMatchObject({
        complete: true,
        reasonCode: "complete",
      });
      expect(offerStep?.actions).toEqual([
        expect.objectContaining({ key: "create_offer", enabled: false }),
        expect.objectContaining({ key: "schedule_offer", enabled: false }),
      ]);
    },
  );

  it.each([
    ["ambiguous legacy service", { type: "service" }],
    [
      "canonical Private Studio",
      { type: "blocker", kind: "private-studio", kindContractVersion: 2 },
    ],
  ])(
    "does not count %s as a tenant bookable offer",
    async (_label, product) => {
      mocks.productFind.mockReturnValue(
        selectedSortedLean([
          {
            ...secondProductFixture,
            ...product,
            kind: "kind" in product ? product.kind : undefined,
          },
        ]),
      );

      const snapshot = await buildSetupCenterSnapshot({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
      });
      const offerStep = snapshot.steps.find(
        (item) => item.id === SETUP_STEP.BOOKABLE_OFFER,
      );

      expect(mocks.bookingFindOne).not.toHaveBeenCalled();
      expect(snapshot.diagnostics.bookableProductId).toBeNull();
      expect(
        offerStep?.checks.find((item) => item.id === "activity"),
      ).toMatchObject({ complete: false });
    },
  );

  it("finds a scheduled course across all active course products and booking-enabled locations", async () => {
    mocks.locationFind.mockReturnValue(
      selectedSortedLean([
        {
          ...locationFixture,
          booking: { enabled: false },
        },
        secondLocationFixture,
      ]),
    );
    mocks.productFind.mockReturnValue(
      selectedSortedLean([
        productFixture,
        {
          ...secondProductFixture,
          type: "course",
          kind: "class",
        },
      ]),
    );
    mocks.bookingFindOne.mockReturnValue(
      selectedLean({
        bookingProduct: SECOND_PRODUCT_ID,
        location: SECOND_LOCATION_ID,
      }),
    );

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(mocks.bookingFindOne).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      bookingProduct: {
        $in: [PRODUCT_ID, SECOND_PRODUCT_ID],
      },
      location: {
        $in: [SECOND_LOCATION_ID],
      },
      start: { $gt: expect.any(Date) },
      archive: false,
      status: { $ne: "cancelled" },
    });
    expect(snapshot.diagnostics).toMatchObject({
      bookableProductId: SECOND_PRODUCT_ID,
      activeLocationId: SECOND_LOCATION_ID,
    });
    const offerStep = snapshot.steps.find(
      (item) => item.id === SETUP_STEP.BOOKABLE_OFFER,
    );
    expect(offerStep?.status).toBe(SETUP_STEP_STATUS.COMPLETE);
    expect(
      offerStep?.actions.find((item) => item.key === "schedule_offer"),
    ).toMatchObject({
      enabled: false,
      href: "/app/bookings/new?setupStep=bookable_offer",
    });
  });

  it("excludes not-applicable and recommended steps from required progress", async () => {
    const soloSnapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const soloTeamStep = soloSnapshot.steps.find(
      (item) => item.id === SETUP_STEP.TEAM,
    );
    const soloRequired = soloSnapshot.steps.filter(
      (item) =>
        item.applicable && item.requirement === SETUP_STEP_REQUIREMENT.REQUIRED,
    );

    expect(soloTeamStep).toMatchObject({
      status: SETUP_STEP_STATUS.NOT_APPLICABLE,
      optional: true,
      requirement: SETUP_STEP_REQUIREMENT.RECOMMENDED,
      applicable: false,
    });
    expect(soloSnapshot.progress.required).toEqual({
      completed: soloRequired.filter(
        (item) => item.status === SETUP_STEP_STATUS.COMPLETE,
      ).length,
      total: soloRequired.length,
      percentage: Math.round(
        (soloRequired.filter(
          (item) => item.status === SETUP_STEP_STATUS.COMPLETE,
        ).length /
          soloRequired.length) *
          100,
      ),
    });

    mocks.teamCount.mockResolvedValue(2);
    const teamSnapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    const teamStep = teamSnapshot.steps.find(
      (item) => item.id === SETUP_STEP.TEAM,
    );

    expect(teamStep).toMatchObject({
      status: SETUP_STEP_STATUS.COMPLETE,
      reasonCode: "complete",
      optional: true,
      requirement: SETUP_STEP_REQUIREMENT.RECOMMENDED,
    });
    expect(teamSnapshot.progress.required).toEqual(
      soloSnapshot.progress.required,
    );
    expect(mocks.communicationSettingsFindOne).not.toHaveBeenCalled();
    expect(mocks.resolveManagedSender).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
    });
    expect(mocks.teamCount).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      status: "active",
    });
  });

  it("reviews an existing non-active teammate instead of sending a duplicate invite", async () => {
    mocks.teamCount.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      snapshot.steps.find((item) => item.id === SETUP_STEP.TEAM),
    ).toMatchObject({
      status: SETUP_STEP_STATUS.INCOMPLETE,
      applicable: true,
      actions: [
        {
          key: "review_team",
          href: "/app/settings/team?setupStep=team",
          enabled: true,
        },
      ],
    });
  });

  it("does not emit deterministic navigation for a disabled step action", async () => {
    mocks.paymentFindOne.mockReturnValueOnce(lean(null));
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      getSetupDiagnosticFallback({
        snapshot,
        stepId: SETUP_STEP.PUBLISH,
        locale: "en",
      }).navigation,
    ).toEqual([]);
  });

  it("keeps the first required outcome strict even when a later action is enabled", () => {
    const snapshot = {
      steps: [
        {
          id: SETUP_STEP.COMMUNICATIONS,
          requirement: SETUP_STEP_REQUIREMENT.RECOMMENDED,
          applicable: true,
          complete: false,
          status: SETUP_STEP_STATUS.INCOMPLETE,
          reasonCode: "communications_incomplete",
          checks: [],
          actions: [
            {
              key: "configure_communications",
              href: "/app/communications",
              enabled: true,
            },
          ],
        },
        {
          id: SETUP_STEP.BOOKABLE_OFFER,
          requirement: SETUP_STEP_REQUIREMENT.REQUIRED,
          applicable: true,
          complete: false,
          status: SETUP_STEP_STATUS.BLOCKED,
          reasonCode: "location_required",
          checks: [
            {
              id: "active_location",
              complete: false,
              optional: false,
              reasonCode: "active_location_missing",
            },
          ],
          actions: [
            {
              key: "create_offer",
              href: "/app/products?action=create",
              enabled: false,
            },
          ],
        },
        {
          id: SETUP_STEP.PAYMENTS,
          requirement: SETUP_STEP_REQUIREMENT.REQUIRED,
          applicable: true,
          complete: false,
          status: SETUP_STEP_STATUS.INCOMPLETE,
          reasonCode: "payments_not_ready",
          checks: [],
          actions: [
            {
              key: "connect_payments",
              href: "/app/settings/payments",
              enabled: true,
            },
          ],
        },
      ],
    } as any;

    expect(getSetupDiagnosticFallback({ snapshot, locale: "en" })).toEqual({
      answer:
        "This step is not complete yet: there is no active location. Open the recommended screen and finish the missing configuration.",
      navigation: [],
    });
  });

  it("answers an explicitly selected completed step without navigation", async () => {
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(
      getSetupDiagnosticFallback({
        snapshot,
        stepId: SETUP_STEP.BOOKABLE_OFFER,
        locale: "en",
      }),
    ).toEqual({
      answer:
        "This step is complete. Continue with the next incomplete item in Launch Center.",
      navigation: [],
    });
  });

  it("records one tenant-scoped aggregate for an idempotent launch event", async () => {
    const input = {
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
      sessionId: "launch_session_01",
      event: SETUP_LAUNCH_EVENT.PUBLIC_SITE_OPENED,
      source: "final_review" as const,
      metadata: { published: true },
    };

    await expect(recordSetupLaunchEvent(input)).resolves.toEqual({
      accepted: true,
      eventId: input.eventId,
      deduplicated: false,
    });
    expect(mocks.launchEventUpdateOne).toHaveBeenCalledWith(
      { tenant: TENANT_ID, eventId: input.eventId },
      {
        $setOnInsert: expect.objectContaining({
          tenant: TENANT_ID,
          actor: USER_ID,
          sessionId: input.sessionId,
          event: SETUP_LAUNCH_EVENT.PUBLIC_SITE_OPENED,
        }),
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    expect(mocks.stateFindOneAndUpdate).toHaveBeenLastCalledWith(
      { tenant: TENANT_ID },
      expect.objectContaining({
        $inc: { "analytics.eventCounts.publicSiteOpened": 1 },
        $min: { "analytics.firstSeenAt": expect.any(Date) },
        $max: { "analytics.lastActivityAt": expect.any(Date) },
      }),
      { returnDocument: "after" },
    );

    mocks.stateFindOneAndUpdate.mockClear();
    mocks.launchEventUpdateOne.mockResolvedValueOnce({ upsertedCount: 0 });
    await expect(recordSetupLaunchEvent(input)).resolves.toEqual({
      accepted: true,
      eventId: input.eventId,
      deduplicated: true,
    });
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("stores multiple contextual guide steps in one session", async () => {
    mocks.launchEventUpdateOne
      .mockResolvedValueOnce({ upsertedCount: 1 })
      .mockResolvedValueOnce({ upsertedCount: 1 });
    mocks.stateFindOneAndUpdate.mockClear();

    for (const [index, guideStep] of (
      ["calendar", "create_action"] as const
    ).entries()) {
      await recordSetupLaunchEvent({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        eventId: `223e4567-e89b-42d3-a456-4266141740${String(index).padStart(2, "0")}`,
        sessionId: "guide_session_01",
        event: `contextual_guide_first_booking_${guideStep}_viewed`,
        source: "contextual_guide",
        metadata: {
          guideId: "first_booking",
          guideVersion: 1,
          guideStep,
          guideEntryPoint: "help_replay",
          position: index + 1,
          total: 4,
        },
      });
    }

    expect(mocks.launchEventUpdateOne).toHaveBeenCalledTimes(2);
    expect(
      mocks.launchEventUpdateOne.mock.calls.map(
        ([, update]) => update.$setOnInsert.event,
      ),
    ).toEqual([
      "contextual_guide_first_booking_calendar_viewed",
      "contextual_guide_first_booking_create_action_viewed",
    ]);
    expect(
      mocks.stateFindOneAndUpdate.mock.calls.filter(
        ([, update]) => update.$max?.["analytics.lastActivityAt"],
      ),
    ).toHaveLength(2);
  });

  it.each([
    [
      SETUP_LAUNCH_EVENT.PRODUCT_TOUR_STARTED,
      "analytics.eventCounts.productTourStarted",
    ],
    [
      SETUP_LAUNCH_EVENT.PRODUCT_TOUR_COMPLETED,
      "analytics.eventCounts.productTourCompleted",
    ],
    [
      SETUP_LAUNCH_EVENT.PRODUCT_TOUR_SKIPPED,
      "analytics.eventCounts.productTourSkipped",
    ],
    [
      SETUP_LAUNCH_EVENT.PRODUCT_TOUR_LAUNCH_CENTER_OPENED,
      "analytics.eventCounts.productTourLaunchCenterOpened",
    ],
  ])("aggregates the %s product tour funnel event", async (event, counter) => {
    mocks.launchEventUpdateOne.mockResolvedValueOnce({ upsertedCount: 1 });
    mocks.stateFindOneAndUpdate.mockClear();

    await recordSetupLaunchEvent({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      eventId: "123e4567-e89b-42d3-a456-426614174098",
      sessionId: "tour_session_01",
      event,
      source: "product_tour",
      metadata: { tourVersion: 1 },
    });

    expect(mocks.stateFindOneAndUpdate).toHaveBeenLastCalledWith(
      { tenant: TENANT_ID },
      expect.objectContaining({
        $inc: { [counter]: 1 },
      }),
      { returnDocument: "after" },
    );
  });

  it("reports null launch milestones before the first authoritative observation", async () => {
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(snapshot.launchMetrics).toMatchObject({
      firstSeenAt: null,
      firstPublishedOfferAt: null,
      firstOfferReadyAt: null,
      firstPublishedAt: null,
      completedAt: null,
      timeToFirstPublishedOfferMs: null,
      steps: {
        [SETUP_STEP.LOCATION]: {
          opened: 0,
          completed: 0,
          dropOffCount: 0,
          dropOffRate: 0,
        },
      },
    });
  });

  it("calculates distinct-session drop-off and time to first published offer", async () => {
    const firstSeenAt = new Date("2026-07-23T09:00:00.000Z");
    const firstPublishedOfferAt = new Date("2026-07-23T09:05:00.000Z");
    stateDocument.analytics = {
      firstSeenAt,
      lastActivityAt: new Date("2026-07-23T09:10:00.000Z"),
      firstPublishedOfferAt,
      firstPublishedAt: new Date("2026-07-23T09:08:00.000Z"),
      eventCounts: {
        launchCenterViewed: 3,
        studioReady: 1,
        publicSiteOpened: 2,
        testBookingOpened: 1,
      },
      steps: {
        [SETUP_STEP.LOCATION]: { opened: 4, completed: 3 },
        [SETUP_STEP.PAYMENTS]: { opened: 2, completed: 0 },
      },
    };

    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(snapshot.launchMetrics).toMatchObject({
      firstSeenAt,
      firstPublishedOfferAt,
      firstOfferReadyAt: firstPublishedOfferAt,
      timeToFirstPublishedOfferMs: 5 * 60 * 1_000,
      eventCounts: {
        launchCenterViewed: 3,
        studioReady: 1,
        publicSiteOpened: 2,
        testBookingOpened: 1,
      },
      steps: {
        [SETUP_STEP.LOCATION]: {
          opened: 4,
          completed: 3,
          dropOffCount: 1,
          dropOffRate: 25,
        },
        [SETUP_STEP.PAYMENTS]: {
          opened: 2,
          completed: 0,
          dropOffCount: 2,
          dropOffRate: 100,
        },
      },
    });
  });

  it("deduplicates a distinct event id rejected by the session-level index", async () => {
    mocks.launchEventUpdateOne.mockRejectedValueOnce(
      Object.assign(new Error("duplicate session event"), { code: 11_000 }),
    );

    await expect(
      recordSetupLaunchEvent({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        eventId: "123e4567-e89b-42d3-a456-426614174001",
        sessionId: "launch_session_01",
        event: SETUP_LAUNCH_EVENT.STEP_OPENED,
        stepId: SETUP_STEP.LOCATION,
        source: "launch_center",
      }),
    ).resolves.toMatchObject({ accepted: true, deduplicated: true });
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("Setup Center publication safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    stateDocument = {
      publication: {
        status: SETUP_PUBLICATION_STATUS.DRAFT,
      },
      practice: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.tenantFindById.mockReturnValue(selectedLean(tenantFixture));
    mocks.locationFind.mockReturnValue(selectedSortedLean([locationFixture]));
    mocks.locationCount.mockResolvedValue(1);
    mocks.productFind.mockReturnValue(selectedSortedLean([productFixture]));
    mocks.paymentFindOne.mockReturnValue(lean(paymentFixture));
    mocks.communicationSettingsFindOne.mockReturnValue(
      selectedLean(communicationFixture),
    );
    mocks.resolveManagedSender.mockResolvedValue({ id: "sender-1" });
    mocks.teamCount.mockResolvedValue(1);
    mocks.membershipPlanCount.mockResolvedValue(0);
    mocks.automationCount.mockResolvedValue(0);
    mocks.customerCount.mockResolvedValue(0);
    mocks.firingProfileCount.mockResolvedValue(0);
    mocks.piecePricingProfileCount.mockResolvedValue(0);
    mocks.kilnCount.mockResolvedValue(0);
    mocks.inventoryItemCount.mockResolvedValue(0);
    mocks.bookingFindOne.mockReturnValue(
      selectedLean({
        bookingProduct: PRODUCT_ID,
        location: LOCATION_ID,
      }),
    );
    mocks.getTenantSubscriptionAccess.mockResolvedValue({
      access: {
        canUseFeatures: true,
        mode: "full",
      },
    });
    mocks.stateFindOne.mockImplementation(() => lean(stateDocument));
    configureStateUpdates();
    mocks.auditCreate.mockResolvedValue({ _id: "audit-1" });
    mocks.publishPublicSiteDraft.mockResolvedValue({
      draftRevision: 2,
      publishedRevision: 2,
    });
  });

  it("rejects a stale definition version before reading or publishing workspace state", async () => {
    await expect(
      publishStudio({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION + 1,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_DEFINITION_CHANGED",
    });

    expect(mocks.tenantFindById).not.toHaveBeenCalled();
    expect(mocks.getTenantSubscriptionAccess).not.toHaveBeenCalled();
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.publishPublicSiteDraft).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("requires active subscription or trial access before publishing", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce({
      access: {
        canUseFeatures: false,
        mode: "restricted",
        reason: "trial_expired",
      },
    });

    await expect(
      publishStudio({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_SUBSCRIPTION_REQUIRED",
      details: {
        canUseFeatures: false,
        reason: "trial_expired",
      },
    });

    expect(mocks.tenantFindById).not.toHaveBeenCalled();
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.publishPublicSiteDraft).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("blocks publication when no customer-bookable product exists", async () => {
    mocks.productFind.mockReturnValue(selectedSortedLean([]));

    await expect(
      publishStudio({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_LAUNCH_BLOCKED",
      details: { blockers: [SETUP_STEP.BOOKABLE_OFFER] },
    });

    expect(mocks.publishPublicSiteDraft).not.toHaveBeenCalled();
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("blocks publication until the public site editor has been reviewed", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({ ...tenantFixture, publicSiteEditor: undefined }),
    );

    await expect(
      publishStudio({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_LAUNCH_BLOCKED",
      details: { blockers: [SETUP_STEP.PUBLIC_SITE] },
    });

    expect(mocks.publishPublicSiteDraft).not.toHaveBeenCalled();
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("blocks publication when a membership-only workspace has no published plan", async () => {
    mocks.tenantFindById.mockReturnValue(
      selectedLean({
        ...tenantFixture,
        modules: {
          bookings: false,
          courses: false,
          memberships: true,
          payments: false,
          communications: false,
          firing: false,
          inventory: false,
        },
      }),
    );

    await expect(
      publishStudio({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_LAUNCH_BLOCKED",
      details: {
        blockers: [SETUP_STEP.MEMBERSHIP],
      },
    });

    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("reports an incomplete required step and performs no publication write", async () => {
    const snapshot = await buildSetupCenterSnapshot({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });
    stateDocument.practice = {
      ...activePractice({
        completedActions: [...SETUP_PRACTICE_ACTION_ORDER],
        readinessFingerprint: snapshot.diagnostics.readinessFingerprint,
      }),
      status: SETUP_PRACTICE_STATUS.COMPLETE,
      completedAt: new Date(),
    };
    mocks.paymentFindOne.mockReturnValue(lean(null));

    await expect(
      publishStudio({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SETUP_LAUNCH_BLOCKED",
      details: {
        blockers: [SETUP_STEP.PAYMENTS],
      },
    });

    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.publishPublicSiteDraft).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("snapshots the current site draft before making the studio live", async () => {
    mocks.stateFindOneAndUpdate.mockClear();
    mocks.auditCreate.mockClear();

    const result = await publishStudio({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
    });

    expect(mocks.publishPublicSiteDraft).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      revision: 2,
    });
    expect(mocks.stateFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        tenant: TENANT_ID,
        "publication.status": {
          $ne: SETUP_PUBLICATION_STATUS.LIVE,
        },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          definitionVersion: SETUP_CENTER_DEFINITION_VERSION,
          "publication.status": SETUP_PUBLICATION_STATUS.LIVE,
          "publication.publishedBy": USER_ID,
        }),
      }),
      {
        returnDocument: "after",
      },
    );
    expect(
      mocks.publishPublicSiteDraft.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.stateFindOneAndUpdate.mock.invocationCallOrder[1]);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        actor: USER_ID,
        event: "studio_published",
        stepId: SETUP_STEP.PUBLISH,
      }),
    );
    expect(result.publication.status).toBe(SETUP_PUBLICATION_STATUS.LIVE);
    expect(result.phase).toBe("launch");
    expect(result.launchReview).toMatchObject({
      status: "in_progress",
      readyToPublish: false,
      launchComplete: false,
      publicSite: { published: true, canPublish: false, publicPath: "/" },
      testBooking: { canStart: true, complete: false },
    });
    expect(result.nextAction).toMatchObject({
      key: "practice_booking",
      enabled: true,
    });
  });

  it("does not mark the studio live when the site snapshot fails", async () => {
    mocks.publishPublicSiteDraft.mockRejectedValueOnce(
      new Error("site snapshot failed"),
    );

    await expect(
      publishStudio({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
      }),
    ).rejects.toThrow("site snapshot failed");

    expect(stateDocument.publication.status).toBe(
      SETUP_PUBLICATION_STATUS.DRAFT,
    );
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("replays publish without changing the original publication timestamp or audit log", async () => {
    const publishedAt = new Date("2026-07-22T12:00:00.000Z");
    stateDocument.publication = {
      status: SETUP_PUBLICATION_STATUS.LIVE,
      publishedAt,
      publishedBy: OTHER_USER_ID,
    };

    const result = await publishStudio({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
    });

    expect(result.publication).toMatchObject({
      status: SETUP_PUBLICATION_STATUS.LIVE,
      publishedAt,
    });
    expect(stateDocument.publication).toMatchObject({
      publishedAt,
      publishedBy: OTHER_USER_ID,
    });
    expect(result.nextAction).toMatchObject({
      key: "practice_booking",
      href: "/app/setup?step=practice_booking",
      enabled: true,
    });
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.publishPublicSiteDraft).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("replays unpublish in draft without writing or auditing", async () => {
    const result = await unpublishStudio({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(result.publication.status).toBe(SETUP_PUBLICATION_STATUS.DRAFT);
    expect(mocks.stateFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("unpublishes live state with a compare-and-set transition", async () => {
    stateDocument.publication = {
      status: SETUP_PUBLICATION_STATUS.LIVE,
      publishedAt: new Date("2026-07-22T12:00:00.000Z"),
      publishedBy: USER_ID,
    };

    const result = await unpublishStudio({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
    });

    expect(mocks.stateFindOneAndUpdate).toHaveBeenCalledWith(
      {
        tenant: TENANT_ID,
        "publication.status": SETUP_PUBLICATION_STATUS.LIVE,
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          "publication.status": SETUP_PUBLICATION_STATUS.DRAFT,
          "publication.unpublishedBy": USER_ID,
        }),
      }),
      { returnDocument: "after" },
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "studio_unpublished",
      }),
    );
    expect(result.publication.status).toBe(SETUP_PUBLICATION_STATUS.DRAFT);
    expect(result.publication.publishedAt).toBeNull();
  });
});
