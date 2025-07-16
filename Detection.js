import dotenv from 'dotenv';
import { supabase } from './supabase.js';
import crypto from 'crypto';

dotenv.config();

console.log('DETECTION.JS: Detection system loading...');

// ==================== HALAXA PAY DETECTION SYSTEM ==================== //

// Environment Variables for APIs
const ALCHEMY_POLYGON_API_KEY = process.env.ALCHEMY_POLYGON_API_KEY;
const ALCHEMY_SOLANA_API_KEY = process.env.ALCHEMY_SOLANA_API_KEY;

// Using centralized Supabase client with service role permissions
// No need for separate client creation here

// Blockchain API Endpoints
const POLYGON_ALCHEMY_URL = `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_POLYGON_API_KEY}`;
const SOLANA_ALCHEMY_URL = `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_SOLANA_API_KEY}`;

// Contract Addresses
const POLYGON_USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

class HalaxaDetectionSystem {
  constructor() {
    this.isRunning = false;
    this.detectionInterval = null;
    this.userWallets = new Map(); // Cache for user wallets
  }

  // ==================== CORE DETECTION ENGINE ==================== //

  async startDetection(intervalMinutes = 5) {
    if (this.isRunning) {
      console.log('Detection system already running');
      return;
    }

    console.log('🚀 Starting Halaxa Detection System...');
    this.isRunning = true;

    // Run initial detection
    await this.runFullDetectionCycle();

    // Set up interval for continuous detection
    this.detectionInterval = setInterval(async () => {
      await this.runFullDetectionCycle();
    }, intervalMinutes * 60 * 1000);

    console.log(`✅ Detection system started with ${intervalMinutes} minute intervals`);
  }

