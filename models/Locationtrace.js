const mongoose = require('mongoose');

// ─── Location Trace Schema ─────────────────────────────────────────────────
// Stores GPS breadcrumbs for field work steps (high write volume — separate collection)

const locationTraceSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true
  },
  stepId: {
    type: String,
    required: true   // stepSchema.stepId (string UUID)
  },
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],   // [longitude, latitude]
      required: true
    }
  },
  accuracyMeters: {
    type: Number,
    default: null
  },
  batteryLevel: {
    type: Number,   // 0–100
    default: null
  },
  recordedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: false   // recordedAt is sufficient; skip createdAt/updatedAt overhead
});

locationTraceSchema.index({ task: 1, stepId: 1, recordedAt: 1 });
locationTraceSchema.index({ employee: 1, recordedAt: -1 });
locationTraceSchema.index({ location: '2dsphere' });


// Auto-expire old traces after 90 days (optional — remove if you want permanent history)
// locationTraceSchema.index({ recordedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
const LocationTrace = mongoose.model('LocationTrace', locationTraceSchema);


// ─── Attendance Schema ─────────────────────────────────────────────────────
const attendanceSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Work date (YYYY-MM-DD stored as Date at midnight UTC)
  workDate: {
    type: Date,
    required: true
  },

  // Punch In
  punchInTime: {
    type: Date,
    default: null
  },
  punchInLocation: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: undefined
    }
  },

  // Punch Out
  punchOutTime: {
    type: Date,
    default: null
  },
  punchOutLocation: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: undefined
    }
  },

  // Derived
  totalHours: {
    type: Number,
    default: null   // Computed on punch-out
  },

  // The task that auto-triggered punch-in (if any)
  firstTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    default: null
  },

  // Manual or auto
  punchInMethod: {
    type: String,
    enum: ['manual', 'auto_task_start'],
    default: 'manual'
  },

  notes: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});


attendanceSchema.index({ employee: 1, workDate: -1 });
attendanceSchema.index({ organization: 1, workDate: -1 });
attendanceSchema.index({ employee: 1, workDate: 1 }, { unique: true });   // One record per employee per day

// Compute total hours on punch-out
attendanceSchema.methods.punchOut = async function(coordinates = null) {
  this.punchOutTime = new Date();

  if (coordinates) {
    this.punchOutLocation = { type: 'Point', coordinates };
  }

  if (this.punchInTime) {
    const diffMs = this.punchOutTime - this.punchInTime;
    this.totalHours = parseFloat((diffMs / (1000 * 60 * 60)).toFixed(2));
  }

  return await this.save();
};

const Attendance = mongoose.model('Attendance', attendanceSchema);

module.exports = { LocationTrace, Attendance };