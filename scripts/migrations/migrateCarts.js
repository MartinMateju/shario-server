import Cart from "../../models/Cart.js";

export const migrateCarts = async ({ tenant }) => {
  const result = await Cart.updateMany(
    {
      tenant: { $exists: false },
    },
    {
      $set: {
        tenant: tenant._id,
      },
    },
  );

  console.log("Carts migrated:", result.modifiedCount);
};
