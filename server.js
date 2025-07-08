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

// Password Reset Route (secure backend handling)
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    
    // Check if user exists in Supabase
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    
    if (error || !user) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }
    
    // Generate reset token and expiry
    const reset_token = crypto.randomUUID();
    const reset_token_expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    
    // Update user with reset token
    const { error: updateError } = await supabase
      .from('users')
      .update({ reset_token, reset_token_expires })
      .eq('id', user.id);
    
    if (updateError) {
      console.error('Failed to update user with reset token:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to generate reset token' });
    }
    
    // Send email via SendGrid (API key from environment)
    const sendgridApiKey = process.env.SENDGRID_API_KEY;
    if (!sendgridApiKey) {
      console.error('SENDGRID_API_KEY not found in environment variables');
      return res.status(500).json({ success: false, error: 'Email service not configured' });
    }
    
    const resetUrl = `${process.env.FRONTEND_URL || 'https://halaxapay.netlify.app'}/PasswordReset.html?token=${reset_token}`;
    const emailHtml = `<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'></head><body style='background:#fff0e3;'><table width='100%' style='background:#fff0e3;'><tr><td align='center'><table width='680' style='background:#fff;border-radius:12px;'><tr><td align='center' style='padding:40px 0 20px;'><img src='https://ad9ae8c18a.imgdist.com/pub/bfra/46888wl5/ha8/dar/44v/Halaxa%20Logo%20New.PNG' width='147' alt='Halaxa Logo'></td></tr><tr><td align='center'><h1 style='font-size:38px;font-family:Arial,sans-serif;'>Forgot Your Password?</h1></td></tr><tr><td align='center'><img src='https://static.vecteezy.com/system/resources/previews/002/697/624/non_2x/password-reset-icon-for-apps-and-web-vector.jpg' width='374' alt='Resetting Password' style='margin:20px 0;'></td></tr><tr><td align='center'><h2 style='font-size:27px;font-family:Arial,sans-serif;'>Let's get you back in</h2></td></tr><tr><td align='center' style='padding:10px 40px;'><p style='font-size:14px;font-family:Arial,sans-serif;'>Hey there, We received a request to reset your Halaxa Pay password. Click the button below to set a new one.</p></td></tr><tr><td align='center' style='padding:20px;'><a href='${resetUrl}' style='background:#2ecc71;color:#fff;padding:12px 32px;border-radius:4px;font-size:16px;text-decoration:none;display:inline-block;'>Reset Password</a></td></tr><tr><td align='center' style='padding:20px 0 0;'><em style='font-size:16px;font-family:Arial,sans-serif;'>© 2025 Halaxa Pay, All rights reserved.</em></td></tr></table></td></tr></table></body></html>`;
    
    const sgResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sendgridApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }], subject: 'Reset your Halaxa Pay password' }],
        from: { email: 'no-reply@halaxa.com', name: 'Halaxa Pay' },
        content: [{ type: 'text/html', value: emailHtml }]
      })
    });
    
    if (!sgResponse.ok) {
      console.error('SendGrid API error:', await sgResponse.text());
      return res.status(500).json({ success: false, error: 'Failed to send reset email' });
    }
    
    res.json({ success: true, message: 'Reset link sent to your email' });
    
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

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