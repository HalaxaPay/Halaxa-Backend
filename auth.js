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
  console.log('🚀 Starting backend user dashboard initialization...');
  
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
    ai_oracle_messages: false
  };

  try {
    // 1. Initialize user_profiles (CRITICAL)
    initializationResults.user_profiles = await safeInsert('user_profiles', {
      user_id: userId,
      name: fullName || '',
      initials: initials,
      email: email,
      created_at: currentTime
    }, 'Creating user profile');

    // 2. Initialize user_plans (CRITICAL)
    initializationResults.user_plans = await safeInsert('user_plans', {
      user_id: userId,
      plan_type: 'basic',
      started_at: currentTime,
      next_billing: nextBilling.toISOString(),
      auto_renewal: true
    }, 'Creating user plan');

    // 3. Initialize user_metrics (CRITICAL)
    initializationResults.user_metrics = await safeInsert('user_metrics', {
      user_id: userId,
      days_active: 0,
      status_level: 'new',
      current_streak: 0,
      longest_streak: 0,
      total_transactions: 0,
      last_transaction: null,
      last_updated: currentTime
    }, 'Creating user metrics');

    // 4. Initialize user_balances (CRITICAL)
    initializationResults.user_balances = await safeInsert('user_balances', {
      user_id: userId,
      wallet_address: '',
      usdc_polygon: 0,
      usdc_tron: 0,
      usdc_solana: 0,
      usd_equivalent: 0,
      last_updated: currentTime
    }, 'Creating user balances');

    // 5. Initialize fees_saved
    initializationResults.fees_saved = await safeInsert('fees_saved', {
      user_id: userId,
      saved_amount: 0,
      total_transactions: 0,
      average_savings_per_tx: 0,
      last_updated: currentTime
    }, 'Creating fees saved tracking');

    // 6. Initialize usdc_balances (Network-specific)
    console.log('💰 Creating network-specific USDC balances...');
    const networks = ['polygon', 'solana', 'tron'];
    let usdcBalanceSuccess = true;
    
    for (const network of networks) {
      const success = await safeInsert('usdc_balances', {
        user_id: userId,
        network: network,
        balance: 0,
        wallet_address: '',
        last_sync: currentTime,
        is_active: false
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
        percentage: 0,
        amount_usdc: 0,
        transaction_count: 0,
        last_updated: currentTime
      }, `Creating ${network} network distribution`);
      
      if (!success) networkDistributionSuccess = false;
    }
    initializationResults.network_distributions = networkDistributionSuccess;

    // 8. Initialize key_metrics
    initializationResults.key_metrics = await safeInsert('key_metrics', {
      user_id: userId,
      total_volume: 0,
      total_transactions: 0,
      successful_payments: 0,
      failed_payments: 0,
      pending_payments: 0,
      conversion_rate: 0,
      last_updated: currentTime
    }, 'Creating key metrics');

    // 9. Initialize execution_metrics
    initializationResults.execution_metrics = await safeInsert('execution_metrics', {
      user_id: userId,
      average_processing_time: 0,
      fastest_transaction: 0,
      slowest_transaction: 0,
      total_processing_time: 0,
      success_rate: 100,
      error_rate: 0,
      last_updated: currentTime
    }, 'Creating execution metrics');

    // 10. Initialize monthly_metrics
    initializationResults.monthly_metrics = await safeInsert('monthly_metrics', {
      user_id: userId,
      month: currentTime.slice(0, 7), // YYYY-MM format
      total_volume: 0,
      transaction_count: 0,
      unique_payers: 0,
      average_transaction: 0,
      growth_rate: 0,
      created_at: currentTime
    }, 'Creating monthly metrics');

    // 11. Initialize transaction_insights
    initializationResults.transaction_insights = await safeInsert('transaction_insights', {
      user_id: userId,
      total_volume: 0,
      average_transaction_size: 0,
      peak_hour: null,
      most_active_day: null,
      transaction_frequency: 0,
      largest_transaction: 0,
      smallest_transaction: 0,
      last_updated: currentTime
    }, 'Creating transaction insights');

    // 12. Initialize user_growth
    initializationResults.user_growth = await safeInsert('user_growth', {
      user_id: userId,
      growth_stage: 'onboarding',
      metrics_score: 0,
      engagement_level: 'new',
      next_milestone: 'first_payment',
      recommendations: JSON.stringify(['Complete your first payment link', 'Set up wallet addresses']),
      last_updated: currentTime
    }, 'Creating user growth tracking');

    // 13. Initialize ai_oracle_messages
    initializationResults.ai_oracle_messages = await safeInsert('ai_oracle_messages', {
      user_id: userId,
      message_type: 'welcome',
      content: `Welcome to Halaxa Pay, ${firstName || 'User'}! Your dashboard is ready to help you manage crypto payments.`,
      is_read: false,
      priority: 'low',
      created_at: currentTime
    }, 'Creating AI oracle welcome message');

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
    const { email, password, fullName } = req.body;

    let first_name = null;
    let last_name = null;

    if (fullName) {
      const nameParts = fullName.split(' ');
      first_name = nameParts[0] || null;
      last_name = nameParts.slice(1).join(' ') || null;
    }

    // 🔐 USE SUPABASE AUTH for user creation (not custom users table)
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
      console.error('Supabase Auth creation error:', authError);
      if (authError.message.includes('already registered')) {
        return res.status(400).json({ error: 'User already exists' });
      }
      return res.status(500).json({ 
        error: 'Failed to create user',
        details: authError.message 
      });
    }

    const newUser = authData.user;
    console.log(`🔐 Created Supabase Auth user: ${newUser.id.substring(0, 8)}****`);

    // 🚀 INITIALIZE USER DASHBOARD TABLES
    console.log(`🎯 Initializing dashboard tables for Supabase Auth user: ${newUser.id}`);
    await initializeUserDashboardTables(newUser.id, email, first_name, last_name);

    // Generate tokens
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