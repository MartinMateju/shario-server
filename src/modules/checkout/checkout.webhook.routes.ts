import { Router } from "express";
import express from "express";

import { stripeWebhook } from "./controllers/checkout.controller.js";

const router = Router();

router.post("/", express.raw({ type: "application/json" }), stripeWebhook);

export default router;