  async stopDetection() {
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
      this.detectionInterval = null;
    }
    this.isRunning = false;
    console.log('🛑 Detection system stopped');
  }

  async runFullDetectionCycle() {
    try {
      console.log('[DETECTION] Running detection cycle...');

      // Get all active users with their wallet addresses
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, email');

      if (usersError) throw usersError;

      // Process each user individually
      for (const user of users) {
        await this.detectUserActivity(user.id);
      }

      console.log(`[DETECTION] Detection cycle completed for ${users.length} users`);
    } catch (error) {
      console.error('[ERROR] Error in detection cycle:', error);
    }
  }

  // ==================== BLOCKCHAIN TRANSACTION DETECTION ==================== //

  async detectUserActivity(userId) {
    try {
      console.log(`[DETECTION] Detecting activity for user: ${userId.substring(0, 8)}****`);
      
      // Get user's wallet addresses
      const userWallets = await this.getUserWallets(userId);

      if (!userWallets || userWallets.length === 0) {
        console.log(`[DETECTION] No wallets found for user ${userId.substring(0, 8)}****`);
        return;
      }

      // Detect new transactions for each wallet
      for (const wallet of userWallets) {
        if (wallet.wallet_address) {
          await this.detectWalletTransactions(userId, wallet.wallet_address, wallet);
        }
      }

      // Update user activity timestamp
      await this.updateUserLastActive(userId);

      console.log(`[DETECTION] Activity detection completed for user ${userId.substring(0, 8)}****`);

    } catch (error) {
      console.error(`[ERROR] Error detecting activity for user ${userId}:`, error);
    }
  }

  async detectWalletTransactions(userId, walletAddress, walletInfo) {
    try {
      console.log(`[DETECTION] Detecting transactions for wallet: ${walletAddress.substring(0, 10)}...`);
      
      // Check both Polygon and Solana for this wallet
      const polygonTxs = await this.getPolygonTransactions(walletAddress);
      const solanaTxs = await this.getSolanaTransactions(walletAddress);

      // Log transaction counts
      console.log(`[DETECTION] Found ${polygonTxs.length} Polygon transactions, ${solanaTxs.length} Solana transactions`);

      // Process transactions (now handled by calculation-engine.js)
      // We only detect and log, no storage needed
      const totalTxs = polygonTxs.length + solanaTxs.length;
      
      if (totalTxs > 0) {
        console.log(`[DETECTION] Processed ${totalTxs} transactions for wallet ${walletAddress.substring(0, 10)}...`);
      }

    } catch (error) {
      console.error(`[ERROR] Error detecting transactions for wallet ${walletAddress}:`, error);
    }
  }

  async getPolygonTransactions(walletAddress) {
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromAddress: walletAddress.toLowerCase(),
          toAddress: walletAddress.toLowerCase(),
          category: ['erc20'],
          contractAddresses: [POLYGON_USDC_CONTRACT],
          maxCount: 50,
          withMetadata: true,
          excludeZeroValue: true
        }]
      };

      const response = await fetch(POLYGON_ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        console.error(`[ERROR] Polygon API error: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = await response.json();
      
      if (data.error) {
        console.error(`[ERROR] Polygon API error:`, data.error);
        return [];
      }
      
      return data.result?.transfers || [];

    } catch (error) {
      console.error('[ERROR] Error fetching Polygon transactions:', error);
      return [];
    }
  }

  async getSolanaTransactions(walletAddress) {
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [walletAddress, { limit: 50 }]
      };

      const response = await fetch(SOLANA_ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        console.error(`[ERROR] Solana API error: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = await response.json();
      
      if (data.error) {
        console.error(`[ERROR] Solana API error:`, data.error);
        return [];
      }
      
      return data.result || [];

    } catch (error) {
      console.error('[ERROR] Error fetching Solana transactions:', error);
      return [];
    }
  }

  // ==================== TRANSACTION PROCESSING ==================== //
  // REMOVED: All Supabase transaction storage logic
  // Now handled by calculation-engine.js with real-time blockchain data

  extractTransactionAmount(transaction) {
    if (transaction.rawContract?.value) {
      return Number(transaction.rawContract.value) / 1_000_000; // USDC decimals
    }
    if (transaction.tokenAmount?.uiAmount) {
      return transaction.tokenAmount.uiAmount;
    }
    return 0;
  }

  determineTransactionDirection(transaction, userWalletAddress) {
    // Improved direction detection using user's wallet address
    const userWallet = userWalletAddress.toLowerCase();
    const toAddress = transaction.to?.toLowerCase();
    const fromAddress = transaction.from?.toLowerCase();

    if (toAddress === userWallet) {
      return 'in'; // Incoming transaction
    } else if (fromAddress === userWallet) {
      return 'out'; // Outgoing transaction
    }
    
    return 'in'; // Default to incoming if unclear
  }

  extractGasFee(transaction) {
    if (transaction.gasUsed && transaction.gasPrice) {
      return Number(transaction.gasUsed) * Number(transaction.gasPrice) / 1_000_000_000_000_000_000; // Convert from wei to ETH equivalent
    }
    return 0;
  }

  calculateFeeSavings(transaction, network) {
    // Calculate approximate fee savings compared to traditional payment methods
    const tradFeeRate = 0.029; // 2.9% traditional payment fee
    const amount = this.extractTransactionAmount(transaction);
    const tradFee = amount * tradFeeRate;
    const blockchainFee = this.extractGasFee(transaction);
    return Math.max(0, tradFee - blockchainFee);
  }
  
  async getUserWallets(userId) {
    try {
      const { data: wallets } = await supabase
        .from('wallet_connections')
        .select('wallet_address, network, is_active')
        .eq('user_id', userId)
        .eq('is_active', true);

      return wallets || [];
    } catch (error) {
      console.error(`[ERROR] Error getting wallets for user ${userId}:`, error);
      return [];
    }
  }

  // ==================== EXECUTION CONTROL ==================== //

  async runDetectionForUser(userId) {
    try {
      console.log(`[DETECTION] Running detection for user ${userId.substring(0, 8)}****`);
      
      await this.detectUserActivity(userId);
      
      console.log(`[DETECTION] Detection completed for user ${userId.substring(0, 8)}****`);
    } catch (error) {
      console.error(`[ERROR] Error running detection for user ${userId}:`, error);
    }
  }

  async updateUserLastActive(userId) {
    try {
      await supabase
        .from('users')
        .update({ last_login: new Date().toISOString() })
        .eq('id', userId);

      console.log(`[DETECTION] Updated last active for user: ${userId.substring(0, 8)}****`);
    } catch (error) {
      console.error(`[ERROR] Error updating last active for user ${userId}:`, error);
    }
  }

  // ==================== HEALTH CHECKS ==================== //

  async checkBlockchainAPIs() {
    try {
      console.log('[HEALTH] Checking blockchain API health...');
      
      // Test Polygon API
      const polygonHealth = await this.testPolygonAPI();
      console.log(`[HEALTH] Polygon API: ${polygonHealth ? '✅ Healthy' : '❌ Unhealthy'}`);
      
      // Test Solana API
      const solanaHealth = await this.testSolanaAPI();
      console.log(`[HEALTH] Solana API: ${solanaHealth ? '✅ Healthy' : '❌ Unhealthy'}`);
      
      return {
        polygon: polygonHealth,
        solana: solanaHealth,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[ERROR] Health check failed:', error);
      return { polygon: false, solana: false, timestamp: new Date().toISOString() };
    }
  }

  async testPolygonAPI() {
    try {
      const response = await fetch(POLYGON_ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_blockNumber',
          params: []
        })
      });
      
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async testSolanaAPI() {
    try {
      const response = await fetch(SOLANA_ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getHealth',
          params: []
        })
      });
      
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  getSystemStatus() {
    return {
      isRunning: this.isRunning,
      intervalActive: !!this.detectionInterval,
      cachedWallets: this.userWallets.size,
      lastRun: new Date().toISOString(),
      version: '2.0.0',
      features: ['blockchain_detection', 'health_checks', 'real_time_monitoring']
    };
  }
}

// Create and export singleton instance
const detectionSystem = new HalaxaDetectionSystem();

// Export for use in other modules
export default detectionSystem;

// ==================== API ENDPOINTS ==================== //

export const DetectionAPI = {
  // Start detection system
  start: async (intervalMinutes = 5) => {
    return await detectionSystem.startDetection(intervalMinutes);
  },

  // Stop detection system  
  stop: async () => {
    return await detectionSystem.stopDetection();
  },

  // Run detection for specific user
  runForUser: async (userId) => {
    return await detectionSystem.runDetectionForUser(userId);
  },

  // Get system status
  status: () => {
    return detectionSystem.getSystemStatus();
  },

  // Manual full cycle run
  runCycle: async () => {
    return await detectionSystem.runFullDetectionCycle();
  },

  // Health check for blockchain APIs
  healthCheck: async () => {
    return await detectionSystem.checkBlockchainAPIs();
  }
};
