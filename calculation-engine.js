import dotenv from 'dotenv';
import { supabase } from './supabase.js';
import crypto from 'crypto';

dotenv.config();

console.log('🚀 CALCULATION-ENGINE.JS: Comprehensive calculation engine loading...');

// ==================== HALAXA CALCULATION ENGINE ==================== //

// Environment Variables for APIs
const ALCHEMY_POLYGON_API_KEY = process.env.ALCHEMY_POLYGON_API_KEY;
const ALCHEMY_SOLANA_API_KEY = process.env.ALCHEMY_SOLANA_API_KEY;

// Blockchain API Endpoints
const POLYGON_ALCHEMY_URL = `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_POLYGON_API_KEY}`;
const SOLANA_ALCHEMY_URL = `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_SOLANA_API_KEY}`;

// Contract Addresses
const POLYGON_USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

class HalaxaCalculationEngine {
  constructor() {
    this.isRunning = false;
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    this.alchemyFailureCount = new Map(); // Track Alchemy failures per wallet
    this.maxAlchemyFailures = 3; // Max failures before fallback
    console.log('[ENGINE] Calculation engine initialized with caching and fallback protection');
  }

  // ==================== CORE BLOCKCHAIN DATA EXTRACTION ==================== //

  /**
   * Get all user wallet addresses from wallet_connections table
   */
  async getUserWallets(userId) {
    try {
      const { data: wallets, error } = await supabase
        .from('wallet_connections')
        .select('wallet_address, network, is_active')
        .eq('user_id', userId)
        .eq('is_active', true);

      if (error) throw error;
      
      if (!wallets || wallets.length === 0) {
        console.log(`[ENGINE] No wallets found for user ${userId.substring(0, 8)}**** - this explains why no data shows`);
        return [];
      }
      
      console.log(`[ENGINE] Found ${wallets.length} active wallets for user ${userId.substring(0, 8)}****`);
      return wallets || [];
    } catch (error) {
      console.error(`[ERROR] Error fetching wallets for user ${userId}:`, error);
      return [];
    }
  }

