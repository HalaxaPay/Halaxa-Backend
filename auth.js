import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';
import { validateEmail, validatePassword, validateRequest, generatePasswordResetToken } from './security.js';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
dotenv.config();

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
    user_preferences: false,
    // MISSING TABLES THAT NEEDED USER ID INJECTION
    transactions: false,
    payment_links: false,
    billing_history: false
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

    // ==================== MISSING TABLES THAT NEED USER ID INJECTION ==================== //
    
    // 24. Initialize transactions (empty initial record)
    initializationResults.transactions = await safeInsert('transactions', {
      user_id: userId,
      network: 'polygon',
      amount_usdc: 0,
      gas_fee: 0,
      status: 'initialized',
      custom_tag: 'Initial Setup',
      direction: 'in',
      fee_savings: 0,
      usd_equivalent: 0
    }, 'Creating initial transaction record');

    // 25. Initialize transaction_timeline (for initial transaction)
    initializationResults.transaction_timeline = await safeInsert('transaction_timeline', {
      transaction_id: null, // Will be updated when actual transactions occur
      status: 'initialized',
      timestamp: currentTime,
      block_number: 0,
      confirmations: 0,
      gas_used: 0,
      notes: 'Account setup - no transactions yet'
    }, 'Creating transaction timeline');

    // 26. Initialize payment_links (template payment link)
    initializationResults.payment_links = await safeInsert('payment_links', {
      link_id: `demo_${userId.substring(0, 8)}`,
      user_id: userId, // ✅ Keep full UUID for database compatibility
      wallet_address: '',
      amount_usdc: 0,
      network: 'polygon',
      product_title: 'Demo Payment Link',
      description: 'Template payment link created during setup',
      link_name: 'Demo Link',
      is_active: false,
      status: 'template'
    }, 'Creating template payment link');

    // 27. Initialize payment_link_stats (for the template link)
    initializationResults.payment_link_stats = await safeInsert('payment_link_stats', {
      payment_link_id: null, // Will be updated with actual payment link ID
      user_id: userId,
      total_payments: 0,
      total_volume_usdc: 0,
      total_volume_usd: 0,
      conversion_rate: 0,
      last_payment_at: null
    }, 'Creating payment link stats');

    // 28. Initialize payment_link_analytics (tracking setup)
    initializationResults.payment_link_analytics = await safeInsert('payment_link_analytics', {
      payment_link_id: null, // Will be updated with actual payment link ID
      user_id: userId,
      event_type: 'setup',
      visitor_ip: null,
      user_agent: 'Setup Process',
      referrer: 'Direct Signup',
      country: null,
      amount_usdc: 0
    }, 'Creating payment link analytics');

    // 29. Initialize billing_history (first billing record)
    initializationResults.billing_history = await safeInsert('billing_history', {
      user_id: userId,
      date: currentTime,
      plan_type: 'basic',
      amount_usd: 0,
      status: 'active',
      invoice_url: null
    }, 'Creating initial billing history');

    // 30. Initialize fee_savings_history (tracking setup)
    initializationResults.fee_savings_history = await safeInsert('fee_savings_history', {
      user_id: userId,
      transaction_id: null,
      network: 'polygon',
      amount_usdc: 0,
      halaxa_fee: 0,
      traditional_fee: 0,
      savings_amount: 0,
      savings_percentage: 0,
      recorded_date: new Date().toISOString().split('T')[0]
    }, 'Creating fee savings history');

    // 31. Initialize wallet_connections (placeholder for future wallets)
    console.log('💼 Creating wallet connections for all networks...');
    let walletConnectionsSuccess = true;
    
    for (const network of networks) {
      const success = await safeInsert('wallet_connections', {
        user_id: userId,
        wallet_address: '',
        network: network,
        connection_type: 'manual',
        is_primary: false,
        is_active: false,
        first_connected_at: currentTime,
        last_used_at: currentTime
      }, `Creating ${network} wallet connection placeholder`);
      
      if (!success) walletConnectionsSuccess = false;
    }
    initializationResults.wallet_connections = walletConnectionsSuccess;

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

    // ✅ AUTOMATIC INSERT INTO USERS TABLE AFTER SUCCESSFUL SIGNUP
    console.log('📝 Inserting user data into users table...');
    let usersTableInserted = false;
    
    try {
      // Check if user already exists in users table to prevent duplicates
      console.log('🔍 Checking if user already exists in users table...');
      const { data: existingUser, error: checkError } = await supabase
        .from('users')
        .select('id, email')
        .eq('id', newUser.id)
        .single();
      
      if (existingUser) {
        console.log('✅ User already exists in users table - skipping insert');
        usersTableInserted = true;
      } else if (checkError && checkError.code === 'PGRST116') {
        // PGRST116 = no rows returned, which means user doesn't exist - proceed with insert
        console.log('📝 User does not exist in users table - proceeding with insert...');
        
        // Prepare user data for insert - start with basic required fields only
        const userData = {
          id: newUser.id,
          email: email
        };
        
        // Add optional fields if they exist
        if (first_name) userData.first_name = first_name;
        if (last_name) userData.last_name = last_name;
        if (fullName) userData.full_name = fullName;
        
        console.log('📋 Attempting insert with user data:', {
          id: userData.id.substring(0, 8) + '****',
          email: userData.email,
          first_name: userData.first_name || '[NOT SET]',
          last_name: userData.last_name || '[NOT SET]',
          full_name: userData.full_name || '[NOT SET]'
        });
        
        // Attempt the insert
        const { data: insertedData, error: insertError } = await supabase
          .from('users')
          .insert([userData])
          .select()
          .single();
        
        if (insertError) {
          console.error('❌ Failed to insert user into users table:', {
            message: insertError.message,
            code: insertError.code,
            details: insertError.details
          });
          console.log('⚠️ User signup successful but users table insert failed - continuing...');
        } else if (insertedData) {
          console.log('✅ User successfully inserted into users table:', {
            id: insertedData.id?.substring(0, 8) + '****',
            email: insertedData.email
          });
          usersTableInserted = true;
        }
      } else {
        // Other error occurred while checking for existing user
        console.error('❌ Error checking existing user in users table:', {
          message: checkError.message,
          code: checkError.code
        });
        console.log('⚠️ Cannot verify if user exists in users table - skipping insert to avoid duplicates');
      }
    } catch (insertException) {
      console.error('❌ Exception during users table operations:', {
        message: insertException.message,
        name: insertException.name
      });
      console.log('⚠️ User signup successful but users table operations failed - continuing...');
    }
    
    // Log the final status
    if (usersTableInserted) {
      console.log('✅ User successfully created in both Supabase Auth AND users table');
    } else {
      console.warn('⚠️ User created in Supabase Auth but NOT in users table - some features may not work');
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

// POST /forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email is required.' });
    }

    // Look up user by email
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'No user found with that email.' });
    }

    // Generate secure token and expiry
    const reset_token = crypto.randomUUID();
    const reset_token_expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    // Update user with reset token and expiry
    const { error: updateError } = await supabase
      .from('users')
      .update({ reset_token, reset_token_expires })
      .eq('id', user.id);

    if (updateError) {
      console.error('Failed to update user with reset token:', updateError);
      return res.status(500).json({ error: 'Failed to set reset token.' });
    }

    // Set up nodemailer with SendGrid
    // Build reset link
    const resetUrl = `https://halaxapay.com/Changepassword.html?token=${reset_token}`;

    await sgMail.send({
      to: email,
      from: {
        email: 'Help@halaxapay.com',
        name: 'HalaxaPay'
      },
      templateId: 'd-730aba5502074796ba366fa966eccc43',
      dynamic_template_data: {
        reset_link: resetUrl,
        subject: 'Reset your Halaxa Pay password'
      }
    });  


    res.json({ message: 'Reset link sent to your email.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error.' });
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

