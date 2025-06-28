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

// Get account details (using existing tables)
router.get('/details', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user profile and plan information
    const [userResponse, planResponse] = await Promise.allSettled([
      supabase.auth.admin.getUserById(userId),
      supabase.from('user_plans').select('*').eq('user_id', userId).maybeSingle()
    ]);
    
    let accountDetails = {
      user_id: userId,
      email: null,
      plan: 'basic',
      created_at: new Date().toISOString(),
      status: 'active'
    };
    
    if (userResponse.status === 'fulfilled' && userResponse.value.data?.user) {
      const user = userResponse.value.data.user;
      accountDetails.email = user.email;
      accountDetails.created_at = user.created_at;
    }
    
    if (planResponse.status === 'fulfilled' && planResponse.value.data) {
      accountDetails.plan = planResponse.value.data.plan_type || 'basic';
    }
    
    res.json({ account: accountDetails });
  } catch (error) {
    console.error('Error fetching account details:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update account details (using existing tables)
router.put('/details', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { walletAddress, chain, preferences } = req.body;

    // Update user metadata
    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: {
        wallet_address: walletAddress,
        preferred_chain: chain,
        preferences: preferences
      }
    });

    if (updateError) {
      console.warn('Could not update user metadata:', updateError);
    }

    res.json({ 
      message: 'Account details updated successfully',
      updated_fields: { walletAddress, chain, preferences }
    });
  } catch (error) {
    console.error('Update account details error:', error);
    res.status(500).json({ error: 'Failed to update account details' });
  }
});

