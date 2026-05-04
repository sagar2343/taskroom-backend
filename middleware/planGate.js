'use strict';
// middleware/planGate.js
//
// Usage in any route file:
//   const { requireFeature, requirePlan } = require('../middleware/planGate');
//
//   // Block if org doesn't have GPS trace on their plan:
//   router.get('/trace', authMiddleware, requireFeature('gpsTrace'), handler);
//
//   // Block if org is below 'pro':
//   router.get('/export', authMiddleware, requirePlan('pro'), handler);

const Organization = require('../models/Organization');
const PLAN_ORDER   = ['starter', 'pro', 'business', 'enterprise'];

/**
 * Attach the org document (with limits virtual) to req.org.
 * Called by every gate — not used standalone.
 */
async function attachOrg(req, res) {
  if (req.org) return req.org; // already attached

  if (!req.user || !req.user.organization) {
    res.status(401).json({ success: false, message: 'Authentication required.' });
    return null;
  }

  const org = await Organization.findById(req.user.organization);
  if (!org) {
    res.status(403).json({ success: false, message: 'Organization not found.' });
    return null;
  }

  // Expire trial if needed
  await org.expireTrial();

  req.org = org;
  return org;
}

/**
 * Gate: require a specific boolean feature flag.
 *
 * @param {string} feature - key in PLAN_LIMITS (e.g. 'gpsTrace', 'exportReports')
 */
function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      const org = await attachOrg(req, res);
      if (!org) return;

      if (!org.hasFeature(feature)) {
        const neededPlan = findMinPlanForFeature(feature);
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
      console.error('planGate error:', err.message);
      res.status(500).json({ success: false, message: 'Plan check failed.' });
    }
  };
}

/**
 * Gate: require at least a certain plan tier.
 *
 * @param {string} minPlan - 'starter' | 'pro' | 'business' | 'enterprise'
 */
function requirePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const org = await attachOrg(req, res);
      if (!org) return;

      const currentIdx = PLAN_ORDER.indexOf(org.effectivePlan);
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
      console.error('planGate error:', err.message);
      res.status(500).json({ success: false, message: 'Plan check failed.' });
    }
  };
}

/**
 * Gate: enforce employee count limit before adding a new member.
 * Use on /api/auth/register or wherever employees are created.
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
function findMinPlanForFeature(feature) {
  const { PLAN_LIMITS } = require('../models/Organization');
  for (const plan of PLAN_ORDER) {
    if (PLAN_LIMITS[plan] && PLAN_LIMITS[plan][feature]) return plan;
  }
  return 'enterprise';
}

module.exports = { requireFeature, requirePlan, enforceEmployeeLimit, enforceRoomLimit };
