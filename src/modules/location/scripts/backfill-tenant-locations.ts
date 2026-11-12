import "dotenv/config";

import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import connectDB from "@/infrastructure/database/connect-db.js";
import { locationRepository } from "@/modules/location/location.repository.js";
import { ensureTenantPrimaryLocation } from "@/modules/location/services/location.service.js";
import { TenantModel } from "@/modules/tenants/tenant.model.js";

type BackfillSummary = {
  created: number;
  repaired: number;
  unchanged: number;
  failed: number;
};

const backfillTenantLocations = async (): Promise<BackfillSummary> => {
  const summary: BackfillSummary = {
    created: 0,
    repaired: 0,
    unchanged: 0,
    failed: 0,
  };

  const cursor = TenantModel.find({
    "onboarding.completed": true,
  }).cursor();

  for await (const tenant of cursor) {
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const freshTenant = await TenantModel.findById(tenant._id)
          .session(session)
          .exec();

        if (!freshTenant) {
          return;
        }

        const tenantId = String(freshTenant._id);
        const primaryBefore = await locationRepository.findPrimary(tenantId, {
          session,
        });
        const activeBefore = await locationRepository.countActive(tenantId, {
          session,
        });

        await ensureTenantPrimaryLocation(freshTenant, { session });

        if (primaryBefore) {
          summary.unchanged += 1;
        } else if (activeBefore > 0) {
          summary.repaired += 1;
        } else {
          summary.created += 1;
        }
      });
    } catch (error) {
      summary.failed += 1;
      logger.error(
        {
          err: error,
          tenantId: String(tenant._id),
        },
        "Failed to backfill the tenant primary studio location.",
      );
    } finally {
      await session.endSession();
    }
  }

  return summary;
};

const run = async (): Promise<void> => {
  try {
    await connectDB();

    const summary = await backfillTenantLocations();

    logger.info(summary, "Studio location backfill completed.");

    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    logger.fatal({ err: error }, "Studio location backfill failed.");
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  }
};

void run();
