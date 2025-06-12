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

export default router; 