import User from "../../models/User.js";

export const migrateUsers = async ({ tenant }) => {
  const result = await User.updateMany(
    {
      tenant: { $exists: false },
    },
    {
      $set: {
        tenant: tenant._id,
      },
    },
  );

  console.log("Users migrated:", result.modifiedCount);
};
