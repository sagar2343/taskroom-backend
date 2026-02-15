const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  // Organization Reference (CRITICAL for Multi-tenancy)
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: [true, 'Organization is required']
  },

  // Basic Info
  name: {
    type: String,
    required: [true, 'Room name is required'],
    trim: true,
    maxlength: [100, 'Room name cannot exceed 100 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  roomCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },

  // Room Creator/Manager
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
//   // Co-managers (optional - other managers who can manage this room)
//   coManagers: [{
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User'
//   }],

  // Room Settings
  settings: {
    isActive: {
      type: Boolean,
      default: true
    },
    autoAcceptMembers: {
      type: Boolean,
      default: false // If true, employees can join without approval
    },
    allowMembersToSeeEachOther: {
      type: Boolean,
      default: true
    },
    maxMembers: {
      type: Number,
      default: 100
    }
  },

  // Room Type/Category
  category: {
    type: String,
    enum: ['sales', 'delivery', 'inspection', 'survey', 'maintenance', 'it', 'other'],
    default: 'other'
  },

  // Members (Employees)
  members: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'inactive'],
      default: 'active'
    },
    role: {
      type: String,
      enum: ['member', 'moderator'], // Moderator can help manage
      default: 'member'
    }
  }],

  // Statistics
  stats: {
    totalMembers: {
      type: Number,
      default: 0
    },
    activeTasks: {
      type: Number,
      default: 0
    },
    completedTasks: {
      type: Number,
      default: 0
    },
    totalTasks: {
      type: Number,
      default: 0
    }
  },

  // Room Image/Icon
  roomImage: {
    type: String,
    default: null
  },

  // Archive/Delete
  isArchived: {
    type: Boolean,
    default: false
  },
  archivedAt: {
    type: Date,
    default: null
  }

}, {
  timestamps: true
});

// Indexes (UPDATED for multi-tenancy)
roomSchema.index({ organization: 1, createdBy: 1 });
roomSchema.index({ organization: 1, roomCode: 1 }, { unique: true }); // Room code unique per org
roomSchema.index({ 'members.user': 1 });
roomSchema.index({ organization: 1, isArchived: 1 });

// Generate unique room code (scoped to organization)
roomSchema.statics.generateRoomCode = async function(organizationId) {
  let code;
  let exists = true;
  
  while (exists) {
    // Generate 6 character alphanumeric code
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
    exists = await this.findOne({ organization: organizationId, roomCode: code });
  }
  
  return code;
};

// Add member to room
roomSchema.methods.addMember = async function(userId, role = 'member') {
  // Check if already a member
  const isMember = this.members.some(m => m.user.toString() === userId.toString());
  
  if (isMember) {
    throw new Error('User is already a member of this room');
  }

  // Check max members limit
  if (this.members.length >= this.settings.maxMembers) {
    throw new Error('Room has reached maximum member capacity');
  }

  this.members.push({
    user: userId,
    role: role,
    status: this.settings.autoAcceptMembers ? 'active' : 'pending'
  });

  this.stats.totalMembers = this.members.filter(m => m.status === 'active').length;
  
  return await this.save();
};

// Remove member from room
roomSchema.methods.removeMember = async function(userId) {
    this.members = this.members.filter(m => m.user.toString() !== userId.toString());
    this.stats.totalMembers = this.members.filter(m => m.status === 'active').length;
    return await this.save();
}

// Update task stats
roomSchema.methods.updateTaskStats = async function(taskStatus) {
  if (taskStatus === 'active') {
    this.stats.activeTasks += 1;
  } else if (taskStatus === 'completed') {
    this.stats.activeTasks = Math.max(0, this.stats.activeTasks - 1);
    this.stats.completedTasks += 1;
  }
  this.stats.totalTasks = this.stats.activeTasks + this.stats.completedTasks;
  return await this.save();
};

module.exports = mongoose.model('Room', roomSchema);