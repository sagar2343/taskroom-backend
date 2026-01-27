const express = require('express');
const Organization = require('../models/Organization');
const authMiddleware = require('../middleware/auth');
const { isManager } = require('../middleware/roleCheck');
const User = require('../models/User');


const router = express.Router();

//  @route   POST /api/organization/create
//  @desc    Create organization (Platform Owner only)
//  @access  Public (for now)
router.post('/create', async (req, res)=> {
    try {
    const {
      name,
    //code,
      domain,
      contactEmail,
      contactPhone,
      logo,
      address,
      settings,
      isActive,
      isSuspended,
      suspensionReason
    } = req.body;

    // validation 
    if (!name || !contactEmail) {
        return res.status(400).json({
        success: false,
        message: 'Organization name and contact email are required'
      });
    }

    // check if domain already exists
    if (domain) {
        const existingOrg = await Organization.findOne({domain});
        if (existingOrg) {
            return res.status(400).json({
                success: false,
                message: 'Organization with this domain already exists'
            });
        }
    }

    const code = await Organization.generateOrgCode();

    const organization = new Organization({
      name,
      code,
      domain,
      contactEmail,
      contactPhone,
      logo,
      address,
      settings,
      isActive,
      isSuspended,
      suspensionReason
    });

    await organization.save();

    res.status(201).json({
      success: true,
      message: 'Organization created successfully',
      data: organization,
      orgId: organization._id,
    });

    
    } catch (error) {
    console.error('Create organization error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }
    res.status(500).json({
      success: false,
      message: 'Server error while creating organization'
    });
  }
});

//  @route   GET /api/organization/getAll
//  @desc    Get all organizations
//  @access  Public (Owner dashboard)
router.get('/getAll', async (req, res) => {
    try {
        const organizations = await Organization.find().sort({ createdAt: -1 });

        res.json({
            success: true,
            data: organizations
        });

    } catch (error) {
    console.error('Get organization error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

//  @route   PUT /api/organization/update/:id
//  @desc    Update organization
//  @access  Public (Owner only – later protect)
router.put('/update/:id', async (req, res) => {
  try {
    const organization = await Organization.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }

    res.json({
      success: true,
      message: 'Organization updated successfully',
      data: organization
    });

  } catch (error) {
    console.error('Update organization error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});


//  @route   GET /api/organization/detail/:id
//  @desc    Get organization detail
//  @access  Public (for now)
router.get('/detail/:id', async (req, res) => {
  try {
    const organization = await Organization.findById(req.params.id);

    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }

    res.json({
      success: true,
      data: organization
    });

  } catch (error) {
    console.error('Get organization detail error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

//  @route   GET /api/organization/members
//  @desc    Get organization member list
//  @access  Private (Manager)
router.get('/members', authMiddleware, isManager, async (req, res) => {
  try {
    const organizationId = req.user.organization;

    // Query params
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const role = req.query.role; // optional filter
    const search = req.query.search || '';

    // Base query (VERY IMPORTANT)
    let query = {
      organization: organizationId
    };

    // Optional role filter
    if (role) {
      query.role = role;
    }

     // Optional search
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { fullName: { $regex: search, $options: 'i' } },
        { mobile: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { employeeId: { $regex: search, $options: 'i'}},
        { managerId: { $regex: search, $options: 'i'}}
      ];
    }

    const totalMembers = await User.countDocuments(query);

    const members = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: {
        members,
        pagination: {
          page,
          limit,
          totalMembers,
          totalPages: Math.ceil(totalMembers / limit)
        }
      }
    });

  } catch(error) {
    console.error('Get members error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching members'
    });
  }
});

module.exports = router;