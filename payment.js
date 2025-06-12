import express from 'express';
import { supabase } from './supabase.js';
import { authenticateToken } from './authMiddleware.js';
import { validateRequest } from './security.js';
import crypto from 'crypto';

const router = express.Router();

// Create payment link
router.post('/create-link', authenticateToken, async (req, res) => {
  try {
    const { walletAddress, amountUsdc, chain, productTitle } = req.body;
    const sellerId = req.user.userId;
    const linkId = crypto.randomBytes(16).toString('hex');

    const { data: paymentLink, error } = await supabase.from('payment_links').insert([{
      link_id: linkId,
      wallet_address: walletAddress,
      amount_usdc: amountUsdc,
      chain,
      product_title: productTitle,
      seller_id: sellerId,
      status: 'pending'
    }]).select().single();

    if (error) throw error;

    res.status(201).json({
      linkId: paymentLink.link_id,
      status: paymentLink.status
    });
  } catch (error) {
    console.error('Create payment link error:', error);
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

// Get payment link details
router.get('/link/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;

    const { data: paymentLink, error } = await supabase.from('payment_links')
      .select('*')
      .eq('link_id', linkId)
      .single();

    if (error || !paymentLink) {
      return res.status(404).json({ error: 'Payment link not found' });
    }

    res.json({
      linkId: paymentLink.link_id,
      walletAddress: paymentLink.wallet_address,
      amountUsdc: paymentLink.amount_usdc,
      chain: paymentLink.chain,
      productTitle: paymentLink.product_title,
      status: paymentLink.status
    });
  } catch (error) {
    console.error('Get payment link error:', error);
    res.status(500).json({ error: 'Failed to get payment link details' });
  }
});

// Submit buyer information
router.post('/submit-buyer-info', async (req, res) => {
  try {
    const { linkId, firstName, lastName, email, addressLine1, addressLine2, city, country } = req.body;

    // Get payment link
    const { data: paymentLink, error: linkError } = await supabase.from('payment_links')
      .select('id')
      .eq('link_id', linkId)
      .single();

    if (linkError || !paymentLink) {
      return res.status(404).json({ error: 'Payment link not found' });
    }

    // Create buyer record
    const { error: buyerError } = await supabase.from('buyers').insert([{
      payment_link_id: paymentLink.id,
      first_name: firstName,
      last_name: lastName,
      email,
      address_line_1: addressLine1,
      address_line_2: addressLine2,
      city,
      country
    }]);

    if (buyerError) throw buyerError;

    res.status(201).json({ message: 'Buyer information submitted successfully' });
  } catch (error) {
    console.error('Submit buyer info error:', error);
    res.status(500).json({ error: 'Failed to submit buyer information' });
  }
});

// Record payment
router.post('/record-payment', async (req, res) => {
  try {
    const { linkId, transactionHash, amountUsdc } = req.body;

    // Get payment link
    const { data: paymentLink, error: linkError } = await supabase.from('payment_links')
      .select('id')
      .eq('link_id', linkId)
      .single();

    if (linkError || !paymentLink) {
      return res.status(404).json({ error: 'Payment link not found' });
    }

    // Record payment
    const { error: paymentError } = await supabase.from('payments').insert([{
      payment_link_id: paymentLink.id,
      transaction_hash: transactionHash,
      amount_usdc: amountUsdc,
      status: 'pending'
    }]);

    if (paymentError) throw paymentError;

    res.status(201).json({ message: 'Payment recorded successfully' });
  } catch (error) {
    console.error('Record payment error:', error);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// Get payment history
router.get('/history/:sellerId', authenticateToken, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { data: payments, error } = await supabase
      .from('payments')
      .select('*')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ payments });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get payment details
router.get('/:paymentId', authenticateToken, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { data: payment, error } = await supabase
      .from('payments')
      .select('*')
      .eq('id', paymentId)
      .single();

    if (error) throw error;
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json({ payment });
  } catch (error) {
    console.error('Error fetching payment details:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router; 