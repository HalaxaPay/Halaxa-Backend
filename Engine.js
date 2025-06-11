import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import csrf from 'csurf';
import cookieParser from 'cookie-parser';
import { authenticateToken } from './authMiddleware.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { validateRequest } from './security.js';
import stripe from './Stripe.js';
import { supabase } from './supabase.js';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cookieParser());

// Global rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(globalLimiter);

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://halaxaa.framer.website',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
}));

// CSRF protection
app.use(csrf({ cookie: true }));

// Body parsing
app.use(express.json());

// CSRF token endpoint
app.get('/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// Helper to generate a unique ID
function generateId(length = 9) {
  return crypto.randomBytes(length).toString('hex');
}

// Async function to check for USDC transfer on Polygon
async function checkPolygonUSDCReceived(wallet_address, amount_usdc) {
  const endpoint = 'https://polygon-mainnet.g.alchemy.com/v2/0nv8rfdR_WWXqSOd2HzBzQvRWJP1Jiqg';
  const payload = {
    jsonrpc: '2.0',
    id: 0,
    method: 'alchemy_getAssetTransfers',
    params: [
      {
        toAddress: wallet_address,
        category: ['erc20'],
        contractAddresses: ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'],
        maxCount: 30,
        withMetadata: false
      }
    ]
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    const transfers = data.result && data.result.transfers ? data.result.transfers : [];
    const expectedValue = Math.round(amount_usdc * 1_000_000);
    for (const transfer of transfers) {
      if (
        transfer.rawContract &&
        Math.abs(Number(transfer.rawContract.value) - expectedValue) <= 50000
      ) {
        return { found: true, hash: transfer.hash };
      }
    }
    return { found: false };
  } catch (err) {
    console.error('Error checking USDC transfer:', err);
    return { found: false };
  }
}

// Async function to check for USDC transfer on TRON (TRC20)
async function checkTRC20USDCReceived(wallet_address, amount_usdc) {
  const endpoint = `https://api.trongrid.io/v1/accounts/${wallet_address}/transactions/trc20`;
  try {
    const response = await fetch(endpoint);
    const data = await response.json();
    const transactions = Array.isArray(data.data) ? data.data.slice(0, 30) : [];
    for (const tx of transactions) {
      if (
        tx.token_info &&
        tx.token_info.address === 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' &&
        Math.abs(Number(tx.value) - amount_usdc) <= 0.05
      ) {
        return { found: true, hash: tx.transaction_id };
      }
    }
    return { found: false };
  } catch (err) {
    console.error('Error checking TRC20 USDC transfer:', err);
    return { found: false };
  }
}

// Validation rules for /create-link
const createLinkValidationRules = [
  body('wallet_address').notEmpty().withMessage('Wallet address is required'),
  body('amount_usdc').isFloat({ gt: 0 }).withMessage('Amount must be a positive number'),
  body('chain').isIn(['Polygon', 'TRC20']).withMessage('Unsupported chain'),
  body('product_title').notEmpty().withMessage('Product title is required'),
];

app.post('/create-link',
  authenticateToken,
  createLinkValidationRules,
  validateRequest,
  async (req, res) => {
    const { wallet_address, amount_usdc, chain, product_title } = req.body;
    const { seller_id, plan } = req.user;

    try {
      // Count how many links this seller already created
      const { count, error: countError } = await supabase
        .from('payment_links')
        .select('*', { count: 'exact' })
        .eq('seller_id', seller_id)
        .eq('status', 'active');

      if (countError) throw countError;

      const maxLinksByPlan = {
        basic: 1,
        pro: 30,
        elite: Infinity
      };

      const maxAllowed = maxLinksByPlan[plan] ?? 0;

      if (count >= maxAllowed) {
        return res.status(403).json({ error: 'Link limit reached for your plan' });
      }

      const link_id = 'link_' + generateId(9);

      const { data, error } = await supabase
        .from('payment_links')
        .insert([{
          link_id,
          wallet_address,
          amount_usdc,
          chain,
          product_title,
          seller_id,
          status: 'pending',
          created_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (error) throw error;

      res.json({ data: { link_id } });
    } catch (err) {
      console.error('Error creating payment link:', err);
      res.status(500).json({ error: 'Failed to create payment link' });
    }
  });

// Validation rules for /submit-buyer-info
const submitBuyerInfoValidationRules = [
  body('link_id').notEmpty().withMessage('Link ID is required'),
  body('first_name').notEmpty().withMessage('First name is required'),
  body('last_name').notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('Invalid email format'),
  body('address').optional().isString().withMessage('Address must be a string'),
];

app.post('/submit-buyer-info',
  submitBuyerInfoValidationRules,
  validateRequest,
  async (req, res) => {
    const { link_id, first_name, last_name, email, address } = req.body;

    try {
      // Get payment link
      const { data: paymentLink, error: linkError } = await supabase
        .from('payment_links')
        .select('id')
        .eq('link_id', link_id)
        .single();

      if (linkError) throw linkError;
      if (!paymentLink) {
        return res.status(404).json({ error: 'Invalid link ID' });
      }

      // Store buyer information
      const { data, error } = await supabase
        .from('buyers')
        .insert([{
          payment_link_id: paymentLink.id,
          first_name,
          last_name,
          email,
          address,
          created_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (error) throw error;

      res.json({ data: { message: 'Buyer info saved' } });
    } catch (err) {
      console.error('Error submitting buyer info:', err);
      res.status(500).json({ error: 'Failed to submit buyer information' });
    }
  });

app.get('/payment-info/:link_id', async (req, res) => {
  const { link_id } = req.params;

  try {
    const { data: link, error } = await supabase
      .from('payment_links')
      .select('product_title, amount_usdc, wallet_address, chain')
      .eq('link_id', link_id)
      .single();

    if (error) throw error;
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    res.json({ data: link });
  } catch (err) {
    console.error('Error fetching payment info:', err);
    res.status(500).json({ error: 'Failed to fetch payment information' });
  }
});

// Validation rules for /i-paid and /verify-payment
const linkIdValidationRule = body('link_id').notEmpty().withMessage('Link ID is required');

app.post('/i-paid',
  linkIdValidationRule,
  validateRequest,
  async (req, res) => {
    const { link_id } = req.body;

    try {
      const { data: link, error: linkError } = await supabase
        .from('payment_links')
        .select('id')
        .eq('link_id', link_id)
        .single();

      if (linkError) throw linkError;
      if (!link) {
        return res.status(404).json({ error: 'Invalid link ID' });
      }

      const { error: updateError } = await supabase
        .from('payment_links')
        .update({ status: 'verifying' })
        .eq('id', link.id);

      if (updateError) throw updateError;

      res.json({ data: { message: 'Payment confirmation started' } });
    } catch (err) {
      console.error('Error updating payment status:', err);
      res.status(500).json({ error: 'Failed to update payment status' });
    }
  });

app.post('/verify-payment',
  linkIdValidationRule,
  validateRequest,
  async (req, res) => {
    const { link_id } = req.body;

    try {
      const { data: link, error: linkError } = await supabase
        .from('payment_links')
        .select('id, wallet_address, amount_usdc, chain')
        .eq('link_id', link_id)
        .single();

      if (linkError) throw linkError;
      if (!link) {
        return res.status(404).json({ error: 'Link not found' });
      }

      let result;
      if (link.chain === 'Polygon') {
        result = await checkPolygonUSDCReceived(link.wallet_address, link.amount_usdc);
      } else if (link.chain === 'TRC20') {
        result = await checkTRC20USDCReceived(link.wallet_address, link.amount_usdc);
      } else {
        return res.status(400).json({ error: 'Unsupported chain' });
      }

      if (result.found) {
        // Check for duplicate transaction
        const { data: existingPayment, error: paymentError } = await supabase
          .from('payments')
          .select('id')
          .eq('transaction_hash', result.hash)
          .single();

        if (paymentError && paymentError.code !== 'PGRST116') throw paymentError;

        if (!existingPayment) {
          // Create payment record
          const { error: insertError } = await supabase
            .from('payments')
            .insert([{
              payment_link_id: link.id,
              transaction_hash: result.hash,
              amount_usdc: link.amount_usdc,
              status: 'confirmed',
              confirmed_at: new Date().toISOString(),
              created_at: new Date().toISOString()
            }]);

          if (insertError) throw insertError;

          // Update payment link status
          const { error: updateError } = await supabase
            .from('payment_links')
            .update({ status: 'paid' })
            .eq('id', link.id);

          if (updateError) throw updateError;
        }

        return res.json({ data: { confirmed: true, transaction_hash: result.hash } });
      }

      res.json({ data: { confirmed: false } });
    } catch (err) {
      console.error('Error verifying payment:', err);
      res.status(500).json({ error: 'Failed to verify payment' });
    }
  });

// Enhanced /dashboard route with plan-based access
app.get('/dashboard/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId, plan } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    const { data: links, error } = await supabase
      .from('payment_links')
      .select('*')
      .eq('seller_id', paramSellerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Base response for all plans
    const dashboardData = links.map(link => ({
      link_id: link.link_id,
      product_title: link.product_title,
      amount_usdc: link.amount_usdc,
      chain: link.chain,
      created_at: link.created_at
    }));

    // Optionally include more data for pro and elite plans
    let enhancedData = [];

    if (plan === 'pro' || plan === 'elite') {
      enhancedData = links.map(link => ({
        tx_hashes: link.tx_hash || null,
        confirmed_at: link.confirmed_at || null
      }));
    }

    res.json({
      data: {
        plan,
        total_links: links.length,
        features: {
          dashboard_access: true,
          recurring_payments: plan === 'elite',
          advanced_metrics: plan === 'pro' || plan === 'elite'
        },
        dashboard_data: dashboardData,
        extras: enhancedData
      }
    });
  } catch (err) {
    console.error('Error fetching dashboard:', err);
    res.status(500).json({ error: 'Dashboard fetch error' });
  }
});

// Get current user's plan and feature access
app.get('/user-plan', authenticateToken, async (req, res) => {
  const { email, seller_id, plan } = req.user;

  const featureMap = {
    basic: {
      max_links: 1,
      recurring_payments: false,
      dashboard_access: true
    },
    pro: {
      max_links: 30,
      recurring_payments: true,
      dashboard_access: true
    },
    elite: {
      max_links: Infinity,
      recurring_payments: true,
      dashboard_access: true
    }
  };

  res.json({
    data: {
      email,
      seller_id,
      plan,
      features: featureMap[plan] || {}
    }
  });
});

// Helper function to get date range for analytics
function getDateRange(period) {
  const now = new Date();
  const start = new Date();

  switch (period) {
    case '7d':
      start.setDate(now.getDate() - 7);
      break;
    case '30d':
      start.setDate(now.getDate() - 30);
      break;
    case '90d':
      start.setDate(now.getDate() - 90);
      break;
    case '1y':
      start.setFullYear(now.getFullYear() - 1);
      break;
    default:
      start.setDate(now.getDate() - 7);
  }

  return {
    start: start.toISOString(),
    end: now.toISOString()
  };
}

// Analytics Overview Endpoint
app.get('/api/analytics/overview/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    // Calculate Total USDC Earned, Total Transactions, Successful Transactions, Average Transaction Value
    const { data: overviewStats, error: statsError } = await supabase
      .from('payments')
      .select(`
        amount_usdc,
        status,
        payment_links!inner(seller_id)
      `)
      .eq('payment_links.seller_id', paramSellerId);

    if (statsError) throw statsError;

    const totalUsdc = overviewStats
      .filter(p => p.status === 'confirmed')
      .reduce((sum, p) => sum + p.amount_usdc, 0);

    const totalTransactions = overviewStats.length;
    const successfulTransactions = overviewStats.filter(p => p.status === 'confirmed').length;
    const avgTransaction = successfulTransactions > 0 ? totalUsdc / successfulTransactions : 0;

    // Get Payment Link Summary
    const { data: links, error: linksError } = await supabase
      .from('payment_links')
      .select('*')
      .eq('seller_id', paramSellerId);

    if (linksError) throw linksError;

    const totalLinks = links.length;
    const pendingLinks = links.filter(l => l.status === 'pending').length;
    const totalGeneratedValue = links.reduce((sum, l) => sum + l.amount_usdc, 0);

    res.json({
      data: {
        stats: {
          totalUsdc,
          totalTransactions,
          successfulTransactions,
          avgTransaction
        },
        paymentLinkSummary: {
          totalLinks,
          activeLinks: pendingLinks,
          totalGeneratedValue
        }
      }
    });
  } catch (err) {
    console.error('Error fetching analytics overview:', err);
    res.status(500).json({ error: 'Error fetching analytics overview' });
  }
});

// Analytics Volume Endpoint
app.get('/api/analytics/volume/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;
  const { period = '7d' } = req.query;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    const { start, end } = getDateRange(period);

    const { data: volumeData, error } = await supabase
      .from('payments')
      .select(`
        amount_usdc,
        created_at,
        payment_links!inner(seller_id)
      `)
      .eq('payment_links.seller_id', paramSellerId)
      .eq('status', 'confirmed')
      .gte('created_at', start)
      .lte('created_at', end);

    if (error) throw error;

    // Group by date and calculate totals
    const dateMap = volumeData.reduce((acc, curr) => {
      const date = curr.created_at.split('T')[0];
      acc[date] = (acc[date] || 0) + curr.amount_usdc;
      return acc;
    }, {});

    // Fill in missing dates with zero volume
    const allDates = [];
    let currentDate = new Date(start);
    while (currentDate <= new Date(end)) {
      allDates.push(currentDate.toISOString().split('T')[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const labels = allDates;
    const data = allDates.map(date => dateMap[date] || 0);

    res.json({
      data: {
        volume: {
          labels,
          data
        }
      }
    });
  } catch (err) {
    console.error('Error fetching analytics volume:', err);
    res.status(500).json({ error: 'Error fetching analytics volume' });
  }
});

// Analytics Distribution Endpoint
app.get('/api/analytics/distribution/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    const { data: distributionData, error } = await supabase
      .from('payments')
      .select(`
        amount_usdc,
        payment_links!inner(
          seller_id,
          chain
        )
      `)
      .eq('payment_links.seller_id', paramSellerId)
      .eq('status', 'confirmed');

    if (error) throw error;

    // Group by chain and calculate totals
    const chainTotals = distributionData.reduce((acc, curr) => {
      const chain = curr.payment_links.chain;
      acc[chain] = (acc[chain] || 0) + curr.amount_usdc;
      return acc;
    }, {});

    res.json({
      data: {
        distribution: Object.entries(chainTotals).map(([chain, totalVolume]) => ({
          chain,
          totalVolume
        }))
      }
    });
  } catch (err) {
    console.error('Error fetching analytics distribution:', err);
    res.status(500).json({ error: 'Error fetching analytics distribution' });
  }
});

// Get All Transactions Endpoint
app.get('/api/transactions/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    const { data: transactions, error } = await supabase
      .from('payments')
      .select(`
        transaction_hash,
        amount_usdc,
        created_at,
        payment_links!inner(
          seller_id,
          product_title
        )
      `)
      .eq('payment_links.seller_id', paramSellerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      data: {
        transactions: transactions.map(t => ({
          transaction_hash: t.transaction_hash,
          amount_usdc: t.amount_usdc,
          created_at: t.created_at,
          product_title: t.payment_links.product_title
        }))
      }
    });
  } catch (err) {
    console.error('Error fetching transactions:', err);
    res.status(500).json({ error: 'Error fetching transactions' });
  }
});

// Get Capital Summary Endpoint
app.get('/api/capital/summary/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    // Calculate Total Balance
    const { data: totalBalanceData, error: totalError } = await supabase
      .from('payments')
      .select('amount_usdc')
      .eq('status', 'confirmed')
      .eq('payment_links.seller_id', paramSellerId);

    if (totalError) throw totalError;

    const totalBalance = totalBalanceData.reduce((sum, p) => sum + p.amount_usdc, 0);

    // Calculate Incoming Capital (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: incomingData, error: incomingError } = await supabase
      .from('payments')
      .select('amount_usdc')
      .eq('status', 'confirmed')
      .eq('payment_links.seller_id', paramSellerId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    if (incomingError) throw incomingError;

    const incomingCapital = incomingData.reduce((sum, p) => sum + p.amount_usdc, 0);

    res.json({
      data: {
        totalBalance,
        incomingCapital30Days: incomingCapital,
        outgoingCapital30Days: 0 // Placeholder as there's no outgoing table
      }
    });
  } catch (err) {
    console.error('Error fetching capital summary:', err);
    res.status(500).json({ error: 'Error fetching capital summary' });
  }
});

// Get Capital Flow Endpoint
app.get('/api/capital/flow/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;
  const { period = '7d' } = req.query;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    const { start, end } = getDateRange(period);

    const { data: flowData, error } = await supabase
      .from('payments')
      .select('amount_usdc, created_at')
      .eq('status', 'confirmed')
      .eq('payment_links.seller_id', paramSellerId)
      .gte('created_at', start)
      .lte('created_at', end);

    if (error) throw error;

    // Group by date
    const dateMap = flowData.reduce((acc, curr) => {
      const date = curr.created_at.split('T')[0];
      acc[date] = (acc[date] || 0) + curr.amount_usdc;
      return acc;
    }, {});

    // Fill in missing dates
    const allDates = [];
    let currentDate = new Date(start);
    while (currentDate <= new Date(end)) {
      allDates.push(currentDate.toISOString().split('T')[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const labels = allDates;
    const incoming = allDates.map(date => dateMap[date] || 0);
    const outgoing = allDates.map(() => 0); // Placeholder for outgoing data

    res.json({
      data: {
        flow: {
          labels,
          incoming,
          outgoing
        }
      }
    });
  } catch (err) {
    console.error('Error fetching capital flow:', err);
    res.status(500).json({ error: 'Error fetching capital flow' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});