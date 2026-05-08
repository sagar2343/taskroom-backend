'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Plan     = require('../models/Plan');

const PLANS = [
  {
    slug: 'starter', label: 'Starter', sortOrder: 0,
    monthlyPrice: 199, yearlyPrice: 1999,
    maxEmployees: 5, maxManagers: 1, maxRooms: 2, historyDays: 30,
    features: {
      taskManagement: true, attendance: true, taskProofUpload: true,
      liveTracking: false, attendanceAnalytics: false, taskHistory: false,
      notifications: false, performanceDashboard: false, routeHistory: false,
      advancedReports: false, exportReports: false,
      prioritySupport: false, premiumAnalytics: false,
    },
    featureLabels: ['Basic task management', 'Attendance tracking', 'Task proof upload'],
  },
  {
    slug: 'growth', label: 'Growth', sortOrder: 1,
    monthlyPrice: 499, yearlyPrice: 4999,
    maxEmployees: 25, maxManagers: 3, maxRooms: 10, historyDays: 90,
    features: {
      taskManagement: true, attendance: true, taskProofUpload: true,
      liveTracking: true, attendanceAnalytics: true, taskHistory: true,
      notifications: true, performanceDashboard: false, routeHistory: false,
      advancedReports: false, exportReports: false,
      prioritySupport: false, premiumAnalytics: false,
    },
    featureLabels: ['Live tracking', 'Attendance analytics', 'Task history', 'Push notifications'],
  },
  {
    slug: 'business', label: 'Business', sortOrder: 2,
    monthlyPrice: 999, yearlyPrice: 9999,
    maxEmployees: 75, maxManagers: 10, maxRooms: 30, historyDays: 365,
    features: {
      taskManagement: true, attendance: true, taskProofUpload: true,
      liveTracking: true, attendanceAnalytics: true, taskHistory: true,
      notifications: true, performanceDashboard: true, routeHistory: true,
      advancedReports: true, exportReports: true,
      prioritySupport: false, premiumAnalytics: false,
    },
    featureLabels: ['Performance dashboard', 'Route history', 'Advanced reports', 'Export PDF/Excel'],
  },
  {
    slug: 'enterprise', label: 'Enterprise', sortOrder: 3,
    isContactSales: true,
    monthlyPrice: 1999, yearlyPrice: 0, // custom — contact sales
    maxEmployees: -1, maxManagers: -1, maxRooms: -1, historyDays: -1,
    features: {
      taskManagement: true, attendance: true, taskProofUpload: true,
      liveTracking: true, attendanceAnalytics: true, taskHistory: true,
      notifications: true, performanceDashboard: true, routeHistory: true,
      advancedReports: true, exportReports: true,
      prioritySupport: true, premiumAnalytics: true,
    },
    featureLabels: ['Full custom solution', 'Priority support', 'Premium analytics', 'Unlimited everything'],
  },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  for (const data of PLANS) {
    await Plan.findOneAndUpdate({ slug: data.slug }, data, { upsert: true, new: true });
    console.log(`✓ ${data.label} seeded`);
  }
  await mongoose.disconnect();
  console.log('Done');
}

seed().catch(err => { console.error(err); process.exit(1); });