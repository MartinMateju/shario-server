import Location from "../../models/Location.js";
import Tenant from "../../models/Tenant.js";

export const getDefaultTenantAndLocations = async () => {
  const tenant = await Tenant.findOne({ slug: "studio-grohova" });

  if (!tenant) {
    throw new Error("Default tenant not found. Run npm run seed:tenant first.");
  }

  const grohova = await Location.findOne({
    tenant: tenant._id,
    slug: "grohova",
  });

  const vaclavska = await Location.findOne({
    tenant: tenant._id,
    slug: "vaclavska",
  });

  if (!grohova || !vaclavska) {
    throw new Error(
      "Default locations not found. Run npm run seed:tenant first.",
    );
  }

  return {
    tenant,
    locations: {
      grohova,
      vaclavska,
    },
  };
};

export const legacyLocationToLocationId = (legacyLocation, locations) => {
  if (!legacyLocation) return null;

  const value = String(legacyLocation).toLowerCase().trim();

  if (value === "grohova") return locations.grohova._id;
  if (value === "vaclavska") return locations.vaclavska._id;

  return null;
};
