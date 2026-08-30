import crypto from "node:crypto";
import express from "express";
import { prisma } from "../db.js";
import { processStripeEvent, verifyStripeSignature } from "../services/stripe-service.js";

export const stripeWebhookRouter = express.Router();

stripeWebhookRouter.post("/webhook", express.raw({ type: "application/json", limit: "256kb" }), async (req, res, next) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    const signature = req.header("stripe-signature");
    if (!verifyStripeSignature(rawBody, signature)) {
      res.status(400).json({ error: "invalid_signature" });
      return;
    }

    const event = JSON.parse(rawBody.toString("utf8")) as Record<string, any>;
    const eventId = typeof event.id === "string" ? event.id : "";
    const eventType = typeof event.type === "string" ? event.type : "unknown";
    if (!eventId) {
      res.status(400).json({ error: "invalid_event" });
      return;
    }

    const existing = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: "stripe", eventId } }
    });
    if (existing) {
      res.json({ received: true, duplicate: true });
      return;
    }

    const result = await processStripeEvent(event);
    await prisma.webhookEvent.create({
      data: {
        provider: "stripe",
        eventId,
        type: eventType,
        payloadHash: crypto.createHash("sha256").update(rawBody).digest("hex")
      }
    });

    res.json({ received: true, ...result });
  } catch (error) {
    next(error);
  }
});
