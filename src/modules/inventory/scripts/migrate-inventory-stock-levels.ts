import "dotenv/config";

import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import connectDB from "@/infrastructure/database/connect-db.js";
import { LocationModel } from "@/modules/location/location.model.js";

import { InventoryItem } from "../inventory-item.schema.js";
import { requiresManualLegacyStockLocation } from "../inventory-stock-levels.js";

const shouldApply = process.argv.includes("--apply");
const sampleLimit = 50;

type MigrationSummary = {
  canonical: number;
  singleLocation: number;
  multipleLocationsAssignedToFirst: number;
  orphanAssignedToPrimary: number;
  manualReview: number;
  compatibilityFieldsRepaired: number;
  blankSkusRemoved: number;
  duplicateOpenReorderGroups: number;
  duplicateOpenReordersCancelled: number;
  reorderSourcesBackfilled: number;
  receivedReordersWithoutMovement: number;
  samples: {
    multipleLocations: string[];
    manualReview: string[];
    duplicateOpenReorders: string[];
    receivedReordersWithoutMovement: string[];
  };
};

const number = (value: unknown): number => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const runMigration = async (): Promise<MigrationSummary> => {
  const summary: MigrationSummary = {
    canonical: 0,
    singleLocation: 0,
    multipleLocationsAssignedToFirst: 0,
    orphanAssignedToPrimary: 0,
    manualReview: 0,
    compatibilityFieldsRepaired: 0,
    blankSkusRemoved: 0,
    duplicateOpenReorderGroups: 0,
    duplicateOpenReordersCancelled: 0,
    reorderSourcesBackfilled: 0,
    receivedReordersWithoutMovement: 0,
    samples: {
      multipleLocations: [],
      manualReview: [],
      duplicateOpenReorders: [],
      receivedReordersWithoutMovement: [],
    },
  };
  const primaryLocations = new Map<string, mongoose.Types.ObjectId | null>();
  const reorderRequests = mongoose.connection.collection("reorderrequests");
  const cursor = InventoryItem.collection.find({});

  for await (const item of cursor) {
    const stockLevels = Array.isArray(item.stockLevels)
      ? item.stockLevels
      : [];
    const legacyLocations = Array.isArray(item.locations)
      ? item.locations.filter(Boolean)
      : [];
    const update: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};

    if (typeof item.sku === "string" && !item.sku.trim()) {
      summary.blankSkusRemoved += 1;
      unset.sku = "";
    }

    if (stockLevels.length) {
      summary.canonical += 1;
      const currentQuantity = stockLevels.reduce(
        (total, level) => total + number(level.currentQuantity),
        0,
      );
      const minimumQuantity = stockLevels.reduce(
        (total, level) => total + number(level.minimumQuantity),
        0,
      );
      const locations = stockLevels.map((level) => level.location);
      const isSynchronized =
        number(item.currentQuantity) === currentQuantity &&
        number(item.minimumQuantity) === minimumQuantity &&
        legacyLocations.map(String).join(",") ===
          locations.map(String).join(",");

      if (!isSynchronized) {
        summary.compatibilityFieldsRepaired += 1;
        update.locations = locations;
        update.currentQuantity = currentQuantity;
        update.minimumQuantity = minimumQuantity;
      }
    } else {
      let locations = legacyLocations;

      if (!locations.length) {
        if (
          requiresManualLegacyStockLocation({
            stockLevels: [],
            locations: [],
            currentQuantity: item.currentQuantity,
            minimumQuantity: item.minimumQuantity,
          })
        ) {
          summary.manualReview += 1;
          if (summary.samples.manualReview.length < sampleLimit) {
            summary.samples.manualReview.push(String(item._id));
          }
          continue;
        }

        const tenantId = String(item.tenant || "");
        let primary = primaryLocations.get(tenantId);

        if (primary === undefined) {
          const location = await LocationModel.findOne({
            tenant: item.tenant,
            isPrimary: true,
            isActive: true,
          })
            .select("_id")
            .lean()
            .exec();
          primary = location?._id ?? null;
          primaryLocations.set(tenantId, primary);
        }

        if (!primary) {
          summary.manualReview += 1;
          if (summary.samples.manualReview.length < sampleLimit) {
            summary.samples.manualReview.push(String(item._id));
          }
          continue;
        }

        locations = [primary];
        summary.orphanAssignedToPrimary += 1;
      } else if (locations.length === 1) {
        summary.singleLocation += 1;
      } else {
        summary.multipleLocationsAssignedToFirst += 1;
        if (summary.samples.multipleLocations.length < sampleLimit) {
          summary.samples.multipleLocations.push(String(item._id));
        }
      }

      const migratedLevels = locations.map((location, index) => ({
        location,
        currentQuantity: index === 0 ? number(item.currentQuantity) : 0,
        minimumQuantity: index === 0 ? number(item.minimumQuantity) : 0,
      }));
      update.stockLevels = migratedLevels;
      update.locations = locations;
      // Exact legacy totals remain unchanged; the multi-location migration
      // never duplicates them across every location.
      update.currentQuantity = number(item.currentQuantity);
      update.minimumQuantity = number(item.minimumQuantity);
    }

    if (
      shouldApply &&
      (Object.keys(update).length || Object.keys(unset).length)
    ) {
      await InventoryItem.collection.updateOne(
        { _id: item._id },
        {
          ...(Object.keys(update).length ? { $set: update } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
      );
    }
  }

  const duplicateOpenGroups = await reorderRequests
    .aggregate<{
      _id: {
        tenant: mongoose.Types.ObjectId;
        item: mongoose.Types.ObjectId;
        location: mongoose.Types.ObjectId;
      };
      ids: mongoose.Types.ObjectId[];
      count: number;
    }>([
      { $match: { status: "open" } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: {
            tenant: "$tenant",
            item: "$item",
            location: "$location",
          },
          ids: { $push: "$_id" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  summary.duplicateOpenReorderGroups = duplicateOpenGroups.length;
  for (const group of duplicateOpenGroups) {
    const duplicateIds = group.ids.slice(1);
    summary.duplicateOpenReordersCancelled += duplicateIds.length;
    if (summary.samples.duplicateOpenReorders.length < sampleLimit) {
      summary.samples.duplicateOpenReorders.push(
        `${String(group._id.tenant)}:${String(group._id.item)}:${String(
          group._id.location,
        )}`,
      );
    }

    if (shouldApply && duplicateIds.length) {
      await reorderRequests.updateMany(
        { _id: { $in: duplicateIds }, status: "open" },
        {
          $set: {
            status: "cancelled",
            resolvedAt: new Date(),
          },
        },
      );
    }
  }

  const missingSourceFilter = {
    $or: [
      { source: { $exists: false } },
      { source: null },
      { source: "" },
    ],
  };
  summary.reorderSourcesBackfilled =
    await reorderRequests.countDocuments(missingSourceFilter);

  if (shouldApply && summary.reorderSourcesBackfilled > 0) {
    await reorderRequests.updateMany(
      {
        ...missingSourceFilter,
        note: { $regex: /^Automatically\b/i },
      },
      { $set: { source: "automatic" } },
    );
    await reorderRequests.updateMany(
      missingSourceFilter,
      { $set: { source: "manual" } },
    );
  }

  const receivedWithoutMovementFilter = {
    status: "received",
    $or: [
      { receivedMovement: { $exists: false } },
      { receivedMovement: null },
    ],
  };
  summary.receivedReordersWithoutMovement =
    await reorderRequests.countDocuments(
      receivedWithoutMovementFilter,
    );
  if (summary.receivedReordersWithoutMovement > 0) {
    const receivedSamples = await reorderRequests
      .find(receivedWithoutMovementFilter, { projection: { _id: 1 } })
      .limit(sampleLimit)
      .toArray();
    summary.samples.receivedReordersWithoutMovement = receivedSamples.map(
      (request) => String(request._id),
    );
  }

  return summary;
};

const run = async (): Promise<void> => {
  try {
    await connectDB();
    const summary = await runMigration();

    logger.info(
      { apply: shouldApply, ...summary },
      shouldApply
        ? "Inventory stock-level migration completed."
        : "Inventory stock-level migration dry run completed. Re-run with --apply after reviewing samples.",
    );

    if (
      summary.manualReview > 0 ||
      summary.receivedReordersWithoutMovement > 0
    ) {
      // Receipt rows cannot be replayed automatically: old deployments may
      // have adjusted stock manually, so doing it again could duplicate stock.
      process.exitCode = 1;
    }
  } catch (error) {
    logger.fatal({ err: error }, "Inventory stock-level migration failed.");
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  }
};

void run();
