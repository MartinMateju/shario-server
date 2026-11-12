import { describe, expect, it } from "vitest";

import { TenantModel } from "@/modules/tenants/tenant.schema.js";
import {
  TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
  TENANT_WORKSPACE_INTENT_SOURCE,
} from "@/modules/tenants/tenant.constants.js";

const completeAnswers = {
  sharedStudio: true,
  classes: false,
  firingServices: true,
  memberships: false,
  vouchers: true,
  inventory: false,
};

const workspaceIntent = (answers?: typeof completeAnswers) => ({
  definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
  confirmedAt: new Date("2026-08-01T12:00:00.000Z"),
  updatedAt: new Date("2026-08-01T12:00:00.000Z"),
  source: TENANT_WORKSPACE_INTENT_SOURCE.OWNER,
  ...(answers ? { answers } : {}),
});

describe("tenant workspace intent answer schema", () => {
  it("stores the exact complete questionnaire answer map", async () => {
    const tenant = new TenantModel({
      name: "Answer schema studio",
      slug: "answer-schema-studio",
      workspaceIntent: workspaceIntent(completeAnswers),
    });

    await tenant.validate();
    expect(tenant.toObject().workspaceIntent?.answers).toEqual(completeAnswers);
  });

  it.each(["time"])(
    "stores v2 %s without the retired firing question",
    async (pricingMode) => {
      const { firingServices: _legacy, ...answers } = completeAnswers;
      const tenant = new TenantModel({
        name: "V2 intent studio",
        slug: "v2-intent-studio",
        workspaceIntent: { ...workspaceIntent(), answers, pricingMode },
      });
      await tenant.validate();
      expect(tenant.toObject().workspaceIntent).toMatchObject({
        definitionVersion: 2,
        answers,
        pricingMode,
      });
    },
  );

  it("rejects unsupported pricing preferences", async () => {
    const tenant = new TenantModel({
      name: "Invalid pricing studio",
      slug: "invalid-pricing-studio",
      workspaceIntent: { ...workspaceIntent(), pricingMode: "per-kilo" },
    });
    await expect(tenant.validate()).rejects.toMatchObject({
      errors: { "workspaceIntent.pricingMode": expect.anything() },
    });
  });

  it("keeps legacy intents without answers valid", async () => {
    const tenant = new TenantModel({
      name: "Legacy intent studio",
      slug: "legacy-intent-studio",
      workspaceIntent: workspaceIntent(),
    });

    await tenant.validate();
    expect(tenant.toObject().workspaceIntent).not.toHaveProperty("answers");
  });

  it("rejects an incomplete stored answer map", async () => {
    const { inventory: _inventory, ...incompleteAnswers } = completeAnswers;
    const tenant = new TenantModel({
      name: "Incomplete answers studio",
      slug: "incomplete-answers-studio",
      workspaceIntent: workspaceIntent(
        incompleteAnswers as typeof completeAnswers,
      ),
    });

    await expect(tenant.validate()).rejects.toMatchObject({
      errors: {
        "workspaceIntent.answers.inventory": expect.anything(),
      },
    });
  });

  it("rejects null while preserving missing answers for legacy intents", async () => {
    const tenant = new TenantModel({
      name: "Null answers studio",
      slug: "null-answers-studio",
      workspaceIntent: {
        ...workspaceIntent(),
        answers: null,
      },
    });

    await expect(tenant.validate()).rejects.toMatchObject({
      errors: {
        "workspaceIntent.answers": expect.anything(),
      },
    });
  });
});
