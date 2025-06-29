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

// ==================== HALAXA PAYMENT VERIFICATION ENGINE ==================== //

// Alchemy API Endpoints
const POLYGON_ALCHEMY_URL = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POLYGON_API_KEY}`;
const SOLANA_ALCHEMY_URL = `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_SOLANA_API_KEY}`;

// USDC Contract Addresses  
const POLYGON_USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Helper to generate unique IDs
function generateId(length = 9) {
  return crypto.randomBytes(length).toString('hex');
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

  /**
   * Universal payment verification that works for both networks
   * Handles multiple buyers sending same amounts simultaneously
   */
  async verifyPayment(payment_link_id, wallet_address, amount_usdc, network, timeframe_minutes = 30) {
    try {
      let transferResult;
      
      // Check appropriate network
      if (network.toLowerCase() === 'polygon') {
        transferResult = await this.checkPolygonUSDCTransfers(wallet_address, amount_usdc, timeframe_minutes);
      } else if (network.toLowerCase() === 'solana') {
        transferResult = await this.checkSolanaUSDCTransfers(wallet_address, amount_usdc, timeframe_minutes);
      } else {
        return { success: false, error: 'Unsupported network' };
      }

      if (!transferResult.success || transferResult.transfers.length === 0) {
        return { 
          success: true, 
          verified: false, 
          message: 'No matching payments found',
          transfers: []
        };
      }

      // Check which transactions haven't been used yet
      const availableTransfers = [];
      
      for (const transfer of transferResult.transfers) {
        // Check if this transaction hash is already used
        const { data: existingPayment, error } = await supabase
          .from('payments')
          .select('id')
          .eq('transaction_hash', transfer.hash)
          .single();

        // If no existing payment found (error PGRST116 means no rows), this transfer is available
        if (error && error.code === 'PGRST116') {
          availableTransfers.push(transfer);
        }
      }

      if (availableTransfers.length === 0) {
        return {
          success: true,
          verified: false,
          message: 'All matching transactions have already been processed',
          transfers: transferResult.transfers
        };
      }

      // Use the most recent available transfer
      const selectedTransfer = availableTransfers.sort((a, b) => 
        (b.timestamp || b.blockNumber || 0) - (a.timestamp || a.blockNumber || 0)
      )[0];

      // Record the payment in database
      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .insert([{
          payment_link_id: payment_link_id,
          transaction_hash: selectedTransfer.hash,
          amount_usdc: selectedTransfer.amount,
          network: selectedTransfer.network,
          from_address: selectedTransfer.from,
          to_address: selectedTransfer.to,
          block_number: selectedTransfer.blockNumber || selectedTransfer.slot,
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (paymentError) {
        console.error('Error recording payment:', paymentError);
        return { success: false, error: 'Failed to record payment' };
      }

      return {
        success: true,
        verified: true,
        payment: payment,
        transaction: selectedTransfer,
        available_transactions: availableTransfers.length,
        message: `Payment verified on ${selectedTransfer.network}`
      };

    } catch (error) {
      console.error('Error verifying payment:', error);
      return { success: false, error: 'Payment verification failed' };
    }
  },

  /**
   * Create a new payment link with validation
   */
  async createPaymentLink(seller_data, link_data) {
    try {
      const { seller_id, plan } = seller_data;
      const { wallet_address, amount_usdc, network, product_title, description } = link_data;

      // Validate network
      if (!['polygon', 'solana'].includes(network.toLowerCase())) {
        return { success: false, error: 'Network must be either Polygon or Solana' };
      }

      // Check plan limits
      const { count: linkCount, error: countError } = await supabase
        .from('payment_links')
        .select('*', { count: 'exact' })
        .eq('user_id', seller_id)
        .eq('is_active', true);

      if (countError) throw countError;

      const planLimits = {
        basic: 1,
        pro: 30,
        elite: Infinity
      };

      const maxLinks = planLimits[plan] || 0;
      if (linkCount >= maxLinks) {
        return { success: false, error: `Plan limit reached. ${plan} plan allows ${maxLinks} active links.` };
      }

      // Generate unique link ID
      const link_id = 'halaxa_' + generateId(12);

      // Create payment link
      const { data: paymentLink, error: linkError } = await supabase
        .from('payment_links')
        .insert([{
          link_id,
          user_id: seller_id,
          wallet_address: wallet_address.trim(),
          amount_usdc: parseFloat(amount_usdc),
          network: network.toLowerCase(),
          link_name: product_title.trim(),
          description: description?.trim() || '',
          is_active: true,
          created_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (linkError) throw linkError;

      return {
        success: true,
        data: {
          link_id,
          payment_link: paymentLink,
          share_url: `https://halaxapay.netlify.app/Payment%20Page.html?link=${link_id}`
        }
      };

    } catch (error) {
      console.error('Error creating payment link:', error);
      return { success: false, error: 'Failed to create payment link' };
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
        .eq('status', 'active')
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
          .single();

      if (paymentError && paymentError.code !== 'PGRST116') {
        throw paymentError;
      }

      const hasPayment = !paymentError && payment;

      return {
        success: true,
      data: {
          link_id,
          link_status: paymentLink.status,
          payment_confirmed: hasPayment,
          payment_details: hasPayment ? {
            transaction_hash: payment.transaction_hash,
            amount_usdc: payment.amount_usdc,
            network: payment.network,
            confirmed_at: payment.confirmed_at
          } : null,
          link_info: {
            wallet_address: paymentLink.wallet_address,
            amount_usdc: paymentLink.amount_usdc,
            network: paymentLink.network,
            product_title: paymentLink.product_title
          }
        }
      };

    } catch (error) {
      console.error('Error checking payment status:', error);
      return { success: false, error: 'Failed to check payment status' };
    }
  },

  /**
   * Complete payment verification workflow for UI buttons
   * This is what your "I Paid" button should call
   */
  async processPaymentVerification(link_id, buyer_info = null) {
    try {
      // Step 1: Get payment link info
      const linkInfo = await this.getPaymentLinkInfo(link_id);
      if (!linkInfo.success) {
        return linkInfo;
      }

      const { wallet_address, amount_usdc, network } = linkInfo.data;

      // Step 2: Mark as pending
      const pendingResult = await this.markPaymentPending(link_id, buyer_info);
      if (!pendingResult.success) {
        return pendingResult;
      }

      // Step 3: Verify payment on blockchain
      const verificationResult = await this.verifyPayment(
        linkInfo.data.link_id, 
        wallet_address, 
        amount_usdc,
        network
      );

      if (!verificationResult.success) {
        return {
          success: false,
          verified: false,
          error: verificationResult.error,
          redirect: 'failure'
        };
      }

      if (verificationResult.verified) {
        // Step 4: Update link status to paid
        await supabase
          .from('payment_links')
          .update({ status: 'paid' })
          .eq('link_id', link_id);

        return {
          success: true,
          verified: true,
          data: verificationResult.payment,
          transaction: verificationResult.transaction,
          redirect: 'success',
          message: 'Payment successfully verified!'
        };
      } else {
        return {
          success: true,
          verified: false,
          message: verificationResult.message,
          redirect: 'failure'
        };
      }

    } catch (error) {
      console.error('Error processing payment verification:', error);
      return {
        success: false,
        verified: false,
        error: 'Payment verification failed',
        redirect: 'failure'
      };
    }
  },

  // Core utilities
  generateId
};

export { generateId };

// ==================== Dashboard Engine - Using EXACT SPA.html Elements ==================== //

export const HalaxaDashboard = {

  // ==================== Total USDC Balance - Using Existing Elements ==================== //
  
  /**
   * Update USDC balance using your exact HTML elements
   */
  async updateExistingBalanceDisplay(user_id) {
    try {
      // Get balance data
      const balanceResult = await this.getTotalUSDCBalance(user_id);
      if (!balanceResult.success) return balanceResult;

      const { total_usdc } = balanceResult.data;

      // Target YOUR EXACT elements from SPA.html
      const balanceMain = document.querySelector('.balance-main');
      const balanceDecimal = document.querySelector('.balance-decimal'); 
      const balanceSubtitle = document.querySelector('.balance-subtitle');
      
      if (balanceMain && balanceDecimal && balanceSubtitle) {
        const [whole, decimal] = total_usdc.toFixed(2).split('.');
        balanceMain.textContent = whole.toLocaleString();
        balanceDecimal.textContent = `.${decimal}`;
        balanceSubtitle.textContent = `${total_usdc.toLocaleString()} USDC`;
      }

      // Also update the metric card in Empire Analytics
      const wealthMetricValue = document.querySelector('.metric-card.wealth .metric-value');
      if (wealthMetricValue) {
        wealthMetricValue.textContent = `$${total_usdc.toLocaleString()}`;
      }

      return { success: true, data: balanceResult.data };

    } catch (error) {
      console.error('Error updating balance display:', error);
      return { success: false, error: 'Failed to update balance' };
    }
  }

  // Keep existing core functions...
};

// ==================== Market Heartbeat - Using EXACT Market Elements ==================== //

const MarketHeartbeat = {
  
  /**
   * Update your exact market stat elements in Market Pulse card
   */
  async updateExistingMarketDisplay() {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,usd-coin&vs_currencies=usd');
      const data = await response.json();

      // Target YOUR EXACT market stat elements
      const marketStats = document.querySelectorAll('.market-stat');
      
      marketStats.forEach((stat, index) => {
        const statValue = stat.querySelector('.stat-value');
        const statChange = stat.querySelector('.stat-change');

        if (index === 0) {
          // First market-stat = Bitcoin (has .fa-bitcoin icon)
          if (statValue) statValue.textContent = `$${data.bitcoin.usd.toLocaleString()}`;
        } else if (index === 1) {
          // Second market-stat = Ethereum (has .fa-ethereum icon)
          if (statValue) statValue.textContent = `$${data.ethereum.usd.toLocaleString()}`;
        } else if (index === 2) {
          // Third market-stat = USDC (has .usdc-icon)
          if (statValue) statValue.textContent = `$${data['usd-coin'].usd.toFixed(4)}`;
        }
      });

      console.log('Market prices updated:', new Date().toLocaleTimeString());
      return { success: true };

    } catch (error) {
      console.error('Error updating market display:', error);
      return { success: false, error: 'Failed to update market data' };
    }
  },

  // Start auto-updates every 30 seconds
  startUpdates() {
    this.updateExistingMarketDisplay(); // Initial update
    setInterval(() => this.updateExistingMarketDisplay(), 30000);
  }
};

// ==================== Button Handlers - Using EXACT Button Classes ==================== //

/**
 * Deploy Funds Button - Using your exact "action-tile send" class
 */
function initializeDeployFundsButton() {
  const deployBtn = document.querySelector('.action-tile.send');
  
  if (deployBtn) {
    deployBtn.addEventListener('click', showDeployFundsModal);
    console.log('Deploy Funds button connected to:', deployBtn);
  } else {
    console.error('Deploy Funds button (.action-tile.send) not found!');
  }
}

function showDeployFundsModal() {
  // Create modal that matches your existing theme
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3>Deploy Funds</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p><strong>Send money from your individual wallet</strong></p>
        <div class="wallet-options">
          <div class="wallet-option" onclick="selectWallet('polygon')">
            <i class="fas fa-circle" style="color: #8b5cf6;"></i>
            <span>Polygon Wallet</span>
          </div>
          <div class="wallet-option" onclick="selectWallet('solana')">
            <i class="fas fa-circle" style="color: #f59e0b;"></i>
            <span>Solana Wallet</span>
          </div>
          <div class="wallet-option" onclick="selectWallet('tron')">
            <i class="fas fa-circle" style="color: #ef4444;"></i>
            <span>Tron Wallet</span>
          </div>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Close modal functionality
  modal.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay') || e.target.classList.contains('modal-close')) {
      document.body.removeChild(modal);
    }
  });
}

/**
 * Summon Assets Button - Using your exact "action-tile receive" class  
 */
function initializeSummonAssetsButton() {
  const summonBtn = document.querySelector('.action-tile.receive');
  
  if (summonBtn) {
    summonBtn.addEventListener('click', () => {
      // Navigate to payment link page using your existing navigation
      const paymentLinkNav = document.querySelector('[data-page="payment-link-page"]');
      if (paymentLinkNav) {
        paymentLinkNav.click(); // Trigger your existing navigation
        console.log('Navigated to Payment Link page');
      } else {
        console.error('Payment link navigation not found!');
      }
    });
    console.log('Summon Assets button connected to:', summonBtn);
  } else {
    console.error('Summon Assets button (.action-tile.receive) not found!');
  }
}

// ==================== Initialize Everything ==================== //

document.addEventListener('DOMContentLoaded', function() {
  // Initialize market updates
  MarketHeartbeat.startUpdates();
  
  // Initialize button handlers  
  initializeDeployFundsButton();
  initializeSummonAssetsButton();
  
  console.log('Dashboard functionality initialized with your exact SPA.html elements');
});

// Global functions for testing
window.testDeployFunds = () => {
  const btn = document.querySelector('.action-tile.send');
  console.log('Deploy Funds button found:', btn);
  if (btn) btn.click();
};

window.testSummonAssets = () => {
  const btn = document.querySelector('.action-tile.receive');
  console.log('Summon Assets button found:', btn);
  if (btn) btn.click();
};

// Add minimal modal styles
const modalStyles = `
<style>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-card {
  background: white;
  border-radius: 12px;
  padding: 24px;
  max-width: 400px;
  width: 90%;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: #6b7280;
}

.wallet-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wallet-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.wallet-option:hover {
  background: #f9fafb;
  border-color: #d1d5db;
}
</style>
`;

document.head.insertAdjacentHTML('beforeend', modalStyles);

// ==================== Forge Link Button Handler ==================== //

/**
 * Forge Link Button - Using exact "action-tile link" class from SPA.html
 */
function initializeForgeLinkButton() {
  const forgeLinkBtn = document.querySelector('.action-tile.link');
  
  if (forgeLinkBtn) {
    forgeLinkBtn.addEventListener('click', () => {
      // Navigate to payment link page using existing navigation system
      const paymentLinkNav = document.querySelector('[data-page="payment-link-page"]');
      if (paymentLinkNav) {
        paymentLinkNav.click(); // Trigger existing navigation
        console.log('Navigated to Payment Link page via Forge Link');
      } else {
        console.error('Payment link navigation not found!');
      }
    });
    console.log('Forge Link button connected to:', forgeLinkBtn);
  } else {
    console.error('Forge Link button (.action-tile.link) not found!');
  }
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  initializeForgeLinkButton();
});

// Global test function
window.testForgeLink = () => {
  const btn = document.querySelector('.action-tile.link');
  console.log('Forge Link button found:', btn);
  if (btn) btn.click();
};

// ==================== Digital Vault Card - Total Balance Update ==================== //

/**
 * Update Digital Vault card using exact elements from SPA.html
 */
async function updateDigitalVaultCard(user_id) {
  try {
    // Get balance data (reuse existing function if available)
    const balanceResult = await HalaxaDashboard.getTotalUSDCBalance(user_id);
    if (!balanceResult.success) return balanceResult;

    const { total_usdc } = balanceResult.data;

    // Target the exact Digital Vault card elements
    const vaultValueElement = document.querySelector('.metric-card.wealth .metric-value');
    const vaultInsightElement = document.querySelector('.metric-card.wealth .metric-insight');
    
    if (vaultValueElement) {
      vaultValueElement.textContent = `$${total_usdc.toLocaleString()}`;
      console.log('Digital Vault updated:', `$${total_usdc.toLocaleString()}`);
    } else {
      console.error('Digital Vault value element (.metric-card.wealth .metric-value) not found!');
    }

    if (vaultInsightElement) {
      vaultInsightElement.textContent = `${total_usdc.toLocaleString()} USDC Accumulated`;
    }

    return { success: true, updated_amount: total_usdc };

  } catch (error) {
    console.error('Error updating Digital Vault card:', error);
    return { success: false, error: 'Failed to update Digital Vault' };
  }
}

/**
 * Initialize Digital Vault card updates
 */
function initializeDigitalVaultCard(user_id) {
  // Initial update
  updateDigitalVaultCard(user_id);
  
  // Auto-update every 60 seconds
  setInterval(() => {
    updateDigitalVaultCard(user_id);
  }, 60000);
  
  console.log('Digital Vault card initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system
  initializeDigitalVaultCard(userId);
});

// Global test function
window.testDigitalVault = (testUserId = 'test-user') => {
  updateDigitalVaultCard(testUserId);
};

// Manual refresh function
window.refreshDigitalVault = (userId) => {
  return updateDigitalVaultCard(userId);
};

// ==================== Transaction Velocity Card - Network Executions ==================== //

/**
 * Update Transaction Velocity card using exact elements from SPA.html
 */
async function updateTransactionVelocityCard(user_id) {
  try {
    // Get transaction data from your database
    const transactionResult = await getTransactionVelocityData(user_id);
    if (!transactionResult.success) return transactionResult;

    const { total_executions, daily_average } = transactionResult.data;

    // Target the exact Transaction Velocity card elements
    const velocityValueElement = document.querySelector('.metric-card.velocity .metric-value');
    const velocityInsightElement = document.querySelector('.metric-card.velocity .metric-insight');
    
    if (velocityValueElement) {
      velocityValueElement.textContent = total_executions.toLocaleString();
      console.log('Transaction Velocity updated:', total_executions.toLocaleString());
    } else {
      console.error('Transaction Velocity value element (.metric-card.velocity .metric-value) not found!');
    }

    if (velocityInsightElement) {
      velocityInsightElement.textContent = `${daily_average}/day avg executions`;
    }

    return { success: true, updated_count: total_executions };

  } catch (error) {
    console.error('Error updating Transaction Velocity card:', error);
    return { success: false, error: 'Failed to update Transaction Velocity' };
  }
}

/**
 * Get transaction velocity data from database
 */
async function getTransactionVelocityData(user_id) {
  try {
    // Get total transaction count
    const { count: totalTransactions, error: countError } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id)
      .eq('status', 'confirmed');

    if (countError) throw countError;

    // Get transactions from last 30 days for daily average
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { count: recentTransactions, error: recentError } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id)
      .eq('status', 'confirmed')
      .gte('created_at', thirtyDaysAgo.toISOString());

    if (recentError) throw recentError;

    const dailyAverage = Math.round(recentTransactions / 30);

    return {
      success: true,
      data: {
        total_executions: totalTransactions || 0,
        daily_average: dailyAverage || 0,
        recent_count: recentTransactions || 0
      }
    };

  } catch (error) {
    console.error('Error fetching transaction velocity data:', error);
    return { 
      success: false, 
      error: 'Failed to fetch transaction data',
      data: {
        total_executions: 0,
        daily_average: 0,
        recent_count: 0
      }
    };
  }
}

/**
 * Initialize Transaction Velocity card updates
 */
function initializeTransactionVelocityCard(user_id) {
  // Initial update
  updateTransactionVelocityCard(user_id);
  
  // Auto-update every 2 minutes (transactions change more frequently)
  setInterval(() => {
    updateTransactionVelocityCard(user_id);
  }, 120000);
  
  console.log('Transaction Velocity card initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system
  initializeTransactionVelocityCard(userId);
});

// Global test function
window.testTransactionVelocity = (testUserId = 'test-user') => {
  updateTransactionVelocityCard(testUserId);
};

// Manual refresh function
window.refreshTransactionVelocity = (userId) => {
  return updateTransactionVelocityCard(userId);
};

// Get real-time velocity metrics
window.getVelocityMetrics = async (userId) => {
  const result = await getTransactionVelocityData(userId);
  console.log('Velocity Metrics:', result.data);
  return result.data;
};

// ==================== Precision Rate Card - Flawless Execution ==================== //

/**
 * Update Precision Rate card using exact elements from SPA.html
 */
async function updatePrecisionRateCard(user_id) {
  try {
    // Get precision rate data from your database
    const precisionResult = await getPrecisionRateData(user_id);
    if (!precisionResult.success) return precisionResult;

    const { precision_percentage, successful_count, total_count } = precisionResult.data;

    // Target the exact Precision Rate card elements
    const precisionValueElement = document.querySelector('.metric-card.precision .metric-value');
    const precisionInsightElement = document.querySelector('.metric-card.precision .metric-insight');
    
    if (precisionValueElement) {
      precisionValueElement.textContent = `${precision_percentage.toFixed(1)}%`;
      console.log('Precision Rate updated:', `${precision_percentage.toFixed(1)}%`);
    } else {
      console.error('Precision Rate value element (.metric-card.precision .metric-value) not found!');
    }

    if (precisionInsightElement) {
      precisionInsightElement.textContent = `${successful_count}/${total_count} Flawless Execution`;
    }

    return { success: true, updated_rate: precision_percentage };

  } catch (error) {
    console.error('Error updating Precision Rate card:', error);
    return { success: false, error: 'Failed to update Precision Rate' };
  }
}

/**
 * Get precision rate data from database
 */
async function getPrecisionRateData(user_id) {
  try {
    // Get total transaction count
    const { count: totalTransactions, error: totalError } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id);

    if (totalError) throw totalError;

    // Get successful transaction count
    const { count: successfulTransactions, error: successError } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id)
      .eq('status', 'confirmed');

    if (successError) throw successError;

    // Calculate precision rate
    let precisionPercentage = 0;
    if (totalTransactions > 0) {
      precisionPercentage = (successfulTransactions / totalTransactions) * 100;
    }

    // If no transactions yet, show perfect rate for demo
    if (totalTransactions === 0) {
      precisionPercentage = 98.5; // Default demo value
    }

    return {
      success: true,
      data: {
        precision_percentage: precisionPercentage,
        successful_count: successfulTransactions || 0,
        total_count: totalTransactions || 0,
        failed_count: (totalTransactions || 0) - (successfulTransactions || 0)
      }
    };

  } catch (error) {
    console.error('Error fetching precision rate data:', error);
    return { 
      success: false, 
      error: 'Failed to fetch precision data',
      data: {
        precision_percentage: 98.5, // Fallback demo value
        successful_count: 0,
        total_count: 0,
        failed_count: 0
      }
    };
  }
}

/**
 * Initialize Precision Rate card updates
 */
function initializePrecisionRateCard(user_id) {
  // Initial update
  updatePrecisionRateCard(user_id);
  
  // Auto-update every 3 minutes (precision doesn't change as frequently)
  setInterval(() => {
    updatePrecisionRateCard(user_id);
  }, 180000);
  
  console.log('Precision Rate card initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system
  initializePrecisionRateCard(userId);
});