  /**
   * Fetch Polygon USDC transactions for a wallet
   */
  async getPolygonTransactions(walletAddress) {
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{
          toAddress: walletAddress.toLowerCase(),
          category: ['erc20'],
          contractAddresses: [POLYGON_USDC_CONTRACT],
          maxCount: 100,
          withMetadata: true,
          excludeZeroValue: true
        }]
      };

      const response = await fetch(POLYGON_ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      
      // Check for Alchemy API errors
      if (data.error) {
        const failureKey = `polygon_${walletAddress}`;
        const failureCount = (this.alchemyFailureCount.get(failureKey) || 0) + 1;
        this.alchemyFailureCount.set(failureKey, failureCount);
        
        if (failureCount >= this.maxAlchemyFailures) {
          console.warn(`[WARNING] Alchemy failed for wallet ${walletAddress} (${failureCount} times) - using fallback data`);
          return this.getFallbackPolygonData();
        } else {
          console.warn(`[WARNING] Alchemy failed for wallet ${walletAddress} (attempt ${failureCount}/${this.maxAlchemyFailures})`);
        }
      } else {
        // Reset failure count on success
        this.alchemyFailureCount.delete(`polygon_${walletAddress}`);
      }
      
      return data.result?.transfers || [];
    } catch (error) {
      console.error('[ERROR] Error fetching Polygon transactions:', error);
      
      // Track failure and use fallback if needed
      const failureKey = `polygon_${walletAddress}`;
      const failureCount = (this.alchemyFailureCount.get(failureKey) || 0) + 1;
      this.alchemyFailureCount.set(failureKey, failureCount);
      
      if (failureCount >= this.maxAlchemyFailures) {
        console.warn(`[WARNING] Alchemy failed for wallet ${walletAddress} (${failureCount} times) - using fallback data`);
        return this.getFallbackPolygonData();
      }
      
      return [];
    }
  }

  /**
   * Fetch Solana USDC transactions for a wallet
   */
  async getSolanaTransactions(walletAddress) {
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [walletAddress, { limit: 100 }]
      };

      const response = await fetch(SOLANA_ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      
      // Check for Alchemy API errors
      if (data.error) {
        const failureKey = `solana_${walletAddress}`;
        const failureCount = (this.alchemyFailureCount.get(failureKey) || 0) + 1;
        this.alchemyFailureCount.set(failureKey, failureCount);
        
        if (failureCount >= this.maxAlchemyFailures) {
          console.warn(`[WARNING] Alchemy failed for wallet ${walletAddress} (${failureCount} times) - using fallback data`);
          return this.getFallbackSolanaData();
        } else {
          console.warn(`[WARNING] Alchemy failed for wallet ${walletAddress} (attempt ${failureCount}/${this.maxAlchemyFailures})`);
        }
      } else {
        // Reset failure count on success
        this.alchemyFailureCount.delete(`solana_${walletAddress}`);
      }
      
      return data.result || [];
    } catch (error) {
      console.error('[ERROR] Error fetching Solana transactions:', error);
      
      // Track failure and use fallback if needed
      const failureKey = `solana_${walletAddress}`;
      const failureCount = (this.alchemyFailureCount.get(failureKey) || 0) + 1;
      this.alchemyFailureCount.set(failureKey, failureCount);
      
      if (failureCount >= this.maxAlchemyFailures) {
        console.warn(`[WARNING] Alchemy failed for wallet ${walletAddress} (${failureCount} times) - using fallback data`);
        return this.getFallbackSolanaData();
      }
      
      return [];
    }
  }

  /**
   * Extract transaction amount from blockchain data
   */
  extractTransactionAmount(transaction) {
    if (transaction.rawContract?.value) {
      return Number(transaction.rawContract.value) / 1_000_000; // USDC decimals
    }
    if (transaction.tokenAmount?.uiAmount) {
      return transaction.tokenAmount.uiAmount;
    }
    return 0;
  }

  // ==================== COMPREHENSIVE DASHBOARD CALCULATIONS ==================== //

  /**
   * Main calculation method - returns complete dashboard data
   */
  async calculateUserDashboard(userId) {
    try {
      console.log(`[ENGINE] Calculation started for user: ${userId.substring(0, 8)}****`);

      // Check cache first
      const cacheKey = `dashboard_${userId}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log('[ENGINE] Returning cached dashboard data');
        return cached.data;
      }

      // Get user wallets
      const userWallets = await this.getUserWallets(userId);
      console.log(`[ENGINE] Wallet count: ${userWallets.length}`);

      if (userWallets.length === 0) {
        console.log(`[ENGINE] No wallets found for user ${userId.substring(0, 8)}**** - returning fallback data`);
        return this.getFallbackData();
      }

      // Fetch all blockchain data
      const allTransactions = [];
      for (const wallet of userWallets) {
        console.log(`[ENGINE] Processing wallet: ${wallet.wallet_address.substring(0, 10)}... on ${wallet.network}`);
        
        if (wallet.network === 'polygon') {
          const polygonTxs = await this.getPolygonTransactions(wallet.wallet_address);
          allTransactions.push(...polygonTxs.map(tx => ({ ...tx, network: 'polygon', wallet: wallet.wallet_address })));
        } else if (wallet.network === 'solana') {
          const solanaTxs = await this.getSolanaTransactions(wallet.wallet_address);
          allTransactions.push(...solanaTxs.map(tx => ({ ...tx, network: 'solana', wallet: wallet.wallet_address })));
        }
      }

      console.log(`[ENGINE] Processed ${allTransactions.length} total transactions`);

      // Calculate comprehensive dashboard data
      const dashboardData = {
        balances: this.calculateBalances(allTransactions, userWallets),
        analytics: this.calculateAnalytics(allTransactions),
        insights: this.generateInsights(allTransactions),
        velocity: this.calculateVelocity(allTransactions),
        precision: this.calculatePrecision(allTransactions),
        magnitude: this.calculateMagnitude(allTransactions),
        networks: this.calculateNetworkDistribution(allTransactions),
        capital_flow: this.calculateCapitalFlow(allTransactions),
        fee_comparison: this.calculateFeeComparison(allTransactions),
        mrr: this.calculateMRR(allTransactions),
        // ADDITIONAL CALCULATIONS FOR COMPLETE DASHBOARD
        digital_vault: this.calculateDigitalVault(allTransactions, userWallets),
        transaction_activity: this.calculateTransactionActivity(allTransactions),
        ai_insights: this.calculateAIFinancialInsights(allTransactions),
        total_volume: this.calculateTotalVolume(allTransactions),
        weekly_transactions: this.calculateWeeklyTransactions(allTransactions),
        monthly_transactions: this.calculateMonthlyTransactions(allTransactions),
        largest_payment: this.calculateLargestPayment(allTransactions),
        average_payment: this.calculateAveragePayment(allTransactions),
        orders: this.calculateOrders(allTransactions),
        revenue: this.calculateRevenue(allTransactions),
        user_balances: this.calculateUserBalances(allTransactions, userWallets),
        network_distribution: this.calculateNetworkDistribution(allTransactions),
        volume_overview: this.calculateVolumeOverview(allTransactions),
        comprehensive_fees: this.calculateComprehensiveFees(allTransactions),
        recent_transactions_detailed: this.calculateRecentTransactionsDetailed(allTransactions),
        countries: this.calculateCountries(allTransactions),
        ready_to_ship: this.calculateReadyToShip(allTransactions),
        new_orders: this.calculateNewOrders(allTransactions),
        total_customers: this.calculateTotalCustomers(allTransactions),
        total_usdc_paid_out: this.calculateTotalUSDCPaidOut(allTransactions),
        billing_history: this.calculateBillingHistory(allTransactions),
        generated_at: new Date().toISOString()
      };

      // Cache the result
      this.cache.set(cacheKey, { data: dashboardData, timestamp: Date.now() });

      console.log(`[ENGINE] Completed calculations for user ${userId.substring(0, 8)}****`);
      return dashboardData;
    } catch (error) {
      console.error(`[ERROR] Dashboard calculation failed for user ${userId}:`, error);
      console.error('[ERROR] Error stack:', error.stack);
      console.error('[ERROR] Error type:', error.constructor.name);
      
      // Return fallback data on error
      console.log('[ENGINE] Returning fallback data due to calculation error');
      return this.getFallbackData();
    }
  }

  // ==================== INDIVIDUAL CALCULATION METHODS ==================== //

  /**
   * Calculate real-time balances across all networks
   */
  calculateBalances(transactions, userWallets) {
    try {
      const balances = {
        total: 0,
        polygon: 0,
        solana: 0,
        tron: 0,
        network_breakdown: {},
        wallet_count: userWallets.length
      };

      // Calculate balances by network
      transactions.forEach(tx => {
        const amount = this.extractTransactionAmount(tx);
        const network = tx.network || 'polygon';
        
        if (!balances.network_breakdown[network]) {
          balances.network_breakdown[network] = 0;
        }
        
        balances.network_breakdown[network] += amount;
        balances[network] += amount;
        balances.total += amount;
      });

      return balances;
    } catch (error) {
      console.error('Error calculating balances:', error);
      return { total: 0, polygon: 0, solana: 0, tron: 0, network_breakdown: {}, wallet_count: 0 };
    }
  }

  /**
   * Calculate comprehensive analytics
   */
  calculateAnalytics(transactions) {
    try {
      const totalVolume = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      const transactionCount = transactions.length;
      const successfulTransactions = transactions.filter(tx => tx.status !== 'failed').length;
      const successRate = transactionCount > 0 ? (successfulTransactions / transactionCount) * 100 : 0;

      // Calculate 24h volume
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const recent24hTxs = transactions.filter(tx => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        return txTime >= oneDayAgo;
      });
      const volume24h = recent24hTxs.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);

      return {
        total_volume: totalVolume,
        transaction_count: transactionCount,
        success_rate: successRate,
        volume_24h: volume24h,
        average_transaction_size: transactionCount > 0 ? totalVolume / transactionCount : 0,
        largest_transaction: transactions.length > 0 ? Math.max(...transactions.map(tx => this.extractTransactionAmount(tx))) : 0,
        smallest_transaction: transactions.length > 0 ? Math.min(...transactions.map(tx => this.extractTransactionAmount(tx))) : 0
      };
    } catch (error) {
      console.error('Error calculating analytics:', error);
      return {
        total_volume: 0,
        transaction_count: 0,
        success_rate: 0,
        volume_24h: 0,
        average_transaction_size: 0,
        largest_transaction: 0,
        smallest_transaction: 0
      };
    }
  }

  /**
   * Calculate transaction velocity metrics
   */
  calculateVelocity(transactions) {
    try {
      const totalExecutions = transactions.length;
      
      // Calculate daily average (last 30 days)
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recent30DaysTxs = transactions.filter(tx => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        return txTime >= thirtyDaysAgo;
      });
      
      const dailyAverage = Math.round(recent30DaysTxs.length / 30);
      
      // Calculate velocity (transactions per day)
      const oldestTx = transactions.reduce((oldest, tx) => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        const oldestTime = oldest.metadata?.blockTimestamp || oldest.blockTime * 1000;
        return txTime < oldestTime ? tx : oldest;
      }, transactions[0]);
      
      const daysSinceFirst = oldestTx ? 
        Math.max(1, Math.ceil((Date.now() - (oldestTx.metadata?.blockTimestamp || oldestTx.blockTime * 1000)) / (1000 * 60 * 60 * 24))) : 1;
      const velocity = Math.round(totalExecutions / daysSinceFirst);

      return {
        total_executions: totalExecutions,
        daily_average: dailyAverage,
        recent_count: recent30DaysTxs.length,
        velocity: velocity
      };
    } catch (error) {
      console.error('Error calculating velocity:', error);
      return { total_executions: 0, daily_average: 0, recent_count: 0, velocity: 0 };
    }
  }

  /**
   * Calculate precision rate (success rate)
   */
  calculatePrecision(transactions) {
    try {
      const totalTransactions = transactions.length;
      const successfulTransactions = transactions.filter(tx => tx.status !== 'failed').length;
      const precisionPercentage = totalTransactions > 0 ? (successfulTransactions / totalTransactions) * 100 : 0;

      return {
        precision_percentage: precisionPercentage,
        successful_count: successfulTransactions,
        total_count: totalTransactions,
        failed_count: totalTransactions - successfulTransactions
      };
    } catch (error) {
      console.error('Error calculating precision:', error);
      return { precision_percentage: 0, successful_count: 0, total_count: 0, failed_count: 0 };
    }
  }

  /**
   * Calculate transaction magnitude (volume analysis)
   */
  calculateMagnitude(transactions) {
    try {
      const amounts = transactions.map(tx => this.extractTransactionAmount(tx));
      const totalVolume = amounts.reduce((sum, amount) => sum + amount, 0);
      const transactionCount = transactions.length;
      const averageAmount = transactionCount > 0 ? totalVolume / transactionCount : 0;

      return {
        average_amount: averageAmount,
        total_volume: totalVolume,
        transaction_count: transactionCount,
        largest_transaction: amounts.length > 0 ? Math.max(...amounts) : 0,
        smallest_transaction: amounts.length > 0 ? Math.min(...amounts) : 0
      };
    } catch (error) {
      console.error('Error calculating magnitude:', error);
      return { average_amount: 0, total_volume: 0, transaction_count: 0, largest_transaction: 0, smallest_transaction: 0 };
    }
  }

  /**
   * Calculate network distribution
   */
  calculateNetworkDistribution(transactions) {
    try {
      const networkStats = {};
      let totalVolume = 0;

      transactions.forEach(tx => {
        const network = tx.network || 'polygon';
        const amount = this.extractTransactionAmount(tx);
        
        if (!networkStats[network]) {
          networkStats[network] = { volume_usdc: 0, transaction_count: 0 };
        }
        
        networkStats[network].volume_usdc += amount;
        networkStats[network].transaction_count += 1;
        totalVolume += amount;
      });

      // Calculate percentages
      const networkDistribution = Object.entries(networkStats).map(([network, stats]) => ({
        network,
        volume_usdc: stats.volume_usdc,
        transaction_count: stats.transaction_count,
        percent_usage: totalVolume > 0 ? (stats.volume_usdc / totalVolume) * 100 : 0
      }));

      return {
        networks: networkDistribution,
        total_volume: totalVolume,
        total_transactions: transactions.length
      };
    } catch (error) {
      console.error('Error calculating network distribution:', error);
      return { networks: [], total_volume: 0, total_transactions: 0 };
    }
  }

  /**
   * Calculate capital flow (received vs paid out)
   */
  calculateCapitalFlow(transactions) {
    try {
      let totalReceived = 0;
      let totalPaidOut = 0;

      transactions.forEach(tx => {
        const amount = this.extractTransactionAmount(tx);
        // Determine direction based on transaction data
        // This is simplified - in real implementation you'd need more sophisticated logic
        if (tx.direction === 'in' || tx.to) {
          totalReceived += amount;
        } else {
          totalPaidOut += amount;
        }
      });

      const netFlow = totalReceived - totalPaidOut;

      return {
        total_received: totalReceived,
        total_paid_out: totalPaidOut,
        net_flow: netFlow,
        flow_percentage: totalReceived > 0 ? (netFlow / totalReceived) * 100 : 0
      };
    } catch (error) {
      console.error('Error calculating capital flow:', error);
      return { total_received: 0, total_paid_out: 0, net_flow: 0, flow_percentage: 0 };
    }
  }

  /**
   * Calculate fee comparison (traditional vs blockchain)
   */
  calculateFeeComparison(transactions) {
    try {
      const totalVolume = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      
      // Traditional payment fees (2.9% + 30¢)
      const traditionalFeeRate = 0.029;
      const traditionalFixedFee = 0.30;
      const traditionalTotalFees = (totalVolume * traditionalFeeRate) + traditionalFixedFee;
      
      // Blockchain fees (estimated average 0.1%)
      const blockchainFeeRate = 0.001;
      const blockchainTotalFees = totalVolume * blockchainFeeRate;
      
      // Savings calculation
      const totalSavings = traditionalTotalFees - blockchainTotalFees;
      const savingsPercentage = traditionalTotalFees > 0 ? ((traditionalTotalFees - blockchainTotalFees) / traditionalTotalFees) * 100 : 0;
      
      return {
        traditional_fees: traditionalTotalFees,
        blockchain_fees: blockchainTotalFees,
        total_savings: totalSavings,
        savings_percentage: savingsPercentage,
        traditional_rate: traditionalFeeRate * 100, // 2.9%
        blockchain_rate: blockchainFeeRate * 100,   // 0.1%
        comparison_data: {
          labels: ['Traditional Fees', 'Blockchain Fees'],
          values: [traditionalTotalFees, blockchainTotalFees],
          savings: totalSavings
        }
      };
    } catch (error) {
      console.error('Error calculating fee comparison:', error);
      return {
        traditional_fees: 0,
        blockchain_fees: 0,
        total_savings: 0,
        savings_percentage: 0,
        traditional_rate: 2.9,
        blockchain_rate: 0.1,
        comparison_data: { labels: [], values: [], savings: 0 }
      };
    }
  }

  /**
   * Calculate MRR (Monthly Recurring Revenue)
   */
  calculateMRR(transactions) {
    try {
      // Calculate monthly revenue based on recent transactions
      const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const monthlyTxs = transactions.filter(tx => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        return txTime >= oneMonthAgo;
      });

      const monthlyRevenue = monthlyTxs.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      
      // Project annual revenue
      const annualRevenue = monthlyRevenue * 12;
      
      return {
        monthly_revenue: monthlyRevenue,
        annual_revenue: annualRevenue,
        transaction_count_monthly: monthlyTxs.length,
        average_monthly_transaction: monthlyTxs.length > 0 ? monthlyRevenue / monthlyTxs.length : 0
      };
    } catch (error) {
      console.error('Error calculating MRR:', error);
      return { monthly_revenue: 0, annual_revenue: 0, transaction_count_monthly: 0, average_monthly_transaction: 0 };
    }
  }

  /**
   * Generate AI-like insights
   */
  generateInsights(transactions) {
    try {
      const totalVolume = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      const totalTransactions = transactions.length;
      const successRate = transactions.length > 0 ? 
        (transactions.filter(tx => tx.status !== 'failed').length / transactions.length) * 100 : 0;

      // Generate insights based on activity
      let message = "Your account is performing well.";
      let type = "general";
      let risk_score = 85;

      if (totalVolume > 10000) {
        message = "High volume detected! You're in the top tier of users. Consider exploring our Pro features for advanced analytics.";
        type = "achievement";
        risk_score = 95;
      } else if (totalTransactions === 0) {
        message = "Welcome to Halaxa! Ready to make your first transaction? Our system is optimized for fast, secure transfers.";
        type = "welcome";
        risk_score = 80;
      } else if (totalTransactions > 50) {
        message = "You're a power user! Your transaction efficiency is excellent. Keep up the great work!";
        type = "congratulations";
        risk_score = 90;
      } else {
        message = "Your transaction activity is growing. Consider setting up automated payments to save time.";
        type = "suggestion";
        risk_score = 85;
      }

      return {
        message,
        type,
        risk_score,
        total_volume: totalVolume,
        transaction_count: totalTransactions,
        success_rate: successRate
      };
    } catch (error) {
      console.error('Error generating insights:', error);
      return {
        message: "System analysis in progress. Check back soon for personalized insights.",
        type: "system",
        risk_score: 85,
        total_volume: 0,
        transaction_count: 0,
        success_rate: 0
      };
    }
  }

  // ==================== WALLET MANAGEMENT ==================== //

  /**
   * Add wallet connection to database
   */
  async addWalletConnection(userId, walletAddress, network) {
    try {
      const { data, error } = await supabase
        .from('wallet_connections')
        .insert([{
          user_id: userId,
          wallet_address: walletAddress,
          network: network.toLowerCase(),
          is_active: true,
          created_at: new Date().toISOString()
        }]);

      if (error) throw error;

      console.log(`✅ Wallet connection added: ${walletAddress} for user ${userId}`);
      return { success: true, data };
    } catch (error) {
      console.error('Error adding wallet connection:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get wallet connections for user
   */
  async getWalletConnections(userId) {
    try {
      const { data, error } = await supabase
        .from('wallet_connections')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true);

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error) {
      console.error('Error fetching wallet connections:', error);
      return { success: false, error: error.message, data: [] };
    }
  }

  // ==================== UTILITY METHODS ==================== //

  /**
   * Get fallback data when calculations fail
   */
  getFallbackData() {
    return {
      balances: { total: 0, polygon: 0, solana: 0, tron: 0, network_breakdown: {}, wallet_count: 0 },
      analytics: { total_volume: 0, transaction_count: 0, success_rate: 0, volume_24h: 0, average_transaction_size: 0, largest_transaction: 0, smallest_transaction: 0 },
      insights: { message: "Loading real-time data...", type: "system", risk_score: 85, total_volume: 0, transaction_count: 0, success_rate: 0 },
      velocity: { total_executions: 0, daily_average: 0, recent_count: 0, velocity: 0 },
      precision: { precision_percentage: 0, successful_count: 0, total_count: 0, failed_count: 0 },
      magnitude: { average_amount: 0, total_volume: 0, transaction_count: 0, largest_transaction: 0, smallest_transaction: 0 },
      networks: { networks: [], total_volume: 0, total_transactions: 0 },
      capital_flow: { total_received: 0, total_paid_out: 0, net_flow: 0, flow_percentage: 0 },
      fee_comparison: { traditional_fees: 0, blockchain_fees: 0, total_savings: 0, savings_percentage: 0, traditional_rate: 2.9, blockchain_rate: 0.1, comparison_data: { labels: [], values: [], savings: 0 } },
      mrr: { monthly_revenue: 0, annual_revenue: 0, transaction_count_monthly: 0, average_monthly_transaction: 0 },
      // ADDITIONAL FALLBACK DATA FOR COMPLETE DASHBOARD
      digital_vault: { total_balance: 0, network_breakdown: {}, unique_wallets: 0, last_updated: new Date().toISOString() },
      transaction_activity: { total_transactions: 0, successful_transactions: 0, success_rate: 0, weekly_transactions: 0, monthly_transactions: 0, average_daily_transactions: 0 },
      ai_insights: { total_volume_30d: 0, average_transaction_size: 0, success_rate: 0, trend_direction: 'stable', trend_percentage: 0, risk_score: 85, predicted_next_month_volume: 0, confidence_level: 60, insight_message: 'Insufficient data for AI analysis' },
      total_volume: { total_volume: 0 },
      weekly_transactions: { weekly_transactions: 0 },
      monthly_transactions: { monthly_transactions: 0 },
      largest_payment: { largest_payment: 0 },
      average_payment: { average_payment: 0 },
      orders: { total_orders: 0 },
      revenue: { total_revenue: 0 },
      user_balances: { total_balance: 0, network_balances: {}, user_id: 'unknown' },
      network_distribution: { networks: [], total_volume: 0, total_transactions: 0 },
      volume_overview: { total_volume: 0, transaction_count: 0, average_volume: 0, volume_trend: 'stable' },
      comprehensive_fees: { traditional_fees: 0, blockchain_fees: 0, total_savings: 0, savings_percentage: 0 },
      recent_transactions_detailed: { recent_transactions: [] },
      countries: { countries: [], total_countries: 0 },
      ready_to_ship: { ready_to_ship: 0 },
      new_orders: { new_orders: 0 },
      total_customers: { total_customers: 0 },
      total_usdc_paid_out: 0,
      billing_history: { billing_history: [] },
      generated_at: new Date().toISOString()
    };
  }

  /**
   * Fallback data for Polygon when Alchemy fails
   */
  getFallbackPolygonData() {
    console.log('[ENGINE] Using fallback Polygon data due to Alchemy API failures');
    return [];
  }

  /**
   * Fallback data for Solana when Alchemy fails
   */
  getFallbackSolanaData() {
    console.log('[ENGINE] Using fallback Solana data due to Alchemy API failures');
    return [];
  }

  /**
   * Clear cache for a specific user
   */
  clearUserCache(userId) {
    const cacheKey = `dashboard_${userId}`;
    this.cache.delete(cacheKey);
    console.log(`🗑️ Cleared cache for user: ${userId.substring(0, 8)}****`);
  }

  // ==================== ADDITIONAL CALCULATION METHODS ==================== //

  /**
   * Calculate digital vault summary
   */
  calculateDigitalVault(transactions, userWallets) {
    try {
      const totalBalance = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      const networkBreakdown = {};
      
      transactions.forEach(tx => {
        const network = tx.network || 'polygon';
        const amount = this.extractTransactionAmount(tx);
        if (!networkBreakdown[network]) networkBreakdown[network] = 0;
        networkBreakdown[network] += amount;
      });

      return {
        total_balance: totalBalance,
        network_breakdown: networkBreakdown,
        unique_wallets: userWallets.length,
        last_updated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error calculating digital vault:', error);
      return { total_balance: 0, network_breakdown: {}, unique_wallets: 0, last_updated: new Date().toISOString() };
    }
  }

  /**
   * Calculate transaction activity
   */
  calculateTransactionActivity(transactions) {
    try {
      const totalTransactions = transactions.length;
      const successfulTransactions = transactions.filter(tx => tx.status !== 'failed').length;
      const successRate = totalTransactions > 0 ? (successfulTransactions / totalTransactions) * 100 : 0;

      // Calculate activity by time periods
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

      const weeklyTxs = transactions.filter(tx => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        return txTime >= oneWeekAgo;
      });

      const monthlyTxs = transactions.filter(tx => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        return txTime >= oneMonthAgo;
      });

      return {
        total_transactions: totalTransactions,
        successful_transactions: successfulTransactions,
        success_rate: successRate,
        weekly_transactions: weeklyTxs.length,
        monthly_transactions: monthlyTxs.length,
        average_daily_transactions: monthlyTxs.length / 30
      };
    } catch (error) {
      console.error('Error calculating transaction activity:', error);
      return { total_transactions: 0, successful_transactions: 0, success_rate: 0, weekly_transactions: 0, monthly_transactions: 0, average_daily_transactions: 0 };
    }
  }

  /**
   * Calculate AI financial insights
   */
  calculateAIFinancialInsights(transactions) {
    try {
      const totalVolume = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      const avgTransactionSize = transactions.length > 0 ? totalVolume / transactions.length : 0;
      const successRate = transactions.length > 0 ? 
        (transactions.filter(tx => tx.status !== 'failed').length / transactions.length) * 100 : 0;

      // Trend analysis
      const sortedTxs = transactions.sort((a, b) => {
        const timeA = a.metadata?.blockTimestamp || a.blockTime * 1000;
        const timeB = b.metadata?.blockTimestamp || b.blockTime * 1000;
        return timeA - timeB;
      });

      const midPoint = Math.floor(sortedTxs.length / 2);
      const firstHalf = sortedTxs.slice(0, midPoint);
      const secondHalf = sortedTxs.slice(midPoint);

      const firstHalfAvg = firstHalf.length > 0 ? 
        firstHalf.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0) / firstHalf.length : 0;
      const secondHalfAvg = secondHalf.length > 0 ? 
        secondHalf.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0) / secondHalf.length : 0;

      const trendDirection = secondHalfAvg > firstHalfAvg ? 'increasing' : 'decreasing';
      const trendPercentage = firstHalfAvg > 0 ? ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 : 0;

      // Risk assessment
      const riskScore = Math.max(0, Math.min(100, 
        85 + (successRate - 95) * 3 + Math.min(5, transactions.length / 10)
      ));

      const predictedVolume = totalVolume * (1 + (trendPercentage / 100));

      return {
        total_volume_30d: totalVolume,
        average_transaction_size: avgTransactionSize,
        success_rate: successRate,
        trend_direction: trendDirection,
        trend_percentage: Math.abs(trendPercentage),
        risk_score: riskScore,
        predicted_next_month_volume: Math.max(0, predictedVolume),
        confidence_level: Math.min(95, 60 + transactions.length),
        insight_message: this.generateInsightMessage(trendDirection, successRate, riskScore)
      };
    } catch (error) {
      console.error('Error calculating AI insights:', error);
      return {
        total_volume_30d: 0,
        average_transaction_size: 0,
        success_rate: 0,
        trend_direction: 'stable',
        trend_percentage: 0,
        risk_score: 85,
        predicted_next_month_volume: 0,
        confidence_level: 60,
        insight_message: 'Insufficient data for AI analysis'
      };
    }
  }

  /**
   * Calculate total volume
   */
  calculateTotalVolume(transactions) {
    try {
      const totalVolume = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      return { total_volume: totalVolume };
    } catch (error) {
      console.error('Error calculating total volume:', error);
      return { total_volume: 0 };
    }
  }

  /**
   * Calculate weekly transactions
   */
  calculateWeeklyTransactions(transactions) {
    try {
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const weeklyTxs = transactions.filter(tx => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        return txTime >= oneWeekAgo;
      });

      return { weekly_transactions: weeklyTxs.length };
    } catch (error) {
      console.error('Error calculating weekly transactions:', error);
      return { weekly_transactions: 0 };
    }
  }

  /**
   * Calculate monthly transactions
   */
  calculateMonthlyTransactions(transactions) {
    try {
      const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const monthlyTxs = transactions.filter(tx => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        return txTime >= oneMonthAgo;
      });

      return { monthly_transactions: monthlyTxs.length };
    } catch (error) {
      console.error('Error calculating monthly transactions:', error);
      return { monthly_transactions: 0 };
    }
  }

  /**
   * Calculate largest payment
   */
  calculateLargestPayment(transactions) {
    try {
      const amounts = transactions.map(tx => this.extractTransactionAmount(tx));
      const largestAmount = amounts.length > 0 ? Math.max(...amounts) : 0;
      return { largest_payment: largestAmount };
    } catch (error) {
      console.error('Error calculating largest payment:', error);
      return { largest_payment: 0 };
    }
  }

  /**
   * Calculate average payment
   */
  calculateAveragePayment(transactions) {
    try {
      const totalAmount = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      const averageAmount = transactions.length > 0 ? totalAmount / transactions.length : 0;
      return { average_payment: averageAmount };
    } catch (error) {
      console.error('Error calculating average payment:', error);
      return { average_payment: 0 };
    }
  }

  /**
   * Calculate orders
   */
  calculateOrders(transactions) {
    try {
      return { total_orders: transactions.length };
    } catch (error) {
      console.error('Error calculating orders:', error);
      return { total_orders: 0 };
    }
  }

  /**
   * Calculate revenue
   */
  calculateRevenue(transactions) {
    try {
      const totalRevenue = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      return { total_revenue: totalRevenue };
    } catch (error) {
      console.error('Error calculating revenue:', error);
      return { total_revenue: 0 };
    }
  }

  /**
   * Calculate user balances
   */
  calculateUserBalances(transactions, userWallets) {
    try {
      const totalBalance = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      return {
        total_balance: totalBalance,
        network_balances: this.calculateNetworkDistribution(transactions).networks.reduce((acc, net) => {
          acc[net.network] = net.volume_usdc;
          return acc;
        }, {}),
        user_id: userWallets[0]?.user_id || 'unknown'
      };
    } catch (error) {
      console.error('Error calculating user balances:', error);
      return { total_balance: 0, network_balances: {}, user_id: 'unknown' };
    }
  }

  /**
   * Calculate volume overview
   */
  calculateVolumeOverview(transactions) {
    try {
      const totalVolume = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      const transactionCount = transactions.length;
      const averageVolume = transactionCount > 0 ? totalVolume / transactionCount : 0;

      return {
        total_volume: totalVolume,
        transaction_count: transactionCount,
        average_volume: averageVolume,
        volume_trend: 'stable' // Simplified for now
      };
    } catch (error) {
      console.error('Error calculating volume overview:', error);
      return { total_volume: 0, transaction_count: 0, average_volume: 0, volume_trend: 'stable' };
    }
  }

  /**
   * Calculate comprehensive fees
   */
  calculateComprehensiveFees(transactions) {
    try {
      const totalVolume = transactions.reduce((sum, tx) => sum + this.extractTransactionAmount(tx), 0);
      
      // Traditional fees (2.9% + 30¢)
      const traditionalFees = (totalVolume * 0.029) + 0.30;
      
      // Blockchain fees (0.1%)
      const blockchainFees = totalVolume * 0.001;
      
      const totalSavings = traditionalFees - blockchainFees;

      return {
        traditional_fees: traditionalFees,
        blockchain_fees: blockchainFees,
        total_savings: totalSavings,
        savings_percentage: traditionalFees > 0 ? (totalSavings / traditionalFees) * 100 : 0
      };
    } catch (error) {
      console.error('Error calculating comprehensive fees:', error);
      return { traditional_fees: 0, blockchain_fees: 0, total_savings: 0, savings_percentage: 0 };
    }
  }

  /**
   * Calculate recent transactions detailed
   */
  calculateRecentTransactionsDetailed(transactions) {
    try {
      const recentTxs = transactions.slice(0, 20).map(tx => ({
        hash: tx.hash || tx.signature || 'unknown',
        amount: this.extractTransactionAmount(tx),
        network: tx.network || 'polygon',
        status: tx.status || 'confirmed',
        timestamp: tx.metadata?.blockTimestamp || tx.blockTime * 1000,
        from: tx.from || 'unknown',
        to: tx.to || 'unknown'
      }));

      return { recent_transactions: recentTxs };
    } catch (error) {
      console.error('Error calculating recent transactions detailed:', error);
      return { recent_transactions: [] };
    }
  }

  /**
   * Calculate countries (simplified)
   */
  calculateCountries(transactions) {
    try {
      // Simplified country calculation - in real implementation you'd get this from transaction metadata
      return { countries: ['United States', 'Canada', 'United Kingdom'], total_countries: 3 };
    } catch (error) {
      console.error('Error calculating countries:', error);
      return { countries: [], total_countries: 0 };
    }
  }

  /**
   * Calculate ready to ship
   */
  calculateReadyToShip(transactions) {
    try {
      // Simplified - in real implementation this would be based on order status
      const readyToShip = transactions.filter(tx => tx.status === 'confirmed').length;
      return { ready_to_ship: readyToShip };
    } catch (error) {
      console.error('Error calculating ready to ship:', error);
      return { ready_to_ship: 0 };
    }
  }

  /**
   * Calculate new orders
   */
  calculateNewOrders(transactions) {
    try {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const newOrders = transactions.filter(tx => {
        const txTime = tx.metadata?.blockTimestamp || tx.blockTime * 1000;
        return txTime >= oneDayAgo;
      });
      return { new_orders: newOrders.length };
    } catch (error) {
      console.error('Error calculating new orders:', error);
      return { new_orders: 0 };
    }
  }

  /**
   * Calculate total customers
   */
  calculateTotalCustomers(transactions) {
    try {
      // Simplified - in real implementation this would be based on unique customer data
      const uniqueCustomers = new Set(transactions.map(tx => tx.from || tx.to)).size;
      return { total_customers: uniqueCustomers };
    } catch (error) {
      console.error('Error calculating total customers:', error);
      return { total_customers: 0 };
    }
  }

  /**
   * Calculate total USDC paid out
   */
  calculateTotalUSDCPaidOut(transactions) {
    try {
      const paidOut = transactions.filter(tx => tx.direction === 'out').reduce((sum, tx) => 
        sum + this.extractTransactionAmount(tx), 0);
      return paidOut;
    } catch (error) {
      console.error('Error calculating total USDC paid out:', error);
      return 0;
    }
  }

  /**
   * Calculate billing history
   */
  calculateBillingHistory(transactions) {
    try {
      const billingHistory = transactions.map(tx => ({
        id: tx.hash || tx.signature || 'unknown',
        amount: this.extractTransactionAmount(tx),
        status: tx.status || 'confirmed',
        date: new Date(tx.metadata?.blockTimestamp || tx.blockTime * 1000).toISOString(),
        network: tx.network || 'polygon'
      }));

      return { billing_history: billingHistory };
    } catch (error) {
      console.error('Error calculating billing history:', error);
      return { billing_history: [] };
    }
  }

  /**
   * Generate insight message
   */
  generateInsightMessage(trendDirection, successRate, riskScore) {
    if (successRate > 95 && riskScore > 90) {
      return "Excellent performance! Your transaction success rate is outstanding.";
    } else if (trendDirection === 'increasing') {
      return "Great progress! Your transaction volume is growing steadily.";
    } else if (successRate > 85) {
      return "Good performance! Consider optimizing for even better results.";
    } else {
      return "Keep improving! Focus on transaction success rates for better performance.";
    }
  }

  /**
   * Get system status
   */
  getSystemStatus() {
    return {
      isRunning: this.isRunning,
      cacheSize: this.cache.size,
      cacheTimeout: this.cacheTimeout,
      lastRun: new Date().toISOString()
    };
  }
}

// Create and export singleton instance
const calculationEngine = new HalaxaCalculationEngine();

// Export for use in other modules
export default calculationEngine;

console.log('✅ CALCULATION-ENGINE.JS: Comprehensive calculation engine loaded successfully');
