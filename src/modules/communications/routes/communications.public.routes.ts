import express from "express";

import { submitSatisfaction } from "../controllers/communications.webhook.controller.js";

// Kept as an empty export for one release so any old import fails closed.
// Customer inbound email and Meta webhook ingestion are intentionally retired.
export const communicationWebhookRouter = express.Router();

export const publicCommunicationRouter = express.Router();
publicCommunicationRouter.post("/satisfaction/:token", submitSatisfaction);
