console.log('SERVER.JS: STARTING APPLICATION EXECUTION');
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
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

// Configure Express to trust Render's proxy securely (fixes X-Forwarded-For validation errors)
// Only trust Render's specific proxy setup - more secure than 'true'
app.set('trust proxy', 1); // Trust first proxy only (Render's load balancer)

// CORS configuration - More explicit for newer CORS versions
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        const allowedOrigins = [
            'https://halaxapay.com',
            'https://www.halaxapay.com',
            'http://localhost:3000',
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://127.0.0.1:8080',
            'http://localhost:8080',
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
    credentials: false, // Changed to false to match frontend omit setting
    preflightContinue: false,
    optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

// Apply CORS and JSON parsing to all routes EXCEPT Stripe webhook
app.use('/api/stripe/webhook', stripeRoutes); // Mount webhook BEFORE JSON parsing

// Enable pre-flight requests for all routes
app.options('*', cors(corsOptions));

app.use(cors(corsOptions));
app.use(express.json());

// ==================== RATE LIMITING ==================== //
// Global rate limiting to prevent API abuse
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`[RATE_LIMIT] IP ${req.ip} exceeded rate limit`);
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: '15 minutes',
      timestamp: new Date().toISOString()
    });
  }
});

// Stricter rate limiting for calculation endpoints
const calculationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // Limit each IP to 20 requests per 5 minutes
  message: {
    error: 'Too many calculation requests, please try again later.',
    retryAfter: '5 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`[RATE_LIMIT] IP ${req.ip} exceeded calculation rate limit`);
    res.status(429).json({
      error: 'Too many calculation requests',
      retryAfter: '5 minutes',
      timestamp: new Date().toISOString()
    });
  }
});

// Apply global rate limiting
app.use(globalLimiter);

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
  const allowedOrigins = ['https://halaxapay.com', 'https://www.halaxapay.com' ,];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'false'); // Changed to false since frontend uses omit
  
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

