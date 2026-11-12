import { Router } from "express";

import { getPublicSubscriptionCatalog } from "../tenant-subscription.public-catalog.js";

export const publicSubscriptionCatalogRouter = Router();

publicSubscriptionCatalogRouter.get("/subscription-catalog", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json(getPublicSubscriptionCatalog());
});
