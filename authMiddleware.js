import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;

export function authenticateToken(req, res, next) {
  // DEVELOPMENT MODE: Bypass authentication when using placeholder credentials
  if (process.env.NODE_ENV === 'development' && process.env.SUPABASE_URL === 'https://placeholder.supabase.co') {
    console.log('🔧 DEVELOPMENT MODE: Bypassing authentication');
    req.user = {
      id: 'dev-user-123',
      email: 'dev@test.com',
      plan: 'basic'
    };
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    
    // 🔐 Validate Supabase Auth UUID format
    if (user.id && typeof user.id === 'string' && user.id.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) {
      console.log(`🔐 Supabase Auth UUID authenticated: ${user.id.substring(0, 8)}****`);
    } else if (user.id && user.id.length === 8) {
      console.warn(`⚠️ Legacy 8-char user ID detected: ${user.id} - needs migration to Supabase Auth`);
    } else if (user.id) {
      console.warn(`⚠️ Unknown user ID format: ${user.id}`);
    }
    
    req.user = user; // Attach user info to request
    next();
  } catch (err) {
    console.error('🔒 JWT verification error:', err.message);
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
} 