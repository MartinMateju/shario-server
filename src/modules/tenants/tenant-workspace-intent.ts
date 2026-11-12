export const buildLegacyWorkspaceIntentMigrationFilter = (cutoff: Date) => ({
  "onboarding.completed": true,
  workspaceIntent: { $exists: false },
  $or: [
    { "onboarding.completedAt": { $lte: cutoff } },
    {
      $and: [
        { "onboarding.completedAt": { $exists: false } },
        {
          $or: [
            { createdAt: { $lte: cutoff } },
            {
              $and: [
                { createdAt: { $exists: false } },
                { updatedAt: { $lte: cutoff } },
              ],
            },
          ],
        },
      ],
    },
  ],
});
