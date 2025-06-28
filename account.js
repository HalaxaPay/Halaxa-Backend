import express from 'express';
import { supabase } from './supabase.js';
import { authenticateToken } from './authMiddleware.js';
import { validateRequest } from './security.js';

const router = express.Router();

// Trigger detection for current user (manual refresh)
router.post('/trigger-detection', authenticateToken, async (req, res) => {
  try {
    console.log('🔍 Manual detection triggered for user:', req.user?.id?.substring(0, 8) + '****');
    
    // Import and run detection for this user
    const { DetectionAPI } = await import('./Detection.js');
    await DetectionAPI.runForUser(req.user.id);
    
    console.log('✅ Manual detection completed successfully');
    res.json({ 
      success: true, 
      message: 'Detection completed successfully',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Manual detection failed:', error);
    res.status(500).json({ 
      error: 'Detection failed', 
      details: error.message 
    });
  }
});

// Get user profile (for dashboard personalization)
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    console.log('📡 Profile endpoint called for user:', req.user?.id?.substring(0, 8) + '****');
    
    // Get user data from Supabase Auth (since we use auth.admin.createUser)
    const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(req.user.id);
    
    if (userError || !user) {
      console.error('❌ User not found in Supabase Auth:', userError);
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user plan from dashboard tables
    const { data: userPlan, error: planError } = await supabase
      .from('user_plans')
      .select('plan_type')
      .eq('user_id', user.id)
      .single();
    
    if (planError && planError.code !== 'PGRST116') {
      console.warn('⚠️ Could not fetch user plan:', planError);
    }
    
    const profile = {
      id: user.id,
      email: user.email,
      first_name: user.user_metadata?.first_name || '',
      last_name: user.user_metadata?.last_name || '',
      plan: userPlan?.plan_type || 'basic',
      created_at: user.created_at,
      email_verified: user.email_confirmed_at ? true : false
    };
    
    console.log('✅ Profile data returned successfully');
    res.json(profile);
    
  } catch (error) {
    console.error('❌ Profile endpoint error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Get account details
router.get('/:sellerId', authenticateToken, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { data: account, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('seller_id', sellerId)
      .single();

    if (error) throw error;
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json({ account });
  } catch (error) {
    console.error('Error fetching account details:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update account details
router.put('/details', authenticateToken, async (req, res) => {
  try {
    const sellerId = req.user.userId;
    const { walletAddress, chain } = req.body;

    const { error } = await supabase
      .from('accounts')
      .upsert({
        seller_id: sellerId,
        wallet_address: walletAddress,
        chain
      });

    if (error) throw error;

    res.json({ message: 'Account details updated successfully' });
  } catch (error) {
    console.error('Update account details error:', error);
    res.status(500).json({ error: 'Failed to update account details' });
  }
});

// Get account insights
router.get('/:sellerId/insights', authenticateToken, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { data: insights, error } = await supabase
      .from('account_insights')
      .select('*')
      .eq('seller_id', sellerId)
      .single();

    if (error) throw error;
    if (!insights) {
      return res.status(404).json({ error: 'Insights not found' });
    }

    res.json({ insights });
  } catch (error) {
    console.error('Error fetching account insights:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user activity
router.get('/activity', authenticateToken, async (req, res) => {
  try {
    const sellerId = req.user.userId;

    const { data: activities, error } = await supabase
      .from('user_activity')
      .select('*')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json(activities);
  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({ error: 'Failed to get user activity' });
  }
});

// Get security events
router.get('/security-events', authenticateToken, async (req, res) => {
  try {
    const sellerId = req.user.userId;

    const { data: events, error } = await supabase
      .from('security_events')
      .select('*')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json(events);
  } catch (error) {
    console.error('Get security events error:', error);
    res.status(500).json({ error: 'Failed to get security events' });
  }
});

// Get current user plan and upgrade information
router.get('/plan-status', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('plan, stripeCustomerId, stripeSubscriptionId, paymentStatus, created_at')
      .eq('id', req.user.id)
      .single();

    // ⚠️ DEV WARNING: Using 'id' for users table is correct (primary key)

    if (error) throw error;

    // Get plan details
    const planDetails = {
      basic: {
        name: 'Basic Plan',
        price: 0,
        limits: { paymentLinks: 1 },
        features: ['1 Payment Link', 'Basic Analytics']
      },
      pro: {
        name: 'Pro Plan', 
        price: 29,
        limits: { paymentLinks: 30 },
        features: ['30 Payment Links', 'Advanced Analytics', 'Priority Support']
      },
      elite: {
        name: 'Elite Plan',
        price: 99,
        limits: { paymentLinks: -1 }, // unlimited
        features: ['Unlimited Payment Links', 'Real-time Analytics', '24/7 Support', 'Custom Branding']
      }
    };

    res.json({
      currentPlan: user.plan || 'basic',
      planDetails: planDetails[user.plan || 'basic'],
      allPlans: planDetails,
      stripeStatus: {
        customerId: user.stripeCustomerId,
        subscriptionId: user.stripeSubscriptionId,
        paymentStatus: user.paymentStatus
      },
      memberSince: user.created_at
    });

  } catch (error) {
    console.error('Error fetching plan status:', error);
    res.status(500).json({ error: 'Failed to fetch plan status' });
  }
});

// Check upgrade eligibility and pricing
router.get('/upgrade-options/:targetPlan', authenticateToken, async (req, res) => {
  try {
    const { targetPlan } = req.params;
    
    if (!['pro', 'elite'].includes(targetPlan)) {
      return res.status(400).json({ error: 'Invalid target plan' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('plan')
      .eq('id', req.user.id)
      .single();

    // ⚠️ DEV WARNING: Using 'id' for users table is correct (primary key)

    if (error) throw error;

    const currentPlan = user.plan || 'basic';
    
    // Check if upgrade is valid
    const planHierarchy = { basic: 0, pro: 1, elite: 2 };
    if (planHierarchy[currentPlan] >= planHierarchy[targetPlan]) {
      return res.status(400).json({ error: 'Cannot downgrade or same plan' });
    }

    const pricing = {
      pro: { price: 29, priceId: 'price_123_pro' },
      elite: { price: 99, priceId: 'price_456_elite' }
    };

    res.json({
      canUpgrade: true,
      currentPlan,
      targetPlan,
      pricing: pricing[targetPlan],
      savings: targetPlan === 'elite' ? 'Best Value - Save 40%' : null
    });

  } catch (error) {
    console.error('Error checking upgrade options:', error);
    res.status(500).json({ error: 'Failed to check upgrade options' });
  }
});

// Get upgrade history
router.get('/upgrade-history', authenticateToken, async (req, res) => {
  try {
    const { data: history, error } = await supabase
      .from('activity_logs')
      .select('action, details, timestamp')
      .eq('user_id', req.user.id)
      .eq('action', 'plan_upgrade')
      .order('timestamp', { ascending: false })
      .limit(10);

    if (error) throw error;

    res.json({
      upgradeHistory: history || []
    });

  } catch (error) {
    console.error('Error fetching upgrade history:', error);
    res.status(500).json({ error: 'Failed to fetch upgrade history' });
  }
});

// Manual plan upgrade (for admin/testing purposes)
router.post('/manual-upgrade', authenticateToken, async (req, res) => {
  try {
    const { targetPlan } = req.body;
    
    if (!['basic', 'pro', 'elite'].includes(targetPlan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    // Update user plan
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        plan: targetPlan,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.user.id);

    // ⚠️ DEV WARNING: Using 'id' for users table is correct (primary key)

    if (updateError) throw updateError;

    // Log the change
    await supabase
      .from('activity_logs')
      .insert({
        user_id: req.user.id,
        action: 'plan_upgrade',
        details: `Plan manually upgraded to ${targetPlan}`,
        timestamp: new Date().toISOString()
      });

    res.json({
      success: true,
      message: `Plan upgraded to ${targetPlan}`,
      newPlan: targetPlan
    });

  } catch (error) {
    console.error('Error with manual upgrade:', error);
    res.status(500).json({ error: 'Failed to upgrade plan' });
  }
});

// Get user dashboard data
router.get('/dashboard-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('📊 Fetching dashboard data for user:', userId.substring(0, 8) + '****');

    // Fetch all dashboard data in parallel with error handling
    const [
      userMetrics,
      userBalances,
      keyMetrics,
      executionMetrics,
      monthlyMetrics,
      transactionInsights,
      feesSaved,
      usdcBalances,
      networkDistributions,
      recentTransactions,
      paymentLinks
    ] = await Promise.allSettled([
      supabase.from('user_metrics').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('user_balances').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('key_metrics').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('execution_metrics').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('monthly_metrics').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('transaction_insights').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('fees_saved').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('usdc_balances').select('*').eq('user_id', userId),
      supabase.from('network_distributions').select('*').eq('user_id', userId),
      supabase.from('transactions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
      supabase.from('payment_links').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)
    ]);

    // Helper function to safely extract data from Promise.allSettled results
    const safeExtract = (result, defaultValue = {}) => {
      if (result.status === 'fulfilled' && result.value.data) {
        return result.value.data;
      }
      return defaultValue;
    };

    const dashboardData = {
      user_metrics: safeExtract(userMetrics, {}),
      user_balances: safeExtract(userBalances, {}),
      key_metrics: safeExtract(keyMetrics, {}),
      execution_metrics: safeExtract(executionMetrics, {}),
      monthly_metrics: safeExtract(monthlyMetrics, {}),
      transaction_insights: safeExtract(transactionInsights, {}),
      fees_saved: safeExtract(feesSaved, {}),
      usdc_balances: safeExtract(usdcBalances, []),
      network_distributions: safeExtract(networkDistributions, []),
      recent_transactions: safeExtract(recentTransactions, []),
      payment_links: safeExtract(paymentLinks, [])
    };

    console.log('✅ Dashboard data fetched successfully');
    res.json(dashboardData);

  } catch (error) {
    console.error('❌ Dashboard data fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Get user transactions with pagination
router.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ transactions: transactions || [] });

  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Get capital data for dashboard
router.get('/capital-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('💰 Fetching capital data for user:', userId.substring(0, 8) + '****');
    
    // Fetch capital-related data from multiple tables with graceful error handling
    const [
      balancesResult,
      transactionsResult,
      feesResult,
      usdcBalancesResult
    ] = await Promise.allSettled([
      supabase.from('user_balances').select('*').eq('user_id', userId).limit(100),
      supabase.from('transaction_insights').select('*').eq('user_id', userId).limit(100),
      supabase.from('fees_saved').select('*').eq('user_id', userId).limit(100),
      supabase.from('usdc_balances').select('*').eq('user_id', userId).limit(100)
    ]);
    
    // Calculate totals with safe data extraction
    let totalReceived = 0;
    let totalPaidOut = 0;
    let totalFeesSaved = 0;
    let hasData = false;
    
    // Process user_balances
    if (balancesResult.status === 'fulfilled' && balancesResult.value.data && balancesResult.value.data.length > 0) {
      const balances = balancesResult.value.data;
      totalReceived = balances.reduce((sum, balance) => sum + (parseFloat(balance.balance) || 0), 0);
      hasData = true;
      console.log('📊 Found user_balances data:', balances.length, 'records');
    }
    
    // Process transaction_insights
    if (transactionsResult.status === 'fulfilled' && transactionsResult.value.data && transactionsResult.value.data.length > 0) {
      const transactions = transactionsResult.value.data;
      totalPaidOut = transactions.reduce((sum, tx) => sum + (parseFloat(tx.total_outgoing) || 0), 0);
      hasData = true;
      console.log('📊 Found transaction_insights data:', transactions.length, 'records');
    }
    
    // Process fees_saved
    if (feesResult.status === 'fulfilled' && feesResult.value.data && feesResult.value.data.length > 0) {
      const fees = feesResult.value.data;
      totalFeesSaved = fees.reduce((sum, fee) => sum + (parseFloat(fee.amount_saved) || 0), 0);
      hasData = true;
      console.log('📊 Found fees_saved data:', fees.length, 'records');
    }
    
    // Process usdc_balances as fallback
    if (usdcBalancesResult.status === 'fulfilled' && usdcBalancesResult.value.data && usdcBalancesResult.value.data.length > 0) {
      const usdcBalances = usdcBalancesResult.value.data;
      if (totalReceived === 0) {
        totalReceived = usdcBalances.reduce((sum, balance) => sum + (parseFloat(balance.balance) || 0), 0);
      }
      hasData = true;
      console.log('📊 Found usdc_balances data:', usdcBalances.length, 'records');
    }
    
    const netFlow = totalReceived - totalPaidOut;
    
    console.log('✅ Capital data calculated:', { totalReceived, totalPaidOut, netFlow, hasData });
    res.json({
      total_received: totalReceived,
      total_paid_out: totalPaidOut,
      net_flow: netFlow,
      fees_saved: totalFeesSaved,
      has_data: hasData,
      message: hasData ? 'Data loaded successfully' : 'No transaction data found. Start creating payment links to see your capital flow.',
      last_updated: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Capital data error:', error);
    // Return default values instead of 500 error
    res.json({
      total_received: 0,
      total_paid_out: 0,
      net_flow: 0,
      fees_saved: 0,
      has_data: false,
      message: 'No data available. Create your first payment link to start tracking capital flow.',
      error: error.message,
      last_updated: new Date().toISOString()
    });
  }
});

// Get user metrics for dashboard
router.get('/user-metrics', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('📊 Fetching user metrics for user:', userId.substring(0, 8) + '****');
    
    // Fetch metrics from multiple tables with graceful error handling
    const [
      keyMetricsResult,
      executionMetricsResult,
      userMetricsResult,
      paymentLinksResult,
      transactionsResult
    ] = await Promise.allSettled([
      supabase.from('key_metrics').select('*').eq('user_id', userId).limit(10),
      supabase.from('execution_metrics').select('*').eq('user_id', userId).limit(10),
      supabase.from('user_metrics').select('*').eq('user_id', userId).limit(10),
      supabase.from('payment_links').select('*').eq('user_id', userId).limit(100),
      supabase.from('transactions').select('*').eq('user_id', userId).limit(100)
    ]);
    
    let metricsData = {
      transaction_velocity: 0,
      flawless_executions: 99.8,
      success_rate: 100,
      avg_processing_time: 2.3,
      total_volume: 0,
      payment_conduits: 0,
      monthly_harvest: 0,
      has_data: false,
      message: 'Getting started - Create your first payment link to see metrics'
    };
    
    let hasData = false;
    
    // Process key metrics
    if (keyMetricsResult.status === 'fulfilled' && keyMetricsResult.value.data?.length > 0) {
      const keyMetrics = keyMetricsResult.value.data[0];
      metricsData.total_volume = parseFloat(keyMetrics.total_volume) || 0;
      hasData = true;
      console.log('📊 Found key_metrics data');
    }
    
    // Process execution metrics
    if (executionMetricsResult.status === 'fulfilled' && executionMetricsResult.value.data?.length > 0) {
      const execMetrics = executionMetricsResult.value.data[0];
      metricsData.flawless_executions = parseFloat(execMetrics.flawless_executions) || 99.8;
      metricsData.success_rate = parseFloat(execMetrics.success_rate) || 100;
      metricsData.avg_processing_time = parseFloat(execMetrics.avg_processing_time) || 2.3;
      hasData = true;
      console.log('📊 Found execution_metrics data');
    }
    
    // Process user metrics
    if (userMetricsResult.status === 'fulfilled' && userMetricsResult.value.data?.length > 0) {
      const userMetrics = userMetricsResult.value.data[0];
      metricsData.transaction_velocity = parseInt(userMetrics.transaction_velocity) || 0;
      hasData = true;
      console.log('📊 Found user_metrics data');
    }
    
    // Count payment links as conduits
    if (paymentLinksResult.status === 'fulfilled' && paymentLinksResult.value.data) {
      const activeLinks = paymentLinksResult.value.data.filter(link => link.is_active !== false);
      metricsData.payment_conduits = activeLinks.length;
      if (activeLinks.length > 0) hasData = true;
      console.log('📊 Found payment_links:', activeLinks.length, 'active links');
    }
    
    // Calculate monthly harvest from transactions
    if (transactionsResult.status === 'fulfilled' && transactionsResult.value.data) {
      const transactions = transactionsResult.value.data;
      const currentMonth = new Date().getMonth();
      const currentYear = new Date().getFullYear();
      
      const monthlyTransactions = transactions.filter(tx => {
        const txDate = new Date(tx.created_at);
        return txDate.getMonth() === currentMonth && txDate.getFullYear() === currentYear;
      });
      
      metricsData.monthly_harvest = monthlyTransactions.reduce((sum, tx) => 
        sum + (parseFloat(tx.amount) || 0), 0);
      
      if (transactions.length > 0) hasData = true;
      console.log('📊 Found transactions:', transactions.length, 'total,', monthlyTransactions.length, 'this month');
    }
    
    metricsData.has_data = hasData;
    if (hasData) {
      metricsData.message = 'Metrics updated with your latest activity';
    }
    
    console.log('✅ User metrics calculated:', metricsData);
    res.json(metricsData);
    
  } catch (error) {
    console.error('❌ User metrics error:', error);
    // Return default values instead of 500 error
    res.json({
      transaction_velocity: 0,
      flawless_executions: 99.8,
      success_rate: 100,
      avg_processing_time: 2.3,
      total_volume: 0,
      payment_conduits: 0,
      monthly_harvest: 0,
      has_data: false,
      message: 'Welcome to Halaxa! Create your first payment link to start tracking metrics.',
      error: error.message
    });
  }
});

export default router; 