const express = require('express');
const Room = require('../models/Room');
const User = require('../models/User');
const Organization = require('../models/Organization');
const authMiddleware = require('../middleware/auth');
const { isManager } = require('../middleware/roleCheck');

const router = express.Router();

// @route   POST /api/rooms
// @desc    Create new room
// @access  Private (Manager or above)
router.post('/', authMiddleware, isManager, async (req, res) => {
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

    // Check if organization can add more rooms
    if (!organization.canAddRoom()) {
      return res.status(400).json({
        success: false,
        message: `Room limit reached. Your plan allows ${organization.settings.maxRooms} rooms.`
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
        maxMembers: maxMembers || 100
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
    const user = await User.findById(req.userId);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const category = req.query.category;
    const search = req.query.search || '';

    let query = {
      organization: user.organization,
      // isArchived: false,
      $or: [
        { createdBy: req.userId },
        { 'members.user': req.userId }
      ]
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

    // Add user's role in each room
    const roomsWithRole = rooms.map(room => {
      const roomObj = room.toObject();
      const member = room.members.find(m => m.user.toString() === req.userId.toString());
      roomObj.myRole = member ? member.role : (room.createdBy._id.toString() === req.userId.toString() ? 'owner' : 'none');
      roomObj.myStatus = member ? member.status : 'none';
      return roomObj;
    });

    res.json({
      success: true,
      message: 'ok',
      data: {
        rooms: roomsWithRole,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(totalRooms / limit),
          totalRooms,
          limit
        }
      }
    });

  } catch (error) {
    console.error('Get my rooms error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
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

    // Check if user has permission to update
    const isCreator = room.createdBy.toString() === req.userId.toString();
    const isAdmin = ['super_admin', 'admin'].includes(user.role);

    if (!isCreator && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this room'
      });
    }

    const { name, description, category, settings, roomImage } = req.body;

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

    // Check permission
    const isCreator = room.createdBy.toString() === req.userId.toString();
    const isAdmin = ['super_admin', 'admin'].includes(user.role);

    if (!isCreator && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only room creator or admin can delete this room'
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
      res.status(400).json({
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

    // Check if already a member
    const isMember = room.members.some(m => m.user.toString() === req.userId.toString());
    
    if (isMember) {
      return res.status(400).json({
        success: false,
        message: 'You are already a member of this room'
      });
    }

    // Add member
    await room.addMember(req.userId);

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

    // Check permission
    const isCreator = room.createdBy.toString() === req.userId.toString();
    // const isCoManager = room.coManagers.some(m => m.toString() === req.userId.toString());

    if (!isCreator) {
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

    // Check permission (can remove self or manager can remove others)
    const isSelf = userId === req.userId.toString();
    const isCreator = room.createdBy.toString() === req.userId.toString();
    // const isCoManager = room.coManagers.some(m => m.toString() === req.userId.toString());

    if (!isSelf && !isCreator) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to remove this member'
      });
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
router.get('/member/:id', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const room = await Room.findOne({
      _id: req.params.id,
      organization: user.organization
    }).populate('members.user', 'username fullName profilePicture role department isOnline lastSeen');

    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    // Check if user has access (member or manager)
    const isMember = room.members.some(m => m.user._id.toString() === req.userId.toString());
    const isCreator = room.createdBy.toString() === req.userId.toString();
    const isAdmin = ['super_admin', 'admin', 'manager'].includes(user.role);

    if (!isMember && !isCreator && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to view this room\'s members'
      });
    }

    res.json({
      success: true,
      data: {
        members: room.members,
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

module.exports = router;