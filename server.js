console.log('SERVER.JS: STARTING APPLICATION EXECUTION');
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './auth.js';
import accountRoutes from './account.js';
import stripeRoutes from './Stripe.js';
import { supabase } from './supabase.js';
import { validateEmail, validatePassword, validateRequest } from './security.js';
import { DetectionAPI } from './Detection.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
const corsOptions = {
    origin: process.env.FRONTEND_URL || 'https://halaxapay.netlify.app',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
};

// Apply CORS and JSON parsing to all routes EXCEPT Stripe webhook
app.use('/api/stripe/webhook', stripeRoutes); // Mount webhook BEFORE JSON parsing
app.use(cors(corsOptions));
app.use(express.json());

// TEMPORARY CATCH-ALL ROUTE FOR DEBUGGING - MUST BE AT THE TOP
app.all('*', (req, res, next) => {
    console.log(`Received request: ${req.method} ${req.originalUrl}`);
    next(); // Pass control to the next middleware/route handler
});

// Basic test route
app.get('/test', (req, res) => {
  res.json({ message: 'Halaxa backend is running!', timestamp: new Date().toISOString() });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', supabase: 'connected' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/stripe', stripeRoutes);

// Detection System API Routes
app.get('/api/detection/status', (req, res) => {
  res.json(DetectionAPI.status());
});

app.post('/api/detection/start', async (req, res) => {
  try {
    const { interval = 5 } = req.body;
    await DetectionAPI.start(interval);
    res.json({ success: true, message: `Detection system started with ${interval} minute intervals` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/detection/stop', async (req, res) => {
  try {
    await DetectionAPI.stop();
    res.json({ success: true, message: 'Detection system stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/detection/run/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await DetectionAPI.runForUser(userId);
    res.json({ success: true, message: `Detection completed for user ${userId}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/detection/cycle', async (req, res) => {
  try {
    await DetectionAPI.runCycle();
    res.json({ success: true, message: 'Full detection cycle completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Access Control API Routes
app.get('/api/access/user-plan/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data: userPlan, error } = await supabase
      .from('user_plans')
      .select('plan_type, started_at, next_billing, auto_renewal')
      .eq('user_id', userId)
      .single();

    if (error || !userPlan) {
      return res.json({ plan: 'basic', features: {} });
    }

    const planLimits = {
      basic: { maxPaymentLinks: 1, maxMonthlyVolume: 500, allowedNetworks: ['polygon'] },
      pro: { maxPaymentLinks: 30, maxMonthlyVolume: 30000, allowedNetworks: ['polygon', 'solana'] },
      elite: { maxPaymentLinks: Infinity, maxMonthlyVolume: Infinity, allowedNetworks: ['polygon', 'solana', 'tron'] }
    };

    const plan = userPlan.plan_type || 'basic';
    const limits = planLimits[plan] || planLimits.basic;

    res.json({
      plan,
      limits,
      planDetails: userPlan
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/access/check-permission', async (req, res) => {
  try {
    const { userId, action, data } = req.body;
    
    // Get user plan
    const { data: userPlan } = await supabase
      .from('user_plans')
      .select('plan_type')
      .eq('user_id', userId)
      .single();

    const plan = userPlan?.plan_type || 'basic';
    
    let permission = { allowed: true };
    
    if (action === 'create_payment_link') {
      // Check payment link limit
      const { data: activeLinks } = await supabase
        .from('payment_links')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true);

      const limits = {
        basic: 1,
        pro: 30,
        elite: Infinity
      };

      const currentCount = activeLinks?.length || 0;
      const maxLinks = limits[plan] || 1;

      if (currentCount >= maxLinks) {
        permission = {
          allowed: false,
          reason: 'payment_link_limit',
          message: `${plan.toUpperCase()} plan allows only ${maxLinks} active link${maxLinks > 1 ? 's' : ''}. Upgrade for more.`,
          current: currentCount,
          limit: maxLinks
        };
      }
    }

    if (action === 'check_volume_limit') {
      // Check monthly volume
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const { data: monthlyTxs } = await supabase
        .from('transactions')
        .select('amount_usdc')
        .eq('user_id', userId)
        .eq('direction', 'in')
        .gte('created_at', monthStart.toISOString());

      const currentVolume = monthlyTxs?.reduce((sum, tx) => sum + (tx.amount_usdc || 0), 0) || 0;
      
      const limits = {
        basic: 500,
        pro: 30000,
        elite: Infinity
      };

      const maxVolume = limits[plan] || 500;

      if (currentVolume >= maxVolume) {
        permission = {
          allowed: false,
          reason: 'volume_limit',
          message: `${plan.toUpperCase()} plan allows max ${maxVolume} USDC monthly volume. Upgrade for higher limits.`,
          current: currentVolume,
          limit: maxVolume
        };
      }
    }

    res.json(permission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/access/usage/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get user plan
    const { data: userPlan } = await supabase
      .from('user_plans')
      .select('plan_type')
      .eq('user_id', userId)
      .single();

    const plan = userPlan?.plan_type || 'basic';
    
    // Get payment links usage
    const { data: activeLinks } = await supabase
      .from('payment_links')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true);

    // Get monthly volume
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const { data: monthlyTxs } = await supabase
      .from('transactions')
      .select('amount_usdc')
      .eq('user_id', userId)
      .eq('direction', 'in')
      .gte('created_at', monthStart.toISOString());

    const currentVolume = monthlyTxs?.reduce((sum, tx) => sum + (tx.amount_usdc || 0), 0) || 0;

    const planLimits = {
      basic: { maxPaymentLinks: 1, maxMonthlyVolume: 500 },
      pro: { maxPaymentLinks: 30, maxMonthlyVolume: 30000 },
      elite: { maxPaymentLinks: Infinity, maxMonthlyVolume: Infinity }
    };

    const limits = planLimits[plan] || planLimits.basic;

    res.json({
      plan,
      paymentLinks: {
        current: activeLinks?.length || 0,
        limit: limits.maxPaymentLinks,
        percentage: limits.maxPaymentLinks === Infinity ? 0 : ((activeLinks?.length || 0) / limits.maxPaymentLinks) * 100
      },
      volume: {
        current: currentVolume,
        limit: limits.maxMonthlyVolume,
        percentage: limits.maxMonthlyVolume === Infinity ? 0 : (currentVolume / limits.maxMonthlyVolume) * 100
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a test endpoint
app.get('/test', (req, res) => {
    res.json({ message: 'Backend is running!' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Auto-start detection system
  try {
    await DetectionAPI.start(5); // Start with 5-minute intervals
    console.log('🚀 Halaxa Detection System started automatically');
  } catch (error) {
    console.error('❌ Failed to start detection system:', error.message);
  }
}); 