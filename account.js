import express from 'express';
import { supabase } from './supabase.js';
import { authenticateToken } from './authMiddleware.js';
import { validateRequest } from './security.js';

const router = express.Router();

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

export default router; 