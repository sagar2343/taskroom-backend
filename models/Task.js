const mongoose = require('mongoose');

// ─── Validation Config Sub-Schema ───────────────────────────────────────────

const validationConfigSchema = new mongoose.Schema({
    requireSignature: {
        type: Boolean,
        default: false
    },
    signatureFrom: {
        type: String,
        enum: ['customer', 'supervisor', 'manager'],
        default: null
    },
    requirePhoto: {
        type: Boolean,
        default: false
    },
    requireLocationCheck: {
        type: Boolean,
        default: false
    },
    requireLocationTrace: {
        type: Boolean,
        default: false
    }
}, { _id: false });


// ─── Step Sub-Schema (Embedded in Task) ─────────────────────────────────────

const stepSchema = new mongoose.Schema({
    stepId: {
        type: String,
        required: true,
        default: () => new mongoose.Types.ObjectId().toString()
    },
    order: {
        type: Number,
        required: true
    },
    title: {
        type: String,
        required: [true, 'Step title is required'],
        trim: true,
        maxlength: [80, 'Step title cannot exceed 80 characters']
    },
    description: {
        type: String, 
        trim: true,
        maxlength: [500, 'Step description cannot exceed 500 characters']
    },

    // Timing
    startDatetime: {
        type: Date,
        required: [true, 'Step start time is required']
    },
    endDatetime: {
        type: Date,
        required: [true, 'Step end time is required']
    },

    // Field Work
    isFieldWorkStep: {
        type: Boolean,
        default: false
    },
    destinationLocation: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            default: undefined
        },
        address: {
            type: String,
            default: null
        }
    },
    locationRadiusMeters: {
        type: Number,
        default: 50,
        min: [10, 'Radius must be at least 10 metres'],
        max: [5000, 'Radius cannot exceed 5000 metres']
    },

    // Validation Requirements
    validations: {
        type: validationConfigSchema,
        default: ()=> ({})
    },

    // Step Status
    status: {
        type: String,
        enum: ['pending', 'in_progress', 'travelling', 'reached', 'completed', 'skipped'],
        default: 'pending'
    },

    // Employee Timestamps
    employeeStartTime: {
        type: Date,
        default: null
    },
    employeeReachTime: {
        type: Date,
        default: null   // Field work only — when Reached was tapped
    },
    employeeCompleteTime: {
        type: Date,
        default: null
    },

    
    // Submission Data (filled by employee on completion)
    submittedPhotoUrl: {
        type: String,
        default: null
    },
    submittedLocation: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number],
            default: undefined
        },
        accuracyMeters: {
            type: Number,
            default: null
        }
    },
    signatureData: {
        type: String,   // base64 or S3 URL
        default: null
    },
    signatureSignedBy: {
        type: String,
        default: null
    },
    signatureRole: {
        type: String,
        enum: ['customer', 'supervisor', 'manager', null],
        default: null
    },
    employeeNotes: {
        type: String,
        trim: true,
        maxlength: [500, 'Notes cannot exceed 500 characters'],
        default: null
    },

    // Overdue flag (set when submitted after endDatetime)
    isOverdue: {
        type: Boolean,
        default: false
    },


    // Edit tracking (if manager edits after employee starts)
    lastEditedAt: {
        type: Date,
        default: null
    },
    editedWhileActive: {
        type: Boolean,
        default: false
    }
}, { _id: false });


// ─── Task Schema ─────────────────────────────────────────────────────────────
const taskSchema = new mongoose.Schema({
    // Multi-tenancy
    organization: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Organization',
        required: [true, 'Organization is required']
    },

    // Room reference (tasks live inside rooms)
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: [true, 'Room is required']  
    },

    // People
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Task must be assigned to an employee']
    },

    // Task Details
    title: {
        type: String,
        required: [true, 'Task title is required'],
        trim: true,
        maxlength: [100, 'Task title cannot exceed 100 characters']
    },
    note: {
        type: String,
        trim: true,
        maxlength: [1000, 'Note cannot exceed 1000 characters']
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high'],
        default: 'medium'
    },

    // Timing
    startDatetime: {
        type: Date,
        required: [true, 'Task start time is required']
    },
    endDatetime: {
        type: Date,
        required: [true, 'Task end time is required']
    },

    // Field Work Mode (global toggle — when true all steps default to field work)
    isFieldWork: {
        type: Boolean,
        default: false
    },

    // Steps (ordered, embedded)
    steps: {
        type: [stepSchema],
        validate: {
            validator: function(steps) {
                return steps && steps.length >= 1;
            },
            message: 'Task must have at least one step'
        }
    },

    // Progress tracking
    currentStepIndex: {
        type: Number,
        default: 0
    },
    totalSteps: {
        type: Number,
        default: 0
    },
    completedSteps: {
        type: Number,
        default: 0
    },

    // Task Status
    status: {
        type: String,
        enum: ['pending', 'in_progress', 'completed', 'overdue', 'cancelled'],
        default: 'pending'
    },

    // Timestamps
    employeeStartTime: {
        type: Date,
        default: null   // When employee first started the task
    },
    completedAt: {
        type: Date,
        default: null
    },
    cancelledAt: {
        type: Date,
        default: null
    },
    cancelledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    cancellationReason: {
        type: String,
        default: null
    },

    // Edit tracking
    lastEditedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    lastEditedAt: {
        type: Date,
        default: null
    },
    editedWhileActive: {
        type: Boolean,
        default: false  // True if manager edited after employee started
    },

    // Used for group task (Multiple employee)
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null   // null = solo task, set = part of a group
    },
    isGroupTask: {
        type: Boolean,
        default: false
    }

}, {
  timestamps: true
});