// Global test function
window.testPrecisionRate = (testUserId = 'test-user') => {
  updatePrecisionRateCard(testUserId);
};

// Manual refresh function
window.refreshPrecisionRate = (userId) => {
  return updatePrecisionRateCard(userId);
};

// Get detailed precision metrics
window.getPrecisionMetrics = async (userId) => {
  const result = await getPrecisionRateData(userId);
  console.log('Precision Metrics:', result.data);
  return result.data;
};

// ==================== Transaction Magnitude Card - Average Flow ==================== //

/**
 * Update Transaction Magnitude card using exact elements from SPA.html
 */
async function updateTransactionMagnitudeCard(user_id) {
  try {
    // Get transaction magnitude data from your database
    const magnitudeResult = await getTransactionMagnitudeData(user_id);
    if (!magnitudeResult.success) return magnitudeResult;

    const { average_amount, total_volume, transaction_count } = magnitudeResult.data;

    // Target the exact Transaction Magnitude card elements
    const magnitudeValueElement = document.querySelector('.metric-card.magnitude .metric-value');
    const magnitudeInsightElement = document.querySelector('.metric-card.magnitude .metric-insight');
    
    if (magnitudeValueElement) {
      magnitudeValueElement.textContent = `$${average_amount.toFixed(2)}`;
      console.log('Transaction Magnitude updated:', `$${average_amount.toFixed(2)}`);
    } else {
      console.error('Transaction Magnitude value element (.metric-card.magnitude .metric-value) not found!');
    }

    if (magnitudeInsightElement) {
      magnitudeInsightElement.textContent = `Average Flow`;
    }

    return { success: true, updated_amount: average_amount };

  } catch (error) {
    console.error('Error updating Transaction Magnitude card:', error);
    return { success: false, error: 'Failed to update Transaction Magnitude' };
  }
}

/**
 * Get transaction magnitude data from database
 */
async function getTransactionMagnitudeData(user_id) {
  try {
    // Get all successful transactions with amounts
    const { data: transactions, error: transactionError } = await supabase
      .from('transactions')
      .select('amount_usdc')
      .eq('user_id', user_id)
      .eq('status', 'confirmed')
      .not('amount_usdc', 'is', null);

    if (transactionError) throw transactionError;

    let averageAmount = 0;
    let totalVolume = 0;
    const transactionCount = transactions?.length || 0;

    if (transactionCount > 0) {
      // Calculate total volume and average
      totalVolume = transactions.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0);
      averageAmount = totalVolume / transactionCount;
    } else {
      // If no transactions yet, show demo value
      averageAmount = 100.58;
      totalVolume = 0;
    }

    return {
      success: true,
      data: {
        average_amount: averageAmount,
        total_volume: totalVolume,
        transaction_count: transactionCount,
        largest_transaction: transactionCount > 0 ? Math.max(...transactions.map(tx => parseFloat(tx.amount_usdc || 0))) : 0,
        smallest_transaction: transactionCount > 0 ? Math.min(...transactions.map(tx => parseFloat(tx.amount_usdc || 0))) : 0
      }
    };

  } catch (error) {
    console.error('Error fetching transaction magnitude data:', error);
    return { 
      success: false, 
      error: 'Failed to fetch magnitude data',
      data: {
        average_amount: 100.58, // Fallback demo value
        total_volume: 0,
        transaction_count: 0,
        largest_transaction: 0,
        smallest_transaction: 0
      }
    };
  }
}

/**
 * Initialize Transaction Magnitude card updates
 */
function initializeTransactionMagnitudeCard(user_id) {
  // Initial update
  updateTransactionMagnitudeCard(user_id);
  
  // Auto-update every 2 minutes (transaction amounts can change frequently)
  setInterval(() => {
    updateTransactionMagnitudeCard(user_id);
  }, 120000);
  
  console.log('Transaction Magnitude card initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system
  initializeTransactionMagnitudeCard(userId);
});

// Global test function
window.testTransactionMagnitude = (testUserId = 'test-user') => {
  updateTransactionMagnitudeCard(testUserId);
};

// Manual refresh function
window.refreshTransactionMagnitude = (userId) => {
  return updateTransactionMagnitudeCard(userId);
};

// Get detailed magnitude metrics
window.getMagnitudeMetrics = async (userId) => {
  const result = await getTransactionMagnitudeData(userId);
  console.log('Magnitude Metrics:', result.data);
  return result.data;
};

// ==================== Payment Conduits Card - Active Bridges ==================== //

/**
 * Update Payment Conduits card using exact elements from SPA.html
 */
async function updatePaymentConduitsCard(user_id) {
  try {
    // Get payment conduits data from your database
    const conduitsResult = await getPaymentConduitsData(user_id);
    if (!conduitsResult.success) return conduitsResult;

    const { active_links, total_links, recent_activity } = conduitsResult.data;

    // Target the exact Payment Conduits card elements
    const conduitsValueElement = document.querySelector('.metric-card.network .metric-value');
    const conduitsInsightElement = document.querySelector('.metric-card.network .metric-insight');
    
    if (conduitsValueElement) {
      conduitsValueElement.textContent = active_links.toString();
      console.log('Payment Conduits updated:', active_links);
    } else {
      console.error('Payment Conduits value element (.metric-card.network .metric-value) not found!');
    }

    if (conduitsInsightElement) {
      conduitsInsightElement.textContent = `Active Bridges`;
    }

    return { success: true, updated_count: active_links };

  } catch (error) {
    console.error('Error updating Payment Conduits card:', error);
    return { success: false, error: 'Failed to update Payment Conduits' };
  }
}

/**
 * Get payment conduits data from database
 */
async function getPaymentConduitsData(user_id) {
  try {
    // Get active payment links count
    const { count: activeLinks, error: activeError } = await supabase
      .from('payment_links')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id)
      .eq('is_active', true);

    if (activeError) throw activeError;

    // Get total payment links count
    const { count: totalLinks, error: totalError } = await supabase
      .from('payment_links')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id);

    if (totalError) throw totalError;

    // Get recent activity (links created in last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { count: recentLinks, error: recentError } = await supabase
      .from('payment_links')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id)
      .gte('created_at', sevenDaysAgo.toISOString());

    if (recentError) throw recentError;

    // If no payment links yet, show demo value
    const displayActiveLinks = activeLinks || 0;

    return {
      success: true,
      data: {
        active_links: displayActiveLinks,
        total_links: totalLinks || 0,
        recent_activity: recentLinks || 0,
        inactive_links: (totalLinks || 0) - (activeLinks || 0)
      }
    };

  } catch (error) {
    console.error('Error fetching payment conduits data:', error);
    return { 
      success: false, 
      error: 'Failed to fetch conduits data',
      data: {
        active_links: 0,
        total_links: 0,
        recent_activity: 0,
        inactive_links: 0
      }
    };
  }
}

/**
 * Initialize Payment Conduits card updates
 */
function initializePaymentConduitsCard(user_id) {
  // Initial update
  updatePaymentConduitsCard(user_id);
  
  // Auto-update every 1 minute (payment links can be created/deactivated frequently)
  setInterval(() => {
    updatePaymentConduitsCard(user_id);
  }, 60000);
  
  console.log('Payment Conduits card initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system
  initializePaymentConduitsCard(userId);
});

// Global test function
window.testPaymentConduits = (testUserId = 'test-user') => {
  updatePaymentConduitsCard(testUserId);
};

// Manual refresh function
window.refreshPaymentConduits = (userId) => {
  return updatePaymentConduitsCard(userId);
};

// Get detailed conduits metrics
window.getConduitsMetrics = async (userId) => {
  const result = await getPaymentConduitsData(userId);
  console.log('Conduits Metrics:', result.data);
  return result.data;
};

// Get payment link breakdown by network
window.getPaymentLinkBreakdown = async (userId) => {
  try {
    const { data: links, error } = await supabase
      .from('payment_links')
      .select('network, is_active')
      .eq('user_id', userId);

    if (error) throw error;

    const breakdown = {
      polygon: { active: 0, inactive: 0 },
      solana: { active: 0, inactive: 0 },
      tron: { active: 0, inactive: 0 }
    };

    links?.forEach(link => {
      const network = link.network.toLowerCase();
      if (breakdown[network]) {
        if (link.is_active) {
          breakdown[network].active++;
        } else {
          breakdown[network].inactive++;
        }
      }
    });

    console.log('Payment Link Network Breakdown:', breakdown);
    return breakdown;

  } catch (error) {
    console.error('Error getting payment link breakdown:', error);
    return null;
  }
};

// ==================== Monthly Constellation Chart ==================== //

/**
 * Update Monthly Constellation chart using exact elements from SPA.html
 */
async function updateMonthlyConstellationChart(user_id) {
  try {
    // Get constellation data for all months
    const constellationResult = await getMonthlyConstellationData(user_id);
    if (!constellationResult.success) return constellationResult;

    const { monthly_data, current_month, current_performance } = constellationResult.data;

    // Target the exact Monthly Constellation elements
    const currentMonthElement = document.querySelector('.current-month');
    const performanceDeltaElement = document.querySelector('.performance-delta');
    const chartValueElement = document.querySelector('.constellation-chart .chart-value');
    
    // Update current month display
    if (currentMonthElement) {
      currentMonthElement.textContent = current_month;
    }
    
    // Update performance delta
    if (performanceDeltaElement) {
      const isPositive = current_performance >= 0;
      performanceDeltaElement.textContent = `${isPositive ? '+' : ''}${current_performance.toFixed(1)}%`;
      performanceDeltaElement.className = `performance-delta ${isPositive ? 'positive' : 'negative'}`;
    }

    // Update chart with monthly data
    updateConstellationChartVisual(monthly_data, current_month);
    
    // Make months clickable
    initializeMonthClickHandlers(user_id, monthly_data);

    console.log('Monthly Constellation updated for:', current_month);
    return { success: true, current_month, current_performance };

  } catch (error) {
    console.error('Error updating Monthly Constellation:', error);
    return { success: false, error: 'Failed to update constellation chart' };
  }
}

/**
 * Get monthly constellation data from database
 */
async function getMonthlyConstellationData(user_id) {
  try {
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth(); // 0-11
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
    
    const monthlyData = {};
    let totalYearRevenue = 0;
    let previousMonthRevenue = 0;

    // Get data for each month of current year
    for (let month = 0; month <= 11; month++) {
      const monthStart = new Date(currentYear, month, 1);
      const monthEnd = new Date(currentYear, month + 1, 0, 23, 59, 59);
      
      // Get payments for this month
      const { data: monthPayments, error } = await supabase
        .from('payments')
        .select('amount_usdc')
        .eq('payment_link_id', user_id)
        .eq('status', 'confirmed')
        .gte('confirmed_at', monthStart.toISOString())
        .lte('confirmed_at', monthEnd.toISOString());

      if (error) throw error;

      const monthRevenue = monthPayments?.reduce((sum, payment) => 
        sum + parseFloat(payment.amount_usdc || 0), 0) || 0;

      monthlyData[monthNames[month]] = {
        revenue: monthRevenue,
        month_index: month,
        is_current: month === currentMonth,
        formatted_revenue: `$${monthRevenue.toLocaleString()}`
      };

      totalYearRevenue += monthRevenue;
      
      if (month === currentMonth - 1) {
        previousMonthRevenue = monthRevenue;
      }
    }

    // Calculate current month performance vs previous month
    const currentMonthRevenue = monthlyData[monthNames[currentMonth]]?.revenue || 0;
    let performanceChange = 0;
    
    if (previousMonthRevenue > 0) {
      performanceChange = ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100;
    } else if (currentMonthRevenue > 0) {
      performanceChange = 100; // First month with revenue
    }

    return {
      success: true,
      data: {
        monthly_data: monthlyData,
        current_month: monthNames[currentMonth],
        current_performance: performanceChange,
        total_year_revenue: totalYearRevenue,
        current_month_revenue: currentMonthRevenue
      }
    };

  } catch (error) {
    console.error('Error fetching constellation data:', error);
    return { 
      success: false, 
      error: 'Failed to fetch constellation data',
      data: {
        monthly_data: {},
        current_month: 'December',
        current_performance: 24.7,
        total_year_revenue: 0,
        current_month_revenue: 21280
      }
    };
  }
}

/**
 * Update the visual chart representation
 */
function updateConstellationChartVisual(monthlyData, currentMonth) {
  // Find chart container
  const chartContainer = document.querySelector('.constellation-chart');
  if (!chartContainer) return;

  // Update chart value display
  const chartValue = chartContainer.querySelector('.chart-value');
  if (chartValue && monthlyData[currentMonth]) {
    chartValue.textContent = monthlyData[currentMonth].formatted_revenue;
  }

  // Update visual chart bars (if they exist)
  updateChartBars(monthlyData);
}

/**
 * Update chart bars visualization
 */
function updateChartBars(monthlyData) {
  const months = Object.keys(monthlyData);
  const maxRevenue = Math.max(...months.map(month => monthlyData[month].revenue));
  
  months.forEach(month => {
    const monthData = monthlyData[month];
    const monthElement = document.querySelector(`[data-month="${month}"]`);
    
    if (monthElement) {
      // Calculate height percentage based on revenue
      const heightPercent = maxRevenue > 0 ? (monthData.revenue / maxRevenue) * 100 : 0;
      
      // Update visual representation
      const barElement = monthElement.querySelector('.month-bar');
      if (barElement) {
        barElement.style.height = `${heightPercent}%`;
        barElement.style.opacity = monthData.revenue > 0 ? '1' : '0.3';
      }
      
      // Add current month indicator
      if (monthData.is_current) {
        monthElement.classList.add('current-month-highlight');
      }
    }
  });
}

/**
 * Initialize month click handlers for interactive chart
 */
function initializeMonthClickHandlers(user_id, monthlyData) {
  const months = Object.keys(monthlyData);
  
  months.forEach(month => {
    const monthElement = document.querySelector(`[data-month="${month}"]`);
    
    if (monthElement) {
      // Remove existing listeners
      monthElement.replaceWith(monthElement.cloneNode(true));
      const newMonthElement = document.querySelector(`[data-month="${month}"]`);
      
      // Add click handler
      newMonthElement.addEventListener('click', () => {
        showMonthDetails(month, monthlyData[month], user_id);
      });
      
      // Add hover effects
      newMonthElement.style.cursor = 'pointer';
      newMonthElement.addEventListener('mouseenter', () => {
        newMonthElement.style.opacity = '0.8';
      });
      newMonthElement.addEventListener('mouseleave', () => {
        newMonthElement.style.opacity = '1';
      });
    }
  });
}

/**
 * Show detailed month information when clicked
 */
async function showMonthDetails(monthName, monthData, user_id) {
  try {
    // Get detailed data for selected month
    const detailsResult = await getMonthDetailedData(user_id, monthData.month_index);
    
    // Update main chart display to show selected month
    const currentMonthElement = document.querySelector('.current-month');
    const chartValueElement = document.querySelector('.constellation-chart .chart-value');
    
    if (currentMonthElement) {
      currentMonthElement.textContent = monthName;
    }
    
    if (chartValueElement) {
      chartValueElement.textContent = monthData.formatted_revenue;
    }

    // Show month-specific chart/details
    displayMonthChart(monthName, detailsResult.data);
    
    console.log(`Showing details for ${monthName}:`, monthData);

  } catch (error) {
    console.error('Error showing month details:', error);
  }
}

/**
 * Get detailed data for specific month
 */
async function getMonthDetailedData(user_id, monthIndex) {
  try {
    const currentYear = new Date().getFullYear();
    const monthStart = new Date(currentYear, monthIndex, 1);
    const monthEnd = new Date(currentYear, monthIndex + 1, 0, 23, 59, 59);
    
    // Get daily breakdown for the month
    const { data: dailyPayments, error } = await supabase
      .from('payments')
      .select('amount_usdc, confirmed_at')
      .eq('payment_link_id', user_id)
      .eq('status', 'confirmed')
      .gte('confirmed_at', monthStart.toISOString())
      .lte('confirmed_at', monthEnd.toISOString())
      .order('confirmed_at', { ascending: true });

    if (error) throw error;

    // Process daily data
    const dailyBreakdown = {};
    dailyPayments?.forEach(payment => {
      const day = new Date(payment.confirmed_at).getDate();
      dailyBreakdown[day] = (dailyBreakdown[day] || 0) + parseFloat(payment.amount_usdc || 0);
    });

    return {
      success: true,
      data: {
        daily_breakdown: dailyBreakdown,
        total_transactions: dailyPayments?.length || 0,
        total_revenue: Object.values(dailyBreakdown).reduce((sum, val) => sum + val, 0),
        best_day: Math.max(...Object.values(dailyBreakdown)) || 0
      }
    };

  } catch (error) {
    console.error('Error fetching month details:', error);
    return { success: false, data: {} };
  }
}

/**
 * Display month-specific chart
 */
function displayMonthChart(monthName, monthDetails) {
  // Create or update a detailed view
  console.log(`Displaying chart for ${monthName}:`, monthDetails);
  
  // You can expand this to show daily breakdown, trends, etc.
  // For now, just update the performance delta
  const performanceDelta = document.querySelector('.performance-delta');
  if (performanceDelta && monthDetails.total_revenue > 0) {
    // Show month-specific performance indicator
    performanceDelta.textContent = `${monthDetails.total_transactions} transactions`;
    performanceDelta.className = 'performance-delta positive';
  }
}

/**
 * Initialize Monthly Constellation chart
 */
function initializeMonthlyConstellationChart(user_id) {
  // Initial update
  updateMonthlyConstellationChart(user_id);
  
  // Auto-update every 10 minutes
  setInterval(() => {
    updateMonthlyConstellationChart(user_id);
  }, 600000);
  
  console.log('Monthly Constellation chart initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id';
  initializeMonthlyConstellationChart(userId);
});

// Global test functions
window.testConstellation = (testUserId = 'test-user') => {
  updateMonthlyConstellationChart(testUserId);
};

window.showMonthData = (month, userId = 'test-user') => {
  getMonthlyConstellationData(userId).then(result => {
    if (result.success && result.data.monthly_data[month]) {
      showMonthDetails(month, result.data.monthly_data[month], userId);
    }
  });
};

// Get constellation metrics
window.getConstellationMetrics = async (userId) => {
  const result = await getMonthlyConstellationData(userId);
  console.log('Constellation Metrics:', result.data);
  return result.data;
};

// ==================== AI Oracle Rotating Messages ==================== //

// 25 super nice AI Oracle quotes
const aiOracleQuotes = [
  { icon: "fas fa-rocket", title: "Velocity Surge Detected", desc: "Transaction frequency increased 34% this week" },
  { icon: "fas fa-shield-alt", title: "Security Fortress Active", desc: "Zero threats detected in the last 30 days" },
  { icon: "fas fa-chart-line", title: "Trajectory Optimization", desc: "Portfolio on track for 145% annual growth" },
  { icon: "fas fa-bolt", title: "Lightning Settlements", desc: "Average transaction time: 1.2s" },
  { icon: "fas fa-gem", title: "Treasury Strength", desc: "USDC reserves at all-time high" },
  { icon: "fas fa-balance-scale", title: "Fee Efficiency", desc: "Network fees reduced by 18% this month" },
  { icon: "fas fa-globe", title: "Global Reach", desc: "Payments received from 27 countries" },
  { icon: "fas fa-user-shield", title: "User Trust", desc: "User satisfaction at 98.7%" },
  { icon: "fas fa-satellite", title: "Network Uptime", desc: "100% uptime maintained for 90 days" },
  { icon: "fas fa-coins", title: "Capital Flow", desc: "Net inflow positive for 6 consecutive weeks" },
  { icon: "fas fa-fire", title: "Hot Streak", desc: "7 days of flawless execution" },
  { icon: "fas fa-heartbeat", title: "Market Pulse", desc: "BTC and ETH volatility at yearly lows" },
  { icon: "fas fa-crown", title: "Elite Status", desc: "You are in the top 1% of Halaxa users" },
  { icon: "fas fa-arrow-up", title: "Growth Momentum", desc: "User base grew 12% this month" },
  { icon: "fas fa-leaf", title: "Eco Mode", desc: "Energy-efficient transactions enabled" },
  { icon: "fas fa-magic", title: "AI Insights", desc: "AI detected optimal trading window" },
  { icon: "fas fa-star", title: "Stellar Performance", desc: "All KPIs exceeded targets" },
  { icon: "fas fa-sync-alt", title: "Seamless Sync", desc: "All wallets synchronized" },
  { icon: "fas fa-lightbulb", title: "Smart Routing", desc: "Best network path auto-selected" },
  { icon: "fas fa-users", title: "Community Power", desc: "Halaxa community reached 10,000 members" },
  { icon: "fas fa-chart-pie", title: "Diversification", desc: "Portfolio diversified across 5 assets" },
  { icon: "fas fa-lock", title: "Ironclad Security", desc: "Multi-factor authentication active" },
  { icon: "fas fa-rocket", title: "Launch Success", desc: "New feature adoption at 92%" },
  { icon: "fas fa-eye", title: "Transparency", desc: "All transactions auditable in real-time" },
  { icon: "fas fa-gift", title: "Reward Unlocked", desc: "You earned a loyalty bonus this month" }
];

// Utility: Get 3 random, non-repeating indices
function getThreeRandomIndices(max) {
  const indices = [];
  while (indices.length < 3) {
    const idx = Math.floor(Math.random() * max);
    if (!indices.includes(idx)) indices.push(idx);
  }
  return indices;
}

// Render 3 random oracle messages
function renderOracleMessages() {
  const feed = document.querySelector('.intelligence-panel .insights-feed');
  if (!feed) return;

  // Remove all current .insight-item children
  while (feed.firstChild) feed.removeChild(feed.firstChild);

  // Pick 3 random, non-repeating messages
  const indices = getThreeRandomIndices(aiOracleQuotes.length);
  indices.forEach((idx, i) => {
    const { icon, title, desc } = aiOracleQuotes[idx];

    // Create .insight-item
    const item = document.createElement('div');
    item.className = 'insight-item' + (i === 0 ? ' priority' : '');

    // Icon
    const iconDiv = document.createElement('div');
    iconDiv.className = 'insight-icon';
    const iconElem = document.createElement('i');
    iconElem.className = icon;
    iconDiv.appendChild(iconElem);

    // Content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'insight-content';
    const titleDiv = document.createElement('div');
    titleDiv.className = 'insight-title';
    titleDiv.textContent = title;
    const descDiv = document.createElement('div');
    descDiv.className = 'insight-desc';
    descDiv.textContent = desc;
    contentDiv.appendChild(titleDiv);
    contentDiv.appendChild(descDiv);

    // Assemble
    item.appendChild(iconDiv);
    item.appendChild(contentDiv);
    feed.appendChild(item);
  });
}

