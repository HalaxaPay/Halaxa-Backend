import { supabase } from './supabase.js';

// Error handling class
class DatabaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

// Initialize the database (no longer needed as tables are created in Supabase)
export async function initDB() {
  console.log('Database connection verified');
  return true;
}

// Query function using Supabase
export async function query(callback) {
  try {
    return await callback(supabase);
  } catch (error) {
    throw new DatabaseError(`Query failed: ${error.message}`, 'QUERY_ERROR');
  }
}

// Transaction function using Supabase
export async function withTransaction(callback) {
  try {
    return await callback(supabase);
  } catch (error) {
    throw new DatabaseError(`Transaction failed: ${error.message}`, 'TRANSACTION_ERROR');
  }
}

// Example of how to use the new query function:
// Instead of:
// await db.get('SELECT * FROM users WHERE email = ?', email);
// Use:
// const { data, error } = await supabase.from('users').select('*').eq('email', email).single();

// Example of how to use the new transaction function:
// Instead of:
// await db.run('INSERT INTO users ...');
// Use:
// const { data, error } = await supabase.from('users').insert([{ ... }]);

// Close all database connections
export async function closeAllConnections() {
  // No need to close connections in Supabase
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