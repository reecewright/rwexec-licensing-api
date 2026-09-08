import crypto from "node:crypto";
import express from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { processStripeEvent, verifyStripeSignature } from "../services/stripe-service.js";

export const stripeWebhookRouter = express.Router();

stripeWebhookRouter.post(
  "/webhook",
  express.raw({ type: "application/json", limit: "256kb" }),
  async (req, res, next) => {
    let reservedEventId: string | null = null;

    try {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body ?? "");
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

      const payloadHash = crypto
        .createHash("sha256")
        .update(rawBody)
        .digest("hex");

      // Reserve the event before processing it. The unique provider/event ID
      // prevents two concurrent Stripe deliveries from running the same work.
      try {
        const reservation = await prisma.webhookEvent.create({
          data: {
            provider: "stripe",
            eventId,
            type: eventType,
            payloadHash,
          },
        });
        reservedEventId = reservation.id;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          res.json({ received: true, duplicate: true });
          return;
        }
        throw error;
      }

      try {
        const result = await processStripeEvent(event);
        res.json({ received: true, ...result });
      } catch (error) {
        // Processing failed, so release the reservation. Stripe will receive a
        // 500 and can safely retry this same event later.
        if (reservedEventId) {
          await prisma.webhookEvent
            .delete({ where: { id: reservedEventId } })
            .catch((cleanupError) => {
              console.error(
                "Could not release failed Stripe webhook reservation:",
                cleanupError,
              );
            });
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  },
);
