const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  // Basic Info
  // "name": "Tech Solutions Ltd",
  // "code": "TECHSOL",
  name: {
    type: String,
    required: [true, 'Organization name is required'],
    trim: true,
    maxlength: [100, 'Organization name cannot exceed 100 characters']
  },
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    minlength: [3, 'Organization code must be at least 3 characters']
  },
  // Company Details "domain": "techsolutions.com",
  domain: {
    type: String,
    trim: true,
    lowercase: true,
    validate: {
      validator: function(v) {
        if (!v) return true; // Domain is optional
        return /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/.test(v);
      },
      message: 'Please enter a valid domain (e.g., company.com)'
    }
  },
  // Contact Info
  contactEmail: {
    type: String,
    required: [true, 'Contact email is required'],
    trim: true,
    lowercase: true,
    validate: {
      validator: function(v) {
        return /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(v);
      },
      message: 'Please enter a valid email'
    }
  },
  contactPhone: {
    type: String,
    validate: {
      validator: function(v) {
        if (!v) return true;
        return /^[0-9]{10}$/.test(v);
      },
      message: 'Phone number must be 10 digits'
    }
  },
  
  // Organization Logo
  logo: {
    type: String,
    default: null
  },

  // Address
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    country: {
      type: String,
      default: 'India'
    }
  },

  // Settings & Limits
  settings: {
    maxRooms: {
      type: Number,
      default: 50
    },
    maxEmployees: {
      type: Number,
      default: 500
    },
    enableLocationTracking: {
      type: Boolean,
      default: true
    },
  },

  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  isSuspended: {
    type: Boolean,
    default: false
  },
  suspensionReason: {
    type: String,
    default: null
  },

  // Statistics
  stats: {
    totalEmployees: {
      type: Number,
      default: 0
    },
    totalManagers: {
      type: Number,
      default: 0
    },
    totalRooms: {
      type: Number,
      default: 0
    },
    totalTasks: {
      type: Number,
      default: 0
    },
    totalTasksCompleted: {
      type: Number,
      default: 0
    }
  },
}, {
  timestamps: true
});


// Indexes
// organizationSchema.index({ code: 1 });
organizationSchema.index({ domain: 1 });
organizationSchema.index({ isActive: 1 });

// Generate unique organization code
organizationSchema.statics.generateOrgCode = async function() {
  let code;
  let exists = true;
  
  while (exists) {
    // Generate 6-8 character alphanumeric code
    code = 'ORG' + Math.random().toString(36).substring(2, 8).toUpperCase();
    exists = await this.findOne({ code });
  }
  
  return code;
};

// Update statistics
organizationSchema.methods.updateStats = async function() {
  const User = mongoose.model('User');
  const Room = mongoose.model('Room');
  // const Task = mongoose.model('Task');
  
  const employees = await User.countDocuments({ 
    organization: this._id, 
    role: 'employee',
    // isActive: true 
  });
  
  const managers = await User.countDocuments({ 
    organization: this._id, 
    role: { $in: ['manager', 'supervisor', 'admin', 'super_admin'] },
    // isActive: true
  });
  
  const rooms = await Room.countDocuments({ 
    organization: this._id,
    isArchived: false
  });
  
  // const tasks = await Task.countDocuments({ organization: this._id });
  // const completedTasks = await Task.countDocuments({ 
  //   organization: this._id, 
  //   status: 'completed' 
  // });
  
  this.stats = {
    totalEmployees: employees,
    totalManagers: managers,
    totalRooms: rooms,
    totalTasks: 0,
    totalTasksCompleted: 0
  };
  
  return await this.save();
};

// Check if organization can add more resources
organizationSchema.methods.canAddRoom = function() {
  return this.stats.totalRooms < this.settings.maxRooms;
};

organizationSchema.methods.canAddEmployee = function() {
  return this.stats.totalEmployees < this.settings.maxEmployees;
};

module.exports = mongoose.model('Organization', organizationSchema);