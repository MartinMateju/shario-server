import Product from "../../models/Product.js";

export const migrateProducts = async ({ tenant }) => {
  const result = await Product.updateMany(
    {
      tenant: { $exists: false },
    },
    {
      $set: {
        tenant: tenant._id,
      },
    },
  );

  console.log("Products migrated:", result.modifiedCount);
};
