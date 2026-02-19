const mongoose = require('mongoose');

// ─── Validation Config Sub-Schema ───────────────────────────────────────────

const validationConfigSchema = new mongoose.Schema({
    requireSignature: {
        type: Boolean,
        default: false
    },
    signatureFrom: {
        type: String,
        enum: ['supervisor', 'manager'],
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
        require: true,
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
    

}, {
  timestamps: true
});