import { getDefaultTenantAndLocations } from "./helpers.js";

import { connectDB, disconnectDB } from "../seed/connect.js";
import { migrateBookings } from "./migrateBookings.js";
import { migrateCarts } from "./migrateCarts.js";
import { migrateOrders } from "./migrateOrders.js";
import { migrateProducts } from "./migrateProducts.js";
import { migrateUsers } from "./migrateUsers.js";

const run = async () => {
  try {
    await connectDB();

    const context = await getDefaultTenantAndLocations();

    await migrateUsers(context);
    await migrateProducts(context);
    await migrateCarts(context);
    await migrateOrders(context);
    await migrateBookings(context);

    console.log("Core migration completed");
  } catch (error) {
    console.error("Core migration failed:", error);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
  }
};

run();
