'use strict';
const mongoose = require('mongoose');

const featuresSchema = new mongoose.Schema({
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
}, { _id: false });

const planSchema = new mongoose.Schema({
  slug:          { type: String, required: true, unique: true, lowercase: true, trim: true },
  label:         { type: String, required: true },
  description:   { type: String, default: '' },
  sortOrder:     { type: Number, default: 0 },
  isActive:      { type: Boolean, default: true },
  isContactSales: { type: Boolean, default: false }, // true = Enterprise / contact us

  // ── Pricing (INR, flat rate — no per-seat) ────────────────────────────────
  monthlyPrice:  { type: Number, required: true, default: 0 }, // 0 = free
  yearlyPrice:   { type: Number, required: true, default: 0 }, // full-year lump sum

  // ── Limits (-1 = unlimited) ───────────────────────────────────────────────
  maxEmployees:  { type: Number, default: 5  },
  maxManagers:   { type: Number, default: 1  },
  maxRooms:      { type: Number, default: 2  },
  historyDays:   { type: Number, default: 30 },

  // ── Features ──────────────────────────────────────────────────────────────
  features:      { type: featuresSchema, default: () => ({}) },

  // ── Displayed as chips in the Flutter app ─────────────────────────────────
  featureLabels: [{ type: String }],

}, { timestamps: true });

planSchema.statics.getActive = function () {
  return this.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
};

planSchema.statics.getBySlug = function (slug) {
  return this.findOne({ slug, isActive: true }).lean();
};

module.exports = mongoose.model('Plan', planSchema);