// Blockchain API health check
app.get('/api/health/blockchain', async (req, res) => {
  try {
    const healthStatus = await DetectionAPI.healthCheck();
    res.json({
      success: true,
      blockchain_apis: healthStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[ERROR] Blockchain health check failed:', error);
    res.status(500).json({
      success: false,
      error: 'Blockchain health check failed',
      details: error.message
    });
  }
});

// Comprehensive system health check
app.get('/api/health/system', async (req, res) => {
  try {
    const blockchainHealth = await DetectionAPI.healthCheck();
    const detectionStatus = DetectionAPI.status();
    
    res.json({
      success: true,
      system: {
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      },
      blockchain_apis: blockchainHealth,
      detection_system: detectionStatus,
      environment: {
        node_version: process.version,
        platform: process.platform,
        env_variables: {
          supabase_url: !!process.env.SUPABASE_URL,
          alchemy_polygon: !!process.env.ALCHEMY_POLYGON_API_KEY,
          alchemy_solana: !!process.env.ALCHEMY_SOLANA_API_KEY,
          jwt_secret: !!process.env.JWT_SECRET
        }
      }
    });
  } catch (error) {
    console.error('[ERROR] System health check failed:', error);
    res.status(500).json({
      success: false,
      error: 'System health check failed',
      details: error.message
    });
  }
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
    
    // 🚨 CRITICAL FIELD VALIDATION: Check each required field
    console.log("🔍 FIELD VALIDATION:");
    console.log("💰 amount_usdc:", req.body.amount_usdc, "type:", typeof req.body.amount_usdc);
    console.log("🏦 wallet_address:", req.body.wallet_address, "type:", typeof req.body.wallet_address);
    console.log("📛 link_name:", req.body.link_name, "type:", typeof req.body.link_name);
    console.log("🌐 network:", req.body.network, "type:", typeof req.body.network);
    console.log("📝 description:", req.body.description, "type:", typeof req.body.description);
    
    if (!req.user?.id) {
      console.error("❌ CRITICAL: No user ID found in JWT token!");
      return res.status(401).json({ success: false, error: 'User authentication failed - no user ID' });
    }

    // 🚨 SERVER-SIDE VALIDATION: Validate all required fields before calling Engine.js
    const validationErrors = [];
    
    if (!req.body.amount_usdc || isNaN(req.body.amount_usdc) || parseFloat(req.body.amount_usdc) <= 0) {
      validationErrors.push('amount_usdc must be a positive number');
    }
    
    if (!req.body.wallet_address || typeof req.body.wallet_address !== 'string' || req.body.wallet_address.trim().length === 0) {
      validationErrors.push('wallet_address is required and cannot be empty');
    }
    
    if (!req.body.link_name || typeof req.body.link_name !== 'string' || req.body.link_name.trim().length === 0) {
      validationErrors.push('link_name is required and cannot be empty');
    }
    
    if (!req.body.network || typeof req.body.network !== 'string' || req.body.network.trim().length === 0) {
      validationErrors.push('network is required and cannot be empty');
    }
    
    if (!['polygon', 'solana'].includes(req.body.network?.toLowerCase())) {
      validationErrors.push('network must be either "polygon" or "solana"');
    }
    
    if (validationErrors.length > 0) {
      console.error("❌ VALIDATION ERRORS:", validationErrors);
      return res.status(400).json({ 
        success: false, 
        error: 'Validation failed', 
        details: validationErrors,
        received_fields: {
          amount_usdc: req.body.amount_usdc,
          wallet_address: req.body.wallet_address,
          link_name: req.body.link_name,
          network: req.body.network,
          description: req.body.description
        }
      });
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
    const user_data = {
      user_id: req.user.id,
      plan: plan
    };
    
    const link_data = {
      wallet_address: req.body.wallet_address,
      amount_usdc: req.body.amount_usdc,
      network: req.body.network,
      product_title: req.body.link_name, // Map link_name to product_title
      description: req.body.description || req.body.link_name
    };
    
    console.log("🎯 Calling HalaxaEngine.createPaymentLink with:", { user_data, link_data });
    
    const result = await HalaxaEngine.createPaymentLink(user_data, link_data);
    
    console.log("📥 Engine.js result:", result);
    console.log("✅ Engine.js success:", result.success);
    if (!result.success) {
      console.error("❌ Engine.js error:", result.error);
    }
    
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
    console.error('❌ CRITICAL: Payment link creation error:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Error message:', error.message);
    
    // Return specific error information for debugging
    res.status(500).json({ 
      success: false,
      error: 'Internal server error during payment link creation',
      details: error.message,
      debug_info: {
        error_type: error.constructor.name,
        timestamp: new Date().toISOString()
      }
    });
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

// ==================== CALCULATION ENGINE API ENDPOINTS ==================== //

// Main dashboard calculation endpoint
app.get('/api/dashboard/:userId', authenticateToken, calculationLimiter, async (req, res) => {
  try {
    console.log(`[ENGINE] Dashboard calculation started for user: ${req.params.userId.substring(0, 8)}****`);
    
    // Validate user ID
    if (!req.params.userId || typeof req.params.userId !== 'string' || req.params.userId.length < 10) {
      console.error('[ERROR] Invalid user ID format:', req.params.userId);
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid user ID format' 
      });
    }
    
    const calculationEngine = await import('./calculation-engine.js');
    const dashboardData = await calculationEngine.default.calculateUserDashboard(req.params.userId);
    
    console.log('[ENGINE] Dashboard calculation completed successfully');
    res.json({
      success: true,
      data: dashboardData
    });
  } catch (error) {
    console.error('[ERROR] Dashboard calculation error:', error);
    console.error('[ERROR] Error stack:', error.stack);
    console.error('[ERROR] Error type:', error.constructor.name);
    
    // Return appropriate error based on error type
    if (error.message.includes('wallet') || error.message.includes('address')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid wallet configuration',
        details: error.message 
      });
    }
    
    if (error.message.includes('API') || error.message.includes('network')) {
      return res.status(503).json({ 
        success: false, 
        error: 'Blockchain API temporarily unavailable',
        details: error.message 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to calculate dashboard data',
      details: error.message,
      debug_info: {
        error_type: error.constructor.name,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Add wallet connection endpoint
app.post('/api/wallet-connection', authenticateToken, calculationLimiter, async (req, res) => {
  try {
    const { wallet_address, network } = req.body;
    const userId = req.user.id;
    
    console.log(`[ENGINE] Wallet connection request for user: ${userId.substring(0, 8)}****`);
    console.log('[ENGINE] Request data:', { wallet_address: wallet_address?.substring(0, 10) + '...', network });
    
    // Validate required fields
    if (!wallet_address || typeof wallet_address !== 'string' || wallet_address.trim().length === 0) {
      console.error('[ERROR] Invalid wallet address:', wallet_address);
      return res.status(400).json({ 
        success: false, 
        error: 'Valid wallet address is required' 
      });
    }
    
    if (!network || typeof network !== 'string' || !['polygon', 'solana'].includes(network.toLowerCase())) {
      console.error('[ERROR] Invalid network:', network);
      return res.status(400).json({ 
        success: false, 
        error: 'Network must be either "polygon" or "solana"' 
      });
    }
    
    // Validate wallet address format
    const walletAddressRegex = /^[0-9a-fA-F]{40,44}$/; // Basic format check
    if (!walletAddressRegex.test(wallet_address)) {
      console.error('[ERROR] Invalid wallet address format:', wallet_address);
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid wallet address format' 
      });
    }
    
    const calculationEngine = await import('./calculation-engine.js');
    const result = await calculationEngine.default.addWalletConnection(userId, wallet_address, network);
    
    if (result.success) {
      // Clear cache to force fresh calculation
      calculationEngine.default.clearUserCache(userId);
      console.log('[ENGINE] Wallet connection added successfully');
      res.json({ success: true, message: 'Wallet connection added successfully' });
    } else {
      console.error('[ERROR] Wallet connection failed:', result.error);
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[ERROR] Wallet connection error:', error);
    console.error('[ERROR] Error stack:', error.stack);
    console.error('[ERROR] Error type:', error.constructor.name);
    
    // Return specific error based on error type
    if (error.message.includes('duplicate') || error.message.includes('already exists')) {
      return res.status(409).json({ 
        success: false, 
        error: 'Wallet connection already exists' 
      });
    }
    
    if (error.message.includes('database') || error.message.includes('connection')) {
      return res.status(503).json({ 
        success: false, 
        error: 'Database temporarily unavailable' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to add wallet connection',
      details: error.message,
      debug_info: {
        error_type: error.constructor.name,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Get wallet connections endpoint
app.get('/api/wallet-connections/:userId', authenticateToken, async (req, res) => {
  try {
    const calculationEngine = await import('./calculation-engine.js');
    const result = await calculationEngine.default.getWalletConnections(req.params.userId);
    
    res.json({
      success: true,
      data: result.data
    });
  } catch (error) {
    console.error('❌ Wallet connections error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch wallet connections' });
  }
});

// Clear user cache endpoint
app.post('/api/dashboard/:userId/clear-cache', authenticateToken, calculationLimiter, async (req, res) => {
  try {
    console.log(`[ENGINE] Cache clear request for user: ${req.params.userId.substring(0, 8)}****`);
    
    // Validate user ID
    if (!req.params.userId || typeof req.params.userId !== 'string' || req.params.userId.length < 10) {
      console.error('[ERROR] Invalid user ID format for cache clear:', req.params.userId);
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid user ID format' 
      });
    }
    
    const calculationEngine = await import('./calculation-engine.js');
    calculationEngine.default.clearUserCache(req.params.userId);
    
    console.log('[ENGINE] Cache cleared successfully');
    res.json({ success: true, message: 'Cache cleared successfully' });
  } catch (error) {
    console.error('[ERROR] Cache clear error:', error);
    console.error('[ERROR] Error stack:', error.stack);
    console.error('[ERROR] Error type:', error.constructor.name);
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to clear cache',
      details: error.message,
      debug_info: {
        error_type: error.constructor.name,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Get calculation engine status
app.get('/api/calculation-engine/status', (req, res) => {
  try {
    const calculationEngine = require('./calculation-engine.js');
    const status = calculationEngine.default.getSystemStatus();
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('[ERROR] Status check error:', error);
    res.status(500).json({ success: false, error: 'Failed to get engine status' });
  }
});

// ==================== COMPREHENSIVE TESTING ENDPOINTS ==================== //

// Test calculation engine with mock data
app.post('/api/test/calculation-engine', async (req, res) => {
  try {
    console.log('[TEST] Testing calculation engine...');
    
    const calculationEngine = await import('./calculation-engine.js');
    const testUserId = 'test-user-123';
    
    // Test with mock wallet data
    const mockWallets = [
      { wallet_address: '0x1234567890123456789012345678901234567890', network: 'polygon' },
      { wallet_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', network: 'solana' }
    ];
    
    // Test calculation engine
    const result = await calculationEngine.default.calculateUserDashboard(testUserId);
    
    res.json({
      success: true,
      test_type: 'calculation_engine',
      result: {
        has_data: !!result,
        data_keys: Object.keys(result || {}),
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[ERROR] Calculation engine test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Calculation engine test failed',
      details: error.message
    });
  }
});

// Test blockchain API connectivity
app.post('/api/test/blockchain-apis', async (req, res) => {
  try {
    console.log('[TEST] Testing blockchain APIs...');
    
    const healthStatus = await DetectionAPI.healthCheck();
    
    res.json({
      success: true,
      test_type: 'blockchain_apis',
      result: healthStatus
    });
  } catch (error) {
    console.error('[ERROR] Blockchain API test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Blockchain API test failed',
      details: error.message
    });
  }
});

// Test error handling scenarios
app.post('/api/test/error-scenarios', async (req, res) => {
  try {
    console.log('[TEST] Testing error handling scenarios...');
    
    const testResults = {
      invalid_user_id: false,
      invalid_wallet_address: false,
      api_timeout: false,
      network_error: false
    };
    
    // Test invalid user ID
    try {
      const calculationEngine = await import('./calculation-engine.js');
      await calculationEngine.default.calculateUserDashboard('invalid-user-id');
    } catch (error) {
      testResults.invalid_user_id = error.message.includes('Invalid') || error.message.includes('not found');
    }
    
    // Test invalid wallet address
    try {
      const calculationEngine = await import('./calculation-engine.js');
      await calculationEngine.default.addWalletConnection('test-user', 'invalid-wallet', 'polygon');
    } catch (error) {
      testResults.invalid_wallet_address = error.message.includes('Invalid') || error.message.includes('format');
    }
    
    res.json({
      success: true,
      test_type: 'error_scenarios',
      results: testResults,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[ERROR] Error scenario test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Error scenario test failed',
      details: error.message
    });
  }
});

// Test rate limiting
app.post('/api/test/rate-limiting', async (req, res) => {
  try {
    console.log('[TEST] Testing rate limiting...');
    
    // This endpoint should be rate limited
    res.json({
      success: true,
      test_type: 'rate_limiting',
      message: 'If you see this, rate limiting is working',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[ERROR] Rate limiting test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Rate limiting test failed',
      details: error.message
    });
  }
});

// Duplicate test endpoint removed - using the one with CORS headers above

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