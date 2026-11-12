import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "@/infrastructure/database/connect-db.js";
import { ensureOpenStudioLocationIndex, reportOpenStudioLocationDuplicates, reportOpenStudioLocationTaxonomyReview, OPEN_STUDIO_LOCATION_INDEX_NAME } from "../open-studio-location-index.js";

// No models are imported: planning cannot implicitly create indexes.
const main = async () => {
  const apply = process.argv.includes("--apply");
  mongoose.set("autoIndex", false);
  await connectDB();
  const products = mongoose.connection.db!.collection("products");
  const duplicates = await reportOpenStudioLocationDuplicates(products);
  const taxonomyReview = await reportOpenStudioLocationTaxonomyReview(products);
  console.log(JSON.stringify({ mode: apply ? "apply" : "plan", index: OPEN_STUDIO_LOCATION_INDEX_NAME, duplicates, taxonomyReview }, null, 2));
  if (duplicates.length || taxonomyReview.length) {
    process.exitCode = 1;
    return;
  }
  if (apply) await ensureOpenStudioLocationIndex(products);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Open Studio index verification failed.");
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
