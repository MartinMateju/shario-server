import mongoose, { Schema, Types } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";

import {
  tenantPublicSiteEditorSchema,
  tenantPublicSiteSchema,
} from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";

const MODEL_NAME = "TenantPublicSiteHeadlineColorTest";
const FixtureModel =
  mongoose.models[MODEL_NAME] ??
  mongoose.model(
    MODEL_NAME,
    new Schema({
      publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
      publicSiteEditor: {
        type: tenantPublicSiteEditorSchema,
        default: undefined,
      },
    }),
  );

describe("tenant public-site homepage headline colour persistence", () => {
  afterAll(() => {
    mongoose.deleteModel(MODEL_NAME);
  });

  it("keeps the inherited default and stores normalized draft and published overrides", async () => {
    const inherited = new FixtureModel({});
    await expect(inherited.validate()).resolves.toBeUndefined();
    expect(inherited.publicSite.pages.home.headlineColor).toBe("");

    const customized = new FixtureModel({
      publicSiteEditor: {
        draft: { pages: { home: { headlineColor: "#abc123" } } },
        published: { pages: { home: { headlineColor: "#d27357" } } },
      },
    });
    await expect(customized.validate()).resolves.toBeUndefined();
    expect(customized.publicSiteEditor.draft.pages.home.headlineColor).toBe(
      "#ABC123",
    );
    expect(customized.publicSiteEditor.published.pages.home.headlineColor).toBe(
      "#D27357",
    );
  });

  it("rejects malformed overrides at the persistence boundary", async () => {
    const document = new FixtureModel({
      publicSite: { pages: { home: { headlineColor: "currentColor" } } },
    });

    await expect(document.validate()).rejects.toThrow();
  });

  it("preserves the override in a publication history snapshot", async () => {
    const version = new TenantPublicSiteVersionModel({
      tenant: new Types.ObjectId(),
      sourceDraftRevision: 3,
      snapshot: { pages: { home: { headlineColor: "#fedcba" } } },
      publishedAt: new Date("2026-08-25T12:00:00.000Z"),
    });

    await expect(version.validate()).resolves.toBeUndefined();
    expect(version.snapshot.pages.home.headlineColor).toBe("#FEDCBA");
  });
});
