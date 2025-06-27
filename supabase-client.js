// ==================== FRONTEND SUPABASE CLIENT ==================== //

/**
 * Frontend Supabase Configuration
 * This file is for client-side operations (browser)
 * Uses ANON KEY only - never expose service role keys to frontend!
 */

import { createClient } from 'https://cdn.skypack.dev/@supabase/supabase-js@2';

// Frontend Configuration - Use environment variables for production
const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || 'https://srdznitapqlulldlkqsk.supabase.co';
const supabaseAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyZHpuaXRhcHFsdWxkbGRrcXNrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk2NjgxNzMsImV4cCI6MjA2NTI0NDE3M30.lJpWHGG8OXJOcFBEVo1T8kRF3_SN_fYGxBkJJk9O3lc';

// Validate configuration
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase configuration. Please check your environment variables.');
}

// Create Supabase client for frontend
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'pkce' // Recommended for SPA
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});

// ==================== AUTHENTICATION HELPERS ==================== //

export const auth = {
  // Sign up user
  async signUp(email, password, userData = {}) {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: userData // Additional user metadata
        }
      });
      
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Sign up error:', error);
      return { success: false, error: error.message };
    }
  },

  // Sign in user
  async signIn(email, password) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      });
      
      if (error) throw error;
      
      // Store user data in localStorage for access control
      if (data.user) {
        // ⚠️ DEV WARNING: data.user.id is Supabase Auth UUID - use for user_id in dashboard tables
        console.log(`🔐 Storing Supabase Auth user ID: ${data.user.id.substring(0, 8)}**** (use for user_id fields)`);
        
        localStorage.setItem('user', JSON.stringify({
          id: data.user.id,
          email: data.user.email,
          ...data.user.user_metadata
        }));
      }
      
      return { success: true, data };
    } catch (error) {
      console.error('Sign in error:', error);
      return { success: false, error: error.message };
    }
  },

  // Sign out user
  async signOut() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      
      // Clear localStorage
      localStorage.removeItem('user');
      localStorage.removeItem('userPlan');
      
      return { success: true };
    } catch (error) {
      console.error('Sign out error:', error);
      return { success: false, error: error.message };
    }
  },

  // Get current user
  getCurrentUser() {
    return supabase.auth.getUser();
  },

  // Get current session
  getSession() {
    return supabase.auth.getSession();
  },

  // Listen to auth changes
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback);
  }
};

// ==================== REAL-TIME HELPERS ==================== //

export const realtime = {
  // Subscribe to table changes
  subscribeToTable(table, callback, filter = null) {
    let subscription = supabase
      .channel(`${table}_changes`)
      .on('postgres_changes', 
        { 
          event: '*', 
          schema: 'public', 
          table: table,
          ...(filter && { filter })
        }, 
        callback
      )
      .subscribe();
    
    return subscription;
  },

  // Subscribe to user-specific changes
  subscribeToUserData(userId, table, callback) {
    return this.subscribeToTable(table, callback, `user_id=eq.${userId}`);
  },

  // Subscribe to payment link updates
  subscribeToPaymentLinks(userId, callback) {
    return this.subscribeToUserData(userId, 'payment_links', callback);
  },

  // Subscribe to transaction updates
  subscribeToTransactions(userId, callback) {
    return this.subscribeToUserData(userId, 'transactions', callback);
  },

  // Unsubscribe from channel
  unsubscribe(subscription) {
    supabase.removeChannel(subscription);
  }
};

// ==================== DATA HELPERS ==================== //

export const database = {
  // Get user plan (frontend-safe query)
  async getUserPlan(userId) {
    try {
      const { data, error } = await supabase
        .from('user_plans')
        .select('plan_type, started_at, next_billing')
        .eq('user_id', userId)
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      
      const plan = data?.plan_type || 'basic';
      localStorage.setItem('userPlan', plan);
      
      return { success: true, plan, data };
    } catch (error) {
      console.error('Error fetching user plan:', error);
      return { success: false, plan: 'basic', error: error.message };
    }
  },

  // Get user payment links
  async getPaymentLinks(userId) {
    try {
      const { data, error } = await supabase
        .from('payment_links')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching payment links:', error);
      return { success: false, data: [], error: error.message };
    }
  },

  // Get user transactions
  async getTransactions(userId, limit = 50) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching transactions:', error);
      return { success: false, data: [], error: error.message };
    }
  },

  // Get user metrics
  async getUserMetrics(userId) {
    try {
      const { data, error } = await supabase
        .from('user_metrics')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching user metrics:', error);
      return { success: false, data: null, error: error.message };
    }
  }
};

// ==================== INITIALIZATION ==================== //

// Initialize auth state on load
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Check for existing session
    const { data: { session } } = await supabase.auth.getSession();
    
    if (session?.user) {
      // Store user data
      localStorage.setItem('user', JSON.stringify({
        id: session.user.id,
        email: session.user.email,
        ...session.user.user_metadata
      }));
      
      // Get user plan
      await database.getUserPlan(session.user.id);
      
      console.log('✅ User session restored');
    } else {
      console.log('ℹ️ No active session');
    }
  } catch (error) {
    console.error('Session initialization error:', error);
  }
});

// Listen for auth changes
auth.onAuthStateChange((event, session) => {
  console.log('Auth state changed:', event);
  
  if (event === 'SIGNED_IN' && session?.user) {
    // ⚠️ DEV WARNING: session.user.id is Supabase Auth UUID - use for user_id in dashboard tables
    console.log(`🔐 Auth state change - user ID: ${session.user.id.substring(0, 8)}**** (use for user_id fields)`);
    
    // Update user data
    localStorage.setItem('user', JSON.stringify({
      id: session.user.id,
      email: session.user.email,
      ...session.user.user_metadata
    }));
    
    // Get user plan
    database.getUserPlan(session.user.id);
    
    // Trigger custom event
    window.dispatchEvent(new CustomEvent('userSignedIn', { 
      detail: { user: session.user } 
    }));
  } else if (event === 'SIGNED_OUT') {
    // Clear data
    localStorage.removeItem('user');
    localStorage.removeItem('userPlan');
    
    // Trigger custom event
    window.dispatchEvent(new CustomEvent('userSignedOut'));
  }
});

// ==================== EXPORT FOR GLOBAL USE ==================== //

// Make available globally
window.supabase = supabase;
window.supabaseAuth = auth;
window.supabaseRealtime = realtime;
window.supabaseDatabase = database;

console.log('🚀 Frontend Supabase client initialized'); 