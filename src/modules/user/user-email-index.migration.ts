import UserModel from "./user.model.js";

export const LEGACY_TENANT_EMAIL_INDEX = "tenant_1_email_1";
export const PARTIAL_TENANT_EMAIL_INDEX = "tenant_1_email_1_partial";

export const migrateUserEmailIndex = async ({
  apply = false,
}: {
  apply?: boolean;
} = {}) => {
  const indexes = await UserModel.collection.indexes();
  const names = new Set(indexes.map((index) => index.name));
  const summary = {
    mode: apply ? "apply" : "dry-run",
    createPartialIndex: !names.has(PARTIAL_TENANT_EMAIL_INDEX),
    dropLegacyIndex: names.has(LEGACY_TENANT_EMAIL_INDEX),
    changed: false,
  };
  if (!apply) return summary;

  let droppedLegacyIndex = false;
  if (summary.dropLegacyIndex && summary.createPartialIndex) {
    // MongoDB cannot change a non-sparse index's partialFilterExpression in
    // place or create an equivalent key pattern with different non-collation
    // options. Run this migration in the deployment maintenance window before
    // enabling name-only imports.
    await UserModel.collection.dropIndex(LEGACY_TENANT_EMAIL_INDEX);
    droppedLegacyIndex = true;
    summary.changed = true;
  }
  if (summary.createPartialIndex) {
    try {
      await UserModel.collection.createIndex(
        { tenant: 1, email: 1 },
        {
          name: PARTIAL_TENANT_EMAIL_INDEX,
          unique: true,
          partialFilterExpression: { email: { $type: "string" } },
        },
      );
      summary.changed = true;
    } catch (error) {
      if (droppedLegacyIndex) {
        await UserModel.collection.createIndex(
          { tenant: 1, email: 1 },
          {
            name: LEGACY_TENANT_EMAIL_INDEX,
            unique: true,
          },
        );
      }
      throw error;
    }
  }
  if (summary.dropLegacyIndex && !droppedLegacyIndex) {
    await UserModel.collection.dropIndex(LEGACY_TENANT_EMAIL_INDEX);
    summary.changed = true;
  }
  return summary;
};