// Refresh Oracle on button click
function initializeOracleRefresh() {
  // Look for a button inside the oracle/intelligence section
  const oraclePanel = document.querySelector('.intelligence-panel');
  if (!oraclePanel) return;

  // Try to find a refresh button, or create one if not present
  let refreshBtn = oraclePanel.querySelector('.oracle-refresh-btn');
  if (!refreshBtn) {
    refreshBtn = document.createElement('button');
    refreshBtn.className = 'oracle-refresh-btn chart-action';
    refreshBtn.title = 'Refresh Oracle';
    refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
    oraclePanel.querySelector('.intelligence-header')?.appendChild(refreshBtn);
  }

  refreshBtn.addEventListener('click', renderOracleMessages);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  renderOracleMessages();
  initializeOracleRefresh();
});

// Manual refresh for testing
window.refreshOracle = renderOracleMessages;

// ==================== Balance Over Time Chart - Data Connection & Fast Refresh ==================== //

/**
 * Update Balance Over Time card using exact elements from SPA.html
 */
async function updateBalanceOverTimeCard(user_id) {
  try {
    // Get balance history data (last 12 months)
    const balanceResult = await getBalanceOverTimeData(user_id);
    if (!balanceResult.success) return balanceResult;

    const { monthly_balances, total_balance, percent_change } = balanceResult.data;

    // Target the exact Balance Over Time card elements
    const valueElement = document.querySelector('.balance-chart-panel .current-value');
    const changeElement = document.querySelector('.balance-chart-panel .value-change');
    const chartSvg = document.querySelector('.balance-chart-panel .balance-chart');

    // Update main value
    if (valueElement) {
      valueElement.textContent = `$${total_balance.toLocaleString()}`;
    }

    // Update percent change
    if (changeElement) {
      const isPositive = percent_change >= 0;
      changeElement.textContent = `${isPositive ? '+' : ''}${percent_change.toFixed(1)}%`;
      changeElement.className = `value-change ${isPositive ? 'positive' : 'negative'}`;
    }

    // Update SVG chart path (simple smooth line for 12 months)
    if (chartSvg && monthly_balances.length > 1) {
      // Calculate points for the chart
      const maxVal = Math.max(...monthly_balances.map(b => b.balance));
      const minVal = Math.min(...monthly_balances.map(b => b.balance));
      const range = maxVal - minVal || 1;
      const width = 300, height = 120, leftPad = 0, rightPad = 0;
      const step = (width - leftPad - rightPad) / (monthly_balances.length - 1);

      // Generate points
      const points = monthly_balances.map((b, i) => {
        const x = leftPad + i * step;
        // Invert y for SVG (higher balance = lower y)
        const y = height - ((b.balance - minVal) / range) * (height * 0.7) - 20;
        return [x, y];
      });

      // Create smooth path (quadratic for simplicity)
      let path = `M${points[0][0]},${points[0][1]}`;
      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        const [prevX, prevY] = points[i - 1];
        const cpx = (x + prevX) / 2;
        path += ` Q${cpx},${prevY} ${x},${y}`;
      }

      // Update the chart line
      const chartLine = chartSvg.querySelector('.chart-line');
      if (chartLine) {
        chartLine.setAttribute('d', path);
      }

      // Update the chart area (fill under the line)
      let areaPath = path + ` L${points[points.length - 1][0]},${height} L${points[0][0]},${height} Z`;
      const chartArea = chartSvg.querySelector('.chart-area');
      if (chartArea) {
        chartArea.setAttribute('d', areaPath);
      }

      // Update chart dots (for key months)
      const chartDots = chartSvg.querySelectorAll('.chart-dot');
      chartDots.forEach((dot, i) => {
        if (points[i]) {
          dot.setAttribute('cx', points[i][0]);
          dot.setAttribute('cy', points[i][1]);
          dot.style.display = '';
        } else {
          dot.style.display = 'none';
        }
      });
    }

    return { success: true, data: balanceResult.data };

  } catch (error) {
    console.error('Error updating Balance Over Time card:', error);
    return { success: false, error: 'Failed to update Balance Over Time' };
  }
}

/**
 * Get balance over time data from database
 */
async function getBalanceOverTimeData(user_id) {
  try {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), month: d.getMonth() });
    }

    // Query balances for each month
    const monthlyBalances = [];
    for (const m of months) {
      const monthStart = new Date(m.year, m.month, 1);
      const monthEnd = new Date(m.year, m.month + 1, 0, 23, 59, 59);

      const { data: balances, error } = await supabase
        .from('usdc_balances')
        .select('balance_usdc')
        .eq('user_id', user_id)
        .gte('timestamp', monthStart.toISOString())
        .lte('timestamp', monthEnd.toISOString())
        .order('timestamp', { ascending: false })
        .limit(1);

      if (error) throw error;

      const balance = balances && balances.length > 0 ? parseFloat(balances[0].balance_usdc) : 0;
      monthlyBalances.push({
        label: monthStart.toLocaleString('en-US', { month: 'short' }),
        balance
      });
    }

    // Calculate total balance (latest month)
    const totalBalance = monthlyBalances[monthlyBalances.length - 1].balance;

    // Calculate percent change from first to last month
    const first = monthlyBalances[0].balance;
    const last = monthlyBalances[monthlyBalances.length - 1].balance;
    const percentChange = first > 0 ? ((last - first) / first) * 100 : 0;

    return {
      success: true,
      data: {
        monthly_balances: monthlyBalances,
        total_balance: totalBalance,
        percent_change: percentChange
      }
    };

  } catch (error) {
    console.error('Error fetching balance over time data:', error);
    return { 
      success: false, 
      error: 'Failed to fetch balance over time data',
      data: {
        monthly_balances: [],
        total_balance: 0,
        percent_change: 0
      }
    };
  }
}

/**
 * Initialize Balance Over Time card updates and fast refresh
 */
function initializeBalanceOverTimeCard(user_id) {
  // Initial update
  updateBalanceOverTimeCard(user_id);

  // Fast refresh on button click
  const refreshBtn = document.querySelector('.balance-chart-panel .chart-action');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      updateBalanceOverTimeCard(user_id);
    });
  }

  // Auto-update every 5 minutes
  setInterval(() => {
    updateBalanceOverTimeCard(user_id);
  }, 300000);

  console.log('Balance Over Time card initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system
  initializeBalanceOverTimeCard(userId);
});

// Manual refresh for testing
window.refreshBalanceOverTime = (userId) => {
  return updateBalanceOverTimeCard(userId);
};

// ==================== Key Metrics Panel - Data Connection & Fast Refresh ==================== //

/**
 * Update Key Metrics panel using exact elements from SPA.html
 */
async function updateKeyMetricsPanel(user_id) {
  try {
    // Get all key metrics data
    const metricsResult = await getKeyMetricsData(user_id);
    if (!metricsResult.success) return metricsResult;

    const {
      conversion_rate,
      avg_processing_time,
      fees_saved_total,
      active_wallets,
      volume_24h,
      gas_optimization_score
    } = metricsResult.data;

    // Find all metric items in order
    const metricsPanel = document.querySelector('.metrics-panel');
    if (!metricsPanel) return;

    const metricItems = metricsPanel.querySelectorAll('.metric-item');
    if (metricItems.length < 6) return;

    // Update each metric value
    metricItems[0].querySelector('.metric-value').textContent = `${conversion_rate.toFixed(1)}%`;
    metricItems[1].querySelector('.metric-value').textContent = `${avg_processing_time.toFixed(1)}s`;
    metricItems[2].querySelector('.metric-value').textContent = `$${fees_saved_total.toLocaleString()}`;
    metricItems[3].querySelector('.metric-value').textContent = `${active_wallets}`;
    metricItems[4].querySelector('.metric-value').textContent = `$${volume_24h.toLocaleString()}`;
    metricItems[5].querySelector('.metric-value').textContent = `${gas_optimization_score.toFixed(0)}%`;

    return { success: true, data: metricsResult.data };

  } catch (error) {
    console.error('Error updating Key Metrics panel:', error);
    return { success: false, error: 'Failed to update Key Metrics' };
  }
}

/**
 * Get all key metrics data from database
 */
async function getKeyMetricsData(user_id) {
  try {
    // 1. Conversion Rate
    // (successful payments / total payment attempts) * 100
    const { count: totalAttempts, error: attemptsError } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id);

    if (attemptsError) throw attemptsError;

    const { count: successfulPayments, error: successError } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id)
      .eq('status', 'confirmed');

    if (successError) throw successError;

    const conversionRate = totalAttempts > 0 ? (successfulPayments / totalAttempts) * 100 : 0;

    // 2. Average Processing Time (in seconds)
    // (average of (confirmed_at - created_at) for confirmed transactions)
    const { data: confirmedTxs, error: txsError } = await supabase
      .from('transactions')
      .select('created_at, confirmed_at')
      .eq('user_id', user_id)
      .eq('status', 'confirmed');

    if (txsError) throw txsError;

    let avgProcessingTime = 0;
    if (confirmedTxs && confirmedTxs.length > 0) {
      const totalTime = confirmedTxs.reduce((sum, tx) => {
        const created = new Date(tx.created_at).getTime();
        const confirmed = new Date(tx.confirmed_at).getTime();
        return sum + ((confirmed - created) / 1000);
      }, 0);
      avgProcessingTime = totalTime / confirmedTxs.length;
    }

    // 3. Fees Saved (sum from fees_saved table)
    const { data: feesSavedRows, error: feesError } = await supabase
      .from('fees_saved')
      .select('saved_amount')
      .eq('user_id', user_id);

    if (feesError) throw feesError;

    const feesSavedTotal = feesSavedRows?.reduce((sum, row) => sum + parseFloat(row.saved_amount || 0), 0) || 0;

    // 4. Active Wallets (from user_balances table, is_active = true)
    const { count: activeWallets, error: walletsError } = await supabase
      .from('user_balances')
      .select('*', { count: 'exact' })
      .eq('user_id', user_id)
      .eq('is_active', true);

    if (walletsError) throw walletsError;

    // 5. Total Volume (24h) (sum of amount_usdc from transactions in last 24h)
    const dayAgo = new Date();
    dayAgo.setDate(dayAgo.getDate() - 1);

    const { data: tx24h, error: tx24hError } = await supabase
      .from('transactions')
      .select('amount_usdc')
      .eq('user_id', user_id)
      .eq('status', 'confirmed')
      .gte('created_at', dayAgo.toISOString());

    if (tx24hError) throw tx24hError;

    const volume24h = tx24h?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;

    // 6. Gas Optimization (average from key_metrics table, fallback to 87%)
    let gasOptimizationScore = 87;
    const { data: keyMetrics, error: keyMetricsError } = await supabase
      .from('key_metrics')
      .select('gas_optimization_score')
      .eq('user_id', user_id)
      .order('id', { ascending: false })
      .limit(1)
      .single();

    if (!keyMetricsError && keyMetrics && keyMetrics.gas_optimization_score !== undefined) {
      gasOptimizationScore = keyMetrics.gas_optimization_score;
    }

    return {
      success: true,
      data: {
        conversion_rate: conversionRate,
        avg_processing_time: avgProcessingTime,
        fees_saved_total: feesSavedTotal,
        active_wallets: activeWallets || 0,
        volume_24h: volume24h,
        gas_optimization_score: gasOptimizationScore
      }
    };

  } catch (error) {
    console.error('Error fetching key metrics data:', error);
    return {
      success: false,
      error: 'Failed to fetch key metrics data',
      data: {
        conversion_rate: 94.2,
        avg_processing_time: 2.3,
        fees_saved_total: 1240,
        active_wallets: 156,
        volume_24h: 45230,
        gas_optimization_score: 87
      }
    };
  }
}

/**
 * Initialize Key Metrics panel updates and fast refresh
 */
function initializeKeyMetricsPanel(user_id) {
  // Initial update
  updateKeyMetricsPanel(user_id);

  // Fast refresh on button click
  const refreshBtn = document.querySelector('.metrics-panel .chart-action');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      updateKeyMetricsPanel(user_id);
    });
  }

  // Auto-update every 5 minutes
  setInterval(() => {
    updateKeyMetricsPanel(user_id);
  }, 300000);

  console.log('Key Metrics panel initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system
  initializeKeyMetricsPanel(userId);
});

// Manual refresh for testing
window.refreshKeyMetrics = (userId) => {
  return updateKeyMetricsPanel(userId);
};

// ==================== Transaction Insights Panel - Data Connection & Fast Refresh ==================== //

/**
 * Update Transaction Insights panel using exact elements from SPA.html
 */
async function updateTransactionInsightsPanel(user_id) {
  try {
    // Get all transaction insights data
    const insightsResult = await getTransactionInsightsData(user_id);
    if (!insightsResult.success) return insightsResult;

    const {
      peak_hour_volume,
      cross_chain_transfers,
      smart_contract_calls,
      avg_api_response_time,
      security_score,
      user_satisfaction_score
    } = insightsResult.data;

    // Find all insight items in order
    // (Assumes the first .metrics-panel is Key Metrics, the second is Transaction Insights)
    const panels = document.querySelectorAll('.metrics-panel');
    if (panels.length < 2) return;
    const insightsPanel = panels[1];
    const insightItems = insightsPanel.querySelectorAll('.metric-item');
    if (insightItems.length < 6) return;

    // Update each insight value
    insightItems[0].querySelector('.metric-value').textContent = `$${peak_hour_volume.toLocaleString()}`;
    insightItems[1].querySelector('.metric-value').textContent = `${cross_chain_transfers}`;
    insightItems[2].querySelector('.metric-value').textContent = `${smart_contract_calls}`;
    insightItems[3].querySelector('.metric-value').textContent = `${avg_api_response_time}ms`;
    insightItems[4].querySelector('.metric-value').textContent = `${security_score.toFixed(1)}%`;
    insightItems[5].querySelector('.metric-value').textContent = `${user_satisfaction_score.toFixed(1)}/5`;

    return { success: true, data: insightsResult.data };

  } catch (error) {
    console.error('Error updating Transaction Insights panel:', error);
    return { success: false, error: 'Failed to update Transaction Insights' };
  }
}

/**
 * Get all transaction insights data from database
 */
async function getTransactionInsightsData(user_id) {
  try {
    // Try to get from transaction_insights table (if you have it)
    const { data: insights, error } = await supabase
      .from('transaction_insights')
      .select('*')
      .eq('user_id', user_id)
      .order('id', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    // Fallback demo values if not found
    return {
      success: true,
      data: {
        peak_hour_volume: insights?.peak_hour ? parseFloat(insights.peak_hour.replace(/[^0-9.]/g, '')) : 8450,
        cross_chain_transfers: insights?.cross_chain_transfers ?? 234,
        smart_contract_calls: insights?.smart_contract_calls ?? 1567,
        avg_api_response_time: insights?.avg_api_response_time ?? 145,
        security_score: insights?.security_score ?? 99.8,
        user_satisfaction_score: insights?.user_satisfaction_score ?? 4.9
      }
    };

  } catch (error) {
    console.error('Error fetching transaction insights data:', error);
    return {
      success: false,
      error: 'Failed to fetch transaction insights data',
      data: {
        peak_hour_volume: 8450,
        cross_chain_transfers: 234,
        smart_contract_calls: 1567,
        avg_api_response_time: 145,
        security_score: 99.8,
        user_satisfaction_score: 4.9
      }
    };
  }
}

/**
 * Initialize Transaction Insights panel updates and fast refresh
 */
function initializeTransactionInsightsPanel(user_id) {
  // Initial update
  updateTransactionInsightsPanel(user_id);

  // Fast refresh on button click
  // (Assumes the first .metrics-panel is Key Metrics, the second is Transaction Insights)
  const panels = document.querySelectorAll('.metrics-panel');
  if (panels.length < 2) return;
  const insightsPanel = panels[1];
  const refreshBtn = insightsPanel.querySelector('.chart-action');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      updateTransactionInsightsPanel(user_id);
    });
  }

  // Auto-update every 5 minutes
  setInterval(() => {
    updateTransactionInsightsPanel(user_id);
  }, 300000);

  console.log('Transaction Insights panel initialized for user:', user_id);
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system
  initializeTransactionInsightsPanel(userId);
});

// Manual refresh for testing
window.refreshTransactionInsights = (userId) => {
  return updateTransactionInsightsPanel(userId);
};

/**
 * Update Total Transactions card using optimized query and robust DOM targeting.
 */
async function updateTotalTransactionsCard(user_id) {
  try {
    // 1. Use .select('id', { count: 'exact' }) for lighter DB queries
    const { count: totalTransactions, error } = await supabase
      .from('transactions')
      .select('id', { count: 'exact' })
      .eq('user_id', user_id);

    if (error) throw error;

    let found = false;

    // 3. Prioritize direct selection using a new .total-transactions-card class if possible
    const directCard = document.querySelector('.total-transactions-card');
    if (directCard) {
      // Try to find the number element inside the card
      let numberElem = directCard.querySelector('h2, h3, .stat-value, .summary-value, .metric-value, strong, span');
      if (numberElem) {
        numberElem.textContent = totalTransactions.toLocaleString();
        found = true;
      }
    }

    // 2. Use regex check for label-based lookup if direct class not found
    if (!found) {
      const cards = document.querySelectorAll('.card, .stat-card, .summary-card, div');
      cards.forEach(card => {
        const label = card.textContent?.trim();
        if (label && /Total Transactions/i.test(label)) {
          let numberElem = card.querySelector('h2, h3, .stat-value, .summary-value, .metric-value, strong, span');
          if (numberElem) {
            numberElem.textContent = totalTransactions.toLocaleString();
            found = true;
          }
        }
      });
    }

    // 4. Fallback: try to find by icon and update the next sibling
    if (!found) {
      const iconElem = document.querySelector('.fa-chart-line, .fa-chart-area, .fa-chart-bar');
      if (iconElem && iconElem.parentElement) {
        const numberElem = iconElem.parentElement.nextElementSibling;
        if (numberElem) {
          numberElem.textContent = totalTransactions.toLocaleString();
        }
      }
    }

    console.log('Total Transactions card updated:', totalTransactions);
    return { success: true, total: totalTransactions };

  } catch (error) {
    console.error('Error updating Total Transactions card:', error);
    return { success: false, error: 'Failed to update Total Transactions' };
  }
}

/**
 * Update Total Volume card using optimized query and robust DOM targeting.
 */
async function updateTotalVolumeCard(user_id) {
  try {
    // Query: Sum all confirmed transaction amounts for this user
    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('amount_usdc')
      .eq('user_id', user_id)
      .eq('status', 'confirmed');

    if (error) throw error;

    // Calculate total volume
    const totalVolume = transactions?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;

    let found = false;

    // 1. Prioritize direct selection using a .total-volume-card class if possible
    const directCard = document.querySelector('.total-volume-card');
    if (directCard) {
      let numberElem = directCard.querySelector('h2, h3, .stat-value, .summary-value, .metric-value, strong, span');
      if (numberElem) {
        numberElem.textContent = `$${totalVolume.toLocaleString()}`;
        found = true;
      }
    }

    // 2. Use regex check for label-based lookup if direct class not found
    if (!found) {
      const cards = document.querySelectorAll('.card, .stat-card, .summary-card, div');
      cards.forEach(card => {
        const label = card.textContent?.trim();
        if (label && /Total Volume/i.test(label)) {
          let numberElem = card.querySelector('h2, h3, .stat-value, .summary-value, .metric-value, strong, span');
          if (numberElem) {
            numberElem.textContent = `$${totalVolume.toLocaleString()}`;
            found = true;
          }
        }
      });
    }

    // 3. Fallback: try to find by icon and update the next sibling
    if (!found) {
      const iconElem = document.querySelector('.fa-coins, .fa-database, .fa-layer-group');
      if (iconElem && iconElem.parentElement) {
        const numberElem = iconElem.parentElement.nextElementSibling;
        if (numberElem) {
          numberElem.textContent = `$${totalVolume.toLocaleString()}`;
        }
      }
    }

    console.log('Total Volume card updated:', totalVolume);
    return { success: true, total: totalVolume };

  } catch (error) {
    console.error('Error updating Total Volume card:', error);
    return { success: false, error: 'Failed to update Total Volume' };
  }
}

/**
 * Initialize Total Volume card updates
 */
function initializeTotalVolumeCard(user_id) {
  // Initial update
  updateTotalVolumeCard(user_id);

  // Auto-update every 5 minutes
  setInterval(() => {
    updateTotalVolumeCard(user_id);
  }, 300000);

  console.log('Total Volume card initialized for user:', user_id);
}

// Initialize on DOM load (only on the transactions page)
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system

  // Only run if the Total Volume card is present
  if (document.body.textContent.includes('Total Volume')) {
    initializeTotalVolumeCard(userId);
  }
});

// Manual refresh for testing
window.refreshTotalVolume = (userId) => {
  return updateTotalVolumeCard(userId);
};

/**
 * Update Fees Saved card to always show 100%
 */
function updateFeesSavedCard() {
  let found = false;

  // 1. Prioritize direct selection using a .fees-saved-card class if possible
  const directCard = document.querySelector('.fees-saved-card');
  if (directCard) {
    let numberElem = directCard.querySelector('h2, h3, .stat-value, .summary-value, .metric-value, strong, span');
    if (numberElem) {
      numberElem.textContent = '100%';
      found = true;
    }
  }

  // 2. Use regex check for label-based lookup if direct class not found
  if (!found) {
    const cards = document.querySelectorAll('.card, .stat-card, .summary-card, div');
    cards.forEach(card => {
      const label = card.textContent?.trim();
      if (label && /Fees Saved/i.test(label)) {
        let numberElem = card.querySelector('h2, h3, .stat-value, .summary-value, .metric-value, strong, span');
        if (numberElem) {
          numberElem.textContent = '100%';
          found = true;
        }
      }
    });
  }

  // 3. Fallback: try to find by icon and update the next sibling
  if (!found) {
    const iconElem = document.querySelector('.fa-piggy-bank, .fa-piggy, .fa-percent');
    if (iconElem && iconElem.parentElement) {
      const numberElem = iconElem.parentElement.nextElementSibling;
      if (numberElem) {
        numberElem.textContent = '100%';
      }
    }
  }

  console.log('Fees Saved card set to 100%');
}

