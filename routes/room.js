const express = require('express');
const Room = require('../models/Room');
const User = require('../models/User');
const Organization = require('../models/Organization');
const authMiddleware = require('../middleware/auth');
const { isManager } = require('../middleware/roleCheck');
const { enforceRoomLimit } = require('../middleware/planGate');
const Attendance = require('../models/Attendance');
const Task = require('../models/Task');

const router = express.Router();

// ── Permission helper ────────────────────────────────────────────────────
// Owner  = room.createdBy → "super manager", full rights on this room.
// Moderator = a manager who joined this room later ('moderator' member role)
//             → full rights EXCEPT removing the owner or other managers/
//             moderators, and cannot delete/archive the room.
function getRoomPermission(room, userId, userRole) {
  const uid = userId.toString();
  const isOwner = room.createdBy.toString() === uid;

  const member = room.members.find(m => {
    const mUserId = m.user?._id ? m.user._id.toString() : m.user.toString();
    return mUserId === uid;
  });

  const isModerator = !isOwner && userRole === 'manager' &&
    member?.role === 'moderator' && member?.status === 'active';

  return {
    isOwner,
    isModerator,
    canManage: isOwner || isModerator, // add/remove employees, edit tasks, edit room
  };
}


// @route   POST /api/rooms
// @desc    Create new room
// @access  Private (Manager or above)
router.post('/', authMiddleware, isManager, enforceRoomLimit, async (req, res) => {
  try {
    const { name, description, category, settings, maxMembers } = req.body;

    // Validation
    if (!name) {
        return res.json({
        success: false,
        message: 'Room name is required'
        });
    }

    const user = await User.findById(req.userId);
    const organization = await Organization.findById(user.organization);
    await organization.applyPlanExpiryIfNeeded(); // ensure plan is current before reading limits

    // Note: enforceRoomLimit middleware already blocked if limit reached.
    // No need to call canAddRoom() again here.

    // ── Plan-based member cap ────────────────────────────────────────────
    // A room can never hold more people than the org's plan allows in total
    // (max employees + max managers). -1 on the plan means unlimited.
    const { maxEmployees = 5, maxManagers = 1 } = organization.planLimits || {};
    const planMaxMembers = (maxEmployees === -1 || maxManagers === -1)
      ? 999999
      : maxEmployees + maxManagers;

    let resolvedMaxMembers = maxMembers ? parseInt(maxMembers, 10) : planMaxMembers;
    if (!resolvedMaxMembers || resolvedMaxMembers <= 0) resolvedMaxMembers = planMaxMembers;

    if (resolvedMaxMembers > planMaxMembers) {
      return res.status(403).json({
        success:    false,
        message:    `Your ${organization.effectivePlan} plan allows a maximum of ${planMaxMembers} members per room. Upgrade your plan to set a higher limit.`,
        upgradeUrl: '/billing',
        limit:      planMaxMembers,
      });
    }

    // Generate unique room code for this organization
    const roomCode = await Room.generateRoomCode(organization._id);

    // Create room
    const room = new Room({
      organization: organization._id,
      name,
      description,
      roomCode,
      createdBy: req.userId,
      category: category || 'other',
      settings: {
        ...settings,
        maxMembers: resolvedMaxMembers
      }
    });

    await room.save();

    // Update organization stats
    await organization.updateStats();

    res.status(201).json({
      success: true,
      message: 'Room created successfully',
      data: {
        room: {
          id: room._id,
          name: room.name,
          description: room.description,
          roomCode: room.roomCode,
          category: room.category,
          createdBy: room.createdBy,
          settings: room.settings,
          stats: room.stats,
          createdAt: room.createdAt
        }
      }
    });

  } catch (error) {
    console.error('Create room error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error while creating room'
    });
  }
});

