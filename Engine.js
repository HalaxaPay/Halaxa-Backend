import cors from 'cors';
import helmet from 'helmet';
import csrf from 'csurf';
import cookieParser from 'cookie-parser';
import { authenticateToken } from './authMiddleware.js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { validateRequest } from './security.js';
import stripe from './Stripe.js';
import { supabase } from './supabase.js';

dotenv.config();

console.log('ENGINE.JS: Payment verification engine loading...');
console.log('📊 NOTE: Dashboard calculations moved to calculation-engine.js for real-time blockchain data');

// ==================== HALAXA PAYMENT VERIFICATION ENGINE ==================== //

// Alchemy API Endpoints
const POLYGON_ALCHEMY_URL = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POLYGON_API_KEY}`;
const SOLANA_ALCHEMY_URL = `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_SOLANA_API_KEY}`;

// USDC Contract Addresses  
const POLYGON_USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Helper to generate unique IDs that fit database constraints
function generateId(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export const HalaxaEngine = {
  
  // ==================== BLOCKCHAIN PAYMENT VERIFICATION ==================== //
  
  /**
   * Check for USDC transfers on Polygon Network
   * Returns array of transactions with unique hashes for verification
   */
  async checkPolygonUSDCTransfers(wallet_address, amount_usdc, timeframe_minutes = 30) {
    try {
  const payload = {
    jsonrpc: '2.0',
        id: 1,
    method: 'alchemy_getAssetTransfers',
    params: [
      {
            toAddress: wallet_address.toLowerCase(),
        category: ['erc20'],
            contractAddresses: [POLYGON_USDC_CONTRACT],
            maxCount: 100, // Check more transactions for accuracy
            withMetadata: true,
            excludeZeroValue: true
          }
        ]
      };

      const response = await fetch(POLYGON_ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
      
      if (!data.result || !data.result.transfers) {
        return { success: false, error: 'No transfers found' };
      }

      const transfers = data.result.transfers;
      const expectedValue = Math.round(amount_usdc * 1_000_000); // USDC has 6 decimals
      const timeframeCutoff = new Date(Date.now() - (timeframe_minutes * 60 * 1000));

      // Find matching transactions
      const matchingTransfers = transfers.filter(transfer => {
        // Check amount match (allow small tolerance for rounding)
        const transferValue = Number(transfer.rawContract?.value || 0);
        const amountMatch = Math.abs(transferValue - expectedValue) <= 5000; // 0.5 USDC tolerance
        
        // Check if transaction is within timeframe
        const transferTime = new Date(transfer.metadata?.blockTimestamp || 0);
        const timeMatch = transferTime >= timeframeCutoff;
        
        return amountMatch && timeMatch && transfer.hash;
      });

      return {
        success: true,
        transfers: matchingTransfers.map(transfer => ({
          hash: transfer.hash,
          amount: Number(transfer.rawContract?.value || 0) / 1_000_000,
          from: transfer.from,
          to: transfer.to,
          timestamp: transfer.metadata?.blockTimestamp,
          blockNumber: transfer.blockNum,
          network: 'Polygon'
        }))
      };

    } catch (error) {
      console.error('Error checking Polygon USDC transfers:', error);
      return { success: false, error: 'Failed to check Polygon transfers' };
    }
  },

  /**
   * Check for USDC transfers on Solana Network
   * Returns array of transactions with unique signatures for verification
   */
  async checkSolanaUSDCTransfers(wallet_address, amount_usdc, timeframe_minutes = 30) {
    try {
      // Get recent transactions for the wallet
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [
          wallet_address,
          {
            limit: 100 // Check more signatures for accuracy
          }
        ]
      };

      const response = await fetch(SOLANA_ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      
      if (!data.result) {
        return { success: false, error: 'No transactions found' };
      }

      const signatures = data.result;
      const expectedAmount = amount_usdc;
      const timeframeCutoff = Date.now() / 1000 - (timeframe_minutes * 60); // Solana uses Unix timestamp

      const matchingTransfers = [];

      // Check each transaction for USDC transfers
      for (const sig of signatures) {
        if (sig.blockTime < timeframeCutoff) continue; // Skip old transactions
        
        try {
          // Get detailed transaction info
          const txPayload = {
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [
              sig.signature,
              {
                encoding: 'jsonParsed',
                maxSupportedTransactionVersion: 0
              }
            ]
          };

          const txResponse = await fetch(SOLANA_ALCHEMY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(txPayload)
          });

          const txData = await txResponse.json();
          
          if (!txData.result) continue;

          const transaction = txData.result;
          const instructions = transaction.transaction?.message?.instructions || [];

          // Look for USDC transfer instructions
          for (const instruction of instructions) {
            if (instruction.parsed?.type === 'transfer' || instruction.parsed?.type === 'transferChecked') {
              const info = instruction.parsed.info;
              
              // Check if it's USDC and correct amount
              if (info?.mint === SOLANA_USDC_MINT || instruction.program === 'spl-token') {
                const transferAmount = info?.tokenAmount?.uiAmount || info?.amount / 1_000_000;
                
                if (Math.abs(transferAmount - expectedAmount) <= 0.5) { // 0.5 USDC tolerance
                  matchingTransfers.push({
                    hash: sig.signature,
                    amount: transferAmount,
                    from: info?.source || info?.authority,
                    to: info?.destination,
                    timestamp: sig.blockTime,
                    slot: sig.slot,
                    network: 'Solana'
                  });
                }
              }
            }
          }
        } catch (txError) {
          console.warn('Error processing Solana transaction:', txError);
          continue;
        }
      }

      return {
        success: true,
        transfers: matchingTransfers
      };

    } catch (error) {
      console.error('Error checking Solana USDC transfers:', error);
      return { success: false, error: 'Failed to check Solana transfers' };
    }
  },

  // ==================== PAYMENT VERIFICATION ORCHESTRATOR ==================== //

  /**
   * Verify a payment across networks
   * Primary verification method used by UI
   */
  async verifyPayment(payment_link_id, wallet_address, amount_usdc, network, timeframe_minutes = 30) {
    try {
      console.log(`🔍 Verifying payment: ${amount_usdc} USDC on ${network} to ${wallet_address}`);
      
      let verificationResult;
      
      // Choose verification method based on network
      if (network.toLowerCase() === 'polygon') {
        verificationResult = await this.checkPolygonUSDCTransfers(wallet_address, amount_usdc, timeframe_minutes);
      } else if (network.toLowerCase() === 'solana') {
        verificationResult = await this.checkSolanaUSDCTransfers(wallet_address, amount_usdc, timeframe_minutes);
      } else {
        return { success: false, error: 'Unsupported network' };
      }

      if (!verificationResult.success) {
        return verificationResult;
      }

      const transfers = verificationResult.transfers || [];
      
      if (transfers.length === 0) {
        return {
          success: false, 
          error: 'No matching payments found',
          verified: false,
          searched_timeframe: timeframe_minutes,
          searched_amount: amount_usdc,
          searched_network: network
        };
      }

      // Payment found - store verification result
      const verifiedTransfer = transfers[0]; // Use the first match

      // Store in payments table
      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .insert([{
          payment_link_id,
          tx_hash: verifiedTransfer.hash,
          amount_usdc: verifiedTransfer.amount,
          network: network.toLowerCase(),
          from_address: verifiedTransfer.from,
          to_address: verifiedTransfer.to,
          status: 'confirmed',
          verified_at: new Date().toISOString(),
          block_number: verifiedTransfer.blockNumber || null,
          block_timestamp: verifiedTransfer.timestamp
        }])
        .select()
        .single();

      if (paymentError) {
        console.error('Error storing payment:', paymentError);
        // Don't fail verification if storage fails
      }

      return {
        success: true,
        verified: true,
        payment: verifiedTransfer,
        confirmation: payment || null,
        message: `Payment verified: ${verifiedTransfer.amount} USDC on ${network}`
      };

    } catch (error) {
      console.error('Payment verification error:', error);
      return { success: false, error: 'Verification failed' };
    }
  },

  // ==================== PAYMENT LINK MANAGEMENT ==================== //

  /**
   * Create a new payment link
   * Used by the payment link creation API
   */
  async createPaymentLink(user_data, link_data) {
    try {
      const { user_id, plan } = user_data;
      const { wallet_address, amount_usdc, network, product_title, description } = link_data;

      // 🚨 CRITICAL VALIDATION: Ensure user ID is present
      console.log("🔍 DEBUG - Validating user_id:", user_id);
      console.log("🔍 DEBUG - user_id type:", typeof user_id);
      console.log("🔍 DEBUG - user_id length:", user_id?.length);
      console.log("🔍 DEBUG - user_id truthy:", !!user_id);
      
      if (!user_id) {
        console.error('❌ CRITICAL: user_id is null or undefined!', { user_data, link_data });
        return { success: false, error: 'User authentication required - user_id missing' };
      }

      // 🚨 KEEP FULL UUID: Database expects UUID format
      const database_user_id = user_id;
      console.log(`🔗 Using full UUID for database: ${user_id}`);

      console.log("🔐 Creating payment link for user:", user_id);
      console.log("📊 User plan:", plan);
      console.log("💰 Payment link data:", { 
        wallet_address, 
        amount_usdc, 
        network, 
        product_title, 
        description 
      });

      // 🚨 CRITICAL VALIDATION: Check all required fields
      console.log("🔍 DEBUG - Validating link_data fields:");
      console.log("💰 amount_usdc:", amount_usdc, "type:", typeof amount_usdc);
      console.log("🏦 wallet_address:", wallet_address, "type:", typeof wallet_address);
      console.log("🌐 network:", network, "type:", typeof network);
      console.log("📛 product_title:", product_title, "type:", typeof product_title);
      console.log("📝 description:", description, "type:", typeof description);
      
      // Validate required fields
      if (!amount_usdc || isNaN(amount_usdc) || amount_usdc <= 0) {
        return { success: false, error: 'Invalid amount: must be a positive number' };
      }
      
      if (!wallet_address || typeof wallet_address !== 'string' || wallet_address.trim().length === 0) {
        return { success: false, error: 'Invalid wallet address: cannot be empty' };
      }
      
      if (!product_title || typeof product_title !== 'string' || product_title.trim().length === 0) {
        return { success: false, error: 'Invalid product title: cannot be empty' };
      }
      
      if (!network || typeof network !== 'string') {
        return { success: false, error: 'Invalid network: must be a string' };
      }

      // Validate network
      if (!['polygon', 'solana'].includes(network.toLowerCase())) {
        return { success: false, error: 'Network must be either Polygon or Solana' };
      }

      // Check plan limits
      const { count: linkCount, error: countError } = await supabase
        .from('payment_links')
        .select('*', { count: 'exact' })
        .eq('user_id', database_user_id)
        .eq('is_active', true);

      if (countError) {
        console.error('❌ Error checking payment link count:', countError);
        throw countError;
      }

      console.log(`📈 Current active links for database_user_id ${database_user_id}: ${linkCount}`);

      const planLimits = {
        basic: 1,
        pro: 30,
        elite: Infinity
      };

      const maxLinks = planLimits[plan] || 0;
      if (linkCount >= maxLinks) {
        console.log(`🚫 Plan limit reached: ${linkCount}/${maxLinks} for ${plan} plan`);
        return { success: false, error: `Plan limit reached. ${plan} plan allows ${maxLinks} active links.` };
      }

      // Generate unique link ID (6 characters to be safe for database constraint)
      const link_id = generateId(6);
      console.log("🆔 Generated link ID:", link_id);

      // 🚨 SIMPLIFIED: Only use user_id (removed seller_id as requested)
      // Using database_user_id to fit VARCHAR(8) constraint
      const insertData = {
          link_id,
          user_id: database_user_id,
          wallet_address: wallet_address.trim(),
          amount_usdc: parseFloat(amount_usdc),
          network: network.toLowerCase(),
          link_name: product_title.trim(),
          description: description?.trim() || '',
          is_active: true,
          created_at: new Date().toISOString()
      };

      console.log("💾 Inserting payment link data into Supabase:", insertData);

      // Create payment link
      const { data: paymentLink, error: linkError } = await supabase
        .from('payment_links')
        .insert([insertData])
        .select()
        .single();

      if (linkError) {
        console.error('❌ Supabase insert error:', linkError);
        console.error('❌ Failed insert data:', insertData);
        throw linkError;
      }

      console.log("✅ Payment link created successfully:", paymentLink);

      return {
        success: true,
        data: {
          link_id,
          payment_link: paymentLink,
          share_url: `https://halaxapay.com/Payment%20Page.html?link=${link_id}`
        }
      };

    } catch (error) {
      console.error('❌ Engine.js createPaymentLink error:', error);
      console.error('❌ Error type:', error.constructor.name);
      console.error('❌ Error message:', error.message);
      console.error('❌ Error stack:', error.stack);
      
      // Return specific error information
      return { 
        success: false, 
        error: 'Database error during payment link creation',
        details: error.message,
        debug_info: {
          error_type: error.constructor.name,
          timestamp: new Date().toISOString()
        }
      };
    }
  },

  // ==================== UI WORKFLOW FUNCTIONS ==================== //

  /**
   * Get payment link information for payment page
   * Used when buyer visits payment link
   */
  async getPaymentLinkInfo(link_id) {
    try {
      const { data: paymentLink, error } = await supabase
        .from('payment_links')
        .select('*')
        .eq('link_id', link_id)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return { success: false, error: 'Payment link not found or expired' };
        }
        throw error;
      }

      return {
        success: true,
        data: {
          link_id: paymentLink.link_id,
          wallet_address: paymentLink.wallet_address,
          amount_usdc: paymentLink.amount_usdc,
          network: paymentLink.network,
          product_title: paymentLink.product_title,
          description: paymentLink.description,
          status: paymentLink.status,
          created_at: paymentLink.created_at
        }
      };

    } catch (error) {
      console.error('Error fetching payment link info:', error);
      return { success: false, error: 'Failed to fetch payment link information' };
    }
  },

  /**
   * Mark payment as pending when user clicks "I Paid" button
   * Updates status and records user action
   */
  async markPaymentPending(link_id, buyer_info = null) {
    try {
      const { data: paymentLink, error: linkError } = await supabase
        .from('payment_links')
        .select('id, status')
        .eq('link_id', link_id)
        .single();

      if (linkError) {
        if (linkError.code === 'PGRST116') {
          return { success: false, error: 'Payment link not found' };
        }
        throw linkError;
      }

      // Update payment link status to pending verification
      const { error: updateError } = await supabase
        .from('payment_links')
        .update({ 
          status: 'pending_verification',
          updated_at: new Date().toISOString()
        })
        .eq('id', paymentLink.id);

      if (updateError) throw updateError;

      // Store buyer information if provided
      if (buyer_info) {
        const { error: buyerError } = await supabase
          .from('buyers')
          .insert([{
            payment_link_id: paymentLink.id,
            first_name: buyer_info.first_name,
            last_name: buyer_info.last_name,
            email: buyer_info.email,
            address: buyer_info.address || null,
            created_at: new Date().toISOString()
          }]);

        if (buyerError) {
          console.warn('Error storing buyer info:', buyerError);
          // Don't fail the whole operation if buyer info fails
        }
      }

      return {
        success: true,
        data: {
          link_id,
          status: 'pending_verification',
          message: 'Payment marked as pending. Starting verification process...'
        }
      };

    } catch (error) {
      console.error('Error marking payment as pending:', error);
      return { success: false, error: 'Failed to update payment status' };
    }
  },

  /**
   * Check payment status for UI updates
   * Returns current payment status and verification results
   */
  async checkPaymentStatus(link_id) {
    try {
      // Get payment link details
      const { data: paymentLink, error: linkError } = await supabase
        .from('payment_links')
        .select('*')
        .eq('link_id', link_id)
        .single();

      if (linkError) {
        if (linkError.code === 'PGRST116') {
          return { success: false, error: 'Payment link not found' };
        }
        throw linkError;
      }

      // Check if payment exists
      const { data: payment, error: paymentError } = await supabase
          .from('payments')
        .select('*')
        .eq('payment_link_id', paymentLink.id)
        .eq('status', 'confirmed')
        .order('created_at', { ascending: false })
        .limit(1);

      if (paymentError) throw paymentError;

      const isConfirmed = payment && payment.length > 0;

      return {
        success: true,
      data: {
          link_id,
          status: isConfirmed ? 'confirmed' : paymentLink.status || 'active',
          payment: isConfirmed ? payment[0] : null,
          payment_link: paymentLink
        }
      };

    } catch (error) {
      console.error('Error checking payment status:', error);
      return { success: false, error: 'Failed to check payment status' };
    }
  },

  /**
   * Process payment verification for a specific link
   * Combines buyer info processing with payment verification
   */
  async processPaymentVerification(link_id, buyer_info = null) {
    try {
      // First get payment link details
      const linkInfo = await this.getPaymentLinkInfo(link_id);
      if (!linkInfo.success) {
        return linkInfo;
      }

      const paymentLink = linkInfo.data;

      // Mark payment as pending
      const pendingResult = await this.markPaymentPending(link_id, buyer_info);
      if (!pendingResult.success) {
        return pendingResult;
      }

      // Attempt verification
      const verificationResult = await this.verifyPayment(
        link_id,
        paymentLink.wallet_address,
        paymentLink.amount_usdc,
        paymentLink.network,
        30 // 30 minute timeframe
      );

        return {
          success: true,
        data: {
          link_id,
          verification: verificationResult,
          pending_status: pendingResult.data
        }
      };

    } catch (error) {
      console.error('Error processing payment verification:', error);
      return { success: false, error: 'Failed to process payment verification' };
    }
  },

  // ==================== DATA FETCHING FUNCTIONS ==================== //
  // REMOVED: All UI update functions that used document.querySelector
  // These were causing "document is not defined" errors in Node.js backend
  // UI updates should be handled by the frontend (SPA.js) via API calls

  /**
   * Fetch user dashboard data
   * Backend-safe data aggregation function
   */
  async getUserDashboardData(user_id) {
    try {
      // Get basic user stats
      const { count: totalTransactions } = await supabase
        .from('transactions')
        .select('*', { count: 'exact' })
        .eq('user_id', user_id);

      const { count: activePaymentLinks } = await supabase
        .from('payment_links')
        .select('*', { count: 'exact' })
        .eq('user_id', user_id)
        .eq('is_active', true);

      // Get total USDC received
      const { data: incomingTxs } = await supabase
        .from('transactions')
        .select('amount_usdc')
        .eq('user_id', user_id)
        .eq('direction', 'in')
        .eq('status', 'confirmed');

      const totalUSDCReceived = (incomingTxs || []).reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0);

      return {
        success: true,
        data: {
          total_transactions: totalTransactions || 0,
          active_payment_links: activePaymentLinks || 0,
          total_usdc_received: totalUSDCReceived,
          user_id
        }
      };

    } catch (error) {
      console.error('Error fetching user dashboard data:', error);
      return { success: false, error: 'Failed to fetch dashboard data' };
    }
  },

  /**
   * Fetch user balance data across networks
   * Backend-safe balance calculation
   */
  async getUserBalanceData(user_id) {
    try {
      // Get all confirmed incoming transactions
      const { data: incomingTxs } = await supabase
        .from('transactions')
        .select('amount_usdc, network')
        .eq('user_id', user_id)
        .eq('direction', 'in')
        .eq('status', 'confirmed');

      // Get all confirmed outgoing transactions  
      const { data: outgoingTxs } = await supabase
        .from('transactions')
        .select('amount_usdc, network')
        .eq('user_id', user_id)
        .eq('direction', 'out')
        .eq('status', 'confirmed');

      // Calculate balances by network
      const balances = {};
      let totalBalance = 0;

      (incomingTxs || []).forEach(tx => {
        const network = tx.network || 'polygon';
        if (!balances[network]) balances[network] = 0;
        balances[network] += parseFloat(tx.amount_usdc || 0);
        totalBalance += parseFloat(tx.amount_usdc || 0);
      });

      (outgoingTxs || []).forEach(tx => {
        const network = tx.network || 'polygon';
        if (!balances[network]) balances[network] = 0;
        balances[network] -= parseFloat(tx.amount_usdc || 0);
        totalBalance -= parseFloat(tx.amount_usdc || 0);
      });

      return {
        success: true,
        data: {
          total_balance: totalBalance,
          network_balances: balances,
          user_id
        }
      };

    } catch (error) {
      console.error('Error fetching user balance data:', error);
      return { success: false, error: 'Failed to fetch balance data' };
    }
  },

  /**
   * Fetch recent transactions for user
   * Backend-safe transaction history
   */
  async getRecentTransactions(user_id, limit = 10) {
    try {
      const { data: transactions, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      return {
        success: true,
        data: {
          transactions: transactions || [],
          count: transactions?.length || 0,
          user_id
        }
      };

  } catch (error) {
      console.error('Error fetching recent transactions:', error);
      return { success: false, error: 'Failed to fetch transactions' };
    }
  },

  /**
   * Fetch payment links for user
   * Backend-safe payment link retrieval
   */
  async getUserPaymentLinks(user_id, limit = 50) {
    try {
      // 🚨 KEEP FULL UUID: Database expects UUID format
      const database_user_id = user_id;

      const { data: paymentLinks, error } = await supabase
        .from('payment_links')
        .select('*')
        .eq('user_id', database_user_id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      return {
        success: true,
        data: {
          payment_links: paymentLinks || [],
          count: paymentLinks?.length || 0,
          user_id
        }
      };

  } catch (error) {
      console.error('Error fetching payment links:', error);
      return { success: false, error: 'Failed to fetch payment links' };
  }
  }
}