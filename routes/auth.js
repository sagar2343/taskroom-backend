const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

// @route   POST /api/auth/register
// @desc    Register new user (within an organization)
// @access  Public (requires organization code)
router.post('/register', async (req, res) => {
  try {
    const { 
      username, 
      password, 
      mobile, 
      role, 
      fullName,
      email,
      employeeId,
      managerId,
      department,
      designation,
      organizationCode // Required for registration
    } = req.body;

    // Validation
    if (!username || !password || !mobile || !role) {
      return res.status(400).json({
        success: false,
        message: 'Please provide username, password, mobile, and role'
      });
    }

    // Find organization by code
    const organization = await require('../models/Organization').findOne({
      code: organizationCode.toUpperCase(),
      isActive: true
    });

    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Invalid organization code'
      });
    }

    // Check if organization can add more employees
    if (role == 'employee' && !organization.canAddEmployee()) {
      return res.status(400).json({
        success: false,
        message: 'Organization has reached maximum employee limit'
      });
    }

    // Validate role
    if (!['manager', 'employee'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role'
      });
    }

    // Check if user already exists in this organization
    const existingUser = await User.findOne({
      $or: [{ username }, { mobile }]
    });

    if (existingUser) {
      if (existingUser.username === username) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists in this organization'
        });
      }
      if (existingUser.mobile === mobile) {
        return res.status(400).json({
          success: false,
          message: 'Mobile number already registered in this organization'
        });
      }
    }

    // Check if employeeId/managerId already exists in organization
    if (role === 'employee' && employeeId) {
      const existingEmpId = await User.findOne({ 
        organization: organization._id,
        employeeId 
      });
      if (existingEmpId) {
        return res.status(400).json({
          success: false,
          message: 'Employee ID already exists'
        });
      }
    }

    if (role === 'manager' && managerId) {
      const existingMgrId = await User.findOne({ 
        organization: organization._id,
        managerId 
      });
      if (existingMgrId) {
        return res.status(400).json({
          success: false,
          message: 'Manager ID already exists'
        });
      }
    }

    // Create user object
    const userData = {
      organization: organization._id,
      username,
      password,
      mobile,
      role,
      fullName,
      email,
      department,
      designation
    };

    // Add role-specific IDs
    if (role === 'employee' && employeeId) {
      userData.employeeId = employeeId;
    }
    if (role == 'manager' && managerId) {
      userData.managerId = managerId;
    }

    // Create new user
    const user = new User(userData);
    await user.save();

    // Update organization stats
    await organization.updateStats();

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user._id,
        role: user.role,
        organizationId: organization._id
       },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const populatedUser = await User.findById(user._id).populate('organization');

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user: populatedUser,
        token
      }
    });

  } catch (error) {
    console.error('Register error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error during registration'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { username, password, organizationCode } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide username and password'
      });
    }

    // Organization code is optional for login (will find user's org)
    let query = { username };

    if (organizationCode) {
      const organization = await require('../models/Organization').findOne({
        code: organizationCode.toUpperCase() 
      });
      if (!organization) {
        return res.status(404).json({
          success: false,
          message: 'Invalid organization code'
        });
      }
      query.organization = organization._id;
    }

    // Find user
    const user = await User.findOne(query).populate('organization');
    // const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User Not found'
      });
    }

    // Check if organization is active
    if (!user.organization.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Organization is currently inactive. Please contact administrator.'
      });
    }

    // Check if organization is suspended
    if (user.organization.isSuspended) {
      return res.status(403).json({
        success: false,
        message: `Organization suspended: ${user.organization.suspensionReason || 'Contact support'}`
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update online status and last seen
    user.isOnline = true;
    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: user,
        token
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post('/logout', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);

    if (user) {
      user.isOnline = false;
      user.lastSeen = new Date();
      await user.save();
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.json({
      success: true,
      message: 'Logged out'
    });
  }
});

module.exports = router;