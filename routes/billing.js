'use strict';
const express        = require('express');
const crypto         = require('crypto');
const Razorpay       = require('razorpay');
const Organization   = require('../models/Organization');
const Subscription   = require('../models/Subscription');
const Plan           = require('../models/Plan');
const authMiddleware = require('../middleware/auth');
const { isManager }  = require('../middleware/roleCheck');
const { sendPaymentReceipt } = require('../utils/mailer');

const router = express.Router();

let _razorpay = null;
function getRazorpay() {
  if (!_razorpay) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
      throw new Error('Razorpay credentials not configured.');
    _razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
}

// @route   GET /api/billing/plans/public
// @desc    Public plan listing for landing page — no auth required
// @access  Public
router.get('/plans/public', async (req, res) => {
  try {
    const Plan = require('../models/Plan');
    const plans = await Plan.getActive(); // already sorted by sortOrder
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/billing/plans  (public — from DB) ────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const plans = await Plan.getActive();
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/billing/status  (manager) ───────────────────────────────────────
router.get('/status', authMiddleware, isManager, async (req, res) => {
  try {
    const org  = await Organization.findById(req.user.organization);
    await org.applyPlanExpiryIfNeeded(); // auto-downgrade to starter if plan expired
    const last = await Subscription.latestPaid(org._id);

    // ── Always resolve limits from the EFFECTIVE plan (handles trial correctly)
    const effectivePlanDoc = await Plan.getBySlug(org.effectivePlan);
    const effectiveLimits  = effectivePlanDoc
      ? {
          maxEmployees: effectivePlanDoc.maxEmployees,
          maxManagers:  effectivePlanDoc.maxManagers,
          maxRooms:     effectivePlanDoc.maxRooms,
          historyDays:  effectivePlanDoc.historyDays,
          features:     effectivePlanDoc.features,
        }
      : org.planLimits; // fallback to cached if Plan not found

    const trialDaysLeft = org.isTrialActive && org.trialEndsAt
      ? Math.max(0, Math.ceil((org.trialEndsAt - new Date()) / 86_400_000))
      : 0;

    const subscriptionDaysLeft = org.planExpiresAt
      ? Math.max(0, Math.ceil((org.planExpiresAt - new Date()) / 86_400_000))
      : 0;

    res.json({
      success: true,
      data: {
        plan:                org.plan,
        effectivePlan:       org.effectivePlan,
        isTrialActive:       org.isTrialActive,
        trialDaysLeft,
        subscriptionDaysLeft,
        trialEndsAt:         org.trialEndsAt,
        planExpiresAt:       org.planExpiresAt,
        billableSeats:       org.billableSeats,
        limits:              effectiveLimits,   // ← live from Plan model
        lastPayment: last ? {
          id:         last._id,
          amount:     last.totalAmountPaise / 100,
          status:     last.status,
          validUntil: last.validUntil,
          paidAt:     last.updatedAt,
        } : null,
      },
    });
  } catch (err) {
    console.error('billing/status:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/billing/create-order  (manager) ────────────────────────────────
router.post('/create-order', authMiddleware, isManager, async (req, res) => {
  try {
    const { plan: planSlug, billingCycle = 'monthly', billingEmail } = req.body;

    const plan = await Plan.getBySlug(planSlug);
    if (!plan)
      return res.status(400).json({ success: false, message: 'Invalid plan selected.' });
    if (plan.isContactSales)
      return res.status(400).json({ success: false, message: 'Contact sales for Enterprise pricing.' });
    if (plan.monthlyPrice === 0)
      return res.status(400).json({ success: false, message: 'This plan is free — no payment needed.' });

    const org = await Organization.findById(req.user.organization);

    // ✅ FIX: variable name matches shorthand in res.json below
    const totalAmountINR   = billingCycle === 'annual' ? plan.yearlyPrice : plan.monthlyPrice;
    const totalAmountPaise = totalAmountINR * 100;

    const order = await getRazorpay().orders.create({
      amount:   totalAmountPaise,
      currency: 'INR',
      notes: { organizationId: org._id.toString(), plan: planSlug, billingCycle },
    });

    const sub = await Subscription.create({
      organization:     org._id,
      plan:             planSlug,
      billingCycle,
      seats:            org.billableSeats || 0,
      razorpayOrderId:  order.id,
      basePricePaise:   totalAmountPaise,
      perSeatPaise:     0,
      totalAmountPaise,                                   // ✅ clean shorthand
      billingEmail:     billingEmail || org.billingEmail || org.contactEmail,
      status:           'created',
    });

    if (billingEmail)
      await Organization.findByIdAndUpdate(org._id, { billingEmail });

    res.json({
      success: true,
      data: {
        orderId:          order.id,
        subscriptionId:   sub._id,
        totalAmountPaise,                                 // ✅ no more crash
        totalAmountINR,
        razorpayKeyId:    process.env.RAZORPAY_KEY_ID,
        orgName:          org.name,
        billingEmail:     sub.billingEmail,
        planLabel:        plan.label,
        billingCycle,
      },
    });
  } catch (err) {
    console.error('billing/create-order:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/billing/verify-payment  (manager) ──────────────────────────────
router.post('/verify-payment', authMiddleware, isManager, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, subscriptionId } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !subscriptionId)
      return res.status(400).json({ success: false, message: 'Missing payment verification fields.' });

    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (expectedSig !== razorpaySignature)
      return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });

    const sub = await Subscription.findOne({ _id: subscriptionId, razorpayOrderId });
    if (!sub)
      return res.status(404).json({ success: false, message: 'Subscription record not found.' });

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

    const org = await Organization.findById(sub.organization);
    await org.upgradePlan(sub.plan, validUntil);    // syncs planLimits from Plan model

    // Send receipt — fire and forget (don't let email failure break the response)
    sendPaymentReceipt({
      to:           sub.billingEmail,
      orgName:      org.name,
      plan:         sub.plan,
      billingCycle: sub.billingCycle,
      amountINR:    sub.totalAmountPaise / 100,
      validUntil,
      paymentId:    razorpayPaymentId,
    }).catch(err => console.error('Receipt email failed:', err));  // non-fatal

    res.json({
      success: true,
      message: `Payment verified! Your org is now on the ${sub.plan} plan.`,
      data: { plan: sub.plan, validUntil, amountPaid: sub.totalAmountPaise / 100 },
    });
  } catch (err) {
    console.error('billing/verify-payment:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/billing/webhook  (Razorpay — no auth) ──────────────────────────
router.post('/webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['x-razorpay-signature'];
      const expected  = crypto
        .createHmac('sha256', webhookSecret)
        .update(req.body)
        .digest('hex');
      if (expected !== signature)
        return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    const event   = JSON.parse(req.body.toString());
    const payload = event.payload?.payment?.entity;

    if (event.event === 'payment.captured' && payload) {
      const sub = await Subscription.findOne({ razorpayOrderId: payload.order_id });
      if (sub && sub.status !== 'paid') {
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
      await Subscription.findOneAndUpdate(
        { razorpayOrderId: payload.order_id, status: 'created' },
        { status: 'failed' },
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error('billing/webhook:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/billing/history  (manager) ──────────────────────────────────────
router.get('/history', authMiddleware, isManager, async (req, res) => {
  try {
    const subs = await Subscription
      .find({ organization: req.user.organization, status: { $in: ['paid', 'failed'] } })
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({
      success: true,
      data: subs.map(s => ({
        id:           s._id,
        plan:         s.plan,
        billingCycle: s.billingCycle,
        amountINR:    s.totalAmountPaise / 100,
        status:       s.status,
        validFrom:    s.validFrom,
        validUntil:   s.validUntil,
        paidAt:       s.status === 'paid' ? s.updatedAt : null,
      })),
    });
  } catch (err) {
    console.error('billing/history:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;