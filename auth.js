import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from './supabase.js';
import { validateEmail, validatePassword, validateRequest } from './security.js';
import crypto from 'crypto';

const router = express.Router();

// Register endpoint
router.post('/register', validateEmail, validatePassword, validateRequest, async (req, res) => {
  try {
    const { email, password, fullName } = req.body;

    let first_name = null;
    let last_name = null;

    if (fullName) {
      const nameParts = fullName.split(' ');
      first_name = nameParts[0] || null;
      last_name = nameParts.slice(1).join(' ') || null;
    }

    // Check if user already exists
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      console.error('Error checking existing user:', checkError);
      return res.status(500).json({ error: 'Error checking user existence' });
    }

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert([
        {
          email,
          password: hashedPassword,
          first_name,
          last_name,
          plan: 'basic',
          created_at: new Date().toISOString(),
          is_email_verified: true // Set to true by default for now
        }
      ])
      .select()
      .single();

    if (createError) {
      console.error('Error creating user:', createError);
      console.error('Supabase INSERT failed with message:', createError.message, 'Details:', createError.details);
      return res.status(500).json({
        error: 'Failed to create user',
        details: createError.message
      });
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { id: newUser.id, email: newUser.email },
      process.env.JWT_SECRET || 'your-temporary-secret-key', // Fallback for development
      { expiresIn: '1h' }
    );

    const refreshToken = jwt.sign(
      { id: newUser.id },
      process.env.JWT_REFRESH_SECRET || 'your-temporary-refresh-key', // Fallback for development
      { expiresIn: '7d' }
    );

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: newUser.id,
        email: newUser.email,
        first_name: newUser.first_name,
        last_name: newUser.last_name,
        plan: newUser.plan
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'An error occurred during registration',
      details: error.message
    });
  }
});

// Login endpoint
router.post('/login', validateEmail, validateRequest, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Get user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const refreshToken = jwt.sign(
      { id: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        plan: user.plan
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify email
router.get('/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Find user with this verification token
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('verification_token', token)
      .single();

    if (userError || !user) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    // Update user's email verification status
    const { error: updateError } = await supabase
      .from('users')
      .update({
        is_email_verified: true,
        verification_token: null
      })
      .eq('id', user.id);

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
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate password reset token
    const resetToken = await generatePasswordResetToken(user.id);
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    // TODO: Send password reset email
    // For now, just log the URL to the console
    console.log('Password Reset URL:', resetUrl);

    res.json({ message: 'Password reset email sent (check console for URL)' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Forgot password failed' });
  }
});

// Reset password
router.post('/reset-password', validatePassword, validateRequest, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    // Find token
    const { data: resetToken, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('token', token)
      .gte('expires_at', new Date().toISOString())
      .single();

    if (tokenError || !resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update user's password
    const { error: updateError } = await supabase
      .from('users')
      .update({ password: hashedPassword })
      .eq('id', resetToken.user_id);

    if (updateError) throw updateError;

    // Invalidate token
    const { error: invalidateError } = await supabase
      .from('password_reset_tokens')
      .update({ expires_at: new Date().toISOString() })
      .eq('id', resetToken.id);

    if (invalidateError) throw invalidateError;

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// Refresh token
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // Get user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .eq('refresh_token', refreshToken)
      .single();

    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Generate new access token
    const accessToken = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ accessToken });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

export default router; 