/**
 * Initialize Fees Saved card updates
 */
function initializeFeesSavedCard() {
  updateFeesSavedCard();

  // Auto-update every 10 minutes (in case of re-render)
  setInterval(updateFeesSavedCard, 600000);

  console.log('Fees Saved card initialized (always 100%)');
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
  if (document.body.textContent.includes('Fees Saved')) {
    initializeFeesSavedCard();
  }
});

// Manual refresh for testing
window.refreshFeesSaved = updateFeesSavedCard;

/**
 * Update Transactions This Week card using optimized query and robust DOM targeting.
 */
async function updateTransactionsThisWeekCard(user_id) {
  try {
    // Calculate the start of the current week (Monday)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 (Sun) - 6 (Sat)
    const diffToMonday = (dayOfWeek + 6) % 7; // 0 (Mon) - 6 (Sun)
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    monday.setHours(0, 0, 0, 0);

    // Query: Count all transactions for this user since this week's Monday
    const { count: weekTxCount, error } = await supabase
      .from('transactions')
      .select('id', { count: 'exact' })
      .eq('user_id', user_id)
      .gte('created_at', monday.toISOString());

    if (error) throw error;

    let found = false;

    // 1. Prioritize direct selection using a .transactions-this-week-card class if possible
    const directCard = document.querySelector('.transactions-this-week-card');
    if (directCard) {
      let numberElem = directCard.querySelector('h2, h3, .stat-value, .summary-value, .metric-value, strong, span');
      if (numberElem) {
        numberElem.textContent = weekTxCount.toLocaleString();
        found = true;
      }
    }

    // 2. Use regex check for label-based lookup if direct class not found
    if (!found) {
      const cards = document.querySelectorAll('.card, .stat-card, .summary-card, div');
      cards.forEach(card => {
        const label = card.textContent?.trim();
        if (label && /This Week/i.test(label)) {
          let numberElem = card.querySelector('h2, h3, .stat-value, .summary-value, .metric-value, strong, span');
          if (numberElem) {
            numberElem.textContent = weekTxCount.toLocaleString();
            found = true;
          }
        }
      });
    }

    // 3. Fallback: try to find by icon and update the next sibling
    if (!found) {
      const iconElem = document.querySelector('.fa-calendar, .fa-calendar-week, .fa-calendar-alt');
      if (iconElem && iconElem.parentElement) {
        const numberElem = iconElem.parentElement.nextElementSibling;
        if (numberElem) {
          numberElem.textContent = weekTxCount.toLocaleString();
        }
      }
    }

    console.log('Transactions This Week card updated:', weekTxCount);
    return { success: true, total: weekTxCount };

  } catch (error) {
    console.error('Error updating Transactions This Week card:', error);
    return { success: false, error: 'Failed to update Transactions This Week' };
  }
}

/**
 * Initialize Transactions This Week card updates
 */
function initializeTransactionsThisWeekCard(user_id) {
  // Initial update
  updateTransactionsThisWeekCard(user_id);

  // Auto-update every 5 minutes
  setInterval(() => {
    updateTransactionsThisWeekCard(user_id);
  }, 300000);

  console.log('Transactions This Week card initialized for user:', user_id);
}

// Initialize on DOM load (only on the transactions page)
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system

  // Only run if the card is present
  if (document.body.textContent.includes('This Week')) {
    initializeTransactionsThisWeekCard(userId);
  }
});

// Manual refresh for testing
window.refreshTransactionsThisWeek = (userId) => {
  return updateTransactionsThisWeekCard(userId);
};

/**
 * Update Transaction Activity bar chart for the last 10 days.
 * This code assumes your HTML has a container for the bars and labels, and each bar is a child element.
 * No new HTML or CSS is created or changed.
 */
async function updateTransactionActivityChart(user_id) {
  try {
    // 1. Calculate the last 10 days (including today)
    const days = [];
    const today = new Date();
    for (let i = 9; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      days.push({
        date: d,
        label: i === 0 ? 'Today' : d.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
        iso: d.toISOString().split('T')[0]
      });
    }

    // 2. Query all transactions for the last 10 days for this user
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 9);
    startDate.setHours(0, 0, 0, 0);

    const { data: txs, error } = await supabase
      .from('transactions')
      .select('id, created_at')
      .eq('user_id', user_id)
      .gte('created_at', startDate.toISOString());

    if (error) throw error;

    // 3. Count transactions per day
    const txCounts = {};
    days.forEach(day => {
      txCounts[day.iso] = 0;
    });
    txs.forEach(tx => {
      const txDate = new Date(tx.created_at).toISOString().split('T')[0];
      if (txCounts[txDate] !== undefined) {
        txCounts[txDate]++;
      }
    });

    // 4. Find the max count for scaling
    const maxCount = Math.max(...Object.values(txCounts), 1);

    // 5. Update the chart bars and labels
    // Assumes a container with class .transaction-activity-chart and each bar is a child with .activity-bar
    const chartContainer = document.querySelector('.transaction-activity-chart');
    if (!chartContainer) return;

    // Find all bar elements and label elements (assume order matches days array)
    const bars = chartContainer.querySelectorAll('.activity-bar');
    const labels = chartContainer.querySelectorAll('.activity-label');

    days.forEach((day, i) => {
      const count = txCounts[day.iso];
      // Set bar height as a percentage of max (min 10% for visibility if count > 0)
      if (bars[i]) {
        const percent = count > 0 ? Math.max((count / maxCount) * 100, 10) : 0;
        bars[i].style.height = percent + '%';
        bars[i].title = `${count} transactions`;
        bars[i].style.opacity = count > 0 ? '1' : '0.3';
      }
      // Set label
      if (labels[i]) {
        labels[i].textContent = day.label;
      }
    });

    console.log('Transaction Activity chart updated:', txCounts);
    return { success: true, txCounts };

  } catch (error) {
    console.error('Error updating Transaction Activity chart:', error);
    return { success: false, error: 'Failed to update Transaction Activity chart' };
  }
}

/**
 * Initialize Transaction Activity chart updates
 */
function initializeTransactionActivityChart(user_id) {
  // Initial update
  updateTransactionActivityChart(user_id);

  // Auto-update every 5 minutes
  setInterval(() => {
    updateTransactionActivityChart(user_id);
  }, 300000);

  console.log('Transaction Activity chart initialized for user:', user_id);
}

// Initialize on DOM load (only on the transactions page)
document.addEventListener('DOMContentLoaded', function() {
  // Replace 'your-user-id' with actual user ID
  const userId = 'your-user-id'; // You'll need to get this from your auth system

  // Only run if the Transaction Activity chart is present
  if (document.querySelector('.transaction-activity-chart')) {
    initializeTransactionActivityChart(userId);
  }
});

// Manual refresh for testing
window.refreshTransactionActivityChart = (userId) => {
  return updateTransactionActivityChart(userId);
};

// ==================== Recent Transactions - SPA.html Integration ==================== //

const TRANSACTIONS_PAGE_SIZE = 10; // Number of transactions to load per batch

let transactionsOffset = 0;
let transactionsLoading = false;
let transactionsEndReached = false;

/**
 * Fetch transactions from Supabase with pagination.
 */
async function fetchRecentTransactions(user_id, limit = TRANSACTIONS_PAGE_SIZE, offset = 0) {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, amount_usdc, tx_hash, network, status, created_at, custom_tag, gas_fee, fee_savings')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}

/**
 * Render a single transaction card into the existing HTML structure.
 * This function assumes you have a container with a class like .recent-transactions-list.
 */
function renderTransactionCard(tx) {
  const container = document.querySelector('.recent-transactions-list');
  if (!container) return;

  // Find a template card (hidden or with a class like .transaction-card-template)
  let template = container.querySelector('.transaction-card-template');
  let card;
  if (template) {
    card = template.cloneNode(true);
    card.classList.remove('transaction-card-template');
    card.style.display = '';
  } else {
    // Fallback: clone the first card
    card = container.firstElementChild.cloneNode(true);
  }

  // Fill in transaction data
  // Amount
  const amountElem = card.querySelector('.transaction-amount');
  if (amountElem) amountElem.textContent = `${parseFloat(tx.amount_usdc).toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC`;

  // Transaction ID (shortened)
  const txIdElem = card.querySelector('.transaction-id');
  if (txIdElem) txIdElem.textContent = tx.tx_hash ? `${tx.tx_hash.slice(0, 6)}...${tx.tx_hash.slice(-4)}` : '—';
  if (txIdElem) txIdElem.title = tx.tx_hash || '';

  // Fee Savings
  const feeElem = card.querySelector('.transaction-fee-saved');
  if (feeElem) feeElem.textContent = tx.fee_savings ? `You saved ${tx.fee_savings}% in gas fees!` : '';

  // Custom Tag
  const tagElem = card.querySelector('.transaction-custom-tag');
  if (tagElem) tagElem.textContent = tx.custom_tag || '';

  // Status
  const statusElem = card.querySelector('.transaction-status');
  if (statusElem) {
    statusElem.textContent = tx.status === 'confirmed' ? 'Completed' : 'Pending';
    statusElem.className = 'transaction-status ' + (tx.status === 'confirmed' ? 'completed' : 'pending');
  }

  // Network badge
  const networkElem = card.querySelector('.transaction-network');
  if (networkElem) networkElem.textContent = tx.network ? tx.network.toUpperCase() : '';

  // Date/time
  const dateElem = card.querySelector('.transaction-date');
  if (dateElem) {
    const date = new Date(tx.created_at);
    dateElem.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  // Explorer button
  const explorerBtn = card.querySelector('.transaction-explorer-btn');
  if (explorerBtn) {
    let url = '';
    if (tx.network && tx.tx_hash) {
      if (tx.network.toLowerCase() === 'polygon') {
        url = `https://polygonscan.com/tx/${tx.tx_hash}`;
      } else if (tx.network.toLowerCase() === 'tron' || tx.network.toLowerCase() === 'trc20') {
        url = `https://tronscan.org/#/transaction/${tx.tx_hash}`;
      } else if (tx.network.toLowerCase() === 'solana') {
        url = `https://solscan.io/tx/${tx.tx_hash}`;
      }
    }
    explorerBtn.onclick = () => { if (url) window.open(url, '_blank'); };
    explorerBtn.style.display = url ? '' : 'none';
  }

  // Copy Transaction ID button
  const copyBtn = card.querySelector('.transaction-copy-btn');
  if (copyBtn && tx.tx_hash) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(tx.tx_hash);
      copyBtn.title = 'Copied!';
      setTimeout(() => { copyBtn.title = 'Copy Transaction ID'; }, 1000);
    };
    copyBtn.style.display = '';
  }

  // Insert card into container
  container.appendChild(card);
}

/**
 * Render a batch of transactions.
 */
function renderTransactionsBatch(transactions) {
  const container = document.querySelector('.recent-transactions-list');
  if (!container) return;

  // Remove any "Load more" button before appending new cards
  const loadMoreBtn = document.querySelector('.load-more-transactions-btn');
  if (loadMoreBtn) loadMoreBtn.remove();

  // Render each transaction
  transactions.forEach(tx => renderTransactionCard(tx));

  // Add "Load more" button if not at end
  if (!transactionsEndReached) {
    const btn = document.createElement('button');
    btn.className = 'load-more-transactions-btn';
    btn.textContent = 'Load more transactions';
    btn.onclick = loadMoreTransactions;
    container.appendChild(btn);
  }
}

/**
 * Load more transactions (pagination).
 */
async function loadMoreTransactions() {
  if (transactionsLoading || transactionsEndReached) return;
  transactionsLoading = true;

  // Replace 'your-user-id' with actual user ID from your auth system
  const userId = 'your-user-id';

  // Fetch next batch
  const newTxs = await fetchRecentTransactions(userId, TRANSACTIONS_PAGE_SIZE, transactionsOffset);
  if (newTxs.length < TRANSACTIONS_PAGE_SIZE) transactionsEndReached = true;
  transactionsOffset += newTxs.length;

  renderTransactionsBatch(newTxs);

  transactionsLoading = false;
}

/**
 * Initialize Recent Transactions section.
 */
async function initializeRecentTransactions() {
  // Reset state
  transactionsOffset = 0;
  transactionsEndReached = false;

  // Remove all but the template card
  const container = document.querySelector('.recent-transactions-list');
  if (!container) return;
  const template = container.querySelector('.transaction-card-template');
  container.innerHTML = '';
  if (template) container.appendChild(template);

  // Load first batch
  await loadMoreTransactions();
}

// Initialize on DOM load (only on the transactions page)
document.addEventListener('DOMContentLoaded', function() {
  // Only run if the Recent Transactions section is present
  if (document.querySelector('.recent-transactions-list')) {
    initializeRecentTransactions();
  }
});

// Manual refresh for testing
window.refreshRecentTransactions = initializeRecentTransactions;

// ==================== Payment Link Form - SPA.html Integration with Subscription Limits ==================== //

document.addEventListener('DOMContentLoaded', function () {
  // Elements
  const amountInput = document.getElementById('usdc-amount');
  const walletInput = document.getElementById('wallet-address');
  const networkOptions = document.querySelectorAll('.network-option');
  const gasFeeElem = document.getElementById('gas-fee-value');
  const linkNameInput = document.getElementById('link-name');
  const createBtn = document.getElementById('create-link-btn');
  const form = document.getElementById('payment-form');
  const generatedLinkContent = document.getElementById('generated-link-content');
  const pasteBtn = document.querySelector('.paste-btn');

  // State
  let selectedNetwork = 'polygon';

  // === Replace this with your actual user ID and plan retrieval logic ===
  const userId = window.currentUserId || 'your-user-id'; // Set this from your auth system
  async function getUserPlan() {
    // Example: fetch from Supabase user profile table
    // const { data, error } = await supabase.from('users').select('plan').eq('id', userId).single();
    // return data?.plan || 'basic';
    // For demo, return a hardcoded plan:
    return window.currentUserPlan || 'basic'; // 'basic', 'pro', or 'elite'
  }

  // 1. Network selection logic
  networkOptions.forEach(option => {
    option.addEventListener('click', function () {
      networkOptions.forEach(opt => opt.classList.remove('active'));
      this.classList.add('active');
      selectedNetwork = this.getAttribute('data-network');
      if (gasFeeElem) gasFeeElem.textContent = '~$0.00';
    });
  });

  // 2. Gas fee always negligible
  if (gasFeeElem) gasFeeElem.textContent = '~$0.00';

  // 3. Paste wallet address button
  if (pasteBtn && walletInput) {
    pasteBtn.addEventListener('click', async function () {
      try {
        const text = await navigator.clipboard.readText();
        walletInput.value = text;
      } catch (err) {
        alert('Could not paste from clipboard.');
      }
    });
  }

  // 4. Form submission logic with subscription limits
  if (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!amountInput || !walletInput || !linkNameInput) return;

      // Basic validation
      const amount = parseFloat(amountInput.value);
      const wallet = walletInput.value.trim();
      const linkName = linkNameInput.value.trim();

      if (!amount || amount <= 0) {
        alert('Please enter a valid USDC amount.');
        return;
      }
      if (!wallet || wallet.length < 5) {
        alert('Please enter a valid wallet address.');
        return;
      }
      if (!linkName) {
        alert('Please enter a payment link name.');
        return;
      }

      // Disable button to prevent double submit
      if (createBtn) createBtn.disabled = true;

      try {
        // Get user plan
        const plan = (await getUserPlan()).toLowerCase();

        // Check subscription limits
        let canCreate = true;
        let errorMsg = '';

        if (plan === 'basic') {
          // Only 1 active payment link allowed
          const { count, error } = await supabase
            .from('payment_links')
            .select('id', { count: 'exact' })
            .eq('user_id', userId)
            .eq('is_active', true);
          if (error) throw error;
          if (count >= 1) {
            canCreate = false;
            errorMsg = 'Basic plan allows only 1 active payment link. Please upgrade or deactivate an existing link.';
          }
        } else if (plan === 'pro') {
          // 30 per calendar month
          const now = new Date();
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
          const { count, error } = await supabase
            .from('payment_links')
            .select('id', { count: 'exact' })
            .eq('user_id', userId)
            .gte('created_at', monthStart.toISOString());
          if (error) throw error;
          if (count >= 30) {
            canCreate = false;
            errorMsg = 'Pro plan allows only 30 payment links per month. Please upgrade to Elite for unlimited links.';
          }
        }
        // Elite: unlimited, no check

        if (!canCreate) {
          alert(errorMsg);
          return;
        }

        // Store in Supabase
        const { data, error } = await supabase
          .from('payment_links')
          .insert([{
            user_id: userId,
            amount_usdc: amount,
            wallet_address: wallet,
            network: selectedNetwork,
            link_name: linkName,
            is_active: true,
            created_at: new Date().toISOString()
          }])
          .select()
          .single();

        if (error) throw error;

        // UI feedback: show the generated link
        if (generatedLinkContent) {
          generatedLinkContent.innerHTML = `
            <div class="link-success">
              <i class="fas fa-link"></i>
              <p>Payment Link Created!</p>
              <div class="created-link-url">${window.location.origin}/pay/${data.id || data.link_id || ''}</div>
            </div>
          `;
        }
        // Optionally reset form
        amountInput.value = '';
        walletInput.value = '';
        linkNameInput.value = '';
        networkOptions.forEach(opt => opt.classList.remove('active'));
        networkOptions[0].classList.add('active');
        selectedNetwork = 'polygon';
        if (gasFeeElem) gasFeeElem.textContent = '~$0.00';

      } catch (err) {
        alert('Error creating payment link: ' + (err.message || err));
      } finally {
        if (createBtn) createBtn.disabled = false;
      }
    });
  }
});

// ==================== Payment Link Display - SPA.html Integration ==================== //

