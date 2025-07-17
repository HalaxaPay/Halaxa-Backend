import dotenv from 'dotenv';
dotenv.config();  

import express from 'express';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import { supabase } from './supabase.js';
import { getPricingForIP, getClientIP } from './geoBlock.js';

const router = express.Router();

// Stripe configuration - will use test keys in development
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey || stripeKey.includes('your_str') || stripeKey === 'sk_test_dummy_key_12345') {
  console.warn('⚠️ STRIPE WARNING: Using development mode - Stripe features disabled');
}

const stripe = stripeKey && !stripeKey.includes('your_str') && stripeKey !== 'sk_test_dummy_key_12345' 
  ? new Stripe(stripeKey) 
  : null;

const endpointSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET;

// Plan configurations with fake price IDs as requested
const PLAN_CONFIGS = {
  pro: {
    priceId: 'price_123_pro',
    name: 'Pro Plan',
    price: 29,
    features: ['30 Payment Links', 'Advanced Analytics', 'Priority Support']
  },
  elite: {
    priceId: 'price_456_elite', 
    name: 'Elite Plan',
    price: 99,
    features: ['Unlimited Payment Links', 'Real-time Analytics', '24/7 Support', 'Custom Branding']
  }
};

// Create checkout session endpoint
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, email, userId, billing = 'monthly' } = req.body;

    if (!plan || !email) {
      return res.status(400).json({ error: 'Plan and email are required' });
    }

    const planConfig = PLAN_CONFIGS[plan];
    if (!planConfig) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    // Get geo-based pricing
    const clientIP = getClientIP(req);
    const geoPricing = getPricingForIP(clientIP);
    
    // Determine price based on billing cycle
    const planPrice = billing === 'yearly' ? geoPricing[plan].yearly : geoPricing[plan].monthly;
    const billingDescription = billing === 'yearly' ? 'Annual' : 'Monthly';
    
    console.log(`💰 Checkout session for ${plan} plan: $${planPrice} (${billing}) - IP: ${clientIP}`);

    // Check if Stripe is configured
    if (!stripe) {
      console.log('🧪 DEV MODE: Simulating successful plan upgrade');
      
      // In development, simulate successful upgrade
      await updateUserPlan(email, plan, {
        stripeCustomerId: 'cus_dev_' + Date.now(),
        stripeSessionId: 'cs_dev_' + Date.now(),
        paymentStatus: 'completed'
      });
      
      return res.json({
        sessionId: 'dev_session_' + Date.now(),
        url: `${process.env.FRONTEND_URL || 'https://halaxapay.com'}?upgrade=success&plan=${plan}&dev=true`,
        devMode: true,
        message: 'Development mode: Plan upgraded automatically',
        pricing: { [plan]: planPrice, billing }
      });
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${planConfig.name} (${billingDescription})`,
              description: `Upgrade to ${planConfig.name} - ${planConfig.features.join(', ')}`
            },
            unit_amount: planPrice * 100, // Convert to cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment', // One-time payment, change to 'subscription' if needed
      customer_email: email,
      metadata: {
        plan: plan,
        billing: billing,
        price: planPrice.toString(),
        userId: userId || '',
        email: email
      },
      success_url: `${process.env.FRONTEND_URL || 'https://halaxapay.com'}?upgrade=success&plan=${plan}&billing=${billing}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://halaxapay.com'}?upgrade=cancelled`,
    });

    res.json({ 
      sessionId: session.id,
      url: session.url,
      pricing: { [plan]: planPrice, billing }
    });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Get plan information endpoint
router.get('/plans', (req, res) => {
  res.json({
    plans: {
      basic: {
        name: 'Basic Plan',
        price: 0,
        features: ['1 Payment Link', 'Basic Analytics']
      },
      ...PLAN_CONFIGS
    }
  });
});

// Webhook handler
router.post(
  '/webhook',
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

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(event.data.object);
          break;
        
        case 'invoice.payment_succeeded':
          await handlePaymentSucceeded(event.data.object);
          break;
        
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await handleSubscriptionUpdate(event.data.object);
          break;
        
        case 'customer.subscription.deleted':
          await handleSubscriptionCancelled(event.data.object);
          break;

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

// Helper functions for webhook processing
async function handleCheckoutSessionCompleted(session) {
  const email = session.customer_email || session.customer_details?.email;
  const plan = session.metadata?.plan;
  
  if (email && plan) {
    await updateUserPlan(email, plan, {
      stripeCustomerId: session.customer,
      stripeSessionId: session.id,
      paymentStatus: 'completed'
    });
    console.log(`✅ Plan upgraded to ${plan} for ${email} via checkout session`);
  }
}

async function handlePaymentSucceeded(invoice) {
  const email = invoice.customer_email;
  const subscription = invoice.subscription;
  
  if (email && subscription) {
    // Get subscription details to determine plan
    const sub = await stripe.subscriptions.retrieve(subscription);
    const priceId = sub.items.data[0]?.price?.id;
    
    const priceToPlanMap = {
      'price_123_pro': 'pro',
      'price_456_elite': 'elite'
    };
    
    const plan = priceToPlanMap[priceId];
    if (plan) {
      await updateUserPlan(email, plan, {
        stripeCustomerId: invoice.customer,
        stripeSubscriptionId: subscription,
        paymentStatus: 'active'
      });
      console.log(`✅ Subscription payment succeeded for ${email}, plan: ${plan}`);
    }
  }
}

async function handleSubscriptionUpdate(subscription) {
  const customer = await stripe.customers.retrieve(subscription.customer);
  const email = customer.email;
  const priceId = subscription.items.data[0]?.price?.id;
  
  const priceToPlanMap = {
    'price_123_pro': 'pro',
    'price_456_elite': 'elite'
  };
  
  const plan = priceToPlanMap[priceId];
  if (email && plan) {
    await updateUserPlan(email, plan, {
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      paymentStatus: subscription.status
    });
    console.log(`✅ Subscription updated for ${email}, plan: ${plan}, status: ${subscription.status}`);
  }
}

async function handleSubscriptionCancelled(subscription) {
  const customer = await stripe.customers.retrieve(subscription.customer);
  const email = customer.email;
  
  if (email) {
    await updateUserPlan(email, 'basic', {
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: null,
      paymentStatus: 'cancelled'
    });
    console.log(`✅ Subscription cancelled for ${email}, downgraded to basic plan`);
  }
}

async function updateUserPlan(email, plan, stripeData = {}) {
  try {
    // Get user ID from Supabase Auth
    const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) throw listError;
    
    const user = users.find(u => u.email === email);
    if (!user) {
      console.warn(`User with email ${email} not found in auth`);
      return;
    }

    // Check if user already has a plan entry
    const { data: existingPlan } = await supabase
      .from('user_plans')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (existingPlan) {
      // Update existing plan
      const { error: updateError } = await supabase
        .from('user_plans')
        .update({ 
          plan_type: plan,
          next_billing: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          auto_renew: plan !== 'basic'
        })
        .eq('user_id', user.id);
        
      if (updateError) throw updateError;
    } else {
      // Create new plan entry
      const { error: insertError } = await supabase
        .from('user_plans')
        .insert({
          user_id: user.id,
          plan_type: plan,
          started_at: new Date().toISOString(),
          next_billing: plan !== 'basic' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null,
          auto_renew: plan !== 'basic'
        });
        
      if (insertError) throw insertError;
    }

    console.log(`✅ Updated user plan to ${plan} for ${email}`);
    
  } catch (err) {
    console.error('❌ Failed to update user plan:', err.message);
    throw err;
  }
}



export default router; 