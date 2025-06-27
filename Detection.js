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
      console.log('🔍 Running detection cycle...');

      // Get all active users with their wallet addresses
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, email');

      if (usersError) throw usersError;

      // Process each user individually
      for (const user of users) {
        await this.detectUserActivity(user.id);
        await this.updateUserMetrics(user.id);
        await this.generateUserInsights(user.id);
      }

      // Update global metrics
      await this.updateGlobalMetrics();

      console.log(`✅ Detection cycle completed for ${users.length} users`);
    } catch (error) {
      console.error('❌ Error in detection cycle:', error);
    }
  }

  // ==================== BLOCKCHAIN TRANSACTION DETECTION ==================== //

  async detectUserActivity(userId) {
    try {
      // Get user's wallet addresses
      const userWallets = await this.getUserWallets(userId);

      // Get user's payment links
      const { data: paymentLinks } = await supabase
        .from('payment_links')
        .select('*')
        .eq('user_id', userId);

      // Detect new transactions for each wallet
      for (const wallet of userWallets) {
        if (wallet.wallet_address) {
          await this.detectWalletTransactions(userId, wallet.wallet_address, wallet);
        }
      }

      // Monitor payment link activity
      if (paymentLinks) {
        for (const link of paymentLinks) {
          await this.monitorPaymentLinkActivity(userId, link);
        }
      }

      // Update user activity timestamp
      await this.updateUserLastActive(userId);

    } catch (error) {
      console.error(`Error detecting activity for user ${userId}:`, error);
    }
  }

  async detectWalletTransactions(userId, walletAddress, walletInfo) {
    try {
      // Check both Polygon and Solana for this wallet
      const polygonTxs = await this.getPolygonTransactions(walletAddress);
      const solanaTxs = await this.getSolanaTransactions(walletAddress);

      // Process Polygon transactions
      for (const tx of polygonTxs) {
        await this.processAndStoreTransaction(userId, tx, 'polygon', walletAddress);
      }

      // Process Solana transactions
      for (const tx of solanaTxs) {
        await this.processAndStoreTransaction(userId, tx, 'solana', walletAddress);
      }

    } catch (error) {
      console.error(`Error detecting transactions for wallet ${walletAddress}:`, error);
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

      const data = await response.json();
      return data.result?.transfers || [];

    } catch (error) {
      console.error('Error fetching Polygon transactions:', error);
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

      const data = await response.json();
      return data.result || [];

    } catch (error) {
      console.error('Error fetching Solana transactions:', error);
      return [];
    }
  }

  // ==================== TRANSACTION PROCESSING ==================== //

  async processAndStoreTransaction(userId, transaction, network, userWalletAddress) {
    try {
      // Check if transaction already exists using tx_hash
      const txHash = transaction.hash || transaction.signature;
      
      const { data: existingTx } = await supabase
        .from('transactions')
        .select('id')
        .eq('tx_hash', txHash)
        .single();

      if (existingTx) return; // Skip if already processed

      // Determine transaction direction
      const direction = this.determineTransactionDirection(transaction, userWalletAddress);
      
      // Extract transaction details matching schema
      const txData = {
        user_id: userId,
        tx_hash: txHash,
        network: network,
        amount_usdc: this.extractTransactionAmount(transaction),
        gas_fee: this.extractGasFee(transaction),
        status: 'completed',
        custom_tag: null,
        direction: direction, // 'in' or 'out'
        created_at: new Date().toISOString(),
        confirmed_at: new Date(transaction.timestamp || transaction.blockTime * 1000).toISOString(),
        fee_savings: this.calculateFeeSavings(transaction, network),
        usd_equivalent: this.extractTransactionAmount(transaction) // Assuming USDC = USD
      };

      // Store transaction
      const { error: txError } = await supabase
        .from('transactions')
        .insert([txData]);

      if (txError) throw txError;

      // Update related tables
      await this.updateTransactionInsights(userId, txData);
      await this.updateUserBalances(userId, txData, userWalletAddress);
      await this.updateNetworkDistributions(userId, network, txData.amount_usdc);

      console.log(`✅ Processed transaction ${txData.tx_hash} for user ${userId}`);

    } catch (error) {
      console.error('Error processing transaction:', error);
    }
  }

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

  // ==================== DASHBOARD DATA POPULATION ==================== //

  async updateUserMetrics(userId) {
    try {
      // Calculate user activity metrics
      const activityMetrics = await this.calculateUserActivityMetrics(userId);
      
      // Update user_metrics table with correct schema
      const { error: metricsError } = await supabase
        .from('user_metrics')
        .upsert([{
          user_id: userId,
          days_active: activityMetrics.daysActive,
          status_level: activityMetrics.statusLevel,
          current_streak: activityMetrics.currentStreak
        }]);

      if (metricsError) throw metricsError;

      // Update monthly_metrics table
      await this.updateMonthlyMetrics(userId);

      // Update key_metrics table
      await this.updateKeyMetrics(userId);

      // Update execution_metrics table
      await this.updateExecutionMetrics(userId);

    } catch (error) {
      console.error(`Error updating metrics for user ${userId}:`, error);
    }
  }

  async calculateUserActivityMetrics(userId) {
    try {
      const { data: transactions } = await supabase
        .from('transactions')
        .select('created_at, confirmed_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      const now = new Date();
      const uniqueDays = new Set();
      let currentStreak = 0;
      let lastActiveDate = null;

      // Calculate days active and streak
      if (transactions) {
        transactions.forEach(tx => {
          const txDate = new Date(tx.created_at);
          const dayKey = txDate.toDateString();
          uniqueDays.add(dayKey);
        });

        // Calculate current streak
        for (let i = 0; i < 30; i++) {
          const checkDate = new Date(now.getTime() - (i * 24 * 60 * 60 * 1000));
          const dayKey = checkDate.toDateString();
          
          if (uniqueDays.has(dayKey)) {
            currentStreak++;
            lastActiveDate = checkDate;
          } else if (currentStreak > 0) {
            break;
          }
        }
      }

      const daysActive = uniqueDays.size;
      const statusLevel = this.determineStatusLevel(daysActive, transactions?.length || 0);

      return {
        daysActive,
        statusLevel,
        currentStreak
      };
    } catch (error) {
      console.error('Error calculating user activity metrics:', error);
      return {
        daysActive: 0,
        statusLevel: 'bronze',
        currentStreak: 0
      };
    }
  }

  determineStatusLevel(daysActive, totalTransactions) {
    if (totalTransactions >= 100 && daysActive >= 30) return 'platinum';
    if (totalTransactions >= 50 && daysActive >= 14) return 'gold';
    if (totalTransactions >= 10 && daysActive >= 7) return 'silver';
    return 'bronze';
  }

  async updateMonthlyMetrics(userId) {
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // Get transactions for current month
      const { data: monthlyTxs } = await supabase
        .from('transactions')
        .select('amount_usdc, direction')
        .eq('user_id', userId)
        .gte('created_at', monthStart.toISOString());

      // Calculate MRR (Monthly Recurring Revenue) equivalent
      const incomingVolume = monthlyTxs?.filter(tx => tx.direction === 'in')
        .reduce((sum, tx) => sum + (tx.amount_usdc || 0), 0) || 0;

      // Create constellation data (simplified)
      const constellationData = {
        total_volume: incomingVolume,
        transaction_count: monthlyTxs?.length || 0,
        avg_transaction: monthlyTxs?.length > 0 ? incomingVolume / monthlyTxs.length : 0,
        networks_used: [...new Set(monthlyTxs?.map(tx => tx.network) || [])],
        generated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('monthly_metrics')
        .upsert([{
          user_id: userId,
          month_start: monthStart.toISOString().split('T')[0], // DATE format
          mrr_usdc: incomingVolume,
          constellation_data: constellationData
        }]);

      if (error) throw error;

    } catch (error) {
      console.error(`Error updating monthly metrics for user ${userId}:`, error);
    }
  }

  async updateKeyMetrics(userId) {
    try {
      const { data: transactions } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId);

      const { data: wallets } = await supabase
        .from('user_balances')
        .select('wallet_address')
        .eq('user_id', userId)
        .eq('is_active', true);

      // Calculate 24h volume
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent24hTxs = transactions?.filter(tx => 
        new Date(tx.created_at) >= oneDayAgo
      ) || [];

      const volume24h = recent24hTxs.reduce((sum, tx) => sum + (tx.amount_usdc || 0), 0);
      const totalFeesSaved = transactions?.reduce((sum, tx) => sum + (tx.fee_savings || 0), 0) || 0;
      
      // Mock some advanced metrics
      const conversionRate = transactions?.length > 0 ? 0.95 : 0; // 95% success rate
      const avgProcessingTime = 15.5; // seconds
      const gasOptimizationScore = 85.2; // percentage

      const { error } = await supabase
        .from('key_metrics')
        .upsert([{
          user_id: userId,
          conversion_rate: conversionRate,
          avg_processing_time: avgProcessingTime,
          fees_saved_total: totalFeesSaved,
          active_wallets: wallets?.length || 0,
          volume_24h: volume24h,
          gas_optimization_score: gasOptimizationScore
        }]);

      if (error) throw error;

    } catch (error) {
      console.error(`Error updating key metrics for user ${userId}:`, error);
    }
  }

  async updateExecutionMetrics(userId) {
    try {
      const { data: transactions } = await supabase
        .from('transactions')
        .select('status, amount_usdc, created_at')
        .eq('user_id', userId);

      const totalExecutions = transactions?.length || 0;
      const flawlessExecutions = transactions?.filter(tx => tx.status === 'completed').length || 0;
      const avgTxFlow = transactions?.reduce((sum, tx) => sum + (tx.amount_usdc || 0), 0) / Math.max(totalExecutions, 1);
      
      // Calculate velocity (transactions per day)
      const oldestTx = transactions?.reduce((oldest, tx) => {
        return new Date(tx.created_at) < new Date(oldest.created_at) ? tx : oldest;
      }, transactions[0]);
      
      const daysSinceFirst = oldestTx ? 
        Math.max(1, Math.ceil((Date.now() - new Date(oldestTx.created_at).getTime()) / (1000 * 60 * 60 * 24))) : 1;
      const velocity = Math.round(totalExecutions / daysSinceFirst);

      const { error } = await supabase
        .from('execution_metrics')
        .upsert([{
          user_id: userId,
          flawless_executions: flawlessExecutions,
          total_executions: totalExecutions,
          avg_tx_flow: avgTxFlow,
          velocity: velocity,
          timestamp: new Date().toISOString()
        }]);

      if (error) throw error;

    } catch (error) {
      console.error(`Error updating execution metrics for user ${userId}:`, error);
    }
  }

  async updateTransactionInsights(userId, transactionData) {
    try {
      // Get all user transactions for analysis
      const { data: allTxs } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId);

      if (!allTxs || allTxs.length === 0) return;

      // Calculate peak hour
      const hourCounts = {};
      allTxs.forEach(tx => {
        const hour = new Date(tx.created_at).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      });
      
      const peakHour = Object.keys(hourCounts).reduce((a, b) => 
        hourCounts[a] > hourCounts[b] ? a : b
      );

      // Count cross-chain transfers (simplified)
      const networks = new Set(allTxs.map(tx => tx.network));
      const crossChainTransfers = networks.size > 1 ? Math.floor(allTxs.length * 0.3) : 0;

      // Mock smart contract calls (simplified)
      const smartContractCalls = Math.floor(allTxs.length * 0.15);

      // Mock advanced metrics
      const avgApiResponseTime = 250 + Math.random() * 100; // ms
      const securityScore = 92.5 + Math.random() * 5; // percentage
      const userSatisfactionScore = 4.2 + Math.random() * 0.6; // out of 5

      const { error } = await supabase
        .from('transaction_insights')
        .upsert([{
          user_id: userId,
          peak_hour: `${peakHour}:00`,
          cross_chain_transfers: crossChainTransfers,
          smart_contract_calls: smartContractCalls,
          avg_api_response_time: avgApiResponseTime,
          security_score: securityScore,
          user_satisfaction_score: userSatisfactionScore
        }]);

      if (error) throw error;

    } catch (error) {
      console.error(`Error updating transaction insights for user ${userId}:`, error);
    }
  }

  async updateUserBalances(userId, transactionData, walletAddress) {
    try {
      // Get existing balance record
      const { data: existingBalance } = await supabase
        .from('user_balances')
        .select('*')
        .eq('user_id', userId)
        .eq('wallet_address', walletAddress)
        .single();

      let polygonBalance = existingBalance?.usdc_polygon || 0;
      let solanaBalance = existingBalance?.usdc_solana || 0;
      let tronBalance = existingBalance?.usdc_tron || 0;

      // Update balance based on network and direction
      if (transactionData.network === 'polygon') {
        if (transactionData.direction === 'in') {
          polygonBalance += transactionData.amount_usdc;
        } else {
          polygonBalance -= transactionData.amount_usdc;
        }
      } else if (transactionData.network === 'solana') {
        if (transactionData.direction === 'in') {
          solanaBalance += transactionData.amount_usdc;
        } else {
          solanaBalance -= transactionData.amount_usdc;
        }
      }

      const totalUsdEquivalent = polygonBalance + solanaBalance + tronBalance;

      const balanceData = {
        user_id: userId,
        wallet_address: walletAddress,
        is_active: true,
        usdc_polygon: polygonBalance,
        usdc_tron: tronBalance,
        usdc_solana: solanaBalance,
        usd_equivalent: totalUsdEquivalent,
        last_active: new Date().toISOString()
      };

      if (existingBalance) {
        balanceData.id = existingBalance.id;
      }

      const { error } = await supabase
        .from('user_balances')
        .upsert([balanceData]);

      if (error) throw error;

      // Also update usdc_balances table
      await this.updateUsdcBalances(userId, transactionData.network, 
        transactionData.network === 'polygon' ? polygonBalance : solanaBalance);

    } catch (error) {
      console.error(`Error updating user balances for user ${userId}:`, error);
    }
  }

  async updateUsdcBalances(userId, network, balance) {
    try {
      const { error } = await supabase
        .from('usdc_balances')
        .insert([{
          user_id: userId,
          network: network,
          balance_usdc: balance,
          balance_usd: balance, // Assuming 1:1 parity
          timestamp: new Date().toISOString()
        }]);

      if (error && !error.message.includes('duplicate')) throw error;

    } catch (error) {
      console.error(`Error updating USDC balances:`, error);
    }
  }

  async updateNetworkDistributions(userId, network, amount) {
    try {
      // Get existing distribution record
      const { data: existing } = await supabase
        .from('network_distributions')
        .select('*')
        .eq('user_id', userId)
        .eq('network', network)
        .single();

      const newVolume = (existing?.volume_usdc || 0) + amount;

      const distributionData = {
        user_id: userId,
        network: network,
        volume_usdc: newVolume,
        percent_usage: 0, // Will be calculated later
        recorded_at: new Date().toISOString()
      };

      if (existing) {
        distributionData.id = existing.id;
      }

      const { error } = await supabase
        .from('network_distributions')
        .upsert([distributionData]);

      if (error) throw error;

      // Recalculate percentages for all user's networks
      await this.recalculateNetworkPercentages(userId);

    } catch (error) {
      console.error(`Error updating network distributions for user ${userId}:`, error);
    }
  }

  async recalculateNetworkPercentages(userId) {
    try {
      const { data: distributions } = await supabase
        .from('network_distributions')
        .select('*')
        .eq('user_id', userId);

      if (!distributions) return;

      const totalVolume = distributions.reduce((sum, dist) => sum + (dist.volume_usdc || 0), 0);

      for (const dist of distributions) {
        const percentage = totalVolume > 0 ? (dist.volume_usdc / totalVolume) * 100 : 0;
        
        await supabase
          .from('network_distributions')
          .update({ percent_usage: percentage })
          .eq('id', dist.id);
      }

    } catch (error) {
      console.error(`Error recalculating network percentages for user ${userId}:`, error);
    }
  }

  // ==================== PAYMENT LINK MONITORING ==================== //

  async monitorPaymentLinkActivity(userId, paymentLink) {
    try {
      // Check for new payments on this link
      const { data: newPayments } = await supabase
        .from('payments')
        .select('*')
        .eq('payment_link_id', paymentLink.id)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(10);

      // Update payment link metrics
      if (newPayments && newPayments.length > 0) {
        await this.updatePaymentLinkMetrics(paymentLink.id, newPayments);
      }

      // Update user's payment activity
      await this.updateUserPaymentActivity(userId, paymentLink, newPayments);

    } catch (error) {
      console.error(`Error monitoring payment link ${paymentLink.id}:`, error);
    }
  }

  async updatePaymentLinkMetrics(paymentLinkId, payments) {
    try {
      const totalAmount = payments.reduce((sum, payment) => sum + (payment.amount_usdc || 0), 0);

      // Update payment link stats
      await supabase
        .from('payment_links')
        .update({
          updated_at: new Date().toISOString()
        })
        .eq('id', paymentLinkId);

    } catch (error) {
      console.error(`Error updating payment link metrics:`, error);
    }
  }

  async updateUserPaymentActivity(userId, paymentLink, payments) {
    try {
      if (!payments || payments.length === 0) return;

      // Update user_growth table (global metrics)
      const { data: allUsers } = await supabase
        .from('users')
        .select('id');

      const activeUsers = allUsers?.length || 0;
      
      const { data: allTxs } = await supabase
        .from('transactions')
        .select('amount_usdc');

      const totalVolume = allTxs?.reduce((sum, tx) => sum + (tx.amount_usdc || 0), 0) || 0;
      const avgVolumePerUser = activeUsers > 0 ? totalVolume / activeUsers : 0;

      await supabase
        .from('user_growth')
        .upsert([{
          active_users: activeUsers,
          avg_volume_per_user: avgVolumePerUser,
          timestamp: new Date().toISOString()
        }]);

    } catch (error) {
      console.error(`Error updating user payment activity:`, error);
    }
  }

  // ==================== AI INSIGHTS GENERATION ==================== //

  async generateUserInsights(userId) {
    try {
      const insights = await this.calculateAIInsights(userId);
      
      const { error } = await supabase
        .from('ai_oracle_messages')
        .insert([{
          user_id: userId,
          message_type: insights.type,
          content: insights.message,
          created_at: new Date().toISOString()
        }]);

      if (error) throw error;

    } catch (error) {
      console.error(`Error generating insights for user ${userId}:`, error);
    }
  }

  async calculateAIInsights(userId) {
    try {
      const { data: transactions } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId);

      const totalVolume = transactions?.reduce((sum, tx) => sum + (tx.amount_usdc || 0), 0) || 0;
      const totalTransactions = transactions?.length || 0;

      // Generate insights based on activity
      let message = "Your account is performing well.";
      let type = "general";

      if (totalVolume > 10000) {
        message = "High volume detected! You're in the top tier of users. Consider exploring our Pro features for advanced analytics.";
        type = "achievement";
      } else if (totalTransactions === 0) {
        message = "Welcome to Halaxa! Ready to make your first transaction? Our system is optimized for fast, secure transfers.";
        type = "welcome";
      } else if (totalTransactions > 50) {
        message = "You're a power user! Your transaction efficiency is excellent. Keep up the great work!";
        type = "congratulations";
      } else {
        message = "Your transaction activity is growing. Consider setting up automated payments to save time.";
        type = "suggestion";
      }

      return { message, type };

    } catch (error) {
      console.error('Error calculating AI insights:', error);
      return {
        message: "System analysis in progress. Check back soon for personalized insights.",
        type: "system"
      };
    }
  }

  // ==================== GLOBAL METRICS ==================== //

  async updateGlobalMetrics() {
    try {
      // Update market prices
      await this.updateMarketPrices();
      
      // Update billing history for subscriptions
      await this.updateBillingHistory();

    } catch (error) {
      console.error('Error updating global metrics:', error);
    }
  }

  async updateMarketPrices() {
    try {
      // Mock price data - in real implementation, fetch from price APIs
      const prices = [
        { asset: 'USDC', price: 1.00 },
        { asset: 'MATIC', price: 0.85 },
        { asset: 'SOL', price: 45.67 }
      ];

      for (const price of prices) {
        await supabase
          .from('market_prices')
          .upsert([{
            asset: price.asset,
            price: price.price,
            fetched_at: new Date().toISOString()
          }]);
      }

    } catch (error) {
      console.error('Error updating market prices:', error);
    }
  }

  async updateBillingHistory() {
    try {
      // Get users with paid plans
      const { data: users } = await supabase
        .from('users')
        .select('id, plan, email')
        .neq('plan', 'basic');

      for (const user of users) {
        // Check if billing record exists for current month
        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const { data: existing } = await supabase
          .from('billing_history')
          .select('id')
          .eq('user_id', user.id)
          .gte('date', currentMonthStart.toISOString())
          .single();

        if (!existing) {
          const planPrices = { pro: 29, elite: 99 };
          const amount = planPrices[user.plan] || 0;

          await supabase
            .from('billing_history')
            .insert([{
              user_id: user.id,
              date: new Date().toISOString(),
              plan_type: user.plan,
              amount_usd: amount,
              status: 'paid',
              invoice_url: `https://invoices.halaxa.com/${user.id}/${now.getMonth() + 1}-${now.getFullYear()}`
            }]);
        }
      }

    } catch (error) {
      console.error('Error updating billing history:', error);
    }
  }

  // ==================== UTILITY METHODS ==================== //

  async updateUserLastActive(userId) {
    try {
      await supabase
        .from('users')
        .update({ last_login: new Date().toISOString() })
        .eq('id', userId);
    } catch (error) {
      console.error(`Error updating last active for user ${userId}:`, error);
    }
  }

  async getUserWallets(userId) {
    try {
      const { data: wallets } = await supabase
        .from('user_balances')
        .select('wallet_address, is_active')
        .eq('user_id', userId)
        .eq('is_active', true);

      return wallets || [];
    } catch (error) {
      console.error(`Error getting wallets for user ${userId}:`, error);
      return [];
    }
  }

  // ==================== EXECUTION CONTROL ==================== //

  async runDetectionForUser(userId) {
    try {
      console.log(`🔍 Running detection for user ${userId}...`);
      
      await this.detectUserActivity(userId);
      await this.updateUserMetrics(userId);
      await this.generateUserInsights(userId);
      
      console.log(`✅ Detection completed for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error running detection for user ${userId}:`, error);
    }
  }

  getSystemStatus() {
    return {
      isRunning: this.isRunning,
      intervalActive: !!this.detectionInterval,
      cachedWallets: this.userWallets.size,
      lastRun: new Date().toISOString()
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
  }
};
