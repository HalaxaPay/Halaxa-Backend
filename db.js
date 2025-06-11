import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { promisify } from 'util';
import crypto from 'crypto';

sqlite3.verbose();

// Database configuration
const DB_CONFIG = {
  filename: './halaxa_users.db',
  driver: sqlite3.Database,
  mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
};

// Connection pool
const pool = {
  connections: new Map(),
  maxConnections: 10,
  currentConnections: 0
};

// Error handling class
class DatabaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

// Generate a unique connection ID
const generateConnectionId = () => crypto.randomBytes(16).toString('hex');

// Get a database connection from the pool
async function getConnection() {
  if (pool.currentConnections >= pool.maxConnections) {
    throw new DatabaseError('Maximum number of connections reached', 'MAX_CONNECTIONS');
  }

  const connectionId = generateConnectionId();
  try {
    const db = await open(DB_CONFIG);
    pool.connections.set(connectionId, db);
    pool.currentConnections++;
    return { db, connectionId };
  } catch (error) {
    throw new DatabaseError(`Failed to create database connection: ${error.message}`, 'CONNECTION_ERROR');
  }
}

// Release a database connection back to the pool
async function releaseConnection(connectionId) {
  const db = pool.connections.get(connectionId);
  if (db) {
    try {
      await db.close();
      pool.connections.delete(connectionId);
      pool.currentConnections--;
    } catch (error) {
      throw new DatabaseError(`Failed to close database connection: ${error.message}`, 'CLOSE_ERROR');
    }
  }
}

// Initialize the database with all required tables and indexes
export async function initDB() {
  const { db, connectionId } = await getConnection();
  
  try {
    // Enable foreign keys
    await db.exec('PRAGMA foreign_keys = ON;');

    // Create users table with indexes
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        hashed_password TEXT NOT NULL,
        plan TEXT DEFAULT 'basic',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_login_at TEXT,
        is_active BOOLEAN DEFAULT 1,
        is_email_verified BOOLEAN DEFAULT 0,
        verification_token TEXT,
        refresh_token TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
    `);

    // Create email verification tokens table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_email_verification_token ON email_verification_tokens(token);
    `);

    // Create password reset tokens table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token);
    `);

    // Create refresh tokens table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_token ON refresh_tokens(token);
    `);

    // Create payment_links table with indexes
    await db.exec(`
      CREATE TABLE IF NOT EXISTS payment_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id TEXT UNIQUE NOT NULL,
        wallet_address TEXT NOT NULL,
        amount_usdc REAL NOT NULL,
        chain TEXT NOT NULL,
        product_title TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_payment_links_link_id ON payment_links(link_id);
      CREATE INDEX IF NOT EXISTS idx_payment_links_wallet ON payment_links(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_payment_links_seller ON payment_links(seller_id);
      CREATE INDEX IF NOT EXISTS idx_payment_links_status ON payment_links(status);
    `);

    // Create buyers table with indexes
    await db.exec(`
      CREATE TABLE IF NOT EXISTS buyers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_link_id INTEGER NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL,
        address_line_1 TEXT NOT NULL,
        address_line_2 TEXT,
        city TEXT NOT NULL,
        country TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (payment_link_id) REFERENCES payment_links(id)
      );
      CREATE INDEX IF NOT EXISTS idx_buyers_payment_link ON buyers(payment_link_id);
      CREATE INDEX IF NOT EXISTS idx_buyers_email ON buyers(email);
    `);

    // Create payments table with indexes
    await db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_link_id INTEGER NOT NULL,
        transaction_hash TEXT UNIQUE NOT NULL,
        amount_usdc REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        confirmed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (payment_link_id) REFERENCES payment_links(id)
      );
      CREATE INDEX IF NOT EXISTS idx_payments_link ON payments(payment_link_id);
      CREATE INDEX IF NOT EXISTS idx_payments_hash ON payments(transaction_hash);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
      CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);
      CREATE INDEX IF NOT EXISTS idx_payments_amount ON payments(amount_usdc);
    `);

    // Add index for payment_links chain
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_payment_links_chain ON payment_links(chain);
    `);

    // Create accounts table with indexes (Added to support Capital and Account pages)
    await db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id TEXT NOT NULL,
        wallet_address TEXT UNIQUE NOT NULL,
        chain TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_seller ON accounts(seller_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_wallet ON accounts(wallet_address);
    `);

    // Create account_insights table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS account_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id TEXT NOT NULL,
        security_score INTEGER DEFAULT 0,
        activity_level TEXT DEFAULT 'low',
        account_age_days INTEGER DEFAULT 0,
        verification_status TEXT DEFAULT 'pending',
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_account_insights_seller ON account_insights(seller_id);
    `);

    // Create faqs table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS faqs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_faqs_category ON faqs(category);
      CREATE INDEX IF NOT EXISTS idx_faqs_priority ON faqs(priority);
    `);

    // Create user_activity table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_activity_seller ON user_activity(seller_id);
      CREATE INDEX IF NOT EXISTS idx_user_activity_type ON user_activity(activity_type);
      CREATE INDEX IF NOT EXISTS idx_user_activity_created ON user_activity(created_at);
    `);

    // Create security_events table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (seller_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_security_events_seller ON security_events(seller_id);
      CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
    `);

    return db;
  } catch (error) {
    await releaseConnection(connectionId);
    throw new DatabaseError(`Database initialization failed: ${error.message}`, 'INIT_ERROR');
  }
}

// Transaction wrapper
export async function withTransaction(callback) {
  const { db, connectionId } = await getConnection();
  try {
    await db.exec('BEGIN TRANSACTION');
    const result = await callback(db);
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw new DatabaseError(`Transaction failed: ${error.message}`, 'TRANSACTION_ERROR');
  } finally {
    await releaseConnection(connectionId);
  }
}

// Query wrapper with error handling
export async function query(callback) {
  const { db, connectionId } = await getConnection();
  try {
    return await callback(db);
  } catch (error) {
    throw new DatabaseError(`Query failed: ${error.message}`, 'QUERY_ERROR');
  } finally {
    await releaseConnection(connectionId);
  }
}

// Close all database connections
export async function closeAllConnections() {
  for (const [connectionId, db] of pool.connections) {
    try {
      await db.close();
      pool.connections.delete(connectionId);
      pool.currentConnections--;
    } catch (error) {
      console.error(`Failed to close connection ${connectionId}:`, error);
    }
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  await closeAllConnections();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeAllConnections();
  process.exit(0);
}); 