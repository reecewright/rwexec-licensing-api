import { Router } from "express";
import { prisma } from "../db.js";
import { createCheckoutSession } from "../services/stripe-service.js";

export const checkoutRouter = Router();

checkoutRouter.get("/:productSlug/:planSlug", async (req, res, next) => {
  try {
    const productSlug = String(req.params.productSlug ?? "")
      .trim()
      .toLowerCase();

    const planSlug = String(req.params.planSlug ?? "")
      .trim()
      .toLowerCase();

    if (!productSlug || !planSlug) {
      return res.status(400).send("Invalid checkout link.");
    }

    const plan = await prisma.plan.findFirst({
      where: {
        slug: planSlug,
        active: true,
        product: {
          slug: productSlug,
          active: true,
        },
      },
      include: {
        product: true,
      },
    });

    if (!plan) {
      return res.status(404).send("That RWExec plan is not available.");
    }

    if (!plan.stripePriceId) {
      return res
        .status(503)
        .send("Online checkout is not configured for this plan yet.");
    }

    const session = await createCheckoutSession({
      planId: plan.id,
      successUrl:
        "https://account.rwexec.com/checkout-success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://test.rwexec.com/plugins.html#rwexec-reservations",
    });

    if (!session.url || typeof session.url !== "string") {
      throw new Error("Stripe Checkout did not return a checkout URL.");
    }

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(303, session.url);
  } catch (error) {
    next(error);
  }
});