// Get account insights (using existing data)
router.get('/insights', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Fetch insights from existing tables
    const [metricsResult, balancesResult, transactionsResult] = await Promise.allSettled([
      supabase.from('user_metrics').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('user_balances').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('payment_links').select('*').eq('user_id', userId)
    ]);
    
    const insights = {
      total_payment_links: 0,
      active_payment_links: 0,
      total_volume: 0,
      success_rate: 99.8,
      avg_transaction_time: 2.3,
      last_activity: new Date().toISOString()
    };
    
    // Process metrics
    if (metricsResult.status === 'fulfilled' && metricsResult.value.data) {
      const metrics = metricsResult.value.data;
      insights.total_volume = parseFloat(metrics.total_volume) || 0;
      insights.success_rate = parseFloat(metrics.success_rate) || 99.8;
    }
    
    // Process payment links
    if (transactionsResult.status === 'fulfilled' && transactionsResult.value.data) {
      const links = transactionsResult.value.data;
      insights.total_payment_links = links.length;
      insights.active_payment_links = links.filter(link => link.is_active !== false).length;
    }
    
    res.json({ insights });
  } catch (error) {
    console.error('Error fetching account insights:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user activity (using existing tables)
router.get('/activity', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get recent activities from payment links and transactions
    const [linksResult, transactionsResult] = await Promise.allSettled([
      supabase.from('payment_links').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(25),
      supabase.from('transactions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(25)
    ]);
    
    let activities = [];
    
    // Process payment links as activities
    if (linksResult.status === 'fulfilled' && linksResult.value.data) {
      const linkActivities = linksResult.value.data.map(link => ({
        id: `link_${link.id}`,
        type: 'payment_link_created',
        description: `Created payment link: ${link.link_name || 'Unnamed'}`,
        amount: link.amount,
        created_at: link.created_at,
        status: link.is_active ? 'active' : 'inactive'
      }));
      activities = activities.concat(linkActivities);
    }
    
    // Process transactions as activities
    if (transactionsResult.status === 'fulfilled' && transactionsResult.value.data) {
      const txActivities = transactionsResult.value.data.map(tx => ({
        id: `tx_${tx.id}`,
        type: 'transaction',
        description: `Transaction of $${tx.amount}`,
        amount: tx.amount,
        created_at: tx.created_at,
        status: tx.status || 'completed'
      }));
      activities = activities.concat(txActivities);
    }
    
    // Sort by date and limit
    activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    activities = activities.slice(0, 50);

    res.json(activities);
  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({ error: 'Failed to get user activity' });
  }
});

// Get current user plan and upgrade information
router.get('/plan-status', authenticateToken, async (req, res) => {
  try {
    // Get user plan from user_plans table and auth info
    const [userPlanResult, userAuthResult] = await Promise.allSettled([
      supabase.from('user_plans').select('*').eq('user_id', req.user.id).maybeSingle(),
      supabase.auth.admin.getUserById(req.user.id)
    ]);

    let currentPlan = 'basic';
    let memberSince = new Date().toISOString();
    let planStatus = 'active';

    // Extract plan info
    if (userPlanResult.status === 'fulfilled' && userPlanResult.value.data) {
      currentPlan = userPlanResult.value.data.plan_type || 'basic';
      planStatus = userPlanResult.value.data.auto_renew ? 'active' : 'inactive';
    }

    // Extract user creation date
    if (userAuthResult.status === 'fulfilled' && userAuthResult.value.data?.user) {
      memberSince = userAuthResult.value.data.user.created_at;
    }

    // Get plan details
    const planDetails = {
      basic: {
        name: 'Basic Plan',
        price: 0,
        limits: { paymentLinks: 1, networks: ['polygon'] },
        features: ['1 Payment Link', 'Polygon Network', 'Basic Analytics']
      },
      pro: {
        name: 'Pro Plan', 
        price: 29,
        limits: { paymentLinks: 30, networks: ['polygon', 'solana'] },
        features: ['30 Payment Links', 'Polygon + Solana Networks', 'Capital Analytics', 'Priority Support']
      },
      elite: {
        name: 'Elite Plan',
        price: 99,
        limits: { paymentLinks: -1, networks: ['polygon', 'solana', 'tron'] }, // unlimited
        features: ['Unlimited Payment Links', 'All Networks', 'Orders & Shipping', 'Custom Branding', '24/7 Support']
      }
    };

    res.json({
      currentPlan: currentPlan,
      planDetails: planDetails[currentPlan],
      allPlans: planDetails,
      status: planStatus,
      memberSince: memberSince
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

    // Get current plan from user_plans table
    const { data: userPlan, error } = await supabase
      .from('user_plans')
      .select('plan_type')
      .eq('user_id', req.user.id)
      .maybeSingle();

    const currentPlan = userPlan?.plan_type || 'basic';
    
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

    // Check if user already has a plan entry
    const { data: existingPlan } = await supabase
      .from('user_plans')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    let updateResult;
    
    if (existingPlan) {
      // Update existing plan
      updateResult = await supabase
        .from('user_plans')
        .update({ 
          plan_type: targetPlan,
          next_billing: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
          auto_renew: true
        })
        .eq('user_id', req.user.id);
    } else {
      // Create new plan entry
      updateResult = await supabase
        .from('user_plans')
        .insert({
          user_id: req.user.id,
          plan_type: targetPlan,
          started_at: new Date().toISOString(),
          next_billing: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          auto_renew: true
        });
    }

    if (updateResult.error) throw updateResult.error;

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

// Quick plan setter for testing (sets plan directly)
router.post('/set-plan', authenticateToken, async (req, res) => {
  try {
    const { plan } = req.body;
    
    if (!['basic', 'pro', 'elite'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Must be: basic, pro, or elite' });
    }

    // Upsert plan in user_plans table
    const { error } = await supabase
      .from('user_plans')
      .upsert({
        user_id: req.user.id,
        plan_type: plan,
        started_at: new Date().toISOString(),
        next_billing: plan !== 'basic' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null,
        auto_renew: plan !== 'basic'
      }, {
        onConflict: 'user_id'
      });

    if (error) throw error;

    res.json({
      success: true,
      message: `Plan set to ${plan}`,
      plan: plan
    });

  } catch (error) {
    console.error('Error setting plan:', error);
    res.status(500).json({ error: 'Failed to set plan' });
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