console.log('SERVER.JS: STARTING APPLICATION EXECUTION');
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import authRoutes from './Main Backend/auth.js';
import paymentRoutes from './Main Backend/payment.js';
import accountRoutes from './Main Backend/account.js';
import faqRoutes from './Main Backend/faq.js';
import { supabase } from './Main Backend/supabase.js';
import { validateEmail, validatePassword, validateRequest } from './Main Backend/security.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
const corsOptions = {
    origin: '*', // Temporarily allow all origins for testing
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// TEMPORARY CATCH-ALL ROUTE FOR DEBUGGING - MUST BE AT THE TOP
app.all('*', (req, res, next) => {
    console.log(`Received request: ${req.method} ${req.originalUrl}`);
    next(); // Pass control to the next middleware/route handler
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/faq', faqRoutes);

// Add a test endpoint
app.get('/test', (req, res) => {
    res.json({ message: 'Backend is running!' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 