// @route   GET /api/rooms
// @desc    Get all rooms in organization
// @access  Private
router.get('/', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const category = req.query.category;
    const search = req.query.search || '';

    // Build query
    let query = { 
      organization: user.organization,
      isArchived: false 
    };

    if (category) {
      query.category = category;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { roomCode: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }

    const totalRooms = await Room.countDocuments(query);

    const rooms = await Room.find(query)
      .populate('createdBy', 'username fullName profilePicture')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    res.json({
      success: true,
      message: 'ok',
      data: {
        rooms,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(totalRooms / limit),
          totalRooms,
          limit
        }
      }
    });

  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/rooms/my-rooms
// @desc    Get user's rooms (created or member of)
// @access  Private
router.get('/my-rooms', authMiddleware, async (req, res) => {
  try {
    const user     = await User.findById(req.userId);
    const page     = parseInt(req.query.page)  || 1;
    const limit    = parseInt(req.query.limit) || 10;
    const skip     = (page - 1) * limit;
    const category = req.query.category;
    const search   = req.query.search || '';
 
    let query = {
      organization: user.organization,
      $or: [
        { createdBy: req.userId },
        { 'members.user': req.userId }
      ]
    };
 
    if (category) query.category = category;
 
    if (search) {
      query.$or = [
        { name:     { $regex: search, $options: 'i' } },
        { roomCode: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }
 
    const totalRooms = await Room.countDocuments(query);
 
    const rooms = await Room.find(query)
      .populate('createdBy', 'username fullName profilePicture')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);
 
    // Decorate each room with the requesting user's role (unchanged)
    let roomsWithRole = rooms.map(room => {
      const roomObj    = room.toObject();
      const member     = room.members.find(
        m => m.user.toString() === req.userId.toString()
      );
      roomObj.myRole   = member
        ? member.role
        : (room.createdBy._id.toString() === req.userId.toString() ? 'owner' : 'none');
      roomObj.myStatus = member ? member.status : 'none';
      return roomObj;
    });
 
    // ── Per-room task summary (single aggregate, mutually exclusive buckets) ─
    try {
      const now     = new Date();
      const roomIds = rooms.map(r => r._id);
 
      // Employees see only their own assigned tasks.
      // Managers see tasks they created (team-level overview).
      const matchQuery = user.role === 'employee'
        ? {
            organization: user.organization,
            assignedTo:   user._id,
            room:         { $in: roomIds },
            status:       { $in: ['pending', 'in_progress'] }   // excludes completed/cancelled
          }
        : {
            organization: user.organization,
            createdBy:    user._id,
            room:         { $in: roomIds },
            status:       { $in: ['pending', 'in_progress'] }
          };
 
      const taskSummaries = await Task.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: '$room',
 
            // ── MUTUALLY EXCLUSIVE buckets ─────────────────────────────────
            //
            // overdue:    deadline has passed  (regardless of status)
            //             → highest priority, checked FIRST
            overdue: {
              $sum: {
                $cond: [
                  { $lt: ['$endDatetime', now] },   // deadline passed
                  1, 0
                ]
              }
            },
 
            // inProgress: actively running AND deadline NOT yet passed
            inProgress: {
              $sum: {
                $cond: [
                  { $and: [
                    { $eq:  ['$status', 'in_progress'] },
                    { $gte: ['$endDatetime', now] }    // still within window
                  ]},
                  1, 0
                ]
              }
            },
 
            // pending:    not yet started AND deadline NOT yet passed
            pending: {
              $sum: {
                $cond: [
                  { $and: [
                    { $eq:  ['$status', 'pending']  },
                    { $gte: ['$endDatetime', now]   }
                  ]},
                  1, 0
                ]
              }
            },
 
            total: { $sum: 1 }
          }
        }
      ]);
 
      // roomId (string) → summary object
      const summaryMap = {};
      taskSummaries.forEach(s => {
        summaryMap[s._id.toString()] = {
          inProgress: s.inProgress,
          pending:    s.pending,
          overdue:    s.overdue,
          total:      s.total
        };
      });
 
      // Inject taskSummary into every room; null when no active tasks exist
      roomsWithRole = roomsWithRole.map(room => ({
        ...room,
        taskSummary: summaryMap[room._id?.toString()] || null
      }));
 
    } catch (summaryErr) {
      // Non-fatal — a failed aggregate still returns the full room list
      console.error('Task summary aggregate failed (non-fatal):', summaryErr);
    }
    // ── End task summary ─────────────────────────────────────────────────────
 
    res.json({
      success: true,
      message: 'ok',
      data: {
        rooms: roomsWithRole,
        pagination: {
          currentPage: page,
          totalPages:  Math.ceil(totalRooms / limit),
          totalRooms,
          limit
        }
      }
    });
 
  } catch (error) {
    console.error('Get my rooms error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// @route   GET /api/rooms/:id
// @desc    Get room details
// @access  Private
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    const room = await Room.findOne({
      _id: req.params.id,
      organization: user.organization,
    })
      .populate('createdBy', 'username fullName profilePicture email')
    //   .populate('coManagers', 'username fullName profilePicture')
      .populate('members.user', 'username fullName profilePicture role department');

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    res.json({
      success: true,
      message: "ok",
      data: { room }
    });

  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/rooms/:id
// @desc    Update room
// @access  Private (Room creator or Admin)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const room = await Room.findOne({
      _id: req.params.id,
      organization: user.organization
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    // Owner (creator) or a moderator-manager who joined this room can edit it
    const { canManage } = getRoomPermission(room, req.userId, user.role);

    if (!canManage) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this room'
      });
    }

    const { name, description, category, settings, roomImage } = req.body;

    // ── Plan-based member cap on edit ──────────────────────────────────────
    if (settings && settings.maxMembers !== undefined) {
      const organization = await Organization.findById(user.organization);
      await organization.applyPlanExpiryIfNeeded();

      const { maxEmployees = 5, maxManagers = 1 } = organization.planLimits || {};
      const planMaxMembers = (maxEmployees === -1 || maxManagers === -1)
        ? 999999
        : maxEmployees + maxManagers;

      const requested = parseInt(settings.maxMembers, 10);

      if (requested > planMaxMembers) {
        return res.status(403).json({
          success:    false,
          message:    `Your ${organization.effectivePlan} plan allows a maximum of ${planMaxMembers} members per room. Upgrade your plan to increase this limit.`,
          upgradeUrl: '/billing',
          limit:      planMaxMembers,
        });
      }

      const activeMemberCount = room.members.filter(m => m.status === 'active').length;
      if (requested < activeMemberCount) {
        return res.status(400).json({
          success: false,
          message: `This room already has ${activeMemberCount} active members. Max members cannot be set lower than that.`
        });
      }
    }

    if (name) room.name = name;
    if (description) room.description = description;
    if (category) room.category = category;
    if (roomImage) room.roomImage = roomImage;
    if (settings) room.settings = { ...room.settings, ...settings };

    await room.save();

    res.json({
      success: true,
      message: 'Room updated successfully',
      data: { room }
    });

  } catch (error) {
    console.error('Update room error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/rooms/:id
// @desc    Delete/Archive room
// @access  Private (Room creator or admin)
router.patch('/archive/:id', authMiddleware, async (req, res) => {
  try {
    const { archive } = req.body;
    
    if (typeof archive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Archive flag must be true or false'
      });
    }

    const user = await User.findById(req.userId);
    const room = await Room.findOne({
      _id: req.params.id,
      organization: user.organization
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    // Check permission — only the room owner (super manager) can archive/delete
    const isCreator = room.createdBy.toString() === req.userId.toString();

    if (!isCreator) {
      return res.status(403).json({
        success: false,
        message: 'Only the room owner can archive or delete this room'
      });
    }

    // Archive instead of delete
    room.isArchived = archive;
    room.archivedAt = archive ? new Date() : null;
    await room.save();

    // Update organization stats
    const organization = await Organization.findById(user.organization);
    await organization.updateStats();

    res.json({
      success: true,
      message: archive
        ? 'Room archived successfully'
        : 'Room restored successfully'
    });

  } catch (error) {
    console.error('Delete room error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/rooms/join
// @desc    Join room using room code
// @access  Private
router.post('/join', authMiddleware, async (req, res) => {
  try {
    const { roomCode } = req.body;

    if (!roomCode) {
      return res.status(400).json({
        success: false,
        message: 'Room code is required'
      });
    }

    const user = await User.findById(req.userId);

    const room = await Room.findOne({
      organization: user.organization,
      roomCode: roomCode.toUpperCase(),
      isArchived: false
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Invalid room code'
      });
    }

    
    if (!room.settings.autoAcceptMembers && user.role === 'employee') {
      return res.status(403).json({
        success: false,
        message: 'This room requires manager approval. Please contact the room manager to be added.'
      });
    }

    // Check if already a member
    const isMember = room.members.some(m => m.user.toString() === req.userId.toString());
    
    if (isMember) {
      return res.status(400).json({
        success: false,
        message: 'You are already a member of this room'
      });
    }

    // Add member — managers joining get 'moderator' rights, employees get 'member'
    const joinRole = user.role === 'manager' ? 'moderator' : 'member';
    await room.addMember(req.userId, joinRole);

    res.json({
      success: true,
      message: 'Successfully joined the room',
      data: {
        room: {
          id: room._id,
          name: room.name,
          roomCode: room.roomCode,
          category: room.category
        }
      }
    });

  } catch(error) {
    console.error('Join room error:', error);

    if (error.message) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/rooms/addMember
// @desc    Add member to room (Manager)
// @access  Private (Room creator or co-manager)
router.post('/member/add', authMiddleware, async (req, res) => {
  try {
    const { userId, roomId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: 'Room ID is required'
      });
    }

    const currentUser = await User.findById(req.userId);
    const room = await Room.findOne({
      _id: roomId,
      organization: currentUser.organization
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    // Check permission — owner or a moderator-manager of this room can add members
    const { canManage } = getRoomPermission(room, req.userId, currentUser.role);

    if (!canManage) {
      return res.status(403).json({
        success: false,
        message: 'Only room managers can add members'
      });
    }

    // Verify user exists in same organization
    const userToAdd = await User.findOne({
      _id: userId,
      organization: currentUser.organization
    });

    if (!userToAdd) {
      return res.status(404).json({
        success: false,
        message: 'User not found in your organization'
      });
    }

    await room.addMember(userId);

    res.json({
      success: true,
      message: 'Member added successfully'
    });

  } catch (error) {
    console.error('Add member error:', error);
    
    if (error.message) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/rooms/removeMember
// @desc    Remove member from room
// @access  Private (Room creator or co-manager or self)
router.delete('/member/remove', authMiddleware, async (req, res) => {
  try {
    const { userId, roomId } = req.body;

    if (!roomId || !userId) {
      return res.status(400).json({
        success: false,
        message: 'roomId and userId are required'
      });
    }

    const currentUser = await User.findById(req.userId);

    const room = await Room.findOne({
      _id: roomId,
      organization: currentUser.organization
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    const isSelf = userId === req.userId.toString();
    const { isOwner, isModerator } = getRoomPermission(room, req.userId, currentUser.role);

    if (!isSelf && !isOwner && !isModerator) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to remove this member'
      });
    }

    // A moderator (non-owner manager) can remove employees, but NOT the owner
    // or any other manager/moderator — only the room owner can do that.
    if (!isSelf && isModerator && !isOwner) {
      const targetUser = await User.findById(userId).select('role');
      const isTargetManager = targetUser?.role === 'manager';

      if (isTargetManager) {
        return res.status(403).json({
          success: false,
          message: 'Only the room owner can remove another manager from this room'
        });
      }
    }

    await room.removeMember(userId);

    res.json({
      success: true,
      message: 'Member removed successfully'
    });

  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/rooms/member/:id
// @desc    Get room members
// @access  Private
// router.get('/member/:id', authMiddleware, async (req, res) => {
//   try {
//     const user = await User.findById(req.userId);
//     const room = await Room.findOne({
//       _id: req.params.id,
//       organization: user.organization
//     }).populate('members.user', 'username fullName profilePicture role department isOnline lastSeen');

//     if (!room) {
//       return res.status(404).json({
//         success: false,
//         message: 'Room not found'
//       });
//     }

//     // Check if user has access (member or manager)
//     const isMember = room.members.some(m => m.user._id.toString() === req.userId.toString());
//     const isCreator = room.createdBy.toString() === req.userId.toString();
//     const isAdmin = ['super_admin', 'admin', 'manager'].includes(user.role);

//     if (!isMember && !isCreator && !isAdmin) {
//       return res.status(403).json({
//         success: false,
//         message: 'You do not have access to view this room\'s members'
//       });
//     }

//     res.json({
//       success: true,
//       data: {
//         members: room.members,
//         totalMembers: room.stats.totalMembers
//       }
//     });

//   } catch (error) {
//     console.error('Get members error:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Server error'
//     });
//   }
// });
router.get('/member/:id', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    const room = await Room.findOne({
      _id: req.params.id,
      organization: user.organization
    }).populate('members.user', 'username fullName profilePicture role department lastSeen');

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    // Access check
    const isMember = room.members.some(m => m.user._id.toString() === req.userId.toString());
    const isCreator = room.createdBy.toString() === req.userId.toString();
    const isAdmin = ['super_admin', 'admin', 'manager'].includes(user.role);

    if (!isMember && !isCreator && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access'
      });
    }

    // 🟢 TODAY START
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    // Get all member IDs
    const memberIds = room.members.map(m => m.user._id);

    // Fetch today's attendance
    const attendanceRecords = await Attendance.find({
      employee: { $in: memberIds },
      workDate: { $gte: start }
    });

    // Convert to map
    const attendanceMap = {};
    attendanceRecords.forEach(a => {
      attendanceMap[a.employee.toString()] = a;
    });

    // 🔥 Merge attendance into members
    const membersWithAttendance = room.members.map(m => {
      const user = m.user;
      const attendance = attendanceMap[user._id.toString()];

      return {
        ...m.toObject(),
        user: {
          ...user.toObject(),

          // ✅ REAL ONLINE STATUS
          isOnline: attendance?.isOnline || false,

          // 💡 Extra useful fields
          totalMinutes: attendance?.totalMinutes || 0,
          sessionsCount: attendance?.sessions?.length || 0,
          lastActive:
            attendance?.sessions?.length > 0
              ? attendance.sessions[attendance.sessions.length - 1]?.endTime
              : null
        }
      };
    });

    res.json({
      success: true,
      data: {
        members: membersWithAttendance,
        totalMembers: room.stats.totalMembers
      }
    });

  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports.getRoomPermission = getRoomPermission;
module.exports = router;