function showGeneratedPaymentLink(linkIdOrSlug) {
  const generatedLinkContent = document.getElementById('generated-link-content');
  if (!generatedLinkContent) return;

  // Build the link URL (adjust the path if your frontend uses a different route)
  const linkUrl = `${window.location.origin}/pay/${linkIdOrSlug}`;

  // Replace the content with a centered, clickable link
  generatedLinkContent.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 120px;">
      <i class="fas fa-link" style="font-size: 2.5rem; color: #10b981; margin-bottom: 12px;"></i>
      <div style="font-size: 1.1rem; font-weight: 500; margin-bottom: 8px;">Your Payment Link:</div>
      <a href="${linkUrl}" target="_blank" style="font-size: 1.1rem; color: #2563eb; word-break: break-all; text-align: center;">
        ${linkUrl}
      </a>
      <button id="copy-payment-link-btn" style="margin-top: 14px; background: #10b981; color: #fff; border: none; border-radius: 6px; padding: 6px 18px; cursor: pointer;">
        Copy Link
      </button>
    </div>
  `;

  // Copy to clipboard functionality
  const copyBtn = document.getElementById('copy-payment-link-btn');
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(linkUrl);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 1200);
    };
  }
}

// --- Integrate this with your payment link creation logic ---

// After successful creation, call:
function onPaymentLinkCreated(data) {
  // data.id or data.link_id should be the unique identifier for the link
  showGeneratedPaymentLink(data.id || data.link_id || data.slug);
}

// Example integration with the previous form logic:
document.addEventListener('DOMContentLoaded', function () {
  // ... (rest of your form logic)
  const form = document.getElementById('payment-form');
  const createBtn = document.getElementById('create-link-btn');
  if (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      // ... (validation and plan logic)
      if (createBtn) createBtn.disabled = true;
      try {
        // ... (plan checks)
        const { data, error } = await supabase
          .from('payment_links')
          .insert([{
            user_id: window.currentUserId || 'your-user-id',
            amount_usdc: parseFloat(document.getElementById('usdc-amount').value),
            wallet_address: document.getElementById('wallet-address').value.trim(),
            network: document.querySelector('.network-option.active').getAttribute('data-network'),
            link_name: document.getElementById('link-name').value.trim(),
            is_active: true,
            created_at: new Date().toISOString()
          }])
          .select()
          .single();

        if (error) throw error;

        // Show the generated link in the box
        onPaymentLinkCreated(data);

        // ... (reset form if desired)
      } catch (err) {
        alert('Error creating payment link: ' + (err.message || err));
      } finally {
        if (createBtn) createBtn.disabled = false;
      }
    });
  }
});

// ==================== Capital Page: Total USDC Received Card Functionality ==================== //

async function fetchTotalUSDCReceived(userId) {
  // Fetch all incoming (received) transactions for the user, grouped by network
  const { data: polygonTxs, error: polygonError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('network', 'polygon')
    .eq('status', 'confirmed');

  const { data: trc20Txs, error: trc20Error } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('network', 'trc20')
    .eq('status', 'confirmed');

  if (polygonError || trc20Error) throw polygonError || trc20Error;

  const polygonTotal = polygonTxs?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;
  const trc20Total = trc20Txs?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;
  const total = polygonTotal + trc20Total;

  return {
    total,
    polygon: polygonTotal,
    trc20: trc20Total
  };
}

function renderTotalUSDCReceivedCard(received) {
  // Find the card elements in the capital page
  const valueElem = document.querySelector('.flow-stat-card.received .flow-stat-value');
  const cryptoElem = document.querySelector('.flow-stat-card.received .flow-stat-crypto');

  if (valueElem) valueElem.textContent = `$${received.total.toLocaleString()}`;
  if (cryptoElem) {
    cryptoElem.textContent =
      `${received.polygon.toLocaleString()} USDC Polygon • ${received.trc20.toLocaleString()} USDC TRC20`;
  }
}

async function initializeTotalUSDCReceivedCard() {
  // Replace with your actual user ID logic
  const userId = window.currentUserId || 'your-user-id';

  try {
    const received = await fetchTotalUSDCReceived(userId);
    renderTotalUSDCReceivedCard(received);
  } catch (err) {
    console.error('Failed to load Total USDC Received:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  // Only run if the capital page/card is present
  if (document.querySelector('.flow-stat-card.received')) {
    initializeTotalUSDCReceivedCard();
  }
});

// Manual refresh for testing
window.refreshTotalUSDCReceived = initializeTotalUSDCReceivedCard;

// ==================== Capital Page: Total USDC Paid Out Card Functionality ==================== //

async function fetchTotalUSDCPaidOut(userId) {
  // Fetch all outgoing (paid out) transactions for the user, grouped by network
  const { data: polygonTxs, error: polygonError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('network', 'polygon')
    .eq('status', 'confirmed')
    .eq('direction', 'out');

  const { data: trc20Txs, error: trc20Error } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('network', 'trc20')
    .eq('status', 'confirmed')
    .eq('direction', 'out');

  if (polygonError || trc20Error) throw polygonError || trc20Error;

  const polygonTotal = polygonTxs?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;
  const trc20Total = trc20Txs?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;
  const total = polygonTotal + trc20Total;

  return {
    total,
    polygon: polygonTotal,
    trc20: trc20Total
  };
}

function renderTotalUSDCPaidOutCard(paidOut) {
  // Find the card elements in the capital page
  const valueElem = document.querySelector('.flow-stat-card.paid-out .flow-stat-value');
  const cryptoElem = document.querySelector('.flow-stat-card.paid-out .flow-stat-crypto');

  if (valueElem) valueElem.textContent = `$${paidOut.total.toLocaleString()}`;
  if (cryptoElem) {
    cryptoElem.textContent =
      `${paidOut.polygon.toLocaleString()} USDC Polygon • ${paidOut.trc20.toLocaleString()} USDC TRC20`;
  }
}

async function initializeTotalUSDCPaidOutCard() {
  // Replace with your actual user ID logic
  const userId = window.currentUserId || 'your-user-id';

  try {
    const paidOut = await fetchTotalUSDCPaidOut(userId);
    renderTotalUSDCPaidOutCard(paidOut);
  } catch (err) {
    console.error('Failed to load Total USDC Paid Out:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  // Only run if the capital page/card is present
  if (document.querySelector('.flow-stat-card.paid-out')) {
    initializeTotalUSDCPaidOutCard();
  }
});

// Manual refresh for testing
window.refreshTotalUSDCPaidOut = initializeTotalUSDCPaidOutCard;

// ==================== Capital Page: Net USDC Flow Card Functionality ==================== //

async function fetchNetUSDCFlow(userId) {
  // Fetch all confirmed received (in) and paid out (out) transactions for each network
  // Received
  const { data: polygonIn, error: polygonInError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('network', 'polygon')
    .eq('status', 'confirmed')
    .eq('direction', 'in');

  const { data: trc20In, error: trc20InError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('network', 'trc20')
    .eq('status', 'confirmed')
    .eq('direction', 'in');

  // Paid Out
  const { data: polygonOut, error: polygonOutError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('network', 'polygon')
    .eq('status', 'confirmed')
    .eq('direction', 'out');

  const { data: trc20Out, error: trc20OutError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('network', 'trc20')
    .eq('status', 'confirmed')
    .eq('direction', 'out');

  if (polygonInError || trc20InError || polygonOutError || trc20OutError)
    throw polygonInError || trc20InError || polygonOutError || trc20OutError;

  const polygonInTotal = polygonIn?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;
  const trc20InTotal = trc20In?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;
  const polygonOutTotal = polygonOut?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;
  const trc20OutTotal = trc20Out?.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) || 0;

  const netPolygon = polygonInTotal - polygonOutTotal;
  const netTrc20 = trc20InTotal - trc20OutTotal;
  const netTotal = netPolygon + netTrc20;

  return {
    netTotal,
    netPolygon,
    netTrc20
  };
}

function renderNetUSDCFlowCard(net) {
  // Find the card elements in the capital page
  const valueElem = document.querySelector('.flow-stat-card.net-flow .flow-stat-value');
  const cryptoElem = document.querySelector('.flow-stat-card.net-flow .flow-stat-crypto');

  // Format with sign and commas
  const formatSigned = v => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toLocaleString();
  const formatSignedUSDC = v => (v >= 0 ? '+' : '-') + Math.abs(v).toLocaleString() + ' USDC';

  if (valueElem) valueElem.textContent = formatSigned(net.netTotal);
  if (cryptoElem) {
    cryptoElem.textContent =
      `${formatSignedUSDC(net.netPolygon)} USDC Polygon • ${formatSignedUSDC(net.netTrc20)} USDC TRC20`;
  }
}

async function initializeNetUSDCFlowCard() {
  // Replace with your actual user ID logic
  const userId = window.currentUserId || 'your-user-id';

  try {
    const net = await fetchNetUSDCFlow(userId);
    renderNetUSDCFlowCard(net);
  } catch (err) {
    console.error('Failed to load Net USDC Flow:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  // Only run if the capital page/card is present
  if (document.querySelector('.flow-stat-card.net-flow')) {
    initializeNetUSDCFlowCard();
  }
});

// Manual refresh for testing
window.refreshNetUSDCFlow = initializeNetUSDCFlowCard;

// ==================== Daily USDC Inflows vs Outflows Bar Chart Functionality ==================== //

/**
 * Fetch inflow and outflow data for the given period (30D, 7D, 24H)
 */
async function fetchUSDCFlowData(userId, period = '30D') {
  const now = new Date();
  let days = 30;
  if (period === '7D') days = 7;
  if (period === '24H') days = 1;

  // Build an array of date strings for the period
  const dateLabels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dateLabels.push(d.toISOString().split('T')[0]);
  }

  // Fetch all relevant transactions for the user in the period
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - days + 1);
  startDate.setHours(0, 0, 0, 0);

  const { data: inflows, error: inflowError } = await supabase
    .from('transactions')
    .select('amount_usdc, created_at')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .eq('direction', 'in')
    .gte('created_at', startDate.toISOString());

  const { data: outflows, error: outflowError } = await supabase
    .from('transactions')
    .select('amount_usdc, created_at')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .eq('direction', 'out')
    .gte('created_at', startDate.toISOString());

  if (inflowError || outflowError) throw inflowError || outflowError;

  // Aggregate by day
  const inflowByDay = {};
  const outflowByDay = {};
  dateLabels.forEach(date => {
    inflowByDay[date] = 0;
    outflowByDay[date] = 0;
  });

  inflows.forEach(tx => {
    const date = new Date(tx.created_at).toISOString().split('T')[0];
    if (inflowByDay[date] !== undefined) {
      inflowByDay[date] += parseFloat(tx.amount_usdc || 0);
    }
  });
  outflows.forEach(tx => {
    const date = new Date(tx.created_at).toISOString().split('T')[0];
    if (outflowByDay[date] !== undefined) {
      outflowByDay[date] += parseFloat(tx.amount_usdc || 0);
    }
  });

  return {
    labels: dateLabels,
    inflows: dateLabels.map(date => inflowByDay[date]),
    outflows: dateLabels.map(date => outflowByDay[date])
  };
}

/**
 * Render the bar chart using Chart.js (assumes a <canvas id="usdc-flow-bar-chart"> exists in your HTML)
 */
let usdcFlowChartInstance = null;
function renderUSDCFlowBarChart({ labels, inflows, outflows }) {
  const ctx = document.getElementById('usdc-flow-bar-chart');
  if (!ctx) return;

  // Destroy previous chart if exists
  if (usdcFlowChartInstance) {
    usdcFlowChartInstance.destroy();
  }

  usdcFlowChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map(date => {
        const d = new Date(date);
        return labels.length === 1
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }),
      datasets: [
        {
          label: 'USDC Received',
          data: inflows,
          backgroundColor: '#34d399',
          borderRadius: 4,
          barPercentage: 0.5,
        },
        {
          label: 'USDC Paid Out',
          data: outflows,
          backgroundColor: '#2563eb',
          borderRadius: 4,
          barPercentage: 0.5,
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true, position: 'bottom' },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: $${context.raw.toLocaleString()}`;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.05)' },
          ticks: {
            callback: value => '$' + value.toLocaleString()
          }
        }
      }
    }
  });
}

/**
 * Handle period button clicks and update chart
 */
async function handleUSDCFlowPeriodChange(period) {
  const userId = window.currentUserId || 'your-user-id';
  try {
    const data = await fetchUSDCFlowData(userId, period);
    renderUSDCFlowBarChart(data);
  } catch (err) {
    console.error('Failed to load USDC flow data:', err);
  }
}

/**
 * Initialize the chart and buttons
 */
function initializeUSDCFlowBarChart() {
  // Only run if the chart container is present
  if (!document.getElementById('usdc-flow-bar-chart')) return;

  // Initial load (30D)
  handleUSDCFlowPeriodChange('30D');

  // Button logic
  const controls = document.querySelectorAll('.chart-controls .chart-control');
  controls.forEach(btn => {
    btn.addEventListener('click', function () {
      controls.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const label = this.textContent.trim();
      if (label === '30D') handleUSDCFlowPeriodChange('30D');
      else if (label === '7D') handleUSDCFlowPeriodChange('7D');
      else if (label === '24H') handleUSDCFlowPeriodChange('24H');
    });
  });
}

document.addEventListener('DOMContentLoaded', function () {
  initializeUSDCFlowBarChart();
});

// Manual refresh for testing
window.refreshUSDCFlowBarChart = initializeUSDCFlowBarChart;

// ==================== Net USDC Flow Over Time Chart Functionality ==================== //

/**
 * Fetch daily net USDC flow (received - paid out) for the last 30 days.
 */
async function fetchNetUSDCFlowOverTime(userId, days = 30) {
  const now = new Date();
  const dateLabels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dateLabels.push(d.toISOString().split('T')[0]);
  }

  // Fetch all relevant transactions for the user in the period
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - days + 1);
  startDate.setHours(0, 0, 0, 0);

  const { data: inflows, error: inflowError } = await supabase
    .from('transactions')
    .select('amount_usdc, created_at')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .eq('direction', 'in')
    .gte('created_at', startDate.toISOString());

  const { data: outflows, error: outflowError } = await supabase
    .from('transactions')
    .select('amount_usdc, created_at')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .eq('direction', 'out')
    .gte('created_at', startDate.toISOString());

  if (inflowError || outflowError) throw inflowError || outflowError;

  // Aggregate by day
  const inflowByDay = {};
  const outflowByDay = {};
  dateLabels.forEach(date => {
    inflowByDay[date] = 0;
    outflowByDay[date] = 0;
  });

  inflows.forEach(tx => {
    const date = new Date(tx.created_at).toISOString().split('T')[0];
    if (inflowByDay[date] !== undefined) {
      inflowByDay[date] += parseFloat(tx.amount_usdc || 0);
    }
  });
  outflows.forEach(tx => {
    const date = new Date(tx.created_at).toISOString().split('T')[0];
    if (outflowByDay[date] !== undefined) {
      outflowByDay[date] += parseFloat(tx.amount_usdc || 0);
    }
  });

  // Net flow per day
  const netFlow = dateLabels.map(date => inflowByDay[date] - outflowByDay[date]);
  return { labels: dateLabels, netFlow };
}

/**
 * Render the net flow line and area in the SVG chart.
 * Matches the .net-flow-chart, .net-flow-area, .net-flow-line, and .flow-point elements in your HTML.
 */
function renderNetUSDCFlowChart({ labels, netFlow }) {
  const svg = document.querySelector('.net-flow-chart');
  if (!svg) return;

  // SVG dimensions
  const width = 500;
  const height = 150;
  const leftPad = 20;
  const rightPad = 20;
  const topPad = 30;
  const bottomPad = 30;
  const chartWidth = width - leftPad - rightPad;
  const chartHeight = height - topPad - bottomPad;

  // Only show up to 6 points for visual clarity (like your image)
  const pointsToShow = 6;
  const step = chartWidth / (pointsToShow - 1);
  const data = netFlow.slice(-pointsToShow);

  // Y scale: center is 0, positive up, negative down
  const maxAbs = Math.max(1, ...data.map(Math.abs));
  const yScale = v => height / 2 - (v / maxAbs) * (chartHeight / 2);

  // Calculate points
  const points = data.map((v, i) => [
    leftPad + i * step,
    yScale(v)
  ]);

  // Build line path (smooth quadratic)
  let linePath = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    const [prevX, prevY] = points[i - 1];
    const cpx = (x + prevX) / 2;
    linePath += ` Q${cpx},${prevY} ${x},${y}`;
  }

  // Build area path
  let areaPath = linePath + ` L${points[points.length - 1][0]},${height - bottomPad} L${points[0][0]},${height - bottomPad} Z`;

  // Update SVG paths
  const areaElem = svg.querySelector('.net-flow-area');
  if (areaElem) areaElem.setAttribute('d', areaPath);

  const lineElem = svg.querySelector('.net-flow-line');
  if (lineElem) lineElem.setAttribute('d', linePath);

  // Update data points
  const pointElems = svg.querySelectorAll('.flow-point');
  pointElems.forEach((circle, i) => {
    if (points[i]) {
      circle.setAttribute('cx', points[i][0]);
      circle.setAttribute('cy', points[i][1]);
      circle.style.display = '';
    } else {
      circle.style.display = 'none';
    }
  });
}

/**
 * Initialize the Net USDC Flow Over Time chart
 */
async function initializeNetUSDCFlowChart() {
  const userId = window.currentUserId || 'your-user-id';
  try {
    const data = await fetchNetUSDCFlowOverTime(userId, 30);
    renderNetUSDCFlowChart(data);
  } catch (err) {
    console.error('Failed to load Net USDC Flow Over Time:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.net-flow-chart')) {
    initializeNetUSDCFlowChart();
  }
});

window.refreshNetUSDCFlowChart = initializeNetUSDCFlowChart;

// ==================== Current User Balances Table Functionality ==================== //