// Google OAuth initiation endpoint
router.get('/google', async (req, res) => {
  try {
    console.log('🔄 Initiating Google OAuth...');
    
    // Use Supabase to generate Google OAuth URL
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${process.env.FRONTEND_URL || 'https://halaxapay.com'}/SPA.html?oauth=google`,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent'
        }
      }
    });
    
    if (error) {
      console.error('❌ Google OAuth URL generation failed:', error);
      return res.status(500).json({ error: 'Failed to generate OAuth URL', details: error.message });
    }
    
    console.log('✅ Google OAuth URL generated, redirecting...');
    
    // Redirect user to Google OAuth
    if (data.url) {
      return res.redirect(data.url);
    } else {
      return res.status(500).json({ error: 'No OAuth URL returned from Supabase' });
    }
    
  } catch (error) {
    console.error('❌ Google OAuth initiation error:', error);
    return res.status(500).json({ error: 'OAuth initiation failed', details: error.message });
  }
});

// Google OAuth sync endpoint
router.post('/oauth-sync', async (req, res) => {
  try {
    const { supabaseToken } = req.body;
    if (!supabaseToken) {
      return res.status(400).json({ error: 'Missing Supabase Auth token' });
    }

    // Get user info from Supabase Auth using the token
    const { data: { user }, error: userError } = await supabase.auth.getUser(supabaseToken);
    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid Supabase Auth token', details: userError?.message });
    }

    // Extract user info
    const userId = user.id;
    const email = user.email;
    const first_name = user.user_metadata?.first_name || '';
    const last_name = user.user_metadata?.last_name || '';
    const fullName = user.user_metadata?.full_name || [first_name, last_name].filter(Boolean).join(' ');

    // Check if user exists in custom users table using simplified logic
    console.log('🔍 Checking if Google user exists in users table...');
    let usersTableInserted = false;
    
    try {
      const { data: existingUser, error: checkError } = await supabase
        .from('users')
        .select('id, email')
        .eq('id', userId)
        .single();
      
      if (existingUser) {
        console.log('✅ Google user already exists in users table');
        usersTableInserted = true;
      } else if (checkError && checkError.code === 'PGRST116') {
        // User doesn't exist - create them
        console.log('📝 Google user does not exist in users table - creating...');
        
        const userData = {
          id: userId,
          email: email
        };
        
        // Add optional fields if they exist
        if (first_name) userData.first_name = first_name;
        if (last_name) userData.last_name = last_name;
        if (fullName) userData.full_name = fullName;
        
        const { data: insertedData, error: insertError } = await supabase
          .from('users')
          .insert([userData])
          .select()
          .single();
        
        if (insertError) {
          console.error('❌ Failed to insert Google user:', insertError.message);
          // Don't fail the entire OAuth process - continue
        } else if (insertedData) {
          console.log('✅ Google user successfully inserted into users table');
          usersTableInserted = true;
        }
      } else {
        console.error('❌ Error checking Google user in users table:', checkError.message);
        // Don't fail the OAuth process - continue
      }
    } catch (exception) {
      console.error('❌ Exception during Google user table operations:', exception.message);
      // Don't fail the OAuth process - continue
    }

    // Initialize dashboard tables (idempotent)
    await initializeUserDashboardTables(userId, email, first_name, last_name);

    // Generate backend JWT tokens
    const accessToken = jwt.sign(
      { id: userId, email: email },
      process.env.JWT_SECRET || 'your-temporary-secret-key',
      { expiresIn: '1h' }
    );
    const refreshToken = jwt.sign(
      { id: userId },
      process.env.JWT_REFRESH_SECRET || 'your-temporary-refresh-key',
      { expiresIn: '7d' }
    );

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: userId,
        email: email,
        first_name,
        last_name,
        plan: 'basic'
      }
    });
  } catch (error) {
    console.error('OAuth sync error:', error);
    res.status(500).json({ error: 'OAuth sync failed', details: error.message });
  }
});

// ==================== DEBUG/ADMIN UTILITIES ==================== //

// Validate user session endpoint
router.get('/validate-session', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ 
        valid: false, 
        error: 'No token provided',
        authenticated: false
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user exists in users table
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, plan')
      .eq('id', decoded.id)
      .single();

    if (error || !user) {
      return res.status(401).json({ 
        valid: false, 
        error: 'User not found in database',
        authenticated: false
      });
    }

    res.json({
      valid: true,
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        plan: user.plan || 'basic'
      }
    });
  } catch (error) {
    console.error('Session validation error:', error);
    res.status(401).json({ 
      valid: false, 
      error: 'Invalid or expired token',
      authenticated: false
    });
  }
});

// Recovery endpoint for users with authentication issues
router.post('/recover-user', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    console.log('🔄 Attempting user recovery for:', email);
    
    // Check Supabase Auth for this user
    const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();
    
    if (authError) {
      return res.status(500).json({ error: 'Failed to fetch auth users', details: authError.message });
    }
    
    const authUser = authUsers.users.find(user => user.email === email);
    
    if (!authUser) {
      return res.status(404).json({ error: 'User not found in authentication system' });
    }
    
    // Check if user exists in custom users table
    const { data: customUser, error: customError } = await supabase
      .from('users')
      .select('id, email')
      .eq('id', authUser.id)
      .single();
    
    if (customUser) {
      return res.json({ 
        message: 'User already exists in users table',
        user: { id: customUser.id, email: customUser.email },
        recovery_needed: false
      });
    }
    
    // User missing from custom table - recover them
    console.log('🔧 Recovering user:', email);
    
    const userData = {
      id: authUser.id,
      email: authUser.email
    };
    
    // Add optional fields if available
    if (authUser.user_metadata?.first_name) userData.first_name = authUser.user_metadata.first_name;
    if (authUser.user_metadata?.last_name) userData.last_name = authUser.user_metadata.last_name;
    if (authUser.user_metadata?.full_name) userData.full_name = authUser.user_metadata.full_name;
    
    const { data: recoveredUser, error: insertError } = await supabase
      .from('users')
      .insert([userData])
      .select()
      .single();
    
    if (insertError) {
      console.error('❌ Failed to recover user:', insertError.message);
      return res.status(500).json({ error: 'Failed to recover user', details: insertError.message });
    }
    
    // Initialize dashboard tables for recovered user
    await initializeUserDashboardTables(
      authUser.id, 
      authUser.email, 
      authUser.user_metadata?.first_name || '',
      authUser.user_metadata?.last_name || ''
    );
    
    console.log('✅ User recovered successfully:', email);
    
    res.json({
      message: 'User recovered successfully',
      user: recoveredUser,
      recovery_needed: true
    });
    
  } catch (error) {
    console.error('❌ User recovery error:', error);
    res.status(500).json({ error: 'Recovery failed', details: error.message });
  }
});

// Get all users from custom users table
router.get('/admin/users', async (req, res) => {
  try {
    console.log('🔍 Fetching all users from custom users table...');
    
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, plan, created_at, is_email_verified')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('❌ Error fetching users:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch users', 
        details: error.message 
      });
    }
    
    console.log(`✅ Found ${users.length} users in custom users table`);
    
    res.json({
      count: users.length,
      users: users.map(user => ({
        ...user,
        id: user.id.substring(0, 8) + '****' // Mask ID for security
      }))
    });
  } catch (error) {
    console.error('❌ Exception fetching users:', error);
    res.status(500).json({ 
      error: 'Server error fetching users', 
      details: error.message 
    });
  }
});

// Sync users from Supabase Auth to custom users table
router.post('/admin/sync-users', async (req, res) => {
  try {
    console.log('🔄 Starting user sync from Supabase Auth to custom users table...');
    
    // Get all Supabase Auth users
    const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();
    
    if (authError) {
      console.error('❌ Error fetching Supabase Auth users:', authError);
      return res.status(500).json({ 
        error: 'Failed to fetch Supabase Auth users', 
        details: authError.message 
      });
    }
    
    console.log(`📊 Found ${authUsers.users.length} users in Supabase Auth`);
    
    // Get all custom table users
    const { data: customUsers, error: customError } = await supabase
      .from('users')
      .select('id');
    
    if (customError) {
      console.error('❌ Error fetching custom users:', customError);
      return res.status(500).json({ 
        error: 'Failed to fetch custom users', 
        details: customError.message 
      });
    }
    
    const customUserIds = new Set(customUsers.map(u => u.id));
    console.log(`📊 Found ${customUsers.length} users in custom users table`);
    
    // Find missing users
    const missingUsers = authUsers.users.filter(authUser => !customUserIds.has(authUser.id));
    console.log(`🔍 Found ${missingUsers.length} users missing from custom table`);
    
    let syncedCount = 0;
    let failedCount = 0;
    const results = [];
    
    for (const authUser of missingUsers) {
      try {
        const { data: syncedUser, error: syncError } = await supabase
          .from('users')
          .insert([{
            id: authUser.id,
            email: authUser.email,
            password: '', // Unknown password - will need manual reset
            first_name: authUser.user_metadata?.first_name || '',
            last_name: authUser.user_metadata?.last_name || '',
            full_name: authUser.user_metadata?.full_name || '',
            plan: 'basic',
            is_email_verified: authUser.email_confirmed_at ? true : false
          }])
          .select()
          .single();
        
        if (syncError) {
          console.error(`❌ Failed to sync user ${authUser.id}:`, syncError.message);
          failedCount++;
          results.push({
            id: authUser.id.substring(0, 8) + '****',
            email: authUser.email,
            status: 'failed',
            error: syncError.message
          });
        } else {
          console.log(`✅ Synced user ${authUser.id.substring(0, 8)}****`);
          syncedCount++;
          results.push({
            id: authUser.id.substring(0, 8) + '****',
            email: authUser.email,
            status: 'synced'
          });
        }
      } catch (error) {
        console.error(`❌ Exception syncing user ${authUser.id}:`, error.message);
        failedCount++;
        results.push({
          id: authUser.id.substring(0, 8) + '****',
          email: authUser.email,
          status: 'failed',
          error: error.message
        });
      }
    }
    
    console.log(`🎉 Sync complete: ${syncedCount} synced, ${failedCount} failed`);
    
    res.json({
      message: 'User sync completed',
      authUsers: authUsers.users.length,
      customUsers: customUsers.length,
      missingUsers: missingUsers.length,
      syncedCount,
      failedCount,
      results
    });
  } catch (error) {
    console.error('❌ Exception during user sync:', error);
    res.status(500).json({ 
      error: 'Server error during sync', 
      details: error.message 
    });
  }
});

// Delete user from both Supabase Auth and custom table
router.delete('/admin/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`🗑️ Deleting user ${userId.substring(0, 8)}**** from both tables...`);
    
    // Delete from custom users table first
    const { error: customDeleteError } = await supabase
      .from('users')
      .delete()
      .eq('id', userId);
    
    if (customDeleteError) {
      console.error('❌ Error deleting from custom users table:', customDeleteError);
    } else {
      console.log('✅ Deleted from custom users table');
    }
    
    // Delete from Supabase Auth
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);
    
    if (authDeleteError) {
      console.error('❌ Error deleting from Supabase Auth:', authDeleteError);
    } else {
      console.log('✅ Deleted from Supabase Auth');
    }
    
    if (customDeleteError || authDeleteError) {
      return res.status(500).json({
        error: 'Partial deletion failure',
        customTableError: customDeleteError?.message,
        authError: authDeleteError?.message
      });
    }
    
    console.log('✅ User completely deleted from both systems');
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('❌ Exception deleting user:', error);
    res.status(500).json({ 
      error: 'Server error deleting user', 
      details: error.message 
    });
  }
});

// DEBUG: Test route to confirm router is loaded
router.get('/test', (req, res) => res.json({ ok: true, message: 'Auth router is active!' }));

// DEBUG: Route existence check
router.get('/route-exists-check', (req, res) => res.json({ ok: true, message: 'Router is loaded and up to date.' }));

export default router;