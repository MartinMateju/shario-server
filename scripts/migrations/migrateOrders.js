import Order from "../../models/Order.js";

export const migrateOrders = async ({ tenant }) => {
  const result = await Order.updateMany(
    {
      tenant: { $exists: false },
    },
    {
      $set: {
        tenant: tenant._id,
      },
    },
  );

  console.log("Orders migrated:", result.modifiedCount);
};
