'use strict';
// middleware/planGate.js

const Organization = require('../models/Organization');

// FIX: was ['starter', 'pro', 'business', 'enterprise'] — 'pro' does not exist
const PLAN_ORDER = ['starter', 'growth', 'business', 'enterprise'];

/**
 * Attach the org document (with limits synced from DB Plan) to req.org.
 * Called by every gate — not used standalone.
 */
async function attachOrg(req, res) {
  if (req.org) return req.org;

  if (!req.user?.organization) {
    res.status(401).json({ success: false, message: 'Authentication required.' });
    return null;
  }

  const org = await Organization.findById(req.user.organization);
  if (!org) {
    res.status(403).json({ success: false, message: 'Organization not found.' });
    return null;
  }

  await org.expireTrial();
  await org.applyPlanExpiryIfNeeded(); // auto-downgrade to starter if paid plan expired

  // Always sync planLimits from the DB Plan document so hasFeature() is accurate
  const Plan = require('../models/Plan');
  const effectivePlanDoc = await Plan.getBySlug(org.effectivePlan);
  if (effectivePlanDoc) {
    // Patch in-memory only (no save) — just for this request
    org.planLimits = {
      maxEmployees: effectivePlanDoc.maxEmployees,
      maxManagers:  effectivePlanDoc.maxManagers,
      maxRooms:     effectivePlanDoc.maxRooms,
      historyDays:  effectivePlanDoc.historyDays,
      features:     effectivePlanDoc.features,
    };
  }

  req.org = org;
  return org;
}

/**
 * Gate: require a specific boolean feature flag.
 * Feature keys must match exactly what is stored in Plan.features in MongoDB.
 *
 * @param {string} feature - e.g. 'liveTracking', 'exportReports', 'performanceDashboard'
 */
function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      const org = await attachOrg(req, res);
      if (!org) return;

      if (!org.hasFeature(feature)) {
        // FIX: findMinPlanForFeature is now async and queries MongoDB
        const neededPlan = await findMinPlanForFeature(feature);
        return res.status(403).json({
          success:     false,
          message:     `This feature requires the ${neededPlan} plan or higher.`,
          upgradeUrl:  '/billing',
          currentPlan: org.effectivePlan,
          neededPlan,
        });
      }

      next();
    } catch (err) {
      console.error('planGate requireFeature error:', err.message);
      res.status(500).json({ success: false, message: 'Plan check failed.' });
    }
  };
}

/**
 * Gate: require at least a certain plan tier.
 *
 * @param {string} minPlan - 'starter' | 'growth' | 'business' | 'enterprise'
 */
function requirePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const org = await attachOrg(req, res);
      if (!org) return;

      const currentIdx  = PLAN_ORDER.indexOf(org.effectivePlan);
      const requiredIdx = PLAN_ORDER.indexOf(minPlan);

      if (currentIdx < requiredIdx) {
        return res.status(403).json({
          success:     false,
          message:     `This action requires the ${minPlan} plan or higher.`,
          upgradeUrl:  '/billing',
          currentPlan: org.effectivePlan,
          neededPlan:  minPlan,
        });
      }

      next();
    } catch (err) {
      console.error('planGate requirePlan error:', err.message);
      res.status(500).json({ success: false, message: 'Plan check failed.' });
    }
  };
}

/**
 * Gate: enforce employee count limit before adding a new member.
 */
async function enforceEmployeeLimit(req, res, next) {
  try {
    const org = await attachOrg(req, res);
    if (!org) return;

    const role = req.body.role;
    if (role === 'employee' && !org.canAddEmployee()) {
      return res.status(403).json({
        success:    false,
        message:    `Your ${org.effectivePlan} plan allows a maximum of ${org.limits.maxEmployees} employees. Upgrade to add more.`,
        upgradeUrl: '/billing',
        limit:      org.limits.maxEmployees,
        current:    org.stats.totalEmployees,
      });
    }

    next();
  } catch (err) {
    console.error('enforceEmployeeLimit error:', err.message);
    res.status(500).json({ success: false, message: 'Limit check failed.' });
  }
}

/**
 * Gate: enforce room count limit before adding a new room.
 */
async function enforceRoomLimit(req, res, next) {
  try {
    const org = await attachOrg(req, res);
    if (!org) return;

    if (!org.canAddRoom()) {
      return res.status(403).json({
        success:    false,
        message:    `Your ${org.effectivePlan} plan allows a maximum of ${org.limits.maxRooms} rooms. Upgrade to add more.`,
        upgradeUrl: '/billing',
        limit:      org.limits.maxRooms,
        current:    org.stats.totalRooms,
      });
    }

    next();
  } catch (err) {
    console.error('enforceRoomLimit error:', err.message);
    res.status(500).json({ success: false, message: 'Limit check failed.' });
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────
// FIX: Was using static PLAN_LIMITS (which is commented out in Organization.js
//      and would crash). Now queries MongoDB Plan collection dynamically.
async function findMinPlanForFeature(feature) {
  const Plan = require('../models/Plan');
  const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
  for (const plan of plans) {
    if (plan.features && plan.features[feature] === true) return plan.slug;
  }
  return 'enterprise';
}

module.exports = { requireFeature, requirePlan, enforceEmployeeLimit, enforceRoomLimit };