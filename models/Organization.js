'use strict';
const mongoose = require('mongoose');

// // ─── Plan Limits Configuration ────────────────────────────────────────────────
// // Single source of truth. Import this anywhere you need to check limits.
// const PLAN_LIMITS = {
//   starter: {
//     label:              'Starter',
//     price:              0,
//     maxEmployees:       20,
//     maxRooms:           5,
//     historyDays:        7,
//     gpsTrace:           false,
//     exportReports:      false,
//     productivityScores: false,
//     perSeatPrice:       0,
//   },
//   pro: {
//     label:              'Pro',
//     price:              1499,
//     maxEmployees:       100,
//     maxRooms:           30,
//     historyDays:        90,
//     gpsTrace:           true,
//     exportReports:      true,
//     productivityScores: true,
//     perSeatPrice:       25,
//   },
//   business: {
//     label:              'Business',
//     price:              3999,
//     maxEmployees:       500,
//     maxRooms:           100,
//     historyDays:        365,
//     gpsTrace:           true,
//     exportReports:      true,
//     productivityScores: true,
//     perSeatPrice:       20,   // ₹20/seat (cheaper than Pro to reward volume)
//   },
//   enterprise: {
//     label:              'Enterprise',
//     price:              null,          // contact sales
//     maxEmployees:       Infinity,
//     maxRooms:           Infinity,
//     historyDays:        Infinity,
//     gpsTrace:           true,
//     exportReports:      true,
//     productivityScores: true,
//     perSeatPrice:       20,
//   },
// };

