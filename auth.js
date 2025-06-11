import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from './db.js';
import {
  authLimiter,
  signupLimiter,
  validateEmail,
  validatePassword,
  validateRequest,
  generateSecureToken,
  generateEmailVerificationToken,
  generatePasswordResetToken,
  sendVerificationEmail,
  sendPasswordResetEmail
} from './security.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

// Signup route with validation and rate limiting
router.post('/signup',
  signupLimiter,
  authLimiter,
  validateEmail,
  validatePassword,
  validateRequest,
  async (req, res) => {
    const { email, password } = req.body;

    try {
      await query(async (db) => {
        const existingUser = await db.get('SELECT id FROM users WHERE email = ?', email);
        if (existingUser) {
          return res.status(409).json({ error: 'Email already in use' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const seller_id = 'halaxa_' + generateSecureToken(9);

        await withTransaction(async (db) => {
          // Create user
          const result = await db.run(
            `INSERT INTO users (
              email, hashed_password, plan, created_at, is_email_verified
            ) VALUES (?, ?, ?, ?, ?)`,
            [email, hashedPassword, 'basic', new Date().toISOString(), false]
          );

          // Generate and store verification token
          const verificationToken = await generateEmailVerificationToken(result.lastID, email);
          await sendVerificationEmail(email, verificationToken);
        });

        return res.status(201).json({
          data: {
            message: 'User created. Please check your email for verification.',
            seller_id
          }
        });
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Login route with rate limiting
router.post('/login',
  authLimiter,
  validateEmail,
  validateRequest,
  async (req, res) => {
    const { email, password } = req.body;

    try {
      await query(async (db) => {
        const user = await db.get('SELECT * FROM users WHERE email = ?', email);

        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const passwordMatch = await bcrypt.compare(password, user.hashed_password);
        if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });

        if (!user.is_email_verified) {
          return res.status(403).json({ error: 'Please verify your email first' });
        }

        // Generate access token
        const accessToken = jwt.sign(
          { 
            id: user.id, 
            seller_id: user.id, 
            email: user.email, 
            plan: user.plan 
          },
          JWT_SECRET,
          { expiresIn: '15m' }
        );

        // Generate refresh token
        const refreshToken = generateSecureToken();
        const refreshTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await db.run(
          `INSERT INTO refresh_tokens (user_id, token, expires_at)
           VALUES (?, ?, ?)`,
          [user.id, refreshToken, refreshTokenExpiry.toISOString()]
        );

        // Update last login
        await db.run(
          'UPDATE users SET last_login_at = ? WHERE id = ?',
          [new Date().toISOString(), user.id]
        );

        res.json({
          data: {
            access_token: accessToken,
            refresh_token: refreshToken,
            seller_id: user.id,
            plan: user.plan
          }
        });
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Refresh token route
router.post('/refresh-token', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }

  try {
    await query(async (db) => {
      const tokenRecord = await db.get(
        `SELECT rt.*, u.email, u.plan 
         FROM refresh_tokens rt
         JOIN users u ON rt.user_id = u.id
         WHERE rt.token = ? AND rt.expires_at > ?`,
        [refresh_token, new Date().toISOString()]
      );

      if (!tokenRecord) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }

      // Generate new access token
      const accessToken = jwt.sign(
        {
          id: tokenRecord.user_id,
          seller_id: tokenRecord.user_id,
          email: tokenRecord.email,
          plan: tokenRecord.plan
        },
        JWT_SECRET,
        { expiresIn: '15m' }
      );

      res.json({ data: { access_token: accessToken } });
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Email verification route
router.get('/verify-email/:token', async (req, res) => {
  const { token } = req.params;

  try {
    await query(async (db) => {
      const verificationRecord = await db.get(
        `SELECT * FROM email_verification_tokens 
         WHERE token = ? AND expires_at > ?`,
        [token, new Date().toISOString()]
      );

      if (!verificationRecord) {
        return res.status(400).json({ error: 'Invalid or expired verification token' });
      }

      await withTransaction(async (db) => {
        // Mark email as verified
        await db.run(
          'UPDATE users SET is_email_verified = ? WHERE id = ?',
          [true, verificationRecord.user_id]
        );

        // Delete used token
        await db.run('DELETE FROM email_verification_tokens WHERE token = ?', [token]);
      });

      res.json({ data: { message: 'Email verified successfully' } });
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Request password reset
router.post('/request-password-reset',
  validateEmail,
  validateRequest,
  async (req, res) => {
    const { email } = req.body;

    try {
      await query(async (db) => {
        const user = await db.get('SELECT id FROM users WHERE email = ?', email);
        if (!user) {
          // Don't reveal if email exists
          return res.json({ data: { message: 'If your email is registered, you will receive a password reset link' } });
        }

        const resetToken = await generatePasswordResetToken(user.id);
        await sendPasswordResetEmail(email, resetToken);

        res.json({ data: { message: 'If your email is registered, you will receive a password reset link' } });
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Reset password
router.post('/reset-password',
  validatePassword,
  validateRequest,
  async (req, res) => {
    const { token, new_password } = req.body;

    try {
      await query(async (db) => {
        const resetRecord = await db.get(
          `SELECT * FROM password_reset_tokens 
           WHERE token = ? AND expires_at > ?`,
          [token, new Date().toISOString()]
        );

        if (!resetRecord) {
          return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        const hashedPassword = await bcrypt.hash(new_password, 10);

        await withTransaction(async (db) => {
          // Update password
          await db.run(
            'UPDATE users SET hashed_password = ? WHERE id = ?',
            [hashedPassword, resetRecord.user_id]
          );

          // Delete used token
          await db.run('DELETE FROM password_reset_tokens WHERE token = ?', [token]);

          // Invalidate all refresh tokens
          await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', [resetRecord.user_id]);
        });

        res.json({ data: { message: 'Password reset successfully' } });
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router; 