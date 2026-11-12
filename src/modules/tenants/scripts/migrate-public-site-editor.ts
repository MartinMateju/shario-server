import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import TenantModel from "@/modules/tenants/tenant.model.js";

const shouldApply = process.argv.includes("--apply");

const run = async (): Promise<void> => {
  await connectDB();

  const filter = {
    "publicSiteEditor.published": { $exists: false },
  };
  const count = await TenantModel.countDocuments(filter);

  console.log(
    `[public-site-editor] ${count} tenant(s) require snapshot initialization.`,
  );
  if (!shouldApply) {
    console.log(
      "[public-site-editor] Dry run only. Re-run with --apply to persist.",
    );
    return;
  }

  const cursor = TenantModel.find(filter).cursor();
  let migrated = 0;

  for await (const tenant of cursor) {
    const published = serializeTenantPublicSite(tenant, {
      snapshot: "published",
    });
    const draft = serializeTenantPublicSite(tenant, {
      snapshot: "draft",
    });
    const draftRevision = Number.isSafeInteger(
      tenant.publicSiteEditor?.draftRevision,
    )
      ? tenant.publicSiteEditor!.draftRevision
      : 0;
    const result = await TenantModel.updateOne(
      {
        _id: tenant._id,
        "publicSiteEditor.published": { $exists: false },
        ...(draftRevision === 0
          ? {
              $or: [
                { "publicSiteEditor.draftRevision": 0 },
                {
                  "publicSiteEditor.draftRevision": {
                    $exists: false,
                  },
                },
              ],
            }
          : { "publicSiteEditor.draftRevision": draftRevision }),
      },
      {
        $set: {
          // The legacy publicSite field is already live and therefore seeds
          // published. A draft created during a rolling deploy is preserved.
          publicSite: published,
          "publicSiteEditor.draft": draft,
          "publicSiteEditor.published": published,
          "publicSiteEditor.draftRevision": draftRevision,
          "publicSiteEditor.publishedRevision": 0,
        },
      },
      { runValidators: true },
    );
    migrated += result.modifiedCount;
  }

  console.log(`[public-site-editor] Migrated ${migrated} tenant(s).`);
};

run()
  .catch((error) => {
    console.error("[public-site-editor] Migration failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
