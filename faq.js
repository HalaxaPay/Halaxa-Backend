import express from 'express';
import { supabase } from './supabase.js';
import { authenticateToken } from './authMiddleware.js';
import { validateRequest } from './security.js';

const router = express.Router();

// Get all FAQs
router.get('/', async (req, res) => {
  try {
    const { data: faqs, error } = await supabase
      .from('faqs')
      .select('*')
      .order('priority', { ascending: true });

    if (error) throw error;

    res.json({ faqs });
  } catch (error) {
    console.error('Error fetching FAQs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get FAQs by category
router.get('/category/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const { data: faqs, error } = await supabase
      .from('faqs')
      .select('*')
      .eq('category', category)
      .order('priority', { ascending: true });

    if (error) throw error;

    res.json({ faqs });
  } catch (error) {
    console.error('Error fetching FAQs by category:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add new FAQ (admin only)
router.post('/', async (req, res) => {
  try {
    const { category, question, answer, priority } = req.body;

    const { data: faq, error } = await supabase.from('faqs')
      .insert([{
        category,
        question,
        answer,
        priority: priority || 0
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(faq);
  } catch (error) {
    console.error('Add FAQ error:', error);
    res.status(500).json({ error: 'Failed to add FAQ' });
  }
});

// Update FAQ (admin only)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { category, question, answer, priority } = req.body;

    const { data: faq, error } = await supabase.from('faqs')
      .update({
        category,
        question,
        answer,
        priority,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(faq);
  } catch (error) {
    console.error('Update FAQ error:', error);
    res.status(500).json({ error: 'Failed to update FAQ' });
  }
});

// Delete FAQ (admin only)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from('faqs')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'FAQ deleted successfully' });
  } catch (error) {
    console.error('Delete FAQ error:', error);
    res.status(500).json({ error: 'Failed to delete FAQ' });
  }
});

export default router; 