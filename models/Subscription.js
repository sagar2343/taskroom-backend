'use strict';
// models/Subscription.js
// Tracks every payment event from Razorpay.
// One document per subscription period (monthly/annual).

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  organization: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Organization',
    required: true,
    index:    true,
  },

  // ─── Plan info ────────────────────────────────────────────────────────────
  plan: {
    type:     String,
    enum:     ['starter', 'pro', 'business', 'enterprise'],
    required: true,
  },
  billingCycle: {
    type:    String,
    enum:    ['monthly', 'annual'],
    default: 'monthly',
  },
  seats: {
    type:    Number,
    default: 0,
  },

  // ─── Razorpay identifiers ─────────────────────────────────────────────────
  razorpayOrderId:      { type: String, default: null, index: true },
  razorpayPaymentId:    { type: String, default: null, index: true },
  razorpaySignature:    { type: String, default: null },

  // ─── Amounts (in paise, i.e. ₹ × 100) ───────────────────────────────────
  basePricePaise:    { type: Number, required: true }, // base plan price
  perSeatPaise:      { type: Number, default: 0 },     // seats × per-seat cost
  totalAmountPaise:  { type: Number, required: true }, // basePricePaise + perSeatPaise

  // ─── Status ───────────────────────────────────────────────────────────────
  status: {
    type:    String,
    enum:    ['created', 'paid', 'failed', 'refunded'],
    default: 'created',
  },

  // ─── Validity window ──────────────────────────────────────────────────────
  validFrom:  { type: Date, default: null },
  validUntil: { type: Date, default: null },

  // ─── Metadata ─────────────────────────────────────────────────────────────
  billingEmail: { type: String, default: null },
  notes:        { type: String, default: null },

}, { timestamps: true });

// Quick lookup: latest paid subscription for an org
subscriptionSchema.statics.latestPaid = function (orgId) {
  return this.findOne({ organization: orgId, status: 'paid' }).sort({ createdAt: -1 });
};

module.exports = mongoose.model('Subscription', subscriptionSchema);
