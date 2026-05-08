'use strict';
// routes/admin/plans.js
// Add your own isAdmin / isSuperAdmin middleware before shipping to prod.
const express        = require('express');
const Plan           = require('../../models/Plan');
const authMiddleware = require('../../middleware/auth');

const router = express.Router();

// GET /api/admin/plans — all plans (incl. inactive)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const plans = await Plan.find().sort({ sortOrder: 1 });
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/plans — create
router.post('/', authMiddleware, async (req, res) => {
  try {
    const plan = await Plan.create(req.body);
    res.status(201).json({ success: true, data: plan });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/plans/:id — update
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const plan = await Plan.findByIdAndUpdate(
      req.params.id, req.body,
      { new: true, runValidators: true }
    );
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, data: plan });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/plans/:id — soft delete
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const plan = await Plan.findByIdAndUpdate(
      req.params.id, { isActive: false }, { new: true }
    );
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, message: `${plan.label} deactivated` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;