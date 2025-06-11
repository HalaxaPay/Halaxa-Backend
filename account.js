import express from 'express';
import { query, withTransaction } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get account details
router.get('/details', authenticateToken, async (req, res) => {
  try {
    const sellerId = req.user.userId;

    const { data: account, error } = await query(async (supabase) => {
      return await supabase.from('accounts')
        .select('*')
        .eq('seller_id', sellerId)
        .single();
    });

    if (error && error.code !== 'PGRST116') { // PGRST116 is "no rows returned"
      throw error;
    }

    res.json(account || { message: 'No account details found' });
  } catch (error) {
    console.error('Get account details error:', error);
    res.status(500).json({ error: 'Failed to get account details' });
  }
});

// Update account details
router.put('/details', authenticateToken, async (req, res) => {
  try {
    const sellerId = req.user.userId;
    const { walletAddress, chain } = req.body;

    const { error } = await query(async (supabase) => {
      return await supabase.from('accounts')
        .upsert({
          seller_id: sellerId,
          wallet_address: walletAddress,
          chain
        });
    });

    if (error) throw error;

    res.json({ message: 'Account details updated successfully' });
  } catch (error) {
    console.error('Update account details error:', error);
    res.status(500).json({ error: 'Failed to update account details' });
  }
});

// Get account insights
router.get('/insights', authenticateToken, async (req, res) => {
  try {
    const sellerId = req.user.userId;

    const { data: insights, error } = await query(async (supabase) => {
      return await supabase.from('account_insights')
        .select('*')
        .eq('seller_id', sellerId)
        .single();
    });

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    res.json(insights || {
      securityScore: 0,
      activityLevel: 'low',
      accountAgeDays: 0,
      verificationStatus: 'pending'
    });
  } catch (error) {
    console.error('Get account insights error:', error);
    res.status(500).json({ error: 'Failed to get account insights' });
  }
});

// Get user activity
router.get('/activity', authenticateToken, async (req, res) => {
  try {
    const sellerId = req.user.userId;

    const { data: activities, error } = await query(async (supabase) => {
      return await supabase.from('user_activity')
        .select('*')
        .eq('seller_id', sellerId)
        .order('created_at', { ascending: false })
        .limit(50);
    });

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

    const { data: events, error } = await query(async (supabase) => {
      return await supabase.from('security_events')
        .select('*')
        .eq('seller_id', sellerId)
        .order('created_at', { ascending: false })
        .limit(50);
    });

    if (error) throw error;

    res.json(events);
  } catch (error) {
    console.error('Get security events error:', error);
    res.status(500).json({ error: 'Failed to get security events' });
  }
});

export default router; 