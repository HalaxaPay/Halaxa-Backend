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
import { authenticateToken } from './authMiddleware.js';
import { geoBlockMiddleware, geoAdminRoutes } from './geoBlock.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration - More explicit for newer CORS versions
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        const allowedOrigins = [
            'https://halaxapay.netlify.app',
            'http://localhost:3000',
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            process.env.FRONTEND_URL
        ].filter(Boolean);
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'Accept', 
        'Origin', 
        'X-Requested-With',
        'Access-Control-Allow-Headers',
        'Access-Control-Allow-Origin'
    ],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

// Apply CORS and JSON parsing to all routes EXCEPT Stripe webhook
app.use('/api/stripe/webhook', stripeRoutes); // Mount webhook BEFORE JSON parsing

// Enable pre-flight requests for all routes
app.options('*', cors(corsOptions));

app.use(cors(corsOptions));
app.use(express.json());

// ==================== GEO-BLOCKING MIDDLEWARE ==================== //
// Apply geo-blocking to all routes (will skip localhost for development)
app.use(geoBlockMiddleware);

// TEMPORARY CATCH-ALL ROUTE FOR DEBUGGING - MUST BE AT THE TOP
app.all('*', (req, res, next) => {
    console.log(`Received request: ${req.method} ${req.originalUrl}`);
    next(); // Pass control to the next middleware/route handler
});

// Basic test route with CORS headers
app.get('/test', (req, res) => {
  console.log('🧪 Test route accessed from origin:', req.headers.origin);
  
  // Manually set CORS headers as backup
  res.header('Access-Control-Allow-Origin', 'https://halaxapay.netlify.app');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  res.json({ 
    message: 'Halaxa backend is running!', 
    timestamp: new Date().toISOString(),
    origin: req.headers.origin,
    cors: 'enabled'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    supabase: 'connected',
    env_check: {
      supabase_url: !!process.env.SUPABASE_URL,
      service_role_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      jwt_secret: !!process.env.JWT_SECRET,
      jwt_refresh_secret: !!process.env.JWT_REFRESH_SECRET
    }
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/stripe', stripeRoutes);

// Geo-blocking admin routes
const geoRouter = express.Router();
geoAdminRoutes(geoRouter);
app.use('/api/geo', geoRouter);

// Payment Link Routes (using Engine.js)
app.post('/api/payment-links/create', authenticateToken, async (req, res) => {
  try {
    // 🚨 CRITICAL LOGGING: Verify user authentication from JWT
    console.log("🔐 Payment link creation request received");
    console.log("👤 Authenticated user ID:", req.user?.id);
    console.log("📧 User email:", req.user?.email);
    console.log("📝 Request body:", req.body);
    
    if (!req.user?.id) {
      console.error("❌ CRITICAL: No user ID found in JWT token!");
      return res.status(401).json({ error: 'User authentication failed - no user ID' });
    }

    const { HalaxaEngine } = await import('./Engine.js');
    
    // Get user plan
    console.log("📊 Fetching user plan for:", req.user.id);
    const { data: userPlan, error: planError } = await supabase
      .from('user_plans')
      .select('plan_type')
      .eq('user_id', req.user.id)
      .single();
    
    if (planError) {
      console.log("⚠️ No user plan found, defaulting to basic:", planError.message);
    }
    
    const plan = userPlan?.plan_type || 'basic';
    console.log("📈 User plan determined:", plan);
    
    // Format data as expected by Engine.js
    const seller_data = {
      seller_id: req.user.id,
      plan: plan
    };
    
    const link_data = {
      wallet_address: req.body.wallet_address,
      amount_usdc: req.body.amount_usdc,
      network: req.body.network,
      product_title: req.body.link_name, // Map link_name to product_title
      description: req.body.description || req.body.link_name
    };
    
    console.log("🎯 Calling HalaxaEngine.createPaymentLink with:", { seller_data, link_data });
    
    const result = await HalaxaEngine.createPaymentLink(seller_data, link_data);
    
    if (result.success) {
      // Format response for frontend
      const response = {
        success: true,
        payment_link: {
          link_id: result.data.link_id,
          link_name: link_data.product_title,
          amount_usdc: link_data.amount_usdc,
          network: link_data.network,
          wallet_address: link_data.wallet_address,
          payment_url: result.data.share_url,
          created_at: new Date().toISOString(),
          is_active: true
        }
      };
      res.json(response);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Payment link creation error:', error);
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

app.get('/api/payment-links', authenticateToken, async (req, res) => {
  try {
    const { data: paymentLinks, error } = await supabase
      .from('payment_links')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ payment_links: paymentLinks || [] });
  } catch (error) {
    console.error('Error fetching payment links:', error);
    res.status(500).json({ error: 'Failed to fetch payment links' });
  }
});

app.get('/api/payment-links/:linkId', async (req, res) => {
  try {
    const { HalaxaEngine } = await import('./Engine.js');
    const result = await HalaxaEngine.getPaymentLinkInfo(req.params.linkId);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    console.error('Error fetching payment link:', error);
    res.status(500).json({ error: 'Failed to fetch payment link' });
  }
});

// Payment verification endpoint
app.post('/api/payment-links/:linkId/verify', async (req, res) => {
  try {
    const { HalaxaEngine } = await import('./Engine.js');
    const { wallet_address, amount_usdc, network } = req.body;
    const linkId = req.params.linkId;
    
    console.log('Verifying payment:', { linkId, wallet_address, amount_usdc, network });
    
    const result = await HalaxaEngine.verifyPayment(linkId, wallet_address, amount_usdc, network);
    
    res.json(result);
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ success: false, error: 'Failed to verify payment' });
  }
});

// Buyer details endpoint
app.post('/api/payment-links/:linkId/buyer', async (req, res) => {
  try {
    const { HalaxaEngine } = await import('./Engine.js');
    const linkId = req.params.linkId;
    const buyerInfo = req.body;
    
    console.log('Saving buyer details for link:', linkId, buyerInfo);
    
    const result = await HalaxaEngine.markPaymentPending(linkId, buyerInfo);
    
    res.json(result);
  } catch (error) {
    console.error('Error saving buyer details:', error);
    res.status(500).json({ success: false, error: 'Failed to save buyer details' });
  }
});

// Additional verification endpoint for backward compatibility
app.post('/api/payment-links/:linkId/process-verification', async (req, res) => {
  try {
    const { HalaxaEngine } = await import('./Engine.js');
    const result = await HalaxaEngine.processPaymentVerification(req.params.linkId, req.body);
    
    res.json(result);
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

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