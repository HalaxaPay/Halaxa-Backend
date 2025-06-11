import dotenv from 'dotenv';
dotenv.config();  

import express from 'express';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import { supabase } from './supabase.js';

const router = express.Router();

// Replace with your real Stripe Secret Key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);  

// Replace with your real Stripe Webhook Signing Secret
const endpointSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET;

router.post(
  '/stripe-webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('❌ Webhook signature invalid:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'invoice.payment_succeeded'
    ) {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const priceId =
        session.subscription
          ? session.items?.data[0]?.price?.id
          : session.lines?.data[0]?.price?.id;

      const priceToPlanMap = {
        'price_123_pro': 'pro',
        'price_456_elite': 'elite'
      };

      const newPlan = priceToPlanMap[priceId];

      if (email && newPlan) {
        try {
          const { error } = await supabase
            .from('users')
            .update({ plan: newPlan })
            .eq('email', email);

          if (error) throw error;
          console.log(`✅ Plan upgraded to ${newPlan} for ${email}`);
        } catch (err) {
          console.error('❌ DB update failed:', err.message);
        }
      }
    }

    res.json({ received: true });
  }
);

export default router; 