async function fetchUserBalances(filter = 'All') {
  // Fetch all user balances, optionally filter by status/network
  let query = supabase
    .from('user_balances')
    .select('user_id, wallet_address, is_active, usdc_polygon, usdc_tron, usdc_solana, usd_equivalent, last_active, user_profiles(name, initials)');

  if (filter === 'Active') {
    query = query.eq('is_active', true);
  } else if (filter === 'Polygon') {
    query = query.gt('usdc_polygon', 0);
  } else if (filter === 'TRC20') {
    query = query.gt('usdc_tron', 0);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

function formatWalletAddress(address) {
  if (!address) return '';
  return address.length > 10
    ? address.slice(0, 6) + '...' + address.slice(-4)
    : address;
}

function formatLastActive(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs !== 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

function updateUserBalancesTable(users) {
  // Find the table body (all .table-row except .table-header)
  const table = document.querySelector('.user-balances-table');
  if (!table) return;
  // Remove all rows except the header
  const header = table.querySelector('.table-header');
  const oldRows = table.querySelectorAll('.table-row');
  oldRows.forEach(row => row.remove());

  // Find a template row if you have one, else use the first .table-row as template
  let templateRow = table.querySelector('.table-row-template');
  if (!templateRow) templateRow = null;

  users.forEach(user => {
    let row;
    if (templateRow) {
      row = templateRow.cloneNode(true);
      row.classList.remove('table-row-template');
      row.style.display = '';
    } else {
      // Find the first .table-row (not .table-header) as template
      const firstRow = table.querySelector('.table-row');
      if (firstRow) {
        row = firstRow.cloneNode(true);
      } else {
        // No template, skip rendering
        return;
      }
    }

    // USER NAME & AVATAR
    const initials = user.user_profiles?.initials || (user.user_profiles?.name ? user.user_profiles.name.split(' ').map(n => n[0]).join('').toUpperCase() : '??');
    const name = user.user_profiles?.name || 'Unknown';
    const userAvatar = row.querySelector('.user-avatar');
    if (userAvatar) userAvatar.textContent = initials;
    const userName = row.querySelector('.user-name');
    if (userName) userName.textContent = name;

    // ACTIVE/INACTIVE
    const userStatus = row.querySelector('.user-status');
    if (userStatus) {
      userStatus.textContent = user.is_active ? 'Active' : 'Inactive';
      userStatus.className = 'user-status ' + (user.is_active ? 'active' : 'inactive');
    }

    // WALLET ADDRESS & COPY BUTTON
    const walletAddr = row.querySelector('.wallet-address');
    if (walletAddr) walletAddr.textContent = formatWalletAddress(user.wallet_address);
    const copyBtn = row.querySelector('.copy-btn');
    if (copyBtn && walletAddr) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(user.wallet_address);
        copyBtn.title = 'Copied!';
        setTimeout(() => { copyBtn.title = 'Copy'; }, 1200);
      };
    }

    // USDC HELD (Polygon, TRC20, Solana)
    const cryptoCell = row.querySelector('.crypto-cell');
    if (cryptoCell) {
      // Remove all .crypto-item children
      cryptoCell.querySelectorAll('.crypto-item').forEach(item => item.remove());
      // Polygon
      if (user.usdc_polygon && user.usdc_polygon > 0) {
        const item = document.createElement('div');
        item.className = 'crypto-item';
        item.innerHTML = `<span class="crypto-amount">${parseFloat(user.usdc_polygon).toLocaleString()} USDC</span>
                          <span class="crypto-network">Polygon</span>`;
        cryptoCell.appendChild(item);
      }
      // TRC20
      if (user.usdc_tron && user.usdc_tron > 0) {
        const item = document.createElement('div');
        item.className = 'crypto-item';
        item.innerHTML = `<span class="crypto-amount">${parseFloat(user.usdc_tron).toLocaleString()} USDC</span>
                          <span class="crypto-network">TRC20</span>`;
        cryptoCell.appendChild(item);
      }
      // Solana
      if (user.usdc_solana && user.usdc_solana > 0) {
        const item = document.createElement('div');
        item.className = 'crypto-item';
        item.innerHTML = `<span class="crypto-amount">${parseFloat(user.usdc_solana).toLocaleString()} USDC</span>
                          <span class="crypto-network">Solana</span>`;
        cryptoCell.appendChild(item);
      }
    }

    // USD EQUIVALENT
    const usdCell = row.querySelector('.amount-cell');
    if (usdCell) usdCell.textContent = user.usd_equivalent ? `$${parseFloat(user.usd_equivalent).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '$0.00';

    // LAST ACTIVITY
    const timeCell = row.querySelector('.time-cell');
    if (timeCell) timeCell.textContent = formatLastActive(user.last_active);

    // Append row to table
    table.appendChild(row);
  });
}

function setupUserBalancesFilters() {
  const controls = document.querySelectorAll('.chart-controls .chart-control');
  controls.forEach(btn => {
    btn.addEventListener('click', async function () {
      controls.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const label = this.textContent.trim();
      await initializeUserBalancesTable(label);
    });
  });
}

async function initializeUserBalancesTable(filter = 'All') {
  try {
    const users = await fetchUserBalances(filter);
    updateUserBalancesTable(users);
  } catch (err) {
    console.error('Failed to load user balances:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.user-balances-table')) {
    initializeUserBalancesTable();
    setupUserBalancesFilters();
  }
});

window.refreshUserBalancesTable = initializeUserBalancesTable;

// ==================== Fees Collected Over Time Chart Functionality ==================== //

async function fetchFeesSavedData(userId) {
  // Fetch all confirmed transactions for the user
  const { data: txs, error } = await supabase
    .from('transactions')
    .select('amount_usdc, created_at')
    .eq('user_id', userId)
    .eq('status', 'confirmed');

  if (error) throw error;

  // Calculate total fees saved (lifetime)
  // Assume all transactions paid 0% fee, compare to 3% proposer fee
  let totalSaved = 0;
  txs.forEach(tx => {
    const amt = parseFloat(tx.amount_usdc || 0);
    totalSaved += amt * 0.03;
  });

  // Aggregate by day for the chart (last 30 days)
  const now = new Date();
  const days = 30;
  const dateLabels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dateLabels.push(d.toISOString().split('T')[0]);
  }
  const savedByDay = {};
  dateLabels.forEach(date => { savedByDay[date] = 0; });
  txs.forEach(tx => {
    const date = new Date(tx.created_at).toISOString().split('T')[0];
    if (savedByDay[date] !== undefined) {
      savedByDay[date] += parseFloat(tx.amount_usdc || 0) * 0.03;
    }
  });

  return {
    totalSaved,
    avgFeePercent: 0.85, // Always show 0.85% as in your design
    chartLabels: dateLabels,
    chartData: dateLabels.map(date => savedByDay[date])
  };
}

function renderFeesCollectedCard(feesData) {
  // Find the card elements in the fees chart panel
  const totalFeesElem = document.querySelector('.fees-summary .fee-value');
  const avgFeeElem = document.querySelectorAll('.fees-summary .fee-value')[1];

  // Set total fees and avg fee %
  if (totalFeesElem) totalFeesElem.textContent = `$${Math.round(feesData.totalSaved).toLocaleString()}`;
  if (avgFeeElem) avgFeeElem.textContent = `${feesData.avgFeePercent.toFixed(2)}%`;

  // Update the SVG line chart
  const svg = document.querySelector('.fees-chart');
  if (!svg) return;

  // SVG dimensions
  const width = 300;
  const height = 120;
  const leftPad = 20;
  const rightPad = 20;
  const topPad = 30;
  const bottomPad = 30;
  const chartWidth = width - leftPad - rightPad;
  const chartHeight = height - topPad - bottomPad;

  // Only show up to 5 points for visual clarity (like your image)
  const pointsToShow = 5;
  const step = chartWidth / (pointsToShow - 1);
  const data = feesData.chartData.slice(-pointsToShow);

  // Y scale: min is 0, max is max value in data
  const maxVal = Math.max(1, ...data);
  const yScale = v => height - bottomPad - (v / maxVal) * chartHeight;

  // Calculate points
  const points = data.map((v, i) => [
    leftPad + i * step,
    yScale(v)
  ]);

  // Build line path (smooth quadratic)
  let linePath = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    const [prevX, prevY] = points[i - 1];
    const cpx = (x + prevX) / 2;
    linePath += ` Q${cpx},${prevY} ${x},${y}`;
  }

  // Update SVG path
  const lineElem = svg.querySelector('.fees-line');
  if (lineElem) lineElem.setAttribute('d', linePath);

  // Update data points
  const pointElems = svg.querySelectorAll('.fee-point');
  pointElems.forEach((circle, i) => {
    if (points[i]) {
      circle.setAttribute('cx', points[i][0]);
      circle.setAttribute('cy', points[i][1]);
      circle.style.display = '';
    } else {
      circle.style.display = 'none';
    }
  });
}

async function initializeFeesCollectedCard() {
  const userId = window.currentUserId || 'your-user-id';
  try {
    const feesData = await fetchFeesSavedData(userId);
    renderFeesCollectedCard(feesData);
  } catch (err) {
    console.error('Failed to load Fees Collected Over Time:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.fees-chart')) {
    initializeFeesCollectedCard();
  }
});

window.refreshFeesCollectedCard = initializeFeesCollectedCard;

// ==================== USDC Network Distribution Pie Chart Functionality ==================== //

/**
 * Fetch and render USDC network distribution (volume by network) using only your existing HTML elements.
 * Assumes you have a pie/donut chart SVG or canvas and legend elements already in SPA.html.
 */

async function updateUSDCNetworkDistribution(userId) {
  // 1. Fetch all confirmed USDC transactions for the user, grouped by network
  const { data: networkRows, error } = await supabase
    .from('network_distributions')
    .select('network, volume_usdc, percent_usage')
    .eq('user_id', userId);

  if (error) throw error;

  // 2. Prepare data for chart
  // Example: [{network: 'polygon', volume_usdc: 700, percent_usage: 70}, ...]
  const networks = networkRows || [];
  const totalVolume = networks.reduce((sum, n) => sum + (parseFloat(n.volume_usdc) || 0), 0);

  // 3. Update legend values (assumes you have elements with classes like .legend-polygon, .legend-solana, etc.)
  networks.forEach(n => {
    const legendElem = document.querySelector(`.legend-${n.network.toLowerCase()}`);
    if (legendElem) {
      legendElem.textContent = `USDC ${capitalize(n.network)} (${Math.round(n.percent_usage)}%)`;
    }
  });

  // 4. Update pie/donut chart (assumes you have SVG paths/arcs or a canvas for each network)
  // Example: <svg> <path class="pie-polygon"> <path class="pie-solana"> ... </svg>
  let startAngle = 0;
  networks.forEach(n => {
    const percent = totalVolume ? (parseFloat(n.volume_usdc) / totalVolume) : 0;
    const endAngle = startAngle + percent * 2 * Math.PI;

    // Update SVG arc for this network
    const arcElem = document.querySelector(`.pie-${n.network.toLowerCase()}`);
    if (arcElem) {
      // Assume a donut chart with radius 40, center (50,50)
      const r = 40, cx = 50, cy = 50;
      const largeArc = percent > 0.5 ? 1 : 0;
      const x1 = cx + r * Math.cos(startAngle - Math.PI / 2);
      const y1 = cy + r * Math.sin(startAngle - Math.PI / 2);
      const x2 = cx + r * Math.cos(endAngle - Math.PI / 2);
      const y2 = cy + r * Math.sin(endAngle - Math.PI / 2);
      const d = [
        `M ${x1} ${y1}`,
        `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`
      ].join(' ');
      arcElem.setAttribute('d', d);
      arcElem.style.display = percent > 0 ? '' : 'none';
    }
    startAngle = endAngle;
  });

  // 5. Hide unused legend/chart elements if there are fewer than expected
  const expectedNetworks = ['polygon', 'solana', 'tron'];
  expectedNetworks.forEach(net => {
    if (!networks.find(n => n.network.toLowerCase() === net)) {
      const legendElem = document.querySelector(`.legend-${net}`);
      if (legendElem) legendElem.textContent = '';
      const arcElem = document.querySelector(`.pie-${net}`);
      if (arcElem) arcElem.style.display = 'none';
    }
  });
}

// Helper to capitalize network names
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ==================== USDC Transaction Volume Overview Table Functionality ==================== //

/**
 * Fetch and render daily USDC transaction statistics for the overview table.
 * Uses only your existing HTML table rows and cells.
 */

async function updateUSDCTransactionVolumeOverview(userId, days = 7) {
  // 1. Prepare date range (last N days)
  const now = new Date();
  const dateLabels = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    dateLabels.push(d.toISOString().split('T')[0]);
  }

  // 2. Fetch all confirmed transactions for the user in the date range
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - days + 1);
  startDate.setHours(0, 0, 0, 0);

  const { data: txs, error } = await supabase
    .from('transactions')
    .select('created_at, amount_usdc, network, usd_equivalent')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .gte('created_at', startDate.toISOString());

  if (error) throw error;

  // 3. Group transactions by date and network
  const dailyStats = {};
  dateLabels.forEach(date => {
    dailyStats[date] = {
      date: new Date(date),
      transactions: 0,
      volumeByNetwork: {},
      totalVolumeUSD: 0,
      totalAmountUSDC: 0
    };
  });

  txs.forEach(tx => {
    const date = tx.created_at.split('T')[0];
    if (!dailyStats[date]) return;
    dailyStats[date].transactions += 1;
    const network = tx.network || 'unknown';
    if (!dailyStats[date].volumeByNetwork[network]) dailyStats[date].volumeByNetwork[network] = 0;
    dailyStats[date].volumeByNetwork[network] += parseFloat(tx.amount_usdc || 0);
    dailyStats[date].totalVolumeUSD += parseFloat(tx.usd_equivalent || 0);
    dailyStats[date].totalAmountUSDC += parseFloat(tx.amount_usdc || 0);
  });

  // 4. Find all table rows (excluding header)
  const rows = document.querySelectorAll('.usdc-volume-table .usdc-volume-row');
  const sortedDates = dateLabels.sort((a, b) => new Date(b) - new Date(a));

  // 5. Fill each row with daily stats, or clear if no data
  rows.forEach((row, i) => {
    const dateKey = sortedDates[i];
    const stat = dailyStats[dateKey];

    // Date cell
    const dateCell = row.querySelector('.usdc-volume-date');
    if (dateCell) {
      dateCell.textContent = stat
        ? stat.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
    }

    // Transactions cell
    const txCell = row.querySelector('.usdc-volume-tx');
    if (txCell) {
      txCell.textContent = stat ? stat.transactions : '';
    }

    // Volume (USDC) cell
    const volCell = row.querySelector('.usdc-volume-usdc');
    if (volCell) {
      if (stat && stat.transactions > 0) {
        // List each network's volume
        volCell.innerHTML = Object.entries(stat.volumeByNetwork)
          .map(([network, amt]) => `<span class="usdc-network-label">${amt.toLocaleString()} USDC ${capitalize(network)}</span>`)
          .join('<br>');
      } else {
        volCell.innerHTML = '';
      }
    }

    // Volume (USD) cell
    const usdCell = row.querySelector('.usdc-volume-usd');
    if (usdCell) {
      usdCell.textContent = stat && stat.transactions > 0
        ? `$${stat.totalVolumeUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        : '';
    }

    // Avg Tx Value cell
    const avgCell = row.querySelector('.usdc-volume-avg');
    if (avgCell) {
      avgCell.textContent = (stat && stat.transactions > 0)
        ? `$${(stat.totalAmountUSDC / stat.transactions).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        : '';
    }
  });
}

// ==================== Payment Status Pie Chart Functionality ==================== //

async function fetchPaymentStatusData(userId) {
  // Fetch all payments for the user
  const { data: payments, error } = await supabase
    .from('payments')
    .select('status')
    .eq('user_id', userId);

  if (error) throw error;

  // Count statuses
  let completed = 0, pending = 0, failed = 0;
  payments.forEach(p => {
    if (p.status === 'confirmed' || p.status === 'completed') completed++;
    else if (p.status === 'pending') pending++;
    else failed++;
  });
  const total = completed + pending + failed;
  const completedPct = total ? Math.round((completed / total) * 100) : 0;
  const pendingPct = total ? Math.round((pending / total) * 100) : 0;
  const failedPct = total ? 100 - completedPct - pendingPct : 0;

  return { total, completed, pending, failed, completedPct, pendingPct, failedPct };
}

function renderPaymentStatusCard(statusData) {
  // Find the SVG and stat elements in your Payment Status card
  const svg = document.querySelector('.payment-status-pie');
  const totalElem = document.querySelector('.payment-status-total');
  const completedElem = document.querySelector('.payment-status-completed');
  const pendingElem = document.querySelector('.payment-status-pending');
  const failedElem = document.querySelector('.payment-status-failed');

  // Set total
  if (totalElem) totalElem.textContent = statusData.total.toLocaleString();

  // Set legend percentages
  if (completedElem) completedElem.textContent = `Completed (${statusData.completedPct}%)`;
  if (pendingElem) pendingElem.textContent = `Pending (${statusData.pendingPct}%)`;
  if (failedElem) failedElem.textContent = `Failed (${statusData.failedPct}%)`;

  // Update SVG pie chart (assume 1 circle per status, with .pie-completed, .pie-pending, .pie-failed)
  if (svg) {
    const r = 48; // radius
    const c = 2 * Math.PI * r;
    const completedLen = c * (statusData.completedPct / 100);
    const pendingLen = c * (statusData.pendingPct / 100);
    const failedLen = c * (statusData.failedPct / 100);

    let offset = 0;
    const completedCircle = svg.querySelector('.pie-completed');
    if (completedCircle) {
      completedCircle.setAttribute('stroke-dasharray', `${completedLen} ${c - completedLen}`);
      completedCircle.setAttribute('stroke-dashoffset', offset);
      offset -= completedLen;
    }
    const pendingCircle = svg.querySelector('.pie-pending');
    if (pendingCircle) {
      pendingCircle.setAttribute('stroke-dasharray', `${pendingLen} ${c - pendingLen}`);
      pendingCircle.setAttribute('stroke-dashoffset', offset);
      offset -= pendingLen;
    }
    const failedCircle = svg.querySelector('.pie-failed');
    if (failedCircle) {
      failedCircle.setAttribute('stroke-dasharray', `${failedLen} ${c - failedLen}`);
      failedCircle.setAttribute('stroke-dashoffset', offset);
    }
  }
}

async function initializePaymentStatusCard() {
  const userId = window.currentUserId || 'your-user-id';
  try {
    const statusData = await fetchPaymentStatusData(userId);
    renderPaymentStatusCard(statusData);
  } catch (err) {
    console.error('Failed to load Payment Status:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.payment-status-pie')) {
    initializePaymentStatusCard();
  }
});

window.refreshPaymentStatusCard = initializePaymentStatusCard;

// ==================== User Growth Card & Chart Functionality ==================== //

async function fetchUserGrowthData() {
  // Fetch user growth stats for the last 4 months (current + 3 previous)
  const now = new Date();
  const months = [];
  for (let i = 3; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      label: d.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
      iso: d.toISOString().split('T')[0].slice(0, 7) // YYYY-MM
    });
  }

  // Query user_growth table for these months
  const { data: growthRows, error } = await supabase
    .from('user_growth')
    .select('active_users, avg_volume_per_user, timestamp')
    .gte('timestamp', months[0].iso + '-01');

  if (error) throw error;

  // Aggregate by month
  const usersByMonth = {};
  const volumeByMonth = {};
  months.forEach(m => {
    usersByMonth[m.iso] = 0;
    volumeByMonth[m.iso] = 0;
  });
  growthRows.forEach(row => {
    const month = new Date(row.timestamp).toISOString().slice(0, 7);
    if (usersByMonth[month] !== undefined) {
      usersByMonth[month] = row.active_users;
      volumeByMonth[month] = row.avg_volume_per_user;
    }
  });

  // Calculate growth percentages (current vs 3 months ago)
  const currentUsers = usersByMonth[months[3].iso];
  const prevUsers = usersByMonth[months[0].iso];
  const userGrowthPct = prevUsers > 0 ? Math.round(((currentUsers - prevUsers) / prevUsers) * 100) : 0;

  const currentVolume = volumeByMonth[months[3].iso];
  const prevVolume = volumeByMonth[months[0].iso];
  const volumeGrowthPct = prevVolume > 0 ? Math.round(((currentVolume - prevVolume) / prevVolume) * 100) : 0;

  return {
    months: months.map(m => m.label),
    users: months.map(m => usersByMonth[m.iso]),
    volume: months.map(m => volumeByMonth[m.iso]),
    currentUsers,
    userGrowthPct,
    currentVolume,
    volumeGrowthPct
  };
}

function renderUserGrowthCard(growth) {
  // Find the card elements
  const usersElem = document.querySelector('.user-growth-users');
  const usersPctElem = document.querySelector('.user-growth-users-pct');
  const volumeElem = document.querySelector('.user-growth-volume');
  const volumePctElem = document.querySelector('.user-growth-volume-pct');
  const svg = document.querySelector('.user-growth-chart');

  // Set values
  if (usersElem) usersElem.textContent = growth.currentUsers?.toLocaleString() || '0';
  if (usersPctElem) {
    usersPctElem.textContent = (growth.userGrowthPct >= 0 ? '+' : '') + growth.userGrowthPct + '%';
    usersPctElem.className = 'user-growth-users-pct ' + (growth.userGrowthPct >= 0 ? 'positive' : 'negative');
  }
  if (volumeElem) volumeElem.textContent = growth.currentVolume ? `$${Math.round(growth.currentVolume).toLocaleString()}` : '$0';
  if (volumePctElem) {
    volumePctElem.textContent = (growth.volumeGrowthPct >= 0 ? '+' : '') + growth.volumeGrowthPct + '%';
    volumePctElem.className = 'user-growth-volume-pct ' + (growth.volumeGrowthPct >= 0 ? 'positive' : 'negative');
  }

  // Update the SVG line chart (users: green, volume: blue)
  if (svg) {
    const width = 300, height = 60, leftPad = 10, rightPad = 10, topPad = 10, bottomPad = 10;
    const chartWidth = width - leftPad - rightPad;
    const chartHeight = height - topPad - bottomPad;
    const pointsToShow = growth.months.length;
    const step = chartWidth / (pointsToShow - 1);

    // Y scale for users and volume
    const maxUsers = Math.max(...growth.users, 1);
    const maxVolume = Math.max(...growth.volume, 1);
    const yScaleUsers = v => height - bottomPad - (v / maxUsers) * chartHeight;
    const yScaleVolume = v => height - bottomPad - (v / maxVolume) * chartHeight;

    // Points
    const userPoints = growth.users.map((v, i) => [leftPad + i * step, yScaleUsers(v)]);
    const volumePoints = growth.volume.map((v, i) => [leftPad + i * step, yScaleVolume(v)]);

    // Build line paths
    let userLine = `M${userPoints[0][0]},${userPoints[0][1]}`;
    for (let i = 1; i < userPoints.length; i++) {
      const [x, y] = userPoints[i];
      const [prevX, prevY] = userPoints[i - 1];
      const cpx = (x + prevX) / 2;
      userLine += ` Q${cpx},${prevY} ${x},${y}`;
    }
    let volumeLine = `M${volumePoints[0][0]},${volumePoints[0][1]}`;
    for (let i = 1; i < volumePoints.length; i++) {
      const [x, y] = volumePoints[i];
      const [prevX, prevY] = volumePoints[i - 1];
      const cpx = (x + prevX) / 2;
      volumeLine += ` Q${cpx},${prevY} ${x},${y}`;
    }

    // Update SVG paths (assume .user-growth-users-line and .user-growth-volume-line)
    const usersLineElem = svg.querySelector('.user-growth-users-line');
    if (usersLineElem) usersLineElem.setAttribute('d', userLine);
    const volumeLineElem = svg.querySelector('.user-growth-volume-line');
    if (volumeLineElem) volumeLineElem.setAttribute('d', volumeLine);

    // Update points (assume .user-growth-users-point and .user-growth-volume-point)
    const userPointsElems = svg.querySelectorAll('.user-growth-users-point');
    userPointsElems.forEach((circle, i) => {
      if (userPoints[i]) {
        circle.setAttribute('cx', userPoints[i][0]);
        circle.setAttribute('cy', userPoints[i][1]);
        circle.style.display = '';
      } else {
        circle.style.display = 'none';
      }
    });
    const volumePointsElems = svg.querySelectorAll('.user-growth-volume-point');
    volumePointsElems.forEach((circle, i) => {
      if (volumePoints[i]) {
        circle.setAttribute('cx', volumePoints[i][0]);
        circle.setAttribute('cy', volumePoints[i][1]);
        circle.style.display = '';
      } else {
        circle.style.display = 'none';
      }
    });
  }
}

async function initializeUserGrowthCard() {
  try {
    const growth = await fetchUserGrowthData();
    renderUserGrowthCard(growth);
  } catch (err) {
    console.error('Failed to load User Growth:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.user-growth-chart')) {
    initializeUserGrowthCard();
  }
});

window.refreshUserGrowthCard = initializeUserGrowthCard;

// ==================== Top Payment Links Card Functionality ==================== //

async function fetchTopPaymentLinks(userId) {
  // Fetch all payment links for the user
  const { data: links, error } = await supabase
    .from('payment_links')
    .select('id, link_name, link_id')
    .eq('user_id', userId);

  if (error) throw error;

  // For each link, fetch payment stats (success count and total volume)
  for (const link of links) {
    const { data: payments, error: payError } = await supabase
      .from('payments')
      .select('amount_usdc')
      .eq('payment_link_id', link.id)
      .eq('status', 'confirmed');

    if (payError) throw payError;

    link.payments_count = payments.length;
    link.total_volume = payments.reduce((sum, p) => sum + parseFloat(p.amount_usdc || 0), 0);
  }

  // Sort by payments_count descending, take top 3
  links.sort((a, b) => b.payments_count - a.payments_count);
  return links.slice(0, 3);
}

function updateTopPaymentLinksCard(links) {
  // Find all top link cards in order
  const cards = document.querySelectorAll('.top-payment-link-card');
  links.forEach((link, i) => {
    const card = cards[i];
    if (!card) return;

    // Link name
    const nameElem = card.querySelector('.top-link-name');
    if (nameElem) nameElem.textContent = link.link_name;

    // Link URL
    const urlElem = card.querySelector('.top-link-url');
    if (urlElem) urlElem.textContent = `halaxa.pay/${link.link_id || ''}`;

    // Payments count
    const paymentsElem = card.querySelector('.top-link-payments');
    if (paymentsElem) paymentsElem.textContent = link.payments_count.toLocaleString();

    // Volume
    const volumeElem = card.querySelector('.top-link-volume');
    if (volumeElem) volumeElem.textContent = `$${Math.round(link.total_volume).toLocaleString()}`;
  });
}

async function initializeTopPaymentLinksCard() {
  const userId = window.currentUserId || 'your-user-id';
  try {
    const links = await fetchTopPaymentLinks(userId);
    updateTopPaymentLinksCard(links);
  } catch (err) {
    console.error('Failed to load Top Payment Links:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.top-payment-link-card')) {
    initializeTopPaymentLinksCard();
  }
});

window.refreshTopPaymentLinksCard = initializeTopPaymentLinksCard;

// ==================== User Profile Card Functionality ==================== //

async function fetchUserProfile(userId) {
  // Fetch user profile info (adjust column names as needed)
  const { data: user, error } = await supabase
    .from('users')
    .select('full_name, email, is_verified, created_at, traits, subscription_type')
    .eq('id', userId)
    .single();

  // ⚠️ DEV WARNING: Using 'id' for users table is correct (primary key)
  console.log(`🔐 Fetching user profile for ID: ${userId.substring(0, 4)}****`);

  if (error) throw error;
  return user;
}

function renderUserProfileCard(user) {
  // Full name
  const nameElem = document.querySelector('.profile-full-name');
  if (nameElem) nameElem.textContent = user.full_name || '';

  // Email
  const emailElem = document.querySelector('.profile-email');
  if (emailElem) emailElem.textContent = user.email || '';

  // Verified badge
  const verifiedElem = document.querySelector('.profile-verified-badge');
  if (verifiedElem) {
    verifiedElem.style.display = user.is_verified ? '' : 'none';
  }

  // Member since
  const memberSinceElem = document.querySelector('.profile-member-since');
  if (memberSinceElem && user.created_at) {
    const date = new Date(user.created_at);
    const monthYear = date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    memberSinceElem.textContent = `Member since ${monthYear}`;
  }

  // Traits (e.g., Early User, Unique Member, etc.)
  const traitElems = document.querySelectorAll('.profile-trait');
  traitElems.forEach(elem => elem.style.display = 'none'); // Hide all first
  if (user.traits && Array.isArray(user.traits)) {
    user.traits.forEach(trait => {
      const traitElem = document.querySelector(`.profile-trait[data-trait="${trait.toLowerCase().replace(/\s/g, '-')}"]`);
      if (traitElem) traitElem.style.display = '';
    });
  }

  // Subscription type (Basic, Pro, Elite)
  const subElems = document.querySelectorAll('.profile-subscription');
  subElems.forEach(elem => elem.style.display = 'none'); // Hide all first
  if (user.subscription_type) {
    const subElem = document.querySelector(`.profile-subscription[data-sub="${user.subscription_type.toLowerCase()}"]`);
    if (subElem) subElem.style.display = '';
  }
}

async function initializeUserProfileCard() {
  const userId = window.currentUserId || 'your-user-id';
  try {
    const user = await fetchUserProfile(userId);
    renderUserProfileCard(user);
  } catch (err) {
    console.error('Failed to load user profile:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.profile-full-name')) {
    initializeUserProfileCard();
  }
});

window.refreshUserProfileCard = initializeUserProfileCard;

// ==================== Your Journey Card Functionality ==================== //

async function fetchUserJourneyData(userId) {
  // Fetch user metrics (days_active, status_level, current_streak)
  const { data: metrics, error } = await supabase
    .from('user_metrics')
    .select('days_active, status_level, current_streak')
    .eq('user_id', userId)
    .single();

  if (error) throw error;
  return metrics;
}

function renderUserJourneyCard(metrics) {
  // Days active
  const daysActiveElem = document.querySelector('.journey-days-active');
  if (daysActiveElem) daysActiveElem.textContent = metrics.days_active ? `${metrics.days_active} Days` : '0 Days';

  // Status level
  const statusLevelElem = document.querySelector('.journey-status-level');
  if (statusLevelElem) statusLevelElem.textContent = metrics.status_level || '';

  // Current streak
  const streakElem = document.querySelector('.journey-current-streak');
  if (streakElem) streakElem.textContent = metrics.current_streak ? `${metrics.current_streak} Days` : '0 Days';
}

async function initializeUserJourneyCard() {
  const userId = window.currentUserId || 'your-user-id';
  try {
    const metrics = await fetchUserJourneyData(userId);
    renderUserJourneyCard(metrics);
  } catch (err) {
    console.error('Failed to load user journey:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.journey-days-active')) {
    initializeUserJourneyCard();
  }
});

window.refreshUserJourneyCard = initializeUserJourneyCard;

// ==================== Subscription Plan Card Functionality ==================== //

async function fetchUserPlanData(userId) {
  // Fetch user plan info (adjust column names as needed)
  const { data: plan, error } = await supabase
    .from('user_plans')
    .select('plan_type, started_at, next_billing, auto_renewal')
    .eq('user_id', userId)
    .single();

  if (error) throw error;
  return plan;
}

function renderUserPlanCard(plan) {
  // Plan badge and label
  const planBadge = document.querySelector('.plan-badge');
  if (planBadge) {
    planBadge.textContent = plan.plan_type ? `${plan.plan_type.charAt(0).toUpperCase() + plan.plan_type.slice(1)} Plan` : '';
    planBadge.className = 'plan-badge ' + (plan.plan_type ? plan.plan_type.toLowerCase() : '');
  }

  // Price
  const priceElem = document.querySelector('.plan-price');
  if (priceElem) {
    if (plan.plan_type && plan.plan_type.toLowerCase() === 'pro') priceElem.textContent = '$29/month';
    else if (plan.plan_type && plan.plan_type.toLowerCase() === 'elite') priceElem.textContent = '$99/month';
    else priceElem.textContent = '$0/month';
  }

  // Started date
  const startedElem = document.querySelector('.plan-started');
  if (startedElem && plan.started_at) {
    const date = new Date(plan.started_at);
    startedElem.textContent = date.toLocaleDateString(undefined, { month: 'long', day: '2-digit', year: 'numeric' });
  }

  // Next billing date
  const nextBillingElem = document.querySelector('.plan-next-billing');
  if (nextBillingElem && plan.next_billing) {
    const date = new Date(plan.next_billing);
    nextBillingElem.textContent = date.toLocaleDateString(undefined, { month: 'long', day: '2-digit', year: 'numeric' });
  }

  // Auto-renewal
  const autoRenewalElem = document.querySelector('.plan-auto-renewal');
  if (autoRenewalElem) {
    autoRenewalElem.textContent = plan.auto_renewal ? 'Active' : 'Inactive';
    autoRenewalElem.className = 'plan-auto-renewal ' + (plan.auto_renewal ? 'active' : 'inactive');
  }

  // Upgrade button logic
  const upgradeBtn = document.querySelector('.plan-upgrade-btn');
  if (upgradeBtn) {
    if (plan.plan_type && plan.plan_type.toLowerCase() === 'pro') {
      upgradeBtn.textContent = 'Upgrade to Elite';
      upgradeBtn.onclick = () => {
        // Your upgrade logic here
        alert('Redirecting to Elite upgrade...');
      };
      upgradeBtn.style.display = '';
    } else if (plan.plan_type && plan.plan_type.toLowerCase() === 'basic') {
      upgradeBtn.textContent = 'Upgrade to Pro';
      upgradeBtn.onclick = () => {
        // Your upgrade logic here
        alert('Redirecting to Pro upgrade...');
      };
      upgradeBtn.style.display = '';
    } else {
      // Already elite or unknown plan
      upgradeBtn.style.display = 'none';
    }
  }

  // Manage plan button
  const manageBtn = document.querySelector('.plan-manage-btn');
  if (manageBtn) {
    manageBtn.onclick = () => {
      // Your manage plan logic here
      alert('Redirecting to manage plan...');
    };
  }
}

async function initializeUserPlanCard() {
  const userId = window.currentUserId || 'your-user-id';
  try {
    const plan = await fetchUserPlanData(userId);
    renderUserPlanCard(plan);
  } catch (err) {
    console.error('Failed to load user plan:', err);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.querySelector('.plan-badge')) {
    initializeUserPlanCard();
  }
});

window.refreshUserPlanCard = initializeUserPlanCard;

// ==================== AI Financial Insights Card Functionality ==================== //

/**
 * This script updates the AI Financial Insights card in your SPA.html.
 * - It displays 3 context-aware messages: Performance, Tip, and Goal.
 * - Messages are selected from 30 options based on user USDC balance and activity.
 * - The card updates every 3 days (using localStorage timestamp).
 * - No new HTML is created or changed; only existing elements are updated.
 */

async function updateAIFinancialInsightsCard(userId) {
  // 1. Fetch user balance and activity data
  const { data: balanceData, error: balanceError } = await supabase
    .from('user_balances')
    .select('usdc_polygon, usdc_tron, usdc_solana, usd_equivalent, last_active')
    .eq('user_id', userId)
    .single();

  if (balanceError || !balanceData) return;

  const totalUSDC = 
    (parseFloat(balanceData.usdc_polygon || 0) +
     parseFloat(balanceData.usdc_tron || 0) +
     parseFloat(balanceData.usdc_solana || 0));
  const usdEquivalent = parseFloat(balanceData.usd_equivalent || 0);

  // 2. Fetch transaction stats for context
  const { count: txCount, error: txError } = await supabase
    .from('transactions')
    .select('id', { count: 'exact' })
    .eq('user_id', userId);

  if (txError) return;

  // 3. Message pools (30 options, 10 per category)
  const performanceMessages = [
    "Excellent! Your transaction frequency increased 34% this month.",
    "Great! Your USDC balance grew by 12% this quarter.",
    "Impressive! You made 5 successful payments this week.",
    "Solid! Your average transaction size is up 8%.",
    "Consistent! You’ve maintained daily activity for 10 days.",
    "Steady! Your USDC holdings are above the platform average.",
    "Active! You’ve used 2 different networks this month.",
    "Efficient! Your average gas fee is below 0.0005 USDC.",
    "Reliable! No failed transactions in the last 30 days.",
    "Growing! Your total volume is up 20% from last month."
  ];

  const tipMessages = [
    "Tip: Consider upgrading to Elite for Unlimited Volume.",
    "Tip: Set a custom tag for easier transaction tracking.",
    "Tip: Use payment links for faster client payments.",
    "Tip: Try cross-chain transfers for better flexibility.",
    "Tip: Review your transaction history for optimization.",
    "Tip: Use the analytics dashboard to spot trends.",
    "Tip: Invite a friend and earn bonus USDC.",
    "Tip: Schedule payments to save time each month."
  ];

  const goalMessages = [
    "Goal: You're 12% away from reaching $50K total volume.",
    "Goal: Complete 10 more transactions to unlock Gold tier.",
    "Goal: Reach $10K in USDC to access premium features.",
    "Goal: Maintain a 7-day streak for a bonus reward.",
    "Goal: Lower your average processing time below 1 minute.",
    "Goal: Achieve a 100% flawless execution rate this month.",
    "Goal: Save $1000 in fees to unlock a special badge.",
    "Goal: Hit $5K in volume on Polygon network.",
    "Goal: Reach 20 successful payment links this quarter."
  ];

  // 4. Select messages based on user data (simple logic, can be expanded)
  let perfIdx = 0, tipIdx = 0, goalIdx = 0;

  // Performance: Based on transaction count and balance
  if (txCount > 50) perfIdx = 0;
  else if (totalUSDC > 10000) perfIdx = 1;
  else if (txCount > 20) perfIdx = 2;
  else if (totalUSDC > 5000) perfIdx = 3;
  else if (txCount > 10) perfIdx = 4;
  else if (totalUSDC > 1000) perfIdx = 5;
  else if (txCount > 5) perfIdx = 6;
  else if (totalUSDC > 500) perfIdx = 7;
  else if (txCount > 0) perfIdx = 8;
  else perfIdx = 9;

  // Tip: Based on balance and activity
  if (totalUSDC > 10000) tipIdx = 0;
  else if (txCount < 5) tipIdx = 1;
  else if (!balanceData.last_active) tipIdx = 2;
  else if (txCount > 30) tipIdx = 3;
  else if (totalUSDC > 5000) tipIdx = 4;
  else if (txCount > 10) tipIdx = 5;
  else if (totalUSDC < 100) tipIdx = 6;
  else if (txCount > 0) tipIdx = 7;
  else tipIdx = 8;

  // Goal: Based on volume and streaks
  if (usdEquivalent < 50000) goalIdx = 0;
  else if (txCount < 10) goalIdx = 1;
  else if (totalUSDC < 10000) goalIdx = 2;
  else if (txCount > 7) goalIdx = 3;
  else if (txCount > 20) goalIdx = 4;
  else if (txCount > 0) goalIdx = 5;
  else if (totalUSDC > 100) goalIdx = 6;
  else if (txCount > 2) goalIdx = 7;
  else if (totalUSDC > 5000) goalIdx = 8;
  else goalIdx = 9;

  // 5. Only update every 3 days (localStorage)
  const lastUpdate = localStorage.getItem('aiInsightsLastUpdate');
  const now = Date.now();
  if (lastUpdate && now - parseInt(lastUpdate, 10) < 3 * 24 * 60 * 60 * 1000) {
    // Already updated in last 3 days, skip update
    return;
  }
  localStorage.setItem('aiInsightsLastUpdate', now.toString());

  // 6. Update the card using your existing HTML
  // Find the card container (adjust selectors as needed)
  const card = document.querySelector('.ai-insights-card, .ai-financial-insights');
  if (!card) return;

  // Find the message elements (adjust selectors as needed)
  const perfElem = card.querySelector('.insight-performance, .insight-excellent, .insight-review');
  const tipElem = card.querySelector('.insight-tip, .insight-advice');
  const goalElem = card.querySelector('.insight-goal, .insight-target');

  if (perfElem) perfElem.textContent = performanceMessages[perfIdx];
  if (tipElem) tipElem.textContent = tipMessages[tipIdx];
  if (goalElem) goalElem.textContent = goalMessages[goalIdx];
}

// Example usage: updateAIFinancialInsightsCard(currentUserId);

// ==================== Total Transactions Card Functionality ==================== //

/**
 * Fetch and render total transactions and percentage increase vs last month.
 * Uses only your existing HTML elements.
 */

async function updateTotalTransactionsCard(userId) {
  // 1. Calculate date ranges for this month and last month
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  // 2. Query: Count transactions for this month
  const { count: thisMonthCount, error: thisMonthError } = await supabase
    .from('transactions')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', startOfThisMonth.toISOString());

  // 3. Query: Count transactions for last month
  const { count: lastMonthCount, error: lastMonthError } = await supabase
    .from('transactions')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', startOfLastMonth.toISOString())
    .lt('created_at', startOfThisMonth.toISOString());

  if (thisMonthError || lastMonthError) return;

  // 4. Calculate percentage increase
  let percentChange = 0;
  if (lastMonthCount && lastMonthCount > 0) {
    percentChange = ((thisMonthCount - lastMonthCount) / lastMonthCount) * 100;
  } else if (thisMonthCount > 0) {
    percentChange = 100;
  }

  // 5. Find and update the card elements (adjust selectors as needed)
  const card = document.querySelector('.total-transactions-card, .stat-card.transactions, .transactions-card');
  if (!card) return;

  // Main value (number)
  const valueElem = card.querySelector('h2, .stat-value, .summary-value, .metric-value, strong, span');
  if (valueElem) valueElem.textContent = thisMonthCount.toLocaleString();

  // Label (should say "Total Transactions")
  // (No change needed if already present)

  // Percentage change element (usually below the number)
  const percentElem = card.querySelector('.stat-change, .summary-change, .metric-insight, .percent-change, .stat-delta, .stat-growth, .stat-increase');
  if (percentElem) {
    percentElem.textContent = (percentChange >= 0 ? '↑ +' : '↓ ') + Math.abs(percentChange).toFixed(0) + '% this month';
    percentElem.style.color = percentChange >= 0 ? '#22c55e' : '#ef4444'; // green/red
  }
}
// Example usage: updateTotalTransactionsCard(currentUserId);

// ==================== Total USDC Received Card Functionality ==================== //

/**
 * Fetch and render total USDC received and percentage increase vs last month.
 * Uses only your existing HTML elements.
 */

async function updateTotalUSDCReceivedCard(userId) {
  // 1. Calculate date ranges for this month and last month
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  // 2. Query: Sum USDC received for this month
  const { data: thisMonthTxs, error: thisMonthError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('direction', 'in')
    .eq('status', 'confirmed')
    .gte('created_at', startOfThisMonth.toISOString());

  // 3. Query: Sum USDC received for last month
  const { data: lastMonthTxs, error: lastMonthError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('direction', 'in')
    .eq('status', 'confirmed')
    .gte('created_at', startOfLastMonth.toISOString())
    .lt('created_at', startOfThisMonth.toISOString());

  if (thisMonthError || lastMonthError) return;

  // 4. Calculate totals
  const thisMonthTotal = (thisMonthTxs || []).reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0);
  const lastMonthTotal = (lastMonthTxs || []).reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0);

  // 5. Calculate percentage increase
  let percentChange = 0;
  if (lastMonthTotal && lastMonthTotal > 0) {
    percentChange = ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100;
  } else if (thisMonthTotal > 0) {
    percentChange = 100;
  }

  // 6. Find and update the card elements (adjust selectors as needed)
  const card = document.querySelector('.total-usdc-received-card, .stat-card.usdc-received, .usdc-received-card');
  if (!card) return;

  // Main value (number)
  const valueElem = card.querySelector('h2, .stat-value, .summary-value, .metric-value, strong, span');
  if (valueElem) valueElem.textContent = '$' + thisMonthTotal.toLocaleString(undefined, { maximumFractionDigits: 0 });

  // Label (should say "Total USDC Received")
  // (No change needed if already present)

  // Percentage change element (usually below the number)
  const percentElem = card.querySelector('.stat-change, .summary-change, .metric-insight, .percent-change, .stat-delta, .stat-growth, .stat-increase');
  if (percentElem) {
    percentElem.textContent = (percentChange >= 0 ? '↑ +' : '↓ ') + Math.abs(percentChange).toFixed(0) + '% this month';
    percentElem.style.color = percentChange >= 0 ? '#22c55e' : '#ef4444'; // green/red
  }
}

// Example usage: updateTotalUSDCReceivedCard(currentUserId);

// ==================== Largest Payment Received Card Functionality ==================== //

/**
 * Fetch and render the largest payment received and its date.
 * Uses only your existing HTML elements.
 */

async function updateLargestPaymentCard(userId) {
  // 1. Query: Find the largest incoming payment for this user
  const { data: txs, error } = await supabase
    .from('transactions')
    .select('amount_usdc, created_at, status, direction')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .eq('direction', 'in')
    .order('amount_usdc', { ascending: false })
    .limit(1);

  if (error) throw error;

  // 2. Find the card in the DOM
  // The card has .usage-stat-card.accent and a .stat-label with "Largest Payment"
  const cards = document.querySelectorAll('.usage-stat-card.accent');
  let card = null;
  for (const c of cards) {
    const label = c.querySelector('.stat-label');
    if (label && /Largest Payment/i.test(label.textContent)) {
      card = c;
      break;
    }
  }
  if (!card) return;

  // 3. Update the amount and date
  const statNumber = card.querySelector('.stat-number');
  const statTrend = card.querySelector('.stat-trend');
  if (txs && txs.length > 0) {
    const tx = txs[0];
    if (statNumber) statNumber.textContent = `$${parseFloat(tx.amount_usdc).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (statTrend) {
      const date = new Date(tx.created_at);
      statTrend.innerHTML = `<i class="fas fa-calendar"></i> ${date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
  } else {
    if (statNumber) statNumber.textContent = '$0.00';
    if (statTrend) statTrend.innerHTML = `<i class="fas fa-calendar"></i> N/A`;
  }
}

// Example usage:
// await updateLargestPaymentCard(currentUserId);

// ==================== Average Payment Value Card Functionality ==================== //

/**
 * Fetch and render average payment value and percentage increase vs last month.
 * Uses only your existing HTML elements.
 */

async function updateAveragePaymentCard(userId) {
  // 1. Calculate date ranges for this month and last month
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  // 2. Query: Get all confirmed incoming payments for this month
  const { data: thisMonthTxs, error: thisMonthError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .eq('direction', 'in')
    .gte('created_at', startOfThisMonth.toISOString());

  // 3. Query: Get all confirmed incoming payments for last month
  const { data: lastMonthTxs, error: lastMonthError } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .eq('direction', 'in')
    .gte('created_at', startOfLastMonth.toISOString())
    .lte('created_at', endOfLastMonth.toISOString());

  if (thisMonthError || lastMonthError) throw thisMonthError || lastMonthError;

  // 4. Calculate averages
  const avgThisMonth = thisMonthTxs && thisMonthTxs.length
    ? thisMonthTxs.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) / thisMonthTxs.length
    : 0;
  const avgLastMonth = lastMonthTxs && lastMonthTxs.length
    ? lastMonthTxs.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0) / lastMonthTxs.length
    : 0;

  // 5. Calculate percentage change
  let percentChange = 0;
  if (avgLastMonth > 0) {
    percentChange = ((avgThisMonth - avgLastMonth) / avgLastMonth) * 100;
  }

  // 6. Find the card in the DOM
  // The card has .usage-stat-card.gradient and a .stat-label with "Average Payment"
  const cards = document.querySelectorAll('.usage-stat-card.gradient');
  let card = null;
  for (const c of cards) {
    const label = c.querySelector('.stat-label');
    if (label && /Average Payment/i.test(label.textContent)) {
      card = c;
      break;
    }
  }
  if (!card) return;

  // 7. Update the value and trend
  const statNumber = card.querySelector('.stat-number');
  const statTrend = card.querySelector('.stat-trend');
  if (statNumber) statNumber.textContent = `$${avgThisMonth.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (statTrend) {
    const trendClass = percentChange > 0 ? 'positive' : percentChange < 0 ? 'negative' : 'neutral';
    statTrend.className = `stat-trend ${trendClass}`;
    statTrend.innerHTML = `
      <i class="fas fa-arrow-${percentChange >= 0 ? 'up' : 'down'}"></i>
      ${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(0)}% this month
    `;
  }
}

// Example usage:
// await updateAveragePaymentCard(currentUserId);

// ==================== Billing History Table Functionality (No New HTML) ==================== //

async function updateBillingHistoryTable(userId) {
  // 1. Fetch billing history from your database (or backend/Stripe if needed)
  const { data: bills, error } = await supabase
    .from('billing_history')
    .select('date, plan_type, amount_usd, status, invoice_url')
    .eq('user_id', userId)
    .order('date', { ascending: false });

  if (error) throw error;

  // 2. Find all existing billing table rows (in order)
  const rows = document.querySelectorAll('.billing-table .billing-table-row');

  // 3. Fill each row with billing data, or clear if no data
  rows.forEach((row, i) => {
    const bill = bills[i];
    const dateMain = row.querySelector('.date-main');
    const dateTime = row.querySelector('.date-time');
    const descMain = row.querySelector('.description-main');
    const descSub = row.querySelector('.description-sub');
    const amountCell = row.querySelector('.amount-cell');
    const statusBadge = row.querySelector('.status-badge-billing');
    const statusIcon = statusBadge ? statusBadge.querySelector('i') : null;
    const statusText = statusBadge ? statusBadge.childNodes[statusBadge.childNodes.length - 1] : null;
    const downloadBtn = row.querySelector('.download-invoice-btn');

    if (bill) {
      // Date
      const dateObj = new Date(bill.date);
      if (dateMain) dateMain.textContent = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      if (dateTime) dateTime.textContent = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      // Description
      if (descMain) descMain.textContent = bill.plan_type || '';
      if (descSub) descSub.textContent = 'Subscription renewal';

      // Amount
      if (amountCell) amountCell.textContent = `$${parseFloat(bill.amount_usd).toFixed(2)}`;

      // Status
      if (statusBadge && statusIcon && statusText) {
        if (bill.status === 'paid') {
          statusBadge.classList.add('paid');
          statusBadge.classList.remove('unpaid');
          statusIcon.className = 'fas fa-check-circle';
          statusText.textContent = ' Paid';
        } else {
          statusBadge.classList.add('unpaid');
          statusBadge.classList.remove('paid');
          statusIcon.className = 'fas fa-times-circle';
          statusText.textContent = ' Unpaid';
        }
      }

      // Invoice download
      if (downloadBtn) {
        if (bill.invoice_url) {
          downloadBtn.disabled = false;
          downloadBtn.onclick = () => window.open(bill.invoice_url, '_blank');
        } else {
          downloadBtn.disabled = true;
          downloadBtn.onclick = null;
        }
      }
    } else {
      // Clear row if no data
      if (dateMain) dateMain.textContent = '';
      if (dateTime) dateTime.textContent = '';
      if (descMain) descMain.textContent = '';
      if (descSub) descSub.textContent = '';
      if (amountCell) amountCell.textContent = '';
      if (statusBadge && statusIcon && statusText) {
        statusBadge.classList.remove('paid', 'unpaid');
        statusIcon.className = '';
        statusText.textContent = '';
      }
      if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.onclick = null;
      }
    }
  });

  // 4. Update the "Total Paid to Date" badge
  const totalPaid = bills
    .filter(b => b.status === 'paid')
    .reduce((sum, b) => sum + parseFloat(b.amount_usd || 0), 0);

  const totalPaidElem = document.querySelector('.total-paid-amount');
  if (totalPaidElem) {
    totalPaidElem.textContent = `$${totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

// Example usage:
// await updateBillingHistoryTable(currentUserId);

// ==================== Pricing Plan Toggle Functionality (Monthly/Annual) ==================== //

/**
 * This script toggles the pricing plan values and labels between monthly and annual.
 * It uses only your existing HTML elements and updates their text content.
 * No new HTML is created or changed.
 */

document.addEventListener('DOMContentLoaded', function () {
  // Find toggle buttons
  const monthlyBtn = document.querySelector('.plan-toggle-monthly, .pricing-toggle .monthly, button[data-toggle="monthly"]');
  const annualBtn = document.querySelector('.plan-toggle-annual, .pricing-toggle .annual, button[data-toggle="annual"]');

  // Find price elements
  const proPriceElem = document.querySelector('.pro-plan .plan-price, .pro-plan .price, .pro-plan .plan-amount');
  const elitePriceElem = document.querySelector('.elite-plan .plan-price, .elite-plan .price, .elite-plan .plan-amount');
  const proPlanCard = document.querySelector('.pro-plan, .plan-card.pro');
  const elitePlanCard = document.querySelector('.elite-plan, .plan-card.elite');

  // Find billing label elements
  const proBillingLabel = proPlanCard ? proPlanCard.querySelector('.plan-billing, .billing-label, .plan-cycle') : null;
  const eliteBillingLabel = elitePlanCard ? elitePlanCard.querySelector('.plan-billing, .billing-label, .plan-cycle') : null;

  // State
  let isAnnual = false;

  function setMonthly() {
    isAnnual = false;
    // Update prices
    if (proPriceElem) proPriceElem.textContent = '$29';
    if (elitePriceElem) elitePriceElem.textContent = '$59';
    // Update billing labels
    if (proBillingLabel) proBillingLabel.textContent = 'Billed monthly';
    if (eliteBillingLabel) eliteBillingLabel.textContent = 'Billed monthly';
    // Update toggle button styles
    if (monthlyBtn) monthlyBtn.classList.add('active');
    if (annualBtn) annualBtn.classList.remove('active');
  }

  function setAnnual() {
    isAnnual = true;
    // Update prices
    if (proPriceElem) proPriceElem.textContent = '$20';
    if (elitePriceElem) elitePriceElem.textContent = '$49';
    // Update billing labels
    if (proBillingLabel) proBillingLabel.textContent = 'Billed annually';
    if (eliteBillingLabel) eliteBillingLabel.textContent = 'Billed annually';
    // Update toggle button styles
    if (monthlyBtn) monthlyBtn.classList.remove('active');
    if (annualBtn) annualBtn.classList.add('active');
  }

  // Attach event listeners
  if (monthlyBtn) {
    monthlyBtn.addEventListener('click', setMonthly);
  }
  if (annualBtn) {
    annualBtn.addEventListener('click', setAnnual);
  }

  // Optionally, set default state on load
  setMonthly();
});

// ==================== Plan Selection Buttons Functionality ==================== //

/**
 * This script makes the plan selection buttons functional:
 * - The button for the user's current plan is disabled/unpressable.
 * - Other plan buttons are enabled and trigger the upgrade/downgrade flow.
 * - Uses only your existing HTML elements and classes.
 * - No new HTML is created or changed.
 */

// Example: You should replace this with your actual logic to get the user's current plan
async function getCurrentUserPlan(userId) {
  // Fetch from your DB or use a global variable
  // Return one of: 'basic', 'pro', 'elite'
  const { data, error } = await supabase
    .from('user_plans')
    .select('plan_type')
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  return data.plan_type; // e.g., 'basic', 'pro', 'elite'
}

async function setupPlanButtons(userId) {
  // Get current plan
  const currentPlan = await getCurrentUserPlan(userId);

  // Find all plan cards and buttons
  const basicBtn = document.querySelector('.basic-plan button, .plan-card.basic button, .get-started-btn');
  const proBtn = document.querySelector('.pro-plan button, .plan-card.pro button, .upgrade-pro-btn');
  const eliteBtn = document.querySelector('.elite-plan button, .plan-card.elite button, .go-elite-btn');

  // Helper to disable a button
  function disableBtn(btn) {
    if (btn) {
      btn.disabled = true;
      btn.classList.add('disabled');
      btn.setAttribute('aria-disabled', 'true');
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.6';
    }
  }

  // Helper to enable a button
  function enableBtn(btn) {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('disabled');
      btn.removeAttribute('aria-disabled');
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
  }

  // Set button states
  if (currentPlan === 'basic') {
    disableBtn(basicBtn);
    enableBtn(proBtn);
    enableBtn(eliteBtn);
  } else if (currentPlan === 'pro') {
    enableBtn(basicBtn);
    disableBtn(proBtn);
    enableBtn(eliteBtn);
  } else if (currentPlan === 'elite') {
    enableBtn(basicBtn);
    enableBtn(proBtn);
    disableBtn(eliteBtn);
  }

  // Add click handlers for enabled buttons
  if (proBtn && !proBtn.disabled) {
    proBtn.onclick = function () {
      // Trigger upgrade to Pro flow
      // e.g., open payment modal, redirect, etc.
      alert('Upgrade to Pro flow triggered!');
    };
  }
  if (eliteBtn && !eliteBtn.disabled) {
    eliteBtn.onclick = function () {
      // Trigger upgrade to Elite flow
      alert('Upgrade to Elite flow triggered!');
    };
  }
  if (basicBtn && !basicBtn.disabled) {
    basicBtn.onclick = function () {
      // Trigger downgrade to Basic or start free flow
      alert('Start Free/Basic flow triggered!');
    };
  }
}

// Usage: Call this after user login or page load, passing the userId
// setupPlanButtons(userId);

// ==================== Total Orders Card Functionality ==================== //

/**
 * Fetch and render the total number of orders (all transactions, any status).
 * Uses only your existing HTML elements in the Orders & Customers page.
 * No new HTML is created or changed.
 */

async function updateTotalOrdersCard(userId) {
  // 1. Query: Count all transactions for this user (any status)
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact' })
    .eq('user_id', userId);

  if (error) throw error;

  // 2. Find the correct metric-number element for "Total Orders"
  // It is the .metric-number whose sibling .metric-label has text "Total Orders"
  const metrics = document.querySelectorAll('.orders-metric');
  metrics.forEach(metric => {
    const label = metric.querySelector('.metric-label');
    const numberElem = metric.querySelector('.metric-number');
    if (label && /Total Orders/i.test(label.textContent) && numberElem) {
      numberElem.textContent = count || 0;
    }
  });
}

// Example usage:
// updateTotalOrdersCard(currentUserId);

// ==================== Ready to Ship Orders Card Functionality ==================== //

/**
 * Fetch and render the number of "Ready to Ship" orders (successful transactions).
 * Uses only your existing HTML elements in the Orders & Customers page.
 * No new HTML is created or changed.
 */

async function updateReadyToShipOrdersCard(userId) {
  // 1. Query: Count all successful transactions for this user
  // (Assuming 'confirmed' or 'completed' status means "Ready to Ship")
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .in('status', ['confirmed', 'completed']);

  if (error) throw error;

  // 2. Find the correct metric-number element for "Ready to Ship"
  // It is the .metric-number whose sibling .metric-label has text "Ready to Ship"
  const metrics = document.querySelectorAll('.orders-metric');
  metrics.forEach(metric => {
    const label = metric.querySelector('.metric-label');
    const numberElem = metric.querySelector('.metric-number');
    if (label && /Ready to Ship/i.test(label.textContent) && numberElem) {
      numberElem.textContent = count || 0;
    }
  });
}

// Example usage:
// updateReadyToShipOrdersCard(currentUserId);

// ==================== Countries Card Functionality (Unique Customer Countries) ==================== //

/**
 * Fetch and render the number of unique countries from customer info.
 * Uses only your existing HTML elements in the Orders & Customers page.
 * No new HTML is created or changed.
 *
 * Assumes you have a 'customers' (or similar) table in Supabase with a 'country' field,
 * and that each customer record is created before a transaction via the buyer's form.
 */

async function updateCountriesCard() {
  // 1. Query: Get all unique countries from the customers table
  const { data, error } = await supabase
    .from('customers')
    .select('country', { count: 'exact', head: false });

  if (error) throw error;

  // 2. Extract unique, non-empty country values
  const uniqueCountries = new Set();
  if (data && Array.isArray(data)) {
    data.forEach(row => {
      if (row.country && typeof row.country === 'string' && row.country.trim()) {
        uniqueCountries.add(row.country.trim());
      }
    });
  }

  // 3. Find the correct metric-number element for "Countries"
  // It is the .metric-number whose sibling .metric-label has text "Countries"
  const metrics = document.querySelectorAll('.orders-metric');
  metrics.forEach(metric => {
    const label = metric.querySelector('.metric-label');
    const numberElem = metric.querySelector('.metric-number');
    if (label && /Countries/i.test(label.textContent) && numberElem) {
      numberElem.textContent = uniqueCountries.size;
    }
  });
}

// Example usage:
// updateCountriesCard();

// ==================== Total Revenue Card Functionality (USD/USDC All-Time) ==================== //

/**
 * Fetch and render the total revenue (sum of all confirmed USDC transactions, shown as USD).
 * Uses only your existing HTML elements in the Orders & Customers page.
 * No new HTML is created or changed.
 */

async function updateTotalRevenueCard(userId) {
  // 1. Query: Sum all confirmed transaction amounts for this user
  const { data, error } = await supabase
    .from('transactions')
    .select('amount_usdc')
    .eq('user_id', userId)
    .eq('status', 'confirmed');

  if (error) throw error;

  // 2. Calculate total revenue (sum of all USDC amounts)
  let totalRevenue = 0;
  if (data && Array.isArray(data)) {
    totalRevenue = data.reduce((sum, tx) => sum + parseFloat(tx.amount_usdc || 0), 0);
  }

  // 3. Format as USD (with commas, no decimals)
  const formattedRevenue = `$${totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  // 4. Find the correct metric-number element for "Total Revenue"
  // It is the .metric-number whose sibling .metric-label has text "Total Revenue"
  const metrics = document.querySelectorAll('.orders-metric');
  metrics.forEach(metric => {
    const label = metric.querySelector('.metric-label');
    const numberElem = metric.querySelector('.metric-number');
    if (label && /Total Revenue/i.test(label.textContent) && numberElem) {
      numberElem.textContent = formattedRevenue;
    }
  });
}

// Example usage:
// updateTotalRevenueCard(currentUserId);

// ==================== New Orders Card Functionality (This Week & Daily Change) ==================== //

/**
 * Fetch and render the number of new orders (this week) and the increase compared to yesterday.
 * Uses only your existing HTML elements in the Orders & Customers page.
 * No new HTML is created or changed.
 */

async function updateNewOrdersCard(userId) {
  // 1. Calculate date ranges
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday as start of week
  startOfWeek.setHours(0, 0, 0, 0);

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfToday.getDate() - 1);

  // 2. Query: Count new orders (all transactions) for this week, today, and yesterday
  const [{ count: weekCount }, { count: todayCount }, { count: yesterdayCount }] = await Promise.all([
    supabase
      .from('transactions')
      .select('id', { count: 'exact' })
      .eq('user_id', userId)
      .gte('created_at', startOfWeek.toISOString()),
    supabase
      .from('transactions')
      .select('id', { count: 'exact' })
      .eq('user_id', userId)
      .gte('created_at', startOfToday.toISOString()),
    supabase
      .from('transactions')
      .select('id', { count: 'exact' })
      .eq('user_id', userId)
      .gte('created_at', startOfYesterday.toISOString())
      .lt('created_at', startOfToday.toISOString())
  ].map(p => p));

  // 3. Calculate daily change
  const dailyChange = (todayCount || 0) - (yesterdayCount || 0);
  const dailyChangeText = (dailyChange >= 0 ? '+' : '') + dailyChange + ' today';

  // 4. Find the correct order-stat-card for "New Orders"
  // It is the .order-stat-card whose .stat-label has text "New Orders"
  const cards = document.querySelectorAll('.order-stat-card');
  cards.forEach(card => {
    const label = card.querySelector('.stat-label');
    const valueElem = card.querySelector('.stat-value');
    const trendElem = card.querySelector('.stat-trend');
    if (label && /New Orders/i.test(label.textContent)) {
      if (valueElem) valueElem.textContent = weekCount || 0;
      if (trendElem) trendElem.textContent = dailyChangeText;
      if (trendElem) trendElem.style.color = dailyChange >= 0 ? '#22c55e' : '#ef4444'; // green/red
    }
  });
}

// Example usage:
// updateNewOrdersCard(currentUserId);

// ==================== Total Customers Card Functionality (All-Time & Weekly Change) ==================== //

/**
 * Fetch and render the total number of unique customers (all-time)
 * and the number of new customers compared to last week.
 * Uses only your existing HTML elements in the Orders & Customers page.
 * No new HTML is created or changed.
 *
 * Assumes you have a 'customers' table in Supabase with a unique 'id' or 'email' per customer,
 * and a 'created_at' field for when the customer was added.
 */

async function updateTotalCustomersCard() {
  // 1. Calculate date ranges for this week and last week
  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday
  startOfThisWeek.setHours(0, 0, 0, 0);

  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  // 2. Query: Get all customers and new customers this week and last week
  const [{ data: allCustomers, error: allError }, { count: thisWeekCount, error: thisWeekError }, { count: lastWeekCount, error: lastWeekError }] = await Promise.all([
    supabase
      .from('customers')
      .select('id, email'), // adjust if your unique field is different
    supabase
      .from('customers')
      .select('id', { count: 'exact' })
      .gte('created_at', startOfThisWeek.toISOString()),
    supabase
      .from('customers')
      .select('id', { count: 'exact' })
      .gte('created_at', startOfLastWeek.toISOString())
      .lt('created_at', startOfThisWeek.toISOString())
  ]);

  if (allError || thisWeekError || lastWeekError) throw allError || thisWeekError || lastWeekError;

  // 3. Calculate total unique customers and weekly change
  const totalCustomers = allCustomers ? allCustomers.length : 0;
  const weeklyChange = (thisWeekCount || 0) - (lastWeekCount || 0);
  const weeklyChangeText = (weeklyChange >= 0 ? '+' : '') + weeklyChange + ' this week';

  // 4. Find the correct order-stat-card for "Total Customers"
  // It is the .order-stat-card whose .stat-label has text "Total Customers"
  const cards = document.querySelectorAll('.order-stat-card');
  cards.forEach(card => {
    const label = card.querySelector('.stat-label');
    const valueElem = card.querySelector('.stat-value');
    const trendElem = card.querySelector('.stat-trend');
    if (label && /Total Customers/i.test(label.textContent)) {
      if (valueElem) valueElem.textContent = totalCustomers;
      if (trendElem) trendElem.textContent = weeklyChangeText;
      if (trendElem) trendElem.style.color = weeklyChange >= 0 ? '#22c55e' : '#ef4444'; // green/red
    }
  });
}

// Example usage:
// updateTotalCustomersCard();

// ==================== Countries Card Functionality (All-Time & Monthly Change) ==================== //

/**
 * Fetch and render the number of unique countries (all-time)
 * and the number of new countries compared to last month.
 * Uses only your existing HTML elements in the Orders & Customers page.
 * No new HTML is created or changed.
 *
 * Assumes you have a 'customers' table in Supabase with a 'country' field and 'created_at' timestamp.
 */

async function updateCountriesCardWithMonthlyChange() {
  // 1. Calculate date ranges for this month and last month
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  // 2. Query: Get all countries, new this month, and new last month
  const [{ data: allCustomers, error: allError }, { data: thisMonthCustomers, error: thisMonthError }, { data: lastMonthCustomers, error: lastMonthError }] = await Promise.all([
    supabase
      .from('customers')
      .select('country'),
    supabase
      .from('customers')
      .select('country')
      .gte('created_at', startOfThisMonth.toISOString()),
    supabase
      .from('customers')
      .select('country')
      .gte('created_at', startOfLastMonth.toISOString())
      .lt('created_at', endOfLastMonth.toISOString())
  ]);

  if (allError || thisMonthError || lastMonthError) throw allError || thisMonthError || lastMonthError;

  // 3. Calculate unique countries all-time, this month, and last month
  const allCountries = new Set();
  const thisMonthCountries = new Set();
  const lastMonthCountries = new Set();

  if (allCustomers) allCustomers.forEach(row => row.country && allCountries.add(row.country.trim()));
  if (thisMonthCustomers) thisMonthCustomers.forEach(row => row.country && thisMonthCountries.add(row.country.trim()));
  if (lastMonthCustomers) lastMonthCustomers.forEach(row => row.country && lastMonthCountries.add(row.country.trim()));

  // 4. Find new countries this month (not present last month)
  const newCountriesThisMonth = Array.from(thisMonthCountries).filter(c => !lastMonthCountries.has(c));

  // 5. Find the correct order-stat-card for "Countries"
  // It is the .order-stat-card whose .stat-label has text "Countries"
  const cards = document.querySelectorAll('.order-stat-card');
  cards.forEach(card => {
    const label = card.querySelector('.stat-label');
    const valueElem = card.querySelector('.stat-value');
    const trendElem = card.querySelector('.stat-trend');
    if (label && /Countries/i.test(label.textContent)) {
      if (valueElem) valueElem.textContent = allCountries.size;
      if (trendElem) {
        trendElem.textContent = `+${newCountriesThisMonth.length} this month`;
        trendElem.style.color = newCountriesThisMonth.length >= 0 ? '#22c55e' : '#ef4444'; // green/red
      }
    }
  });
}

// Example usage:
// updateCountriesCardWithMonthlyChange();

// ==================== Order Management Hub - Card Functionality ==================== //

/**
 * This script:
 * - Populates each order card with full buyer details from the customers table and the real transaction ID.
 * - Shows "New Order" or "Shipped" status.
 * - "Ship Now" button reveals a shipping options card (Fedex, Aramex, HDL) styled to match your dashboard.
 * - "View Details" button zooms in the card for 5 seconds, then zooms out.
 * - Uses your existing HTML for cards, but creates the shipping options card as needed.
 */

// Helper: Format USDC
function formatUSDC(amount) {
  return `$${parseFloat(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

// Helper: Create shipping options card
function createShippingOptionsCard(orderId) {
  // Remove any existing shipping card
  const existing = document.querySelector('.shipping-options-card');
  if (existing) existing.remove();

  const card = document.createElement('div');
  card.className = 'shipping-options-card';
  card.style.position = 'fixed';
  card.style.top = '50%';
  card.style.left = '50%';
  card.style.transform = 'translate(-50%, -50%)';
  card.style.background = '#fff';
  card.style.borderRadius = '18px';
  card.style.boxShadow = '0 8px 32px rgba(0,0,0,0.12)';
  card.style.padding = '32px 40px';
  card.style.zIndex = 9999;
  card.style.textAlign = 'center';
  card.innerHTML = `
    <h3 style="margin-bottom: 18px; font-size: 1.3rem; font-weight: 700;">Best Shipping Options</h3>
    <div style="display: flex; gap: 32px; justify-content: center; margin-bottom: 18px;">
      <div class="ship-opt" style="flex:1;">
        <img src="https://upload.wikimedia.org/wikipedia/commons/7/7e/FedEx_Express.svg" alt="Fedex" style="height:32px; margin-bottom:8px;">
        <div style="font-weight:600;">Fedex</div>
        <div style="font-size:0.95em; color:#888;">2-4 days, tracking</div>
      </div>
      <div class="ship-opt" style="flex:1;">
        <img src="https://upload.wikimedia.org/wikipedia/commons/2/2d/Aramex_logo.svg" alt="Aramex" style="height:32px; margin-bottom:8px;">
        <div style="font-weight:600;">Aramex</div>
        <div style="font-size:0.95em; color:#888;">3-6 days, global</div>
      </div>
      <div class="ship-opt" style="flex:1;">
        <img src="https://www.hdl.com.sa/images/logo.png" alt="HDL" style="height:32px; margin-bottom:8px;">
        <div style="font-weight:600;">HDL</div>
        <div style="font-size:0.95em; color:#888;">1-3 days, MENA</div>
      </div>
    </div>
    <button class="close-ship-card" style="margin-top:10px; padding:8px 24px; border:none; border-radius:8px; background:#2563eb; color:#fff; font-weight:600; cursor:pointer;">Close</button>
  `;
  document.body.appendChild(card);

  card.querySelector('.close-ship-card').onclick = () => card.remove();
}

// Main: Populate order cards
async function populateOrderCards() {
  // 1. Fetch all orders (transactions) and customer info
  const { data: orders, error: ordersError } = await supabase
    .from('transactions')
    .select('id, tx_hash, user_id, amount_usdc, status, created_at, custom_tag')
    .order('created_at', { ascending: false });

  if (ordersError) throw ordersError;

  // 2. Fetch all customers (for mapping)
  const { data: customers, error: customersError } = await supabase
    .from('customers')
    .select('user_id, name, email, address, city, country, wallet_address');

  if (customersError) throw customersError;

  // 3. Map user_id to customer info
  const customerMap = {};
  customers.forEach(c => { customerMap[c.user_id] = c; });

  // 4. Find all order cards in DOM
  const orderCards = document.querySelectorAll('.order-card');
  orderCards.forEach((card, idx) => {
    const order = orders[idx];
    if (!order) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';

    // Transaction ID
    const orderIdElem = card.querySelector('.order-id');
    if (orderIdElem) orderIdElem.textContent = `#${order.tx_hash || order.id}`;

    // Status
    const statusElem = card.querySelector('.order-status');
    if (statusElem) {
      if (order.status === 'confirmed' || order.status === 'completed' || order.status === 'shipped') {
        statusElem.className = 'order-status status-shipped';
        statusElem.innerHTML = `<i class="fas fa-check"></i> Shipped`;
      } else {
        statusElem.className = 'order-status status-new';
        statusElem.innerHTML = `<i class="fas fa-box-open"></i> New Order`;
      }
    }

    // Customer Info
    const customer = customerMap[order.user_id] || {};
    const nameElem = card.querySelector('.customer-name');
    if (nameElem) nameElem.textContent = customer.name || 'Unknown';

    const emailElem = card.querySelector('.customer-email');
    if (emailElem) emailElem.textContent = customer.email || '';

    const valueElem = card.querySelector('.order-value');
    if (valueElem) valueElem.textContent = formatUSDC(order.amount_usdc);

    // Address
    const addressLineElem = card.querySelector('.address-line');
    if (addressLineElem) addressLineElem.textContent = customer.address || '';
    const addressCityElem = card.querySelector('.address-city');
    if (addressCityElem) addressCityElem.textContent = customer.city || '';
    const addressCountryElem = card.querySelector('.address-country');
    if (addressCountryElem) addressCountryElem.textContent = customer.country ? `🇺🇸 ${customer.country}` : '';

    // Ship Now button
    const shipBtn = card.querySelector('.ship-btn');
    if (shipBtn) {
      shipBtn.onclick = (e) => {
        e.preventDefault();
        createShippingOptionsCard(order.id);
      };
    }

    // View Details button
    const viewBtn = card.querySelector('.view-btn');
    if (viewBtn) {
      viewBtn.onclick = (e) => {
        e.preventDefault();
        card.style.transition = 'transform 0.4s cubic-bezier(.4,2,.6,1), box-shadow 0.4s';
        card.style.zIndex = 10;
        card.style.transform = 'scale(1.08)';
        card.style.boxShadow = '0 12px 48px rgba(37,99,235,0.18)';
        setTimeout(() => {
          card.style.transform = '';
          card.style.boxShadow = '';
          card.style.zIndex = '';
        }, 5000);
      };
    }
  });
}

// Example usage (call on page load or after data changes):
// populateOrderCards();