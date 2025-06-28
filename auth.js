import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';
import { validateEmail, validatePassword, validateRequest } from './security.js';
import crypto from 'crypto';

const router = express.Router();

// ==================== SUPABASE AUTH INTEGRATION ==================== //
// Note: Using Supabase Auth for user management
// User IDs are generated automatically as UUIDs by Supabase
// No custom ID generation needed

// ==================== USER DASHBOARD INITIALIZATION ==================== //

async function initializeUserDashboardTables(userId, email, firstName, lastName) {
  console.log('🚀 Starting COMPLETE user dashboard initialization for ALL tables...');
  
  // Helper function for safe inserts
  async function safeInsert(tableName, data, description) {
    try {
      console.log(`📝 ${description}...`);
      const { data: insertData, error } = await supabase
        .from(tableName)
        .insert([data])
        .select();
      
      if (error) {
        if (error.code === '42P01') {
          console.warn(`⚠️ Table '${tableName}' doesn't exist yet - skipping`);
        } else {
          console.error(`❌ Failed to ${description.toLowerCase()}:`, error.message);
        }
        return false;
      } else {
        console.log(`✅ ${description} successful`);
        return true;
      }
    } catch (error) {
      console.error(`❌ Error during ${description.toLowerCase()}:`, error.message);
      return false;
    }
  }

  // Generate user initials
  const generateInitials = (firstName, lastName) => {
    if (!firstName) return 'U';
    if (!lastName) return firstName.charAt(0).toUpperCase();
    return (firstName.charAt(0) + lastName.charAt(0)).toUpperCase();
  };

  const initials = generateInitials(firstName, lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const currentTime = new Date().toISOString();
  const nextBilling = new Date();
  nextBilling.setDate(nextBilling.getDate() + 30);

  const initializationResults = {
    // Original tables
    user_profiles: false,
    user_plans: false,
    user_metrics: false,
    user_balances: false,
    fees_saved: false,
    usdc_balances: false,
    network_distributions: false,
    key_metrics: false,
    execution_metrics: false,
    monthly_metrics: false,
    transaction_insights: false,
    user_growth: false,
    ai_oracle_messages: false,
    // NEW TABLES from ADDITIONAL_TABLES.sql
    daily_activity: false,
    user_subscriptions: false,
    payment_link_stats: false,
    network_stats: false,
    user_achievements: false,
    transaction_status_summary: false,
    fee_savings_history: false,
    capital_flows: false,
    ai_insights: false,
    monthly_performance: false,
    user_activity_sessions: false,
    payment_link_analytics: false,
    wallet_connections: false,
    transaction_timeline: false,
    user_preferences: false
  };

  try {
    // 1. Initialize user_profiles (CRITICAL) - Match actual table structure
    initializationResults.user_profiles = await safeInsert('user_profiles', {
      user_id: userId,
      name: fullName || '',
      initials: initials
      // Note: removed email and created_at as they may not exist in actual table
    }, 'Creating user profile');

    // 2. Initialize user_plans (CRITICAL)
    initializationResults.user_plans = await safeInsert('user_plans', {
      user_id: userId,
      plan_type: 'basic',
      started_at: currentTime,
      next_billing: nextBilling.toISOString(),
      auto_renewal: true
    }, 'Creating user plan');

    // 3. Initialize user_metrics (CRITICAL) - Match actual table structure
    initializationResults.user_metrics = await safeInsert('user_metrics', {
      user_id: userId,
      days_active: 0,
      status_level: 'new',
      current_streak: 0
      // Note: removed fields that don't exist in actual table
    }, 'Creating user metrics');

    // 4. Initialize user_balances (CRITICAL) - Match actual table structure
    initializationResults.user_balances = await safeInsert('user_balances', {
      user_id: userId,
      wallet_address: '',
      is_active: true,
      usdc_polygon: 0,
      usdc_tron: 0,
      usdc_solana: 0,
      usd_equivalent: 0
      // Note: using last_active instead of last_updated to match schema
    }, 'Creating user balances');

    // 5. Initialize fees_saved - Match actual table structure
    initializationResults.fees_saved = await safeInsert('fees_saved', {
      user_id: userId,
      saved_amount: 0
      // Note: removed fields that don't exist in actual table
    }, 'Creating fees saved tracking');

    // 6. Initialize usdc_balances (Network-specific)
    console.log('💰 Creating network-specific USDC balances...');
    const networks = ['polygon', 'solana', 'tron'];
    let usdcBalanceSuccess = true;
    
    for (const network of networks) {
      const success = await safeInsert('usdc_balances', {
        user_id: userId,
        network: network,
        balance_usdc: 0,
        balance_usd: 0
        // Note: removed fields that don't exist in actual table
      }, `Creating ${network} USDC balance`);
      
      if (!success) usdcBalanceSuccess = false;
    }
    initializationResults.usdc_balances = usdcBalanceSuccess;

    // 7. Initialize network_distributions (Network-specific)
    console.log('🌐 Creating network distributions...');
    let networkDistributionSuccess = true;
    
    for (const network of networks) {
      const success = await safeInsert('network_distributions', {
        user_id: userId,
        network: network,
        volume_usdc: 0,
        percent_usage: 0
        // Note: using actual column names from your schema
      }, `Creating ${network} network distribution`);
      
      if (!success) networkDistributionSuccess = false;
    }
    initializationResults.network_distributions = networkDistributionSuccess;

    // 8. Initialize key_metrics - Match actual table structure
    initializationResults.key_metrics = await safeInsert('key_metrics', {
      user_id: userId,
      conversion_rate: 0,
      avg_processing_time: 0,
      fees_saved_total: 0,
      active_wallets: 0,
      volume_24h: 0,
      gas_optimization_score: 0
      // Note: using actual column names from your schema
    }, 'Creating key metrics');

    // 9. Initialize execution_metrics - Match actual table structure
    initializationResults.execution_metrics = await safeInsert('execution_metrics', {
      user_id: userId,
      flawless_executions: 0,
      total_executions: 0,
      avg_tx_flow: 0,
      velocity: 0
      // Note: using actual column names from your schema
    }, 'Creating execution metrics');

    // 10. Initialize monthly_metrics - Match actual table structure
    initializationResults.monthly_metrics = await safeInsert('monthly_metrics', {
      user_id: userId,
      month_start: new Date().toISOString().slice(0, 10), // YYYY-MM-DD format
      mrr_usdc: 0,
      constellation_data: {}
      // Note: using actual column names from your schema
    }, 'Creating monthly metrics');

    // 11. Initialize transaction_insights - Match actual table structure
    initializationResults.transaction_insights = await safeInsert('transaction_insights', {
      user_id: userId,
      peak_hour: null,
      cross_chain_transfers: 0,
      smart_contract_calls: 0,
      avg_api_response_time: 0,
      security_score: 0,
      user_satisfaction_score: 0
      // Note: using actual column names from your schema
    }, 'Creating transaction insights');

    // 12. Initialize user_growth - Match actual table structure
    initializationResults.user_growth = await safeInsert('user_growth', {
      user_id: userId,
      active_users: 1,
      avg_volume_per_user: 0
      // Note: using actual column names from your schema
    }, 'Creating user growth tracking');

    // 13. Initialize ai_oracle_messages - Match actual table structure
    initializationResults.ai_oracle_messages = await safeInsert('ai_oracle_messages', {
      user_id: userId,
      message_type: 'welcome',
      content: `Welcome to Halaxa Pay, ${firstName || 'User'}! Your dashboard is ready to help you manage crypto payments.`
      // Note: removed fields that don't exist in actual table
    }, 'Creating AI oracle welcome message');

    // ==================== INITIALIZE ALL NEW TABLES FROM ADDITIONAL_TABLES.sql ==================== //
    
    // 14. Initialize daily_activity
    initializationResults.daily_activity = await safeInsert('daily_activity', {
      user_id: userId,
      activity_date: new Date().toISOString().split('T')[0], // Today's date
      transaction_count: 0,
      total_volume_usdc: 0,
      total_volume_usd: 0
    }, 'Creating daily activity tracking');

    // 15. Initialize user_subscriptions
    initializationResults.user_subscriptions = await safeInsert('user_subscriptions', {
      user_id: userId,
      plan_tier: 'basic',
      plan_status: 'active',
      started_at: currentTime,
      next_billing_date: nextBilling.toISOString(),
      auto_renewal: true,
      monthly_fee: 0
    }, 'Creating user subscription');

    // 16. Initialize network_stats for each network
    console.log('🌐 Creating network stats for all networks...');
    let networkStatsSuccess = true;
    
    for (const network of networks) {
      const success = await safeInsert('network_stats', {
        user_id: userId,
        network: network,
        total_volume_usdc: 0,
        total_volume_usd: 0,
        transaction_count: 0,
        percentage_of_total: 0,
        avg_gas_fee: 0,
        recorded_date: new Date().toISOString().split('T')[0]
      }, `Creating ${network} network stats`);
      
      if (!success) networkStatsSuccess = false;
    }
    initializationResults.network_stats = networkStatsSuccess;

    // 17. Initialize user_achievements
    initializationResults.user_achievements = await safeInsert('user_achievements', {
      user_id: userId,
      achievement_type: 'days_active',
      achievement_value: 1, // First day
      achievement_date: new Date().toISOString().split('T')[0],
      status_level: 'bronze'
    }, 'Creating user achievements');

    // 18. Initialize transaction_status_summary for each status
    console.log('📊 Creating transaction status summary...');
    const statuses = ['completed', 'pending', 'failed'];
    let statusSummarySuccess = true;
    
    for (const status of statuses) {
      const success = await safeInsert('transaction_status_summary', {
        user_id: userId,
        status: status,
        count: 0,
        percentage: 0,
        total_amount_usdc: 0,
        recorded_date: new Date().toISOString().split('T')[0]
      }, `Creating ${status} status summary`);
      
      if (!success) statusSummarySuccess = false;
    }
    initializationResults.transaction_status_summary = statusSummarySuccess;

    // 19. Initialize capital_flows
    console.log('💰 Creating capital flows tracking...');
    const flowTypes = ['inflow', 'outflow'];
    let capitalFlowsSuccess = true;
    
    for (const flowType of flowTypes) {
      for (const network of networks) {
        const success = await safeInsert('capital_flows', {
          user_id: userId,
          flow_type: flowType,
          amount_usdc: 0,
          amount_usd: 0,
          network: network,
          flow_date: new Date().toISOString().split('T')[0]
        }, `Creating ${flowType} for ${network}`);
        
        if (!success) capitalFlowsSuccess = false;
      }
    }
    initializationResults.capital_flows = capitalFlowsSuccess;

    // 20. Initialize ai_insights
    initializationResults.ai_insights = await safeInsert('ai_insights', {
      user_id: userId,
      insight_type: 'info',
      title: 'Welcome!',
      message: `Welcome to Halaxa Pay, ${firstName || 'User'}! Start by creating your first payment link.`,
      icon_class: 'fas fa-rocket',
      priority: 1,
      is_active: true
    }, 'Creating AI insights');

    // 21. Initialize monthly_performance
    const currentMonthYear = new Date().toISOString().slice(0, 7); // YYYY-MM
    const currentMonthName = new Date().toLocaleString('en-US', { month: 'long' });
    
    initializationResults.monthly_performance = await safeInsert('monthly_performance', {
      user_id: userId,
      month_year: currentMonthYear,
      month_name: currentMonthName,
      total_volume_usdc: 0,
      total_volume_usd: 0,
      transaction_count: 0,
      growth_percentage: 0,
      performance_score: 0
    }, 'Creating monthly performance');

    // 22. Initialize user_activity_sessions
    initializationResults.user_activity_sessions = await safeInsert('user_activity_sessions', {
      user_id: userId,
      session_start: currentTime,
      pages_visited: 1,
      actions_performed: 1, // Registration counts as first action
      last_activity: currentTime
    }, 'Creating user activity session');

    // 23. Initialize user_preferences
    initializationResults.user_preferences = await safeInsert('user_preferences', {
      user_id: userId,
      default_network: 'polygon',
      notification_email: true,
      notification_browser: true,
      dashboard_theme: 'dark',
      preferred_currency: 'USD',
      auto_refresh_interval: 30
    }, 'Creating user preferences');

    // Log final results
    const successCount = Object.values(initializationResults).filter(Boolean).length;
    const totalTables = Object.keys(initializationResults).length;
    
    console.log(`🎉 Backend dashboard initialization complete: ${successCount}/${totalTables} tables initialized`);
    
    // Check core tables
    const coreResults = {
      user_profiles: initializationResults.user_profiles,
      user_plans: initializationResults.user_plans,
      user_metrics: initializationResults.user_metrics,
      user_balances: initializationResults.user_balances
    };
    const coreSuccessCount = Object.values(coreResults).filter(Boolean).length;
    
    if (coreSuccessCount >= 4) {
      console.log('✅ All core dashboard tables initialized successfully');
    } else {
      console.warn('⚠️ Some core tables failed to initialize - dashboard may have empty states');
      console.warn('🔧 Core table results:', coreResults);
    }
    
    const optionalSuccess = successCount - coreSuccessCount;
    const optionalTables = totalTables - 4;
    console.log(`📊 Optional tables: ${optionalSuccess}/${optionalTables} initialized`);
    
    if (successCount >= 10) {
      console.log('🌟 Excellent initialization! User dashboard fully prepared');
    }

  } catch (error) {
    console.error('❌ Error during backend dashboard initialization:', error);
  }
}

// Register endpoint
router.post('/register', validateEmail, validatePassword, validateRequest, async (req, res) => {
  try {
    console.log('📥 Registration request received:', { 
      email: req.body.email, 
      hasPassword: !!req.body.password,
      first_name: req.body.first_name,
      last_name: req.body.last_name 
    });

    const { email, password, first_name, last_name } = req.body;

    // Validate required fields
    if (!email || !password) {
      console.error('❌ Missing required fields:', { email: !!email, password: !!password });
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Use the first_name and last_name directly from the frontend
    // Create fullName for user metadata
    const fullName = [first_name, last_name].filter(Boolean).join(' ');
    console.log('✅ Processing registration for:', email, 'with full name:', fullName);

    // 🔐 USE SUPABASE AUTH for user creation (not custom users table)
    console.log('🔐 Attempting to create Supabase Auth user...');
    console.log('📧 Email:', email);
    console.log('🔑 Service role key present:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
    console.log('🌐 Supabase URL present:', !!process.env.SUPABASE_URL);
    
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: {
        first_name,
        last_name,
        full_name: fullName || `${first_name} ${last_name}`.trim()
      },
      email_confirm: true // Auto-confirm email
    });

    if (authError) {
      console.error('❌ Supabase Auth creation error:', {
        message: authError.message,
        status: authError.status,
        code: authError.code,
        details: authError
      });
      
      if (authError.message.includes('already registered') || authError.message.includes('already exists')) {
        return res.status(400).json({ error: 'User already exists' });
      }
      
      if (authError.message.includes('Invalid API key') || authError.message.includes('unauthorized')) {
        console.error('🔑 Service role key issue - check environment variables');
        return res.status(500).json({ 
          error: 'Authentication service configuration error',
          details: 'Service role key issue'
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to create user',
        details: authError.message,
        code: authError.code
      });
    }

    const newUser = authData.user;
    console.log(`🔐 Created Supabase Auth user: ${newUser.id.substring(0, 8)}****`);

    // 🗃️ ALSO INSERT INTO CUSTOM USERS TABLE (for compatibility with existing queries)
    console.log('📝 Creating custom users table entry...');
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const { data: customUser, error: customUserError } = await supabase
        .from('users')
        .insert([{
          id: newUser.id, // Use same UUID as Supabase Auth
          email: email,
          password: hashedPassword,
          first_name: first_name,
          last_name: last_name,
          full_name: fullName,
          plan: 'basic',
          is_email_verified: true // Auto-verified since using Supabase Auth
        }])
        .select()
        .single();

      if (customUserError) {
        console.warn('⚠️ Could not create custom users table entry:', customUserError.message);
      } else {
        console.log('✅ Custom users table entry created successfully');
      }
    } catch (customUserErr) {
      console.warn('⚠️ Custom users table creation failed:', customUserErr.message);
    }

    // 🚀 INITIALIZE USER DASHBOARD TABLES
    console.log(`🎯 Initializing dashboard tables for Supabase Auth user: ${newUser.id}`);
    await initializeUserDashboardTables(newUser.id, email, first_name, last_name);

    // 🔍 START DETECTION FOR NEW USER
    console.log(`🔍 Starting detection system for new user: ${newUser.id.substring(0, 8)}****`);
    try {
      const { DetectionAPI } = await import('./Detection.js');
      await DetectionAPI.runForUser(newUser.id);
      console.log(`✅ Initial detection completed for new user`);
    } catch (detectionError) {
      console.warn('⚠️ Detection system not available during registration:', detectionError.message);
    }

    // Generate tokens
    console.log('🎫 Generating JWT tokens...');
    console.log('🔑 JWT_SECRET present:', !!process.env.JWT_SECRET);
    console.log('🔄 JWT_REFRESH_SECRET present:', !!process.env.JWT_REFRESH_SECRET);
    
    const accessToken = jwt.sign(
      { id: newUser.id, email: newUser.email },
      process.env.JWT_SECRET || 'your-temporary-secret-key', // Fallback for development
      { expiresIn: '1h' }
    );

    const refreshToken = jwt.sign(
      { id: newUser.id },
      process.env.JWT_REFRESH_SECRET || 'your-temporary-refresh-key', // Fallback for development
      { expiresIn: '7d' }
    );

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: newUser.id,
        email: newUser.email,
        first_name: newUser.user_metadata?.first_name,
        last_name: newUser.user_metadata?.last_name,
        plan: 'basic' // Default plan for new users
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'An error occurred during registration',
      details: error.message
    });
  }
});

// Login endpoint
router.post('/login', validateEmail, validateRequest, async (req, res) => {
  try {
    const { email, password } = req.body;

    // 🔐 USE SUPABASE AUTH for login (not custom users table)
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (authError || !authData.user) {
      console.error('Supabase Auth login error:', authError);
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const user = authData.user;
    console.log(`🔐 Supabase Auth login success: ${user.id.substring(0, 8)}****`);

    // 🔍 START DETECTION FOR RETURNING USER
    console.log(`🔍 Starting detection system for returning user: ${user.id.substring(0, 8)}****`);
    try {
      const { DetectionAPI } = await import('./Detection.js');
      // Run detection in background (don't wait for completion)
      DetectionAPI.runForUser(user.id).then(() => {
        console.log(`✅ Detection completed for returning user: ${user.id.substring(0, 8)}****`);
      }).catch(error => {
        console.warn(`⚠️ Detection failed for user ${user.id.substring(0, 8)}****:`, error.message);
      });
    } catch (detectionError) {
      console.warn('⚠️ Detection system not available during login:', detectionError.message);
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const refreshToken = jwt.sign(
      { id: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    // ⚠️ NOTE: No need to update last_login - Supabase Auth handles this automatically
    console.log(`🔐 Supabase Auth manages user sessions automatically`);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.user_metadata?.first_name,
        last_name: user.user_metadata?.last_name,
        plan: 'basic' // Get from dashboard tables if needed
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify email
router.get('/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Find user with this verification token
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('verification_token', token)
      .single();

    if (userError || !user) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    // Update user's email verification status
    const { error: updateError } = await supabase
      .from('users')
      .update({
        is_email_verified: true,
        verification_token: null
      })
      .eq('id', user.id);

    // ⚠️ DEV WARNING: Using 'id' for users table is correct (primary key)

    if (updateError) throw updateError;

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Email verification failed' });
  }
});

// Request password reset
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    // Find user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate password reset token
    const resetToken = await generatePasswordResetToken(user.id);
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    // TODO: Send password reset email
    // For now, just log the URL to the console
    console.log('Password Reset URL:', resetUrl);

    res.json({ message: 'Password reset email sent (check console for URL)' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Forgot password failed' });
  }
});

// Reset password
router.post('/reset-password', validatePassword, validateRequest, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    // Find token
    const { data: resetToken, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('token', token)
      .gte('expires_at', new Date().toISOString())
      .single();

    if (tokenError || !resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update user's password
    const { error: updateError } = await supabase
      .from('users')
      .update({ password: hashedPassword })
      .eq('id', resetToken.user_id);

    if (updateError) throw updateError;

    // Invalidate token
    const { error: invalidateError } = await supabase
      .from('password_reset_tokens')
      .update({ expires_at: new Date().toISOString() })
      .eq('id', resetToken.id);

    if (invalidateError) throw invalidateError;

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// Refresh token
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // Get user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .eq('refresh_token', refreshToken)
      .single();

    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Generate new access token
    const accessToken = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ accessToken });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// 🔐 Session validation endpoint using Supabase Auth
router.get('/session', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // 🔐 USE SUPABASE AUTH to validate session
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error('Supabase Auth session validation error:', error);
      return res.status(401).json({ error: 'Invalid session' });
    }

    // Log secure session validation
    console.log(`🔐 Supabase Auth session validated: ${user.id.substring(0, 8)}****`);

    res.json({
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.user_metadata?.first_name,
        last_name: user.user_metadata?.last_name,
        plan: 'basic', // Get from dashboard tables if needed
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error('Session validation error:', error);
    return res.status(401).json({ 
      valid: false, 
      error: 'Invalid or expired session' 
    });
  }
});

export default router; 