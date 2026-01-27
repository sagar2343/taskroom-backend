const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({

  // Organization Reference (CRITICAL for Multi-tenancy)
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: [true, 'Organization is required']
  },

    // Basic Authentication
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [30, 'Username cannot exceed 30 characters']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters']
  },
  mobile: {
    type: String,
    required: [true, 'Mobile number is required'],
    unique: true,
    validate: {
      validator: function(v) {
        return /^[0-9]{10}$/.test(v);
      },
      message: 'Mobile number must be 10 digits'
    }
  },
  
  // User Role & Profile (Enhanced with granular roles)
  role: {
    type: String,
    enum: ['manager', 'employee'],
    required: [true, 'Role is required'],
    default: 'employee'
  },
  fullName: {
    type: String,
    trim: true,
    maxlength: [100, 'Full name cannot exceed 100 characters']
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    validate: {
      validator: function(v) {
        if (!v) return true; // Email is optional
        return /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(v);
      },
      message: 'Please enter a valid email'
    }
  },
  profilePicture: {
    type: String, // URL to profile picture
    default: null
  },
  
  // Employee Specific Fields
  employeeId: {
    type: String,
    sparse: true, // Allows null values but unique when set
    // unique: true,
    trim: true
  },

  // Manager Specific Fields
  managerId: {
    type: String,
    sparse: true,
    // unique: true,
    trim: true
  },

  // Location & Tracking
  currentLocation: {
    coordinates: {
      type: [Number], // [longitude, latitude]
      default: [0, 0]
    },
    address: {
      type: String,
      default: null
    },
    lastUpdated: {
      type: Date,
      default: null
    }
  },

  // work status
  isOnline: {
    type: Boolean,
    default: false // Currently online/offline
  },

}, {
  timestamps: true
});


// Index for faster queries (UPDATED for multi-tenancy)
userSchema.index({ organization: 1, role: 1 });
userSchema.index({ organization: 1, username: 1 }, { unique: true }); // Username unique per org
userSchema.index({ organization: 1, mobile: 1 }, { unique: true }); // Mobile unique per org
userSchema.index({ organization: 1, employeeId: 1 }, { unique: true, partialFilterExpression: {employeeId: { $exists: true }} });
userSchema.index({ organization: 1, managerId: 1 }, { unique: true, partialFilterExpression: {managerId: { $exists: true }} });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to update location
userSchema.methods.updateLocation = async function(longitude, latitude, address = null) {
  this.currentLocation = {
    coordinates: [longitude, latitude],
    address: address,
    lastUpdated: new Date()
  };
  return await this.save();
};

// Method to update online status
userSchema.methods.updateOnlineStatus = async function(isOnline) {
  this.isOnline = isOnline;
  this.lastSeen = new Date();
  return await this.save();
};

// Remove password from JSON response
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);