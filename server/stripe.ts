import Stripe from "stripe";
import { logger } from "./logger";

let stripe: Stripe | null = null;

if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  logger.info("Stripe initialized successfully");
} else {
  logger.warn("STRIPE_SECRET_KEY not set — Stripe payments disabled");
}

const TIER_PRICES: Record<string, { amount: number; slots: number; name: string }> = {
  starter: { amount: 9900, slots: 3, name: "Starter Plan — 3 Candidates" },
  basic: { amount: 20000, slots: 10, name: "Basic Plan — 10 Candidates" },
  premium: { amount: 50000, slots: 25, name: "Premium Plan — 25 Candidates" },
  enterprise: { amount: 99900, slots: 50, name: "Enterprise Plan — 50 Candidates" },
};

export function isStripeConfigured(): boolean {
  return stripe !== null;
}

export async function createCheckoutSession(
  tier: string,
  employerId: number,
  userId: string,
  origin: string
): Promise<Stripe.Checkout.Session> {
  if (!stripe) throw new Error("Stripe is not configured");
  const tierConfig = TIER_PRICES[tier];
  if (!tierConfig) throw new Error("Invalid tier");

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: tierConfig.name,
            description: `$20 per candidate slot — ${tierConfig.slots} slots included`,
          },
          unit_amount: tierConfig.amount,
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: `${origin}/employer/dashboard?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/employer/subscribe?payment=cancelled`,
    metadata: {
      tier,
      employerId: String(employerId),
      userId,
      candidateSlots: String(tierConfig.slots),
    },
  });

  return session;
}

export async function retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  if (!stripe) throw new Error("Stripe is not configured");
  return stripe.checkout.sessions.retrieve(sessionId);
}

export { stripe };