// ─── Indexes ──────────────────────────────────────────────────────────────────
taskSchema.index({ organization: 1, assignedTo: 1, status: 1});
taskSchema.index({ organization: 1, createdBy: 1, status: 1 });
taskSchema.index({ organization: 1, room: 1 });
taskSchema.index({ organization: 1, startDatetime: 1 });
taskSchema.index({ assignedTo: 1, startDatetime: 1, status: 1 });
taskSchema.index({ groupId: 1 });


// ─── Pre-save: sync computed fields ──────────────────────────────────────────
taskSchema.pre('save', function(next) {
    if (this.steps) {
        this.totalSteps = this.steps.length;
        this.completedSteps = this.steps.filter(s => s.status === 'completed').length;

        // Keep currentStepIndex pointing to first non-completed step
        const firstPendingIdx = this.steps.findIndex(
            s => !['completed', 'skipped'].includes(s.status)
        );
        this.currentStepIndex = firstPendingIdx === -1 ? this.steps.length - 1 : firstPendingIdx;
    }
    next();
});


// ─── Instance Methods ─────────────────────────────────────────────────────────

// Check if all steps are done
taskSchema.methods.allStepsCompleted = function() {
  return this.steps.every(s => ['completed', 'skipped'].includes(s.status));
};

// Get active step
taskSchema.methods.getActiveStep = function() {
  return this.steps.find(s => s.status === 'in_progress' || s.status === 'travelling' || s.status === 'reached') || null;
};


// Get step by stepId
taskSchema.methods.getStep = function(stepId) {
  return this.steps.find(s => s.stepId === stepId) || null;
};

// Validate step submission (check all required validations are met)
taskSchema.methods.validateStepSubmission = function(stepId, submissionData) {
  const step = this.getStep(stepId);
  if (!step) return { valid: false, message: 'Step not found' };

  const { validations } = step;
  const { photoUrl, signatureData, currentLocation } = submissionData;

  if (validations.requirePhoto && !photoUrl) {
    return { valid: false, message: 'Photo is required to complete this step' };
  }

  if (validations.requireSignature && !signatureData) {
    return { valid: false, message: `Signature from ${validations.signatureFrom || 'required party'} is required` };
  }

  if (validations.requireLocationCheck) {
    if (!currentLocation || !currentLocation.coordinates) {
      return { valid: false, message: 'Location data is required to complete this step' };
    }

    // Check if field work step requires reaching destination first
    if (step.isFieldWorkStep && step.status !== 'reached' && step.status !== 'in_progress') {
      return { valid: false, message: 'You must reach the destination before completing this step' };
    }

    // If destination set, validate radius
    if (step.isFieldWorkStep && step.destinationLocation && step.destinationLocation.coordinates) {
      const distance = getDistanceMeters(
        currentLocation.coordinates,
        step.destinationLocation.coordinates
      );
      if (distance > step.locationRadiusMeters) {
        return {
          valid: false,
          message: `You are ${Math.round(distance)}m away from the destination. You must be within ${step.locationRadiusMeters}m.`,
          distance: Math.round(distance)
        };
      }
    }
  }

  return { valid: true };
};


// ─── Static Methods ──────────────────────────────────────────────────────────

// Get dashboard summary for a manager
taskSchema.statics.getManagerSummary = async function(managerId, organizationId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [statusCounts, todayTasks] = await Promise.all([
    this.aggregate([
      { $match: { createdBy: managerId, organization: organizationId } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    this.countDocuments({
      createdBy: managerId,
      organization: organizationId,
      startDatetime: { $gte: today, $lt: tomorrow }
    })
  ]);

  const summary = { pending: 0, in_progress: 0, completed: 0, overdue: 0, cancelled: 0, today: todayTasks };
  statusCounts.forEach(s => { summary[s._id] = s.count; });
  return summary;
};

// ─── Haversine helper ─────────────────────────────────────────────────────────
function getDistanceMeters([lng1, lat1], [lng2, lat2]) {
  const R = 6371000; // metres
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = mongoose.model('Task', taskSchema);
module.exports.getDistanceMeters = getDistanceMeters;