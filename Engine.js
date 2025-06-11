import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import csrf from 'csurf';
import cookieParser from 'cookie-parser';
import { authenticateToken } from './authMiddleware.js';
import { initDB, query, withTransaction } from './db.js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { validateRequest } from './security.js';
import stripe from './Stripe.js';
dotenv.config();

const app = express();
const PORT = 3000;

// Security middleware
app.use(helmet()); // Adds various HTTP headers for security
app.use(cookieParser()); // Parse cookies

// Global rate limiting (100 requests per 15 minutes per IP)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use(globalLimiter);

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
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

// In-memory storage for payment links
const paymentLinks = {};

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
      await query(async (db) => {
        // Count how many links this seller already created
        const count = await db.get(
          'SELECT COUNT(*) AS total FROM payment_links WHERE seller_id = ?',
          seller_id
        );

        const maxLinksByPlan = {
          basic: 1,
          pro: 30,
          elite: Infinity
        };

        const maxAllowed = maxLinksByPlan[plan] ?? 0;

        if (count.total >= maxAllowed) {
          return res.status(403).json({ error: 'Link limit reached for your plan' });
        }

        const link_id = 'link_' + generateId(9);

        await db.run(
          `INSERT INTO payment_links (
            link_id, wallet_address, amount_usdc, chain, 
            product_title, seller_id, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            link_id,
            wallet_address,
            amount_usdc,
            chain,
            product_title,
            seller_id,
            'pending',
            new Date().toISOString()
          ]
        );

        res.json({ data: { link_id } });
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

// Validation rules for /submit-buyer-info
const submitBuyerInfoValidationRules = [
  body('link_id').notEmpty().withMessage('Link ID is required'),
  body('first_name').notEmpty().withMessage('First name is required'),
  body('last_name').notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('Invalid email format'),
  body('address').optional().isString().withMessage('Address must be a string'), // Address is optional
];

app.post('/submit-buyer-info',
  submitBuyerInfoValidationRules, // Add validation rules
  validateRequest, // Add validation request middleware
  async (req, res) => {
    const { link_id, first_name, last_name, email, address } = req.body;

    try {
      await query(async (db) => {
        const paymentLink = await db.get(
          'SELECT id FROM payment_links WHERE link_id = ?',
          link_id
        );

        if (!paymentLink) {
          return res.status(404).json({ error: 'Invalid link ID' });
        }

        await db.run(
          `INSERT INTO buyers (
            payment_link_id, first_name, last_name, email, address, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            paymentLink.id,
            first_name,
            last_name,
            email,
            address,
            new Date().toISOString()
          ]
        );

        res.json({ data: { message: 'Buyer info saved' } });
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

app.get('/payment-info/:link_id', async (req, res) => {
  const { link_id } = req.params;

  try {
    await query(async (db) => {
      const link = await db.get(
        'SELECT product_title, amount_usdc, wallet_address, chain FROM payment_links WHERE link_id = ?',
        link_id
      );

      if (!link) {
        return res.status(404).json({ error: 'Link not found' });
      }

      res.json({ data: link });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Validation rules for /i-paid and /verify-payment
const linkIdValidationRule = body('link_id').notEmpty().withMessage('Link ID is required');

app.post('/i-paid',
  linkIdValidationRule, // Add validation rule
  validateRequest, // Add validation request middleware
  async (req, res) => {
    const { link_id } = req.body;

    try {
      await query(async (db) => {
        const link = await db.get(
          'SELECT id FROM payment_links WHERE link_id = ?',
          link_id
        );

        if (!link) {
          return res.status(404).json({ error: 'Invalid link ID' });
        }

        await db.run(
          'UPDATE payment_links SET status = ? WHERE id = ?',
          ['verifying', link.id]
        );

        res.json({ data: { message: 'Payment confirmation started' } });
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

app.post('/verify-payment',
  linkIdValidationRule, // Add validation rule
  validateRequest, // Add validation request middleware
  async (req, res) => {
    const { link_id } = req.body;

    try {
      await query(async (db) => {
        const link = await db.get(
          'SELECT id, wallet_address, amount_usdc, chain FROM payment_links WHERE link_id = ?',
          link_id
        );

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
          const existingPayment = await db.get(
            'SELECT id FROM payments WHERE transaction_hash = ?',
            result.hash
          );

          if (!existingPayment) {
            await withTransaction(async (db) => {
              // Create payment record
              await db.run(
                `INSERT INTO payments (
                  payment_link_id, transaction_hash, amount_usdc, 
                  status, confirmed_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  link.id,
                  result.hash,
                  link.amount_usdc,
                  'confirmed',
                  new Date().toISOString(),
                  new Date().toISOString()
                ]
              );

              // Update payment link status
              await db.run(
                'UPDATE payment_links SET status = ? WHERE id = ?',
                ['paid', link.id]
              );
            });
          }

          return res.json({ data: { confirmed: true, transaction_hash: result.hash } });
        }

        res.json({ data: { confirmed: false } });
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

// Enhanced /dashboard route with plan-based access
app.get('/dashboard/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId, plan } = req.user;

  // Ensure the authenticated user is only accessing their own dashboard
  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    const db = await initDB();

    const links = await db.all(
      `SELECT * FROM payment_links WHERE seller_id = ? ORDER BY created_at DESC`,
      paramSellerId
    );

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
    console.error(err);
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
      start.setDate(now.getDate() - 7); // Default to 7 days
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
  // const { period = '7d' } = req.query; // Period is not used in overview

  // Ensure the authenticated user is only accessing their own analytics
  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    await query(async (db) => {
      // Calculate Total USDC Earned, Total Transactions, Successful Transactions, Average Transaction Value
      const overviewStats = await db.get(
        `SELECT 
           SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_usdc ELSE 0 END) AS totalUsdc,
           COUNT(p.id) AS totalTransactions,
           SUM(CASE WHEN p.status = 'confirmed' THEN 1 ELSE 0 END) AS successfulTransactions,
           AVG(CASE WHEN p.status = 'confirmed' THEN p.amount_usdc ELSE 0 END) AS avgTransaction
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ?`,
        paramSellerId
      );

       // Get Payment Link Summary (Active/Pending and Total Generated Value)
       const linkSummary = await db.get(
         `SELECT 
            COUNT(id) AS totalLinks,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingLinks,
            SUM(amount_usdc) AS totalGeneratedValue /* This might need refinement based on if links expire or are one-time use */
          FROM payment_links
          WHERE seller_id = ?`,
         paramSellerId
       );

      res.json({
        data: {
          stats: {
            totalUsdc: overviewStats.totalUsdc || 0,
            totalTransactions: overviewStats.totalTransactions || 0,
            successfulTransactions: overviewStats.successfulTransactions || 0,
            avgTransaction: overviewStats.avgTransaction || 0
          },
          paymentLinkSummary: {
            totalLinks: linkSummary.totalLinks || 0,
            activeLinks: linkSummary.pendingLinks || 0, // Assuming 'pending' means active for now
            totalGeneratedValue: linkSummary.totalGeneratedValue || 0
          }
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching analytics overview' });
  }
});

// Analytics Volume Endpoint
app.get('/api/analytics/volume/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;
  const { period = '7d' } = req.query;

  // Ensure the authenticated user is only accessing their own analytics
  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    const { start, end } = getDateRange(period);

    await query(async (db) => {
      // Fetch confirmed payments within the date range
      const volumeData = await db.all(
        `SELECT 
           SUM(p.amount_usdc) AS totalVolume,
           STRFTIME('%Y-%m-%d', p.created_at) AS date
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'confirmed' AND p.created_at BETWEEN ? AND ?
         GROUP BY date
         ORDER BY date ASC`,
        paramSellerId, start, end
      );

      // Format data for chart.js (fill in missing dates with zero volume)
      const dateMap = volumeData.reduce((acc, curr) => {
        acc[curr.date] = curr.totalVolume;
        return acc;
      }, {});

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
            labels: labels,
            data: data
          }
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching analytics volume' });
  }
});

// Analytics Distribution Endpoint (Placeholder, as dashboard didn't explicitly show this)
app.get('/api/analytics/distribution/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    await query(async (db) => {
      // Example: Distribution by Chain
      const distributionData = await db.all(
        `SELECT 
           pl.chain,
           SUM(p.amount_usdc) AS totalVolume
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'confirmed'
         GROUP BY pl.chain`,
        paramSellerId
      );

      res.json({
        data: {
          distribution: distributionData
        }
      });
    });
  } catch (err) {
    console.error(err);
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
    await query(async (db) => {
      const transactions = await db.all(
        `SELECT 
           p.transaction_hash,
           p.amount_usdc,
           p.created_at,
           pl.product_title
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ?
         ORDER BY p.created_at DESC`,
        paramSellerId
      );

      res.json({
        data: {
          transactions: transactions
        }
      });
    });
  } catch (err) {
    console.error(err);
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
    await query(async (db) => {
      // Calculate Total Balance (sum of all confirmed payments)
      const totalBalanceResult = await db.get(
        `SELECT SUM(amount_usdc) AS totalBalance
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'confirmed'`,
        paramSellerId
      );

      // Calculate Incoming Capital (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const incomingCapitalResult = await db.get(
        `SELECT SUM(p.amount_usdc) AS incomingCapital
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'confirmed' AND p.created_at >= ?`,
        paramSellerId, thirtyDaysAgo.toISOString()
      );

      // Outgoing Capital (assuming you have a table/way to track outgoing funds)
      // Placeholder for now, as there's no explicit 'outgoing' table in db.js
      const outgoingCapital = 0; // Replace with actual query if applicable

      res.json({
        data: {
          totalBalance: totalBalanceResult.totalBalance || 0,
          incomingCapital30Days: incomingCapitalResult.incomingCapital || 0,
          outgoingCapital30Days: outgoingCapital // Placeholder
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching capital summary' });
  }
});

// Get Capital Flow Endpoint (Placeholder - requires more complex time-series aggregation)
app.get('/api/capital/flow/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;
  const { period = '7d' } = req.query;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    const { start, end } = getDateRange(period);

     // This is a simplified placeholder. Real implementation would need
     // to aggregate confirmed payments over time and potentially integrate
     // outgoing transactions if tracked.

    const flowData = await query(async (db) => {
         return db.all(
             `SELECT 
                STRFTIME('%Y-%m-%d', p.created_at) AS date,
                SUM(p.amount_usdc) AS incoming
              FROM payments p
              JOIN payment_links pl ON p.payment_link_id = pl.id
              WHERE pl.seller_id = ? AND p.status = 'confirmed' AND p.created_at BETWEEN ? AND ?
              GROUP BY date
              ORDER BY date ASC`,
             paramSellerId, start, end
         );
     });

     // Format data for chart.js (placeholder for outgoing)
     const dateMap = flowData.reduce((acc, curr) => {
       acc[curr.date] = { incoming: curr.incoming, outgoing: 0 }; // Placeholder outgoing
       return acc;
     }, {});

     const allDates = [];
     let currentDate = new Date(start);
     while (currentDate <= new Date(end)) {
       allDates.push(currentDate.toISOString().split('T')[0]);
       currentDate.setDate(currentDate.getDate() + 1);
     }

     const labels = allDates;
     const incomingData = allDates.map(date => dateMap[date]?.incoming || 0);
     const outgoingData = allDates.map(date => dateMap[date]?.outgoing || 0); // Placeholder

     res.json({
       data: {
         flow: {
           labels: labels,
           incoming: incomingData,
           outgoing: outgoingData
         }
       }
     });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching capital flow' });
  }
});

// Get Connected Accounts Endpoint (Assumes an 'accounts' table with seller_id and balance)
app.get('/api/accounts/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    await query(async (db) => {
      // This assumes an 'accounts' table exists with seller_id, wallet_address, chain, and balance_usdc
      // If not, this query will need adjustment based on how accounts are stored.
      const accounts = await db.all(
        `SELECT wallet_address, chain, balance_usdc 
         FROM accounts 
         WHERE seller_id = ?`,
        paramSellerId
      );

      res.json({
        data: {
          accounts: accounts
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching connected accounts' });
  }
});

// Get Capital by Chain Endpoint
app.get('/api/capital/by-chain/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    await query(async (db) => {
      const capitalByChain = await db.all(
        `SELECT 
           pl.chain,
           SUM(p.amount_usdc) AS totalVolume
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'confirmed'
         GROUP BY pl.chain`,
        paramSellerId
      );

      res.json({
        data: {
          capitalByChain: capitalByChain
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching capital by chain' });
  }
});

// Get Recent Capital Movements Endpoint (Similar to recent transactions, but might include outgoing if tracked)
app.get('/api/capital/recent-movements/:seller_id', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    await query(async (db) => {
      // Fetch recent confirmed payments
      const recentMovements = await db.all(
        `SELECT 
           p.transaction_hash,
           p.amount_usdc,
           p.created_at,
           pl.product_title
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'confirmed'
         ORDER BY p.created_at DESC
         LIMIT 10`,
        paramSellerId
      );

      res.json({
        data: {
          recentMovements: recentMovements
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching recent capital movements' });
  }
});

// Get Specific Account Summary Endpoint (Requires an account ID)
app.get('/api/accounts/:account_id/summary', authenticateToken, async (req, res) => {
  const { account_id } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  try {
    await query(async (db) => {
       // Verify the account belongs to the authenticated seller
       const account = await db.get(
         `SELECT wallet_address, chain, balance_usdc
          FROM accounts
          WHERE id = ? AND seller_id = ?`,
         account_id, tokenSellerId
       );

       if (!account) {
         return res.status(404).json({ error: 'Account not found or does not belong to seller' });
       }

       // Assuming 'status' is derived or stored elsewhere, for now a placeholder
       const status = 'Active'; // Placeholder

       res.json({
         data: {
           walletAddress: account.wallet_address,
           chain: account.chain,
           balance: account.balance_usdc || 0,
           status: status
         }
       });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching account summary' });
  }
});

// Get Recent Activity for Specific Account Endpoint
app.get('/api/accounts/:account_id/activity', authenticateToken, async (req, res) => {
  const { account_id } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  try {
    await query(async (db) => {
      // Verify the account belongs to the authenticated seller
      const account = await db.get(
        `SELECT id FROM accounts WHERE id = ? AND seller_id = ?`,
        account_id, tokenSellerId
      );

      if (!account) {
        return res.status(404).json({ error: 'Account not found or does not belong to seller' });
      }

      // Fetch payments associated with this account's wallet address
      // This is a simplified approach; a more robust solution might track
      // all related transactions (incoming/outgoing) directly linked to the account ID.
      const recentActivity = await db.all(
        `SELECT 
           p.transaction_hash,
           p.amount_usdc,
           p.created_at,
           pl.product_title
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.wallet_address = (SELECT wallet_address FROM accounts WHERE id = ?) AND pl.seller_id = ?
         ORDER BY p.created_at DESC
         LIMIT 10`,
        account_id, tokenSellerId
      );

      // Format activity - assuming all found are incoming payments for simplicity
      const formattedActivity = recentActivity.map(activity => ({
        type: 'received', // Simplified: assuming all are received payments for this example
        description: activity.product_title || 'Payment Received',
        amount_usdc: activity.amount_usdc,
        date: new Date(activity.created_at).toLocaleDateString(),
        transaction_hash: activity.transaction_hash
      }));

      res.json({
        data: {
          activity: formattedActivity
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching account activity' });
  }
});

// Get Connected Payment Links for Specific Account Endpoint
app.get('/api/accounts/:account_id/payment-links', authenticateToken, async (req, res) => {
  const { account_id } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  try {
    await query(async (db) => {
      // Verify the account belongs to the authenticated seller
      const account = await db.get(
        `SELECT id FROM accounts WHERE id = ? AND seller_id = ?`,
        account_id, tokenSellerId
      );

      if (!account) {
        return res.status(404).json({ error: 'Account not found or does not belong to seller' });
      }

      // Fetch payment links created using this account's wallet address
      const connectedPaymentLinks = await db.all(
        `SELECT 
           link_id,
           amount_usdc,
           product_title,
           status
         FROM payment_links
         WHERE wallet_address = (SELECT wallet_address FROM accounts WHERE id = ?) AND seller_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
        account_id, tokenSellerId
      );

      res.json({
        data: {
          paymentLinks: connectedPaymentLinks
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching connected payment links' });
  }
});

// Get Most Used Wallet Addresses for Seller Endpoint
app.get('/api/accounts/:seller_id/most-used-wallets', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    await query(async (db) => {
      // This query counts how many payment links were created to each unique wallet address by the seller.
      // A more advanced query could analyze transaction history for wallets interacted with.
      const mostUsedWallets = await db.all(
        `SELECT 
           wallet_address,
           chain,
           COUNT(id) AS count
         FROM payment_links
         WHERE seller_id = ?
         GROUP BY wallet_address, chain
         ORDER BY count DESC
         LIMIT 5`,
        paramSellerId
      );

      res.json({
        data: {
          mostUsedWallets: mostUsedWallets
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching most used wallets' });
  }
});

// Get Seller's Email Address Endpoint
app.get('/api/users/:seller_id/email', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId, email } = req.user; // Email is already in token

  // Ensure the authenticated user is only accessing their own email
  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  // Email is available directly from the authenticated user object
  res.json({
    data: {
      email: email
    }
  });
});

// Get Seller's Favorite Network Endpoint (Based on the chain used most in payment links)
// app.get('/api/accounts/:seller_id/favorite-network', authenticateToken, async (req, res) => {
//   const { seller_id: paramSellerId } = req.params;
//   const { seller_id: tokenSellerId } = req.user;
//
//   if (paramSellerId !== tokenSellerId) {
//     return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
//   }
//
//   try {
//     await query(async (db) => {
//       const favoriteNetwork = await db.get(
//         `SELECT chain, COUNT(id) AS count
//          FROM payment_links
//          WHERE seller_id = ?
//          GROUP BY chain
//          ORDER BY count DESC
//          LIMIT 1`,
//         paramSellerId
//       );
//
//       res.json({
//         data: {
//           favoriteNetwork: favoriteNetwork ? favoriteNetwork.chain : 'N/A'
//         }
//       });
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Error fetching favorite network' });
//   }
// });

// Get Capital Distribution Endpoint
app.get('/api/capital/:seller_id/distribution', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    await query(async (db) => {
      // Get available balance (confirmed payments)
      const availableBalance = await db.get(
        `SELECT SUM(p.amount_usdc) AS total
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'confirmed'`,
        paramSellerId
      );

      // Get in transit balance (pending payments)
      const inTransit = await db.get(
        `SELECT SUM(p.amount_usdc) AS total
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'pending'`,
        paramSellerId
      );

      // Get reserved balance (reserved for future use)
      const reserved = await db.get(
        `SELECT SUM(p.amount_usdc) AS total
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? AND p.status = 'reserved'`,
        paramSellerId
      );

      res.json({
        success: true,
        data: {
          available: availableBalance.total || 0,
          in_transit: inTransit.total || 0,
          reserved: reserved.total || 0
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching capital distribution' });
  }
});

// Get Capital Trends Endpoint
app.get('/api/capital/:seller_id/trends', authenticateToken, async (req, res) => {
  const { seller_id: paramSellerId } = req.params;
  const { seller_id: tokenSellerId } = req.user;

  if (paramSellerId !== tokenSellerId) {
    return res.status(403).json({ error: 'Access denied: seller ID mismatch' });
  }

  try {
    await query(async (db) => {
      // Get last 6 months of data
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      // Get incoming trends
      const incomingTrends = await db.all(
        `SELECT 
           STRFTIME('%Y-%m', p.created_at) AS month,
           SUM(p.amount_usdc) AS total
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? 
         AND p.status = 'confirmed'
         AND p.created_at >= ?
         GROUP BY month
         ORDER BY month ASC`,
        paramSellerId, sixMonthsAgo.toISOString()
      );

      // Get outgoing trends (if you have outgoing transactions)
      const outgoingTrends = await db.all(
        `SELECT 
           STRFTIME('%Y-%m', p.created_at) AS month,
           SUM(p.amount_usdc) AS total
         FROM payments p
         JOIN payment_links pl ON p.payment_link_id = pl.id
         WHERE pl.seller_id = ? 
         AND p.status = 'sent'
         AND p.created_at >= ?
         GROUP BY month
         ORDER BY month ASC`,
        paramSellerId, sixMonthsAgo.toISOString()
      );

      // Format months for labels
      const months = incomingTrends.map(trend => {
        const [year, month] = trend.month.split('-');
        return new Date(year, month - 1).toLocaleString('default', { month: 'short' });
      });

      // Format data for charts
      const incomingData = incomingTrends.map(trend => trend.total || 0);
      const outgoingData = outgoingTrends.map(trend => trend.total || 0);

      res.json({
        success: true,
        data: {
          labels: months,
          incoming: incomingData,
          outgoing: outgoingData
        }
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching capital trends' });
  }
});

// Account insights endpoints
app.get('/api/account/:sellerId/insights',
  authenticateToken,
  async (req, res) => {
    const { sellerId } = req.params;

    try {
      await query(async (db) => {
        const insights = await db.get(
          `SELECT * FROM account_insights WHERE seller_id = ?`,
          sellerId
        );

        if (!insights) {
          // Calculate initial insights if not exists
          const accountAge = await db.get(
            `SELECT julianday('now') - julianday(created_at) as age_days 
             FROM users WHERE id = ?`,
            sellerId
          );

          const activityCount = await db.get(
            `SELECT COUNT(*) as count FROM user_activity WHERE seller_id = ?`,
            sellerId
          );

          const securityScore = await calculateSecurityScore(db, sellerId);

          const activityLevel = activityCount.count > 10 ? 'high' : 
                              activityCount.count > 5 ? 'medium' : 'low';

          await db.run(
            `INSERT INTO account_insights (
              seller_id, security_score, activity_level, 
              account_age_days, verification_status
            ) VALUES (?, ?, ?, ?, ?)`,
            [
              sellerId,
              securityScore,
              activityLevel,
              Math.floor(accountAge.age_days),
              'verified'
            ]
          );

          return res.json({
            data: {
              security_score: securityScore,
              activity_level: activityLevel,
              account_age_days: Math.floor(accountAge.age_days),
              verification_status: 'verified'
            }
          });
        }

        res.json({ data: insights });
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// FAQ endpoints
app.get('/api/faqs',
  async (req, res) => {
    const { category } = req.query;

    try {
      await query(async (db) => {
        const faqs = await db.all(
          `SELECT * FROM faqs 
           ${category ? 'WHERE category = ?' : ''}
           ORDER BY priority DESC, created_at DESC`,
          category ? [category] : []
        );

        res.json({ data: faqs });
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// User activity endpoints
app.get('/api/account/:sellerId/activity',
  authenticateToken,
  async (req, res) => {
    const { sellerId } = req.params;
    const { limit = 10, offset = 0 } = req.query;

    try {
      await query(async (db) => {
        const activities = await db.all(
          `SELECT * FROM user_activity 
           WHERE seller_id = ?
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`,
          [sellerId, limit, offset]
        );

        const total = await db.get(
          `SELECT COUNT(*) as count FROM user_activity WHERE seller_id = ?`,
          sellerId
        );

        res.json({
          data: activities,
          meta: {
            total: total.count,
            limit: parseInt(limit),
            offset: parseInt(offset)
          }
        });
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Security events endpoints
app.get('/api/account/:sellerId/security-events',
  authenticateToken,
  async (req, res) => {
    const { sellerId } = req.params;
    const { severity } = req.query;

    try {
      await query(async (db) => {
        const events = await db.all(
          `SELECT * FROM security_events 
           WHERE seller_id = ?
           ${severity ? 'AND severity = ?' : ''}
           ORDER BY created_at DESC`,
          severity ? [sellerId, severity] : [sellerId]
        );

        res.json({ data: events });
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Helper function to calculate security score
async function calculateSecurityScore(db, sellerId) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', sellerId);
  let score = 0;

  // Email verification
  if (user.is_email_verified) score += 20;

  // 2FA (if implemented)
  // if (user.has_2fa) score += 30;

  // Account age
  const accountAge = await db.get(
    `SELECT julianday('now') - julianday(created_at) as age_days 
     FROM users WHERE id = ?`,
    sellerId
  );
  if (accountAge.age_days > 30) score += 20;
  else if (accountAge.age_days > 7) score += 10;

  // Activity level
  const activityCount = await db.get(
    `SELECT COUNT(*) as count FROM user_activity WHERE seller_id = ?`,
    sellerId
  );
  if (activityCount.count > 10) score += 20;
  else if (activityCount.count > 5) score += 10;

  // Security events
  const securityEvents = await db.get(
    `SELECT COUNT(*) as count FROM security_events 
     WHERE seller_id = ? AND severity = 'high'`,
    sellerId
  );
  score -= securityEvents.count * 10;

  return Math.max(0, Math.min(100, score));
}

// Unsubscribe from current plan
app.post('/api/subscription/:sellerId/unsubscribe', authenticateToken, async (req, res) => {
  const { sellerId } = req.params;
  const { email } = req.user;

  try {
    await query(async (db) => {
      // Get current subscription
      const subscription = await db.get(`
        SELECT stripe_subscription_id, plan_name, status
        FROM subscriptions
        WHERE seller_id = ? AND status = 'active'
      `, sellerId);

      if (!subscription) {
        return res.status(404).json({
          success: false,
          message: 'No active subscription found'
        });
      }

      // Only allow unsubscribing from paid plans
      if (subscription.plan_name.toLowerCase() === 'basic') {
        return res.status(400).json({
          success: false,
          message: 'Cannot unsubscribe from the basic plan'
        });
      }

      // Cancel the subscription at period end
      const stripeSubscription = await stripe.subscriptions.update(
        subscription.stripe_subscription_id,
        { cancel_at_period_end: true }
      );

      // Update subscription in database
      await db.run(`
        UPDATE subscriptions
        SET cancel_at_period_end = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE seller_id = ?
      `, sellerId);

      // Log the action
      await db.run(`
        INSERT INTO subscription_logs (seller_id, action, details)
        VALUES (?, 'unsubscribe', ?)
      `, sellerId, JSON.stringify({
        plan: subscription.plan_name,
        cancel_at: stripeSubscription.cancel_at,
        current_period_end: stripeSubscription.current_period_end
      }));

      res.json({
        success: true,
        message: 'Successfully unsubscribed',
        data: {
          cancel_at: stripeSubscription.cancel_at,
          current_period_end: stripeSubscription.current_period_end
        }
      });
    });
  } catch (error) {
    console.error('Error unsubscribing:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unsubscribe'
    });
  }
});

// Save buyer information before payment
app.post('/api/payment-links/:linkId/buyer', async (req, res) => {
    const { linkId } = req.params;
    const buyerDetails = req.body;

    try {
        await query(async (db) => {
            // Verify the payment link exists and is active
            const paymentLink = await db.get(`
                SELECT id, status
                FROM payment_links
                WHERE id = ? AND status = 'active'
            `, linkId);

            if (!paymentLink) {
                return res.status(404).json({
                    success: false,
                    message: 'Payment link not found or inactive'
                });
            }

            // Save buyer details
            await db.run(`
                UPDATE payment_links
                SET buyer_name = ?,
                    buyer_email = ?,
                    buyer_address = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, 
            buyerDetails.name,
            buyerDetails.email,
            JSON.stringify(buyerDetails.address),
            linkId
            );

            res.json({
                success: true,
                message: 'Buyer details saved successfully'
            });
        });
    } catch (error) {
        console.error('Error saving buyer details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save buyer details'
        });
    }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Ensure the database is initialized when the server starts
initDB().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Export initDB for potential external use (e.g., testing)
export { initDB };