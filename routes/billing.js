'use strict';
// routes/billing.js
//
// Razorpay payment integration.
// Mounted at /api/billing in server.js
//
// SETUP:
//   npm install razorpay
//   Add to .env:
//     RAZORPAY_KEY_ID=rzp_live_xxxx
//     RAZORPAY_KEY_SECRET=xxxx
//     RAZORPAY_WEBHOOK_SECRET=xxxx

const express      = require('express');
const crypto       = require('crypto');
const Razorpay     = require('razorpay');
const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const authMiddleware = require('../middleware/auth');
const { isManager }  = require('../middleware/roleCheck');

const router = express.Router();

// Razorpay client (lazy init so missing env doesn't crash on import)
let _razorpay = null;
function getRazorpay() {
  if (!_razorpay) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('Razorpay credentials not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env');
    }
    _razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
}

// ─── Plan catalogue ────────────────────────────────────────────────────────────
// GET /api/billing/plans  (public)
router.get('/plans', (req, res) => {
  const { PLAN_LIMITS } = Organization;
  res.json({
    success: true,
    data: Object.entries(PLAN_LIMITS)
      .filter(([key]) => key !== 'enterprise')
      .map(([key, val]) => ({
        id:                 key,
        label:              val.label,
        priceMonthly:       val.price,
        perSeatPrice:       val.perSeatPrice,
        maxEmployees:       val.maxEmployees,
        maxRooms:           val.maxRooms,
        historyDays:        val.historyDays,
        gpsTrace:           val.gpsTrace,
        exportReports:      val.exportReports,
        productivityScores: val.productivityScores,
      })),
  });
});

// ─── Current subscription status ──────────────────────────────────────────────
// GET /api/billing/status  (manager only)
router.get('/status', authMiddleware, isManager, async (req, res) => {
  try {
    const org  = await Organization.findById(req.user.organization);
    const last = await Subscription.latestPaid(org._id);

    const trialDaysLeft = org.isTrialActive && org.trialEndsAt
      ? Math.max(0, Math.ceil((org.trialEndsAt - new Date()) / 86400000))
      : 0;

    res.json({
      success: true,
      data: {
        plan:          org.plan,
        effectivePlan: org.effectivePlan,
        isTrialActive: org.isTrialActive,
        trialDaysLeft,
        trialEndsAt:   org.trialEndsAt,
        planExpiresAt: org.planExpiresAt,
        billableSeats: org.billableSeats,
        limits:        org.limits,
        lastPayment:   last ? {
          id:          last._id,
          amount:      last.totalAmountPaise / 100,
          status:      last.status,
          validUntil:  last.validUntil,
          paidAt:      last.updatedAt,
        } : null,
      },
    });
  } catch (err) {
    console.error('billing/status error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Create Razorpay order ─────────────────────────────────────────────────────
// POST /api/billing/create-order  (manager only)
// Body: { plan: 'pro'|'business', billingCycle: 'monthly'|'annual', billingEmail }
router.post('/create-order', authMiddleware, isManager, async (req, res) => {
  try {
    const { plan, billingCycle = 'monthly', billingEmail } = req.body;
    const { PLAN_LIMITS } = Organization;

    if (!plan || !PLAN_LIMITS[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan selected.' });
    }
    if (plan === 'starter') {
      return res.status(400).json({ success: false, message: 'Starter is free — no payment needed.' });
    }

    const org    = await Organization.findById(req.user.organization);
    const limits = PLAN_LIMITS[plan];

    // Base price (monthly or annual with 20% discount)
    const baseMonthly  = limits.price;
    const months       = billingCycle === 'annual' ? 12 : 1;
    const discount     = billingCycle === 'annual' ? 0.8 : 1;
    const baseAmount   = Math.round(baseMonthly * months * discount);

    // Per-seat charge
    const seats        = org.billableSeats || 0;
    const perSeatMonthly = limits.perSeatPrice * seats;
    const perSeatTotal = Math.round(perSeatMonthly * months * discount);

    const totalAmount  = baseAmount + perSeatTotal;
    const totalPaise   = totalAmount * 100; // Razorpay expects paise

    // Create Razorpay order
    const order = await getRazorpay().orders.create({
      amount:   totalPaise,
      currency: 'INR',
      notes: {
        organizationId: org._id.toString(),
        plan,
        billingCycle,
        seats,
      },
    });

    // Persist subscription record (status: created)
    const sub = await Subscription.create({
      organization:    org._id,
      plan,
      billingCycle,
      seats,
      razorpayOrderId: order.id,
      basePricePaise:  baseAmount * 100,
      perSeatPaise:    perSeatTotal * 100,
      totalAmountPaise: totalPaise,
      billingEmail:    billingEmail || org.billingEmail || org.contactEmail,
      status:          'created',
    });

    // Update billing email on org
    if (billingEmail) {
      await Organization.findByIdAndUpdate(org._id, { billingEmail });
    }

    res.json({
      success: true,
      data: {
        orderId:          order.id,
        subscriptionId:   sub._id,
        totalAmountPaise,
        totalAmountINR:   totalAmount,
        razorpayKeyId:    process.env.RAZORPAY_KEY_ID,
        orgName:          org.name,
        billingEmail:     sub.billingEmail,
        breakdown: {
          basePlan:   baseAmount,
          perSeat:    perSeatTotal,
          seats,
          billingCycle,
          discount:   billingCycle === 'annual' ? '20%' : null,
        },
      },
    });
  } catch (err) {
    console.error('billing/create-order error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Verify payment after Razorpay checkout ────────────────────────────────────
// POST /api/billing/verify-payment  (manager only)
// Body: { razorpayOrderId, razorpayPaymentId, razorpaySignature, subscriptionId }
router.post('/verify-payment', authMiddleware, isManager, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, subscriptionId } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !subscriptionId) {
      return res.status(400).json({ success: false, message: 'Missing payment verification fields.' });
    }

    // Verify signature
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (expectedSig !== razorpaySignature) {
      return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
    }

    // Find and update subscription record
    const sub = await Subscription.findOne({ _id: subscriptionId, razorpayOrderId });
    if (!sub) {
      return res.status(404).json({ success: false, message: 'Subscription record not found.' });
    }

    // Compute validity window
    const now        = new Date();
    const months     = sub.billingCycle === 'annual' ? 12 : 1;
    const validUntil = new Date(now);
    validUntil.setMonth(validUntil.getMonth() + months);

    sub.razorpayPaymentId = razorpayPaymentId;
    sub.razorpaySignature = razorpaySignature;
    sub.status            = 'paid';
    sub.validFrom         = now;
    sub.validUntil        = validUntil;
    await sub.save();

    // Upgrade org plan
    const org = await Organization.findById(sub.organization);
    await org.upgradePlan(sub.plan, validUntil);

    res.json({
      success: true,
      message: `🎉 Payment verified! Your organization is now on the ${sub.plan} plan.`,
      data: {
        plan:        sub.plan,
        validUntil,
        amountPaid:  sub.totalAmountPaise / 100,
      },
    });
  } catch (err) {
    console.error('billing/verify-payment error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Razorpay Webhook (server-side confirmation) ───────────────────────────────
// POST /api/billing/webhook  (no auth — verified by signature)
// In Razorpay dashboard: set webhook URL to https://yourserver.com/api/billing/webhook
// NOTE: express.raw() for this route is applied globally in server.js
// Do NOT add express.raw() here — it would double-buffer the body.
router.post('/webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.warn('RAZORPAY_WEBHOOK_SECRET not set — skipping webhook signature check');
    } else {
      const signature = req.headers['x-razorpay-signature'];
      const expected  = crypto
        .createHmac('sha256', webhookSecret)
        .update(req.body)
        .digest('hex');

      if (expected !== signature) {
        return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
      }
    }

    const event   = JSON.parse(req.body.toString());
    const payload = event.payload?.payment?.entity;

    if (event.event === 'payment.captured' && payload) {
      const orderId = payload.order_id;
      const sub     = await Subscription.findOne({ razorpayOrderId: orderId });

      if (sub && sub.status !== 'paid') {
        // Idempotent: mark paid if not already done via verify-payment
        const now        = new Date();
        const months     = sub.billingCycle === 'annual' ? 12 : 1;
        const validUntil = new Date(now);
        validUntil.setMonth(validUntil.getMonth() + months);

        sub.razorpayPaymentId = payload.id;
        sub.status            = 'paid';
        sub.validFrom         = now;
        sub.validUntil        = validUntil;
        await sub.save();

        const org = await Organization.findById(sub.organization);
        if (org) await org.upgradePlan(sub.plan, validUntil);
      }
    }

    if (event.event === 'payment.failed' && payload) {
      const orderId = payload.order_id;
      await Subscription.findOneAndUpdate(
        { razorpayOrderId: orderId, status: 'created' },
        { status: 'failed' }
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error('billing/webhook error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Payment history ───────────────────────────────────────────────────────────
// GET /api/billing/history  (manager only)
router.get('/history', authMiddleware, isManager, async (req, res) => {
  try {
    const subs = await Subscription.find({ organization: req.user.organization })
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({
      success: true,
      data: subs.map(s => ({
        id:           s._id,
        plan:         s.plan,
        billingCycle: s.billingCycle,
        seats:        s.seats,
        amountINR:    s.totalAmountPaise / 100,
        status:       s.status,
        validFrom:    s.validFrom,
        validUntil:   s.validUntil,
        paidAt:       s.status === 'paid' ? s.updatedAt : null,
      })),
    });
  } catch (err) {
    console.error('billing/history error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
