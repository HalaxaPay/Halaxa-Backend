import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { supabase } from './supabase.js';

// Email validation regex
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Password validation rules
const PASSWORD_RULES = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true
};

// Email validation middleware
export const validateEmail = body('email')
  .matches(EMAIL_REGEX)
  .withMessage('Invalid email format');

// Password validation middleware
export const validatePassword = body('password')
  .isLength({ min: PASSWORD_RULES.minLength })
  .withMessage(`Password must be at least ${PASSWORD_RULES.minLength} characters`)
  .matches(/[A-Z]/)
  .withMessage('Password must contain at least one uppercase letter')
  .matches(/[a-z]/)
  .withMessage('Password must contain at least one lowercase letter')
  .matches(/[0-9]/)
  .withMessage('Password must contain at least one number')
  .matches(/[!@#$%^&*(),.?":{}|<>]/)
  .withMessage('Password must contain at least one special character');

// Request validation middleware
export const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Generate secure random token
export const generateSecureToken = (length = 32) => {
  return crypto.randomBytes(length).toString('hex');
};

// Email verification token generation and storage
export const generateEmailVerificationToken = async (userId, email) => {
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const { error } = await supabase
    .from('email_verification_tokens')
    .insert([
      {
        user_id: userId,
        token: token,
        email: email,
        expires_at: expiresAt.toISOString()
      }
    ]);

  if (error) throw error;
  return token;
};

// Password reset token generation and storage
export const generatePasswordResetToken = async (userId) => {
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

  const { error } = await supabase
    .from('password_reset_tokens')
    .insert([
      {
        user_id: userId,
        token: token,
        expires_at: expiresAt.toISOString()
      }
    ]);

  if (error) throw error;
  return token;
};

// Email sending configuration
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Send verification email
export const sendVerificationEmail = async (email, token) => {
  const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
  
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Verify your email address',
    html: `
      <h1>Email Verification</h1>
      <p>Please click the link below to verify your email address:</p>
      <a href="${verificationUrl}">${verificationUrl}</a>
      <p>This link will expire in 24 hours.</p>
    `
  });
};

// Send password reset email
export const sendPasswordResetEmail = async (email, token) => {
  const resetUrl = `${process.env.FRONTEND_URL}/PasswordReset.html?token=${token}`;
  
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Reset your password',
    html: `
      <h1>Password Reset</h1>
      <p>Please click the link below to reset your password:</p>
      <a href="${resetUrl}">${resetUrl}</a>
      <p>This link will expire in 1 hour.</p>
    `
  });
}; 