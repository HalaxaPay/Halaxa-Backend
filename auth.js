import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../db.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/email.js';
import crypto from 'crypto';

const router = express.Router();

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if user already exists
    const { data: existingUser, error: checkError } = await query(async (supabase) => {
      return await supabase.from('users').select('*').eq('email', email).single();
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // Create new user
    const { data: newUser, error: createError } = await query(async (supabase) => {
      return await supabase.from('users').insert([{
        email,
        hashed_password: hashedPassword,
        verification_token: verificationToken,
        is_email_verified: false
      }]).select().single();
    });

    if (createError) throw createError;

    // Send verification email
    await sendVerificationEmail(email, verificationToken);

    res.status(201).json({ message: 'Registration successful. Please check your email to verify your account.' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Get user
    const { data: user, error: userError } = await query(async (supabase) => {
      return await supabase.from('users').select('*').eq('email', email).single();
    });

    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.hashed_password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate tokens
    const accessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

    // Update user's refresh token and last login
    const { error: updateError } = await query(async (supabase) => {
      return await supabase.from('users')
        .update({ 
          refresh_token: refreshToken,
          last_login_at: new Date().toISOString()
        })
        .eq('id', user.id);
    });

    if (updateError) throw updateError;

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        isEmailVerified: user.is_email_verified
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify email
router.get('/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Find user with this verification token
    const { data: user, error: userError } = await query(async (supabase) => {
      return await supabase.from('users')
        .select('*')
        .eq('verification_token', token)
        .single();
    });

    if (userError || !user) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    // Update user's email verification status
    const { error: updateError } = await query(async (supabase) => {
      return await supabase.from('users')
        .update({ 
          is_email_verified: true,
          verification_token: null
        })
        .eq('id', user.id);
    });

    if (updateError) throw updateError;

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Email verification failed' });
  }
});

// Request password reset
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    // Find user
    const { data: user, error: userError } = await query(async (supabase) => {
      return await supabase.from('users').select('*').eq('email', email).single();
    });

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now

    // Store reset token
    const { error: tokenError } = await query(async (supabase) => {
      return await supabase.from('password_reset_tokens').insert([{
        user_id: user.id,
        token: resetToken,
        expires_at: expiresAt.toISOString()
      }]);
    });

    if (tokenError) throw tokenError;

    // Send reset email
    await sendPasswordResetEmail(email, resetToken);

    res.json({ message: 'Password reset instructions sent to your email' });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// Reset password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    // Find valid reset token
    const { data: resetToken, error: tokenError } = await query(async (supabase) => {
      return await supabase.from('password_reset_tokens')
        .select('*')
        .eq('token', token)
        .gt('expires_at', new Date().toISOString())
        .single();
    });

    if (tokenError || !resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and delete reset token
    const { error: updateError } = await withTransaction(async (supabase) => {
      // Update password
      await supabase.from('users')
        .update({ hashed_password: hashedPassword })
        .eq('id', resetToken.user_id);

      // Delete reset token
      await supabase.from('password_reset_tokens')
        .delete()
        .eq('token', token);
    });

    if (updateError) throw updateError;

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Refresh token
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // Get user
    const { data: user, error: userError } = await query(async (supabase) => {
      return await supabase.from('users')
        .select('*')
        .eq('id', decoded.userId)
        .eq('refresh_token', refreshToken)
        .single();
    });

    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Generate new access token
    const accessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.json({ accessToken });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

export default router; 