// ─── Schema ───────────────────────────────────────────────────────────────────
const organizationSchema = new mongoose.Schema({
  // Basic Info
  name: {
    type:      String,
    required:  [true, 'Organization name is required'],
    trim:      true,
    maxlength: [100, 'Organization name cannot exceed 100 characters'],
  },
  code: {
    type:      String,
    required:  true,
    unique:    true,
    uppercase: true,
    trim:      true,
    minlength: [3, 'Organization code must be at least 3 characters'],
  },

  // Company Details
  domain: {
    type:      String,
    trim:      true,
    lowercase: true,
    validate: {
      validator(v) {
        if (!v || v.trim() === '') return true;
        // Reject if it looks like an email
        if (v.includes('@')) return false;
        // Allow domain.com, sub.domain.com etc.
        return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(v);
      },
      message: 'Please enter a valid domain (e.g., company.com) — not an email address',
    },
  },

  // Contact Info
  contactEmail: {
    type:      String,
    required:  [true, 'Contact email is required'],
    trim:      true,
    lowercase: true,
    validate: {
      validator: v => /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(v),
      message:   'Please enter a valid email',
    },
  },
  contactPhone: {
    type: String,
    validate: {
      validator(v) {
        if (!v) return true;
        return /^[0-9]{10}$/.test(v);
      },
      message: 'Phone number must be 10 digits',
    },
  },

  // Organization Logo
  logo: { type: String, default: null },

  // Address
  address: {
    street:  String,
    city:    String,
    state:   String,
    pincode: String,
    country: { type: String, default: 'India' },
  },

  // ─── BILLING / PLAN FIELDS ────────────────────────────────────────────────
  plan: {
    type:    String,
    enum:    ['starter', 'growth', 'business', 'enterprise'],
    default: 'starter',
  },
  planExpiresAt:  { type: Date,    default: null },
  trialEndsAt: {
    type:    Date,
    default: () => { const d = new Date(); d.setDate(d.getDate() + 14); return d; },
  },
  isTrialActive:  { type: Boolean, default: true },
  billingEmail:   { type: String,  default: null },
  razorpayCustomerId: {
    type:    String,
    default: null,
  },
  // Cached billable seats (synced on member change)
  billableSeats:  { type: Number,  default: 0    },
  
  // ─────────────────────────────────────────────────────────────────────────

  // Settings & Limits (synced from plan on upgrade)
  planLimits: {
    maxEmployees:  { type: Number, default: 5  },
    maxManagers:   { type: Number, default: 1  },
    maxRooms:      { type: Number, default: 2  },
    historyDays:   { type: Number, default: 30 },
    features: {
      taskManagement:       { type: Boolean, default: true  },
      attendance:           { type: Boolean, default: true  },
      taskProofUpload:      { type: Boolean, default: true  },
      liveTracking:         { type: Boolean, default: false },
      attendanceAnalytics:  { type: Boolean, default: false },
      taskHistory:          { type: Boolean, default: false },
      notifications:        { type: Boolean, default: false },
      performanceDashboard: { type: Boolean, default: false },
      routeHistory:         { type: Boolean, default: false },
      advancedReports:      { type: Boolean, default: false },
      exportReports:        { type: Boolean, default: false },
      prioritySupport:      { type: Boolean, default: false },
      premiumAnalytics:     { type: Boolean, default: false },
    },
  },

  settings: {
    maxRooms:               { type: Number,  default: 5 },
    maxEmployees:           { type: Number,  default: 20 },
    enableLocationTracking: { type: Boolean, default: true },
  },

  // Status
  isActive:         { type: Boolean, default: true },
  isSuspended:      { type: Boolean, default: false },
  suspensionReason: { type: String,  default: null },

  // Statistics
  stats: {
    totalEmployees:      { type: Number, default: 0 },
    totalManagers:       { type: Number, default: 0 },
    totalRooms:          { type: Number, default: 0 },
    totalTasks:          { type: Number, default: 0 },
    totalTasksCompleted: { type: Number, default: 0 },
  },
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

// ─── Indexes ──────────────────────────────────────────────────────────────────
organizationSchema.index({ domain:   1 });
organizationSchema.index({ isActive: 1 });
organizationSchema.index({ plan:     1 });

// ─── Virtual: effective plan (active trial counts as Pro) ─────────────────────
organizationSchema.virtual('effectivePlan').get(function () {
  if (this.isTrialActive && this.trialEndsAt && new Date() < this.trialEndsAt)
    return 'growth';
  return this.plan;
});

// ─── Virtual: current plan limits object ──────────────────────────────────────
organizationSchema.virtual('limits').get(function () {
  return this.planLimits;
});

// ─── Statics ──────────────────────────────────────────────────────────────────
// organizationSchema.statics.PLAN_LIMITS = PLAN_LIMITS;

organizationSchema.statics.generateOrgCode = async function () {
  let code, exists = true;
  while (exists) {
    code   = 'ORG' + Math.random().toString(36).substring(2, 8).toUpperCase();
    exists = await this.findOne({ code });
  }
  return code;
};

// ─── Instance methods ─────────────────────────────────────────────────────────
organizationSchema.methods.updateStats = async function () {
  const User = mongoose.model('User');
  const Room = mongoose.model('Room');

  const [employees, managers, rooms] = await Promise.all([
    User.countDocuments({ organization: this._id, role: 'employee' }),
    User.countDocuments({ organization: this._id, role: { $in: ['manager'] } }),
    Room.countDocuments({ organization: this._id, isArchived: false }),
  ]);

  this.stats = {
    totalEmployees:      employees,
    totalManagers:       managers,
    totalRooms:          rooms,
    totalTasks:          0,
    totalTasksCompleted: 0,
  };
  this.billableSeats = employees + managers;
  return await this.save();
};

organizationSchema.methods.canAddRoom = function () {
  const max = this.planLimits?.maxRooms ?? 2;
  return max === -1 || this.stats.totalRooms < max;
};

organizationSchema.methods.canAddEmployee = function () {
  const max = this.planLimits?.maxEmployees ?? 5;
  return max === -1 || this.stats.totalEmployees < max;
};

organizationSchema.methods.canAddManager = function () {
  const max = this.planLimits?.maxManagers ?? 1;
  return max === -1 || this.stats.totalManagers < max;
};

/** Upgrade to a paid plan and sync settings limits */
organizationSchema.methods.upgradePlan = async function (newPlan, expiresAt) {
  const PlanModel = mongoose.model('Plan');
  const plan = await PlanModel.getBySlug(newPlan);
  if (!plan) throw new Error(`Unknown plan: ${newPlan}`);

  this.plan          = newPlan;
  this.planExpiresAt = expiresAt || null;
  this.isTrialActive = false;

  // Cache limits so virtuals/middleware work sync
  this.planLimits = {
    maxEmployees: plan.maxEmployees,
    maxManagers:  plan.maxManagers,
    maxRooms:     plan.maxRooms,
    historyDays:  plan.historyDays,
    features:     plan.features,
  };

  this.settings.maxEmployees = plan.maxEmployees === -1 ? 999999 : plan.maxEmployees;
  this.settings.maxRooms     = plan.maxRooms === -1     ? 999999 : plan.maxRooms;

  return this.save();
};

/** Call from a daily cron to expire trials */
organizationSchema.methods.expireTrial = async function () {
  if (this.isTrialActive && this.trialEndsAt && new Date() > this.trialEndsAt) {
    this.isTrialActive = false;
    await this.save();
  }
};

/** Feature gate check — use in planGate middleware */
organizationSchema.methods.hasFeature = function (feature) {
  return !!this.planLimits?.features?.[feature];
};

module.exports = mongoose.model('Organization', organizationSchema);
// module.exports.PLAN_LIMITS = PLAN_LIMITS;
