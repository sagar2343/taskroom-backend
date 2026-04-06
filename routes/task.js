const express = require('express');
const mongoose = require('mongoose');
const Task = require('../models/Task');
const { LocationTrace, Attendance } = require('../models/Locationtrace');
const Room = require('../models/Room');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const { isManager } = require('../middleware/roleCheck');
const { getDistanceMeters } = require('../models/Task');

const router = express.Router();

router.use(authMiddleware);

// ═══════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const getTodayRange = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
};

const findTaskForManager = async (taskId, managerId, organizationId) => {
  return Task.findOne({
    _id: taskId,
    organization: organizationId,
    createdBy: managerId
  });
};

const findTaskForEmployee = async (taskId, employeeId, organizationId) => {
  return Task.findOne({
    _id: taskId,
    organization: organizationId,
    assignedTo: employeeId
  });
};

// ═══════════════════════════════════════════════════════════════════════
//  MANAGER ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ─── POST /api/tasks ── Manager: Create Task ──────────────────────────
router.post('/', isManager, async (req, res) => {
  try {
    const {
      roomId, assignedTo, title, note, priority,
      startDatetime, endDatetime, isFieldWork, steps
    } = req.body;

    if (!roomId || !assignedTo || !title || !startDatetime || !endDatetime || !steps) {
      return res.status(400).json({
        success: false,
        message: 'roomId, assignedTo, title, startDatetime, endDatetime, and steps are required'
      });
    }

    if (!isValidObjectId(roomId)) {
      return res.status(400).json({ success: false, message: 'Invalid roomId' });
    }

    if (!Array.isArray(assignedTo) || assignedTo.length === 0) {
      return res.status(400).json({ success: false, message: 'assignedTo must be a non-empty array of employee IDs' });
    }

    const invalidIds = assignedTo.filter(id => !isValidObjectId(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ success: false, message: `Invalid employee ID(s): ${invalidIds.join(', ')}` });
    }

    const start = new Date(startDatetime);
    const end = new Date(endDatetime);
    if (end <= start) {
      return res.status(400).json({ success: false, message: 'End datetime must be after start datetime' });
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one step is required' });
    }

    const room = await Room.findOne({
      _id: roomId,
      organization: req.user.organization,
      isArchived: false
    });
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    if (room.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only create tasks in rooms you manage'
      });
    }

    const nonMembers = assignedTo.filter(empId =>
      !room.members.some(m => m.user.toString() === empId && m.status === 'active')
    );
    if (nonMembers.length > 0) {
      return res.status(400).json({
        success: false,
        message: `These employees are not active members of this room: ${nonMembers.join(', ')}`
      });
    }

    const builtSteps = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];

      if (!s.title || !s.startDatetime || !s.endDatetime) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: title, startDatetime, and endDatetime are required`
        });
      }

      const stepStart = new Date(s.startDatetime);
      const stepEnd = new Date(s.endDatetime);

      if (stepEnd <= stepStart) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: End datetime must be after start datetime`
        });
      }

      if (stepEnd > end) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: Step end time cannot exceed task end time`
        });
      }

      const requireLocationCheck = s.validations?.requireLocationCheck || false;
      const hasDestination = !!(
        s.destinationLocation &&
        Array.isArray(s.destinationLocation.coordinates) &&
        s.destinationLocation.coordinates.length === 2
      );

      if (requireLocationCheck && !hasDestination) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: A destination pin is required when Destination Check is enabled`
        });
      }

      const isFieldStep = requireLocationCheck && hasDestination;

      // Radius validation
      if (requireLocationCheck && s.locationRadiusMeters) {
        if (s.locationRadiusMeters < 10 || s.locationRadiusMeters > 5000) {
          return res.status(400).json({
            success: false,
            message: `Step ${i + 1}: Location radius must be between 10 and 5000 metres`
          });
        }
      }

      // Signature validation
      if (s.validations?.requireSignature && !s.validations?.signatureFrom) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: Signature source (customer/supervisor/manager) is required`
        });
      }

      builtSteps.push({
        stepId: new mongoose.Types.ObjectId().toString(),
        order: i + 1,
        title: s.title,
        description: s.description || null,
        startDatetime: stepStart,
        endDatetime: stepEnd,

        isFieldWorkStep: isFieldStep,
        destinationLocation: isFieldStep ? {
          type: 'Point',
          coordinates: s.destinationLocation.coordinates,
          address: s.destinationLocation.address || null
        } : undefined,
        locationRadiusMeters: s.locationRadiusMeters || 100,

        validations: {
          requireSignature: s.validations?.requireSignature || false,
          signatureFrom: s.validations?.signatureFrom || null,
          requirePhoto: s.validations?.requirePhoto || false,
          requireLocationCheck: requireLocationCheck,
          requireLocationTrace: !!(s.validations?.requireLocationTrace || isFieldWork)
        }
      });
    }

    const isGroup = assignedTo.length > 1;
    const groupId = isGroup ? new mongoose.Types.ObjectId() : null;

    const taskDocs = assignedTo.map(empId => ({
      organization: req.user.organization,
      room: roomId,
      createdBy: req.userId,
      assignedTo: empId,
      title,
      note: note || null,
      priority: priority || 'medium',
      startDatetime: start,
      endDatetime: end,
      isFieldWork: isFieldWork || false,
      steps: builtSteps,
      groupId,
      isGroupTask: isGroup
    }));

    const createdTasks = await Task.insertMany(taskDocs);

    await Room.findByIdAndUpdate(roomId, {
      $inc: {
        'stats.totalTasks': createdTasks.length,
        'stats.activeTasks': createdTasks.length
      }
    });

    const populatedTasks = await Task.find({
      _id: { $in: createdTasks.map(t => t._id) }
    })
      .populate('assignedTo', 'username fullName profilePicture employeeId')
      .populate('createdBy', 'username fullName')
      .populate('room', 'name roomCode');

    return res.status(201).json({
      success: true,
      message: isGroup
        ? `Group task created and assigned to ${assignedTo.length} employees`
        : 'Task created successfully',
      data: {
        tasks: populatedTasks,
        task: populatedTasks[0],
        groupId,
        isGroupTask: isGroup,
        totalAssigned: assignedTo.length
      }
    });

  } catch (error) {
    console.error('Create task error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }
    res.status(500).json({ success: false, message: 'Server error while creating task' });
  }
});

// ─── GET /api/tasks ── Manager: List their tasks ──────────────────────
// Query params: ?status=pending|in_progress|completed|overdue|cancelled|missed
//               &priority=high|medium|low &roomId=... &assignedTo=... &date=YYYY-MM-DD
router.get('/', isManager, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const { status, assignedTo, roomId, priority, date } = req.query;

    let query = {
      organization: req.user.organization,
      createdBy: req.userId
    };

    if (status === 'missed') {
      query.endDatetime = { $lt: new Date() };
      query.status = { $in: ['pending', 'in_progress'] };
    } else if (status) {
      query.status = status;
    }

    if (assignedTo && isValidObjectId(assignedTo)) query.assignedTo = assignedTo;
    if (roomId && isValidObjectId(roomId)) query.room = roomId;
    if (priority) query.priority = priority;

    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      query.startDatetime = { $gte: d, $lt: next };
    }

    const [tasks, total] = await Promise.all([
      Task.find(query)
        .populate('assignedTo', 'username fullName profilePicture isOnline')
        .populate('room', 'name roomCode')
        .sort({ startDatetime: -1 })
        .skip(skip)
        .limit(limit),
      Task.countDocuments(query)
    ]);

    res.json({
      success: true,
      message: 'ok',
      data: {
        tasks,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          total,
          limit
        }
      }
    });

  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/tasks/active-status
// Called by the employee app on splash / home screen.
// Lightweight — no populate, no heavy queries.
router.get('/active-status', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }
 
    // Find the ONE in_progress task for this employee
    const task = await Task.findOne({
      organization: req.user.organization,
      assignedTo:   req.userId,
      status:       'in_progress'
    }).select('_id room isFieldWork steps');
 
    if (!task) {
      return res.json({
        success: true,
        data: { hasActiveTask: false, taskId: null, stepId: null, requiresTracking: false, roomId: null }
      });
    }
 
    // Find the active step (in_progress / travelling / reached)
    const activeStep = task.steps.find(s =>
      ['in_progress', 'travelling', 'reached'].includes(s.status)
    );
 
    return res.json({
      success: true,
      data: {
        hasActiveTask:    true,
        taskId:           task._id.toString(),
        stepId:           activeStep?.stepId ?? null,
        requiresTracking: task.isFieldWork === true,
        roomId:           task.room.toString(),
      }
    });
 
  } catch (err) {
    console.error('active-status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// ─── GET /api/tasks/dashboard ── Manager: Dashboard summary ──────────
router.get('/dashboard', isManager, async (req, res) => {
  try {
    const orgId = req.user.organization;
    const managerId = req.userId;
    const { start, end } = getTodayRange();

    const [statusBreakdown, missedCount, todayTasks, employeeActivity] = await Promise.all([
      Task.aggregate([
        { $match: { organization: orgId, createdBy: managerId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Task.countDocuments({
        organization: orgId,
        createdBy: managerId,
        endDatetime: { $lt: new Date() },
        status: { $in: ['pending', 'in_progress'] }
      }),
      Task.find({
        organization: orgId,
        createdBy: managerId,
        startDatetime: { $gte: start, $lt: end }
      })
        .populate('assignedTo', 'username fullName profilePicture isOnline')
        .populate('room', 'name roomCode')
        .sort({ startDatetime: 1 })
        .limit(20),
      Task.aggregate([
        {
          $match: {
            organization: orgId,
            createdBy: managerId,
            status: { $in: ['in_progress', 'pending'] },
            startDatetime: { $gte: start, $lt: end }
          }
        },
        {
          $group: {
            _id: '$assignedTo',
            activeTask: { $first: '$title' },
            taskStatus: { $first: '$status' },
            isFieldWork: { $first: '$isFieldWork' }
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'employee'
          }
        },
        { $unwind: '$employee' },
        {
          $project: {
            'employee.username': 1,
            'employee.fullName': 1,
            'employee.profilePicture': 1,
            'employee.isOnline': 1,
            activeTask: 1,
            taskStatus: 1,
            isFieldWork: 1
          }
        }
      ])
    ]);

    const summary = { pending: 0, in_progress: 0, completed: 0, overdue: 0, cancelled: 0, missed: 0 };
    statusBreakdown.forEach(s => { summary[s._id] = s.count; });
    summary.missed = missedCount;

    res.json({
      success: true,
      message: 'ok',
      data: { summary, todayTasks, employeeActivity }
    });

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/tasks/detail ── Get task detail (taskId in body) ───────
router.post('/detail', async (req, res) => {
  try {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId is required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    let query = { _id: taskId, organization: req.user.organization };
    if (req.user.role === 'manager') {
      query.createdBy = req.userId;
    } else {
      query.assignedTo = req.userId;
    }

    const task = await Task.findOne(query)
      .populate('assignedTo', 'username fullName profilePicture employeeId isOnline')
      .populate('createdBy', 'username fullName profilePicture')
      .populate('room', 'name roomCode category');

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    res.json({ success: true, message: 'ok', data: { task } });

  } catch (error) {
    console.error('Get task detail error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/tasks/edit ── Manager: Edit task (taskId in body) ───────
router.put('/edit', isManager, async (req, res) => {
  try {
    const { taskId, title, note, priority, startDatetime, endDatetime, assignedTo } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId is required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForManager(taskId, req.userId, req.user.organization);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    if (['completed', 'cancelled'].includes(task.status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot edit a completed or cancelled task'
      });
    }

    const wasActive = task.status === 'in_progress';

    if (title) task.title = title;
    if (note !== undefined) task.note = note;
    if (priority) task.priority = priority;
    if (startDatetime) task.startDatetime = new Date(startDatetime);
    if (endDatetime) task.endDatetime = new Date(endDatetime);
    if (assignedTo && isValidObjectId(assignedTo)) task.assignedTo = assignedTo;

    task.lastEditedBy = req.userId;
    task.lastEditedAt = new Date();
    if (wasActive) task.editedWhileActive = true;

    await task.save();

    const updatedTask = await Task.findById(task._id)
      .populate('assignedTo', 'username fullName profilePicture')
      .populate('room', 'name roomCode');

    res.json({
      success: true,
      message: wasActive
        ? 'Task updated. Employee will be notified of the changes.'
        : 'Task updated successfully',
      data: { task: updatedTask }
    });

  } catch (error) {
    console.error('Edit task error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PATCH /api/tasks/cancel ── Manager: Cancel task (taskId in body) ─
router.patch('/cancel', isManager, async (req, res) => {
  try {
    const { taskId, reason } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId is required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForManager(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (['completed', 'cancelled'].includes(task.status)) {
      return res.status(400).json({ success: false, message: 'Task is already completed or cancelled' });
    }

    task.status = 'cancelled';
    task.cancelledAt = new Date();
    task.cancelledBy = req.userId;
    task.cancellationReason = reason || null;

    await task.save();

    await Room.findByIdAndUpdate(task.room, {
      $inc: { 'stats.activeTasks': -1 }
    });

    res.json({ success: true, message: 'Task cancelled successfully' });

  } catch (error) {
    console.error('Cancel task error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/tasks/live-location ── Manager: Live location ──────────
//  Body: { taskId }
router.post('/live-location', isManager, async (req, res) => {
  try {
    const { taskId } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId is required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForManager(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const activeStep = task.getActiveStep();
    if (!activeStep || !activeStep.isFieldWorkStep) {
      return res.status(404).json({
        success: false,
        message: 'No active field work step found for this task'
      });
    }

    const latestTrace = await LocationTrace.findOne({
      task: task._id,
      stepId: activeStep.stepId,
      employee: task.assignedTo
    }).sort({ recordedAt: -1 });

    const employee = await User.findById(task.assignedTo)
      .select('fullName username profilePicture currentLocation isOnline');

    res.json({
      success: true,
      message: 'ok',
      data: {
        stepId: activeStep.stepId,
        stepTitle: activeStep.title,
        stepStatus: activeStep.status,
        destination: activeStep.destinationLocation,
        radiusMeters: activeStep.locationRadiusMeters,
        employee,
        latestLocation: latestTrace ? {
          coordinates: latestTrace.location.coordinates,
          accuracyMeters: latestTrace.accuracyMeters,
          recordedAt: latestTrace.recordedAt,
          batteryLevel: latestTrace.batteryLevel
        } : null
      }
    });

  } catch (error) {
    console.error('Live location error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/tasks/location-trace ── Manager: Full route ────────────
//  Body: { taskId, stepId? }
router.post('/location-trace', isManager, async (req, res) => {
  try {
    const { taskId, stepId } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId is required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForManager(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    let traceQuery = { task: task._id, employee: task.assignedTo };
    if (stepId) traceQuery.stepId = stepId;

    const traces = await LocationTrace.find(traceQuery)
      .sort({ recordedAt: 1 })
      .select('location accuracyMeters recordedAt batteryLevel stepId');

    res.json({
      success: true,
      message: 'ok',
      data: { traces, total: traces.length, stepId: stepId || 'all' }
    });

  } catch (error) {
    console.error('Location trace error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  STEP ROUTES  (taskId + stepId always in body)
// ═══════════════════════════════════════════════════════════════════════

// ─── POST /api/tasks/steps/add ── Manager: Add step ───────────────────
//  Body: { taskId, title, description?, startDatetime, endDatetime, ... }
router.post('/steps/add', isManager, async (req, res) => {
  try {
    const {
      taskId, title, description, startDatetime, endDatetime,
      isFieldWorkStep, destinationLocation, locationRadiusMeters, validations
    } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId is required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForManager(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (['completed', 'cancelled'].includes(task.status)) {
      return res.status(400).json({ success: false, message: 'Cannot add steps to a completed or cancelled task' });
    }

    if (!title || !startDatetime || !endDatetime) {
      return res.status(400).json({ success: false, message: 'title, startDatetime, and endDatetime are required' });
    }

    if (isFieldWorkStep && (!destinationLocation || !destinationLocation.coordinates)) {
      return res.status(400).json({ success: false, message: 'Destination location is required for field work steps' });
    }

    const newStep = {
      stepId: new mongoose.Types.ObjectId().toString(),
      order: task.steps.length + 1,
      title,
      description: description || null,
      startDatetime: new Date(startDatetime),
      endDatetime: new Date(endDatetime),
      isFieldWorkStep: isFieldWorkStep || false,
      destinationLocation: isFieldWorkStep && destinationLocation ? {
        type: 'Point',
        coordinates: destinationLocation.coordinates,
        address: destinationLocation.address || null
      } : undefined,
      locationRadiusMeters: locationRadiusMeters || 50,
      validations: {
        requireSignature: validations?.requireSignature || false,
        signatureFrom: validations?.signatureFrom || null,
        requirePhoto: validations?.requirePhoto || false,
        requireLocationCheck: validations?.requireLocationCheck || false,
        requireLocationTrace: validations?.requireLocationTrace || isFieldWorkStep || false
      }
    };

    task.steps.push(newStep);
    task.lastEditedBy = req.userId;
    task.lastEditedAt = new Date();
    if (task.status === 'in_progress') task.editedWhileActive = true;

    await task.save();

    res.json({
      success: true,
      message: 'Step added successfully',
      data: { step: task.steps[task.steps.length - 1] }
    });

  } catch (error) {
    console.error('Add step error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/tasks/steps/edit ── Manager: Edit a step ────────────────
//  Body: { taskId, stepId, title?, description?, ... }
router.put('/steps/edit', isManager, async (req, res) => {
  try {
    const {
      taskId, stepId, title, description, startDatetime, endDatetime,
      isFieldWorkStep, destinationLocation, locationRadiusMeters, validations
    } = req.body;

    if (!taskId || !stepId) {
      return res.status(400).json({ success: false, message: 'taskId and stepId are required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForManager(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const stepIdx = task.steps.findIndex(s => s.stepId === stepId);
    if (stepIdx === -1) return res.status(404).json({ success: false, message: 'Step not found' });

    const step = task.steps[stepIdx];
    const isStepActive = ['in_progress', 'travelling', 'reached'].includes(step.status);

    if (step.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Cannot edit a completed step' });
    }

    if (title) step.title = title;
    if (description !== undefined) step.description = description;
    if (startDatetime) step.startDatetime = new Date(startDatetime);
    if (endDatetime) step.endDatetime = new Date(endDatetime);

    if (!isStepActive) {
      if (isFieldWorkStep !== undefined) step.isFieldWorkStep = isFieldWorkStep;
      if (destinationLocation && destinationLocation.coordinates) {
        step.destinationLocation = {
          type: 'Point',
          coordinates: destinationLocation.coordinates,
          address: destinationLocation.address || null
        };
      }
      if (locationRadiusMeters) step.locationRadiusMeters = locationRadiusMeters;
      if (validations) step.validations = { ...step.validations, ...validations };
    }

    step.lastEditedAt = new Date();
    if (isStepActive) step.editedWhileActive = true;
    task.lastEditedBy = req.userId;
    task.lastEditedAt = new Date();

    await task.save();

    res.json({
      success: true,
      message: isStepActive
        ? 'Step updated. Note: Some changes are restricted while step is active.'
        : 'Step updated successfully',
      data: { step: task.steps[stepIdx] }
    });

  } catch (error) {
    console.error('Edit step error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/tasks/steps/remove ── Manager: Remove a step ─────────
//  Body: { taskId, stepId }
router.delete('/steps/remove', isManager, async (req, res) => {
  try {
    const { taskId, stepId } = req.body;

    if (!taskId || !stepId) {
      return res.status(400).json({ success: false, message: 'taskId and stepId are required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForManager(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const stepIdx = task.steps.findIndex(s => s.stepId === stepId);
    if (stepIdx === -1) return res.status(404).json({ success: false, message: 'Step not found' });

    const step = task.steps[stepIdx];

    if (['in_progress', 'travelling', 'reached', 'completed'].includes(step.status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete a step that is active or already completed'
      });
    }

    if (task.steps.length === 1) {
      return res.status(400).json({ success: false, message: 'Task must have at least one step' });
    }

    task.steps.splice(stepIdx, 1);
    task.steps.forEach((s, i) => { s.order = i + 1; });
    task.lastEditedBy = req.userId;
    task.lastEditedAt = new Date();

    await task.save();

    res.json({ success: true, message: 'Step removed successfully' });

  } catch (error) {
    console.error('Delete step error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  EMPLOYEE ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ─── GET /api/tasks/my/tasks ── Employee: Get their tasks ─────────────
// Query params: ?filter=today|upcoming|active|completed|missed
router.get('/my/tasks', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }

    const { filter = 'today' } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const { start, end } = getTodayRange();

    let query = {
      organization: req.user.organization,
      assignedTo: req.userId
    };

    if (filter === 'today') {
      query.$or = [
        { startDatetime: { $gte: start, $lt: end } },
        { status: 'in_progress' },
        { status: 'pending', startDatetime: { $lt: end } }
      ];
    } else if (filter === 'upcoming') {
      query.startDatetime = { $gt: new Date() };
      query.status = 'pending';
    } else if (filter === 'active') {
      query.status = 'in_progress';
    } else if (filter === 'completed') {
      query.status = 'completed';
    } else if (filter === 'missed') {
      query.endDatetime = { $lt: new Date() };
      query.status = { $in: ['pending', 'in_progress'] };
    }

    const [tasks, total] = await Promise.all([
      Task.find(query)
        .populate('assignedTo', 'username fullName profilePicture isOnline')
        .populate('createdBy', 'username fullName profilePicture')
        .populate('room', 'name roomCode')
        .sort({ startDatetime: -1 })
        .skip(skip)
        .limit(limit),
      Task.countDocuments(query)
    ]);

    res.json({
      success: true,
      message: 'ok',
      data: {
        tasks,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          total,
          limit
        }
      }
    });

  } catch (error) {
    console.error('Get my tasks error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/tasks/start ── Employee: Start task ────────────────────
//  Body: { taskId, coordinates? }
router.post('/start', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }

    const { taskId, coordinates } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId is required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForEmployee(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (task.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Task is already ${task.status}. Only pending tasks can be started.`
      });
    }

    const now = new Date();
    const buffer = new Date(task.startDatetime.getTime() - 15 * 60 * 1000);
    if (now < buffer) {
      return res.status(400).json({
        success: false,
        message: `Task cannot be started yet. It is scheduled for ${task.startDatetime.toLocaleString()}`
      });
    }

    const { start } = getTodayRange();
    let attendance = await Attendance.findOne({
      employee: req.userId,
      workDate: { $gte: start }
    });

    if (!attendance) {
      attendance = new Attendance({
        organization: req.user.organization,
        employee: req.userId,
        workDate: start,
        punchInTime: now,
        punchInLocation: coordinates ? { type: 'Point', coordinates } : undefined,
        firstTaskId: task._id,
        punchInMethod: 'auto_task_start'
      });
      await attendance.save();
    }

    task.status = 'in_progress';
    task.employeeStartTime = now;
    task.steps[0].status = 'in_progress';
    task.steps[0].employeeStartTime = now;

    await task.save();

    res.json({
      success: true,
      message: 'Task started successfully',
      data: {
        task,
        punchedIn: !attendance.punchInTime || attendance.punchInMethod === 'auto_task_start',
        activeStep: task.steps[0]
      }
    });

  } catch (error) {
    console.error('Start task error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/tasks/steps/start ── Employee: Start a step ────────────
//  Body: { taskId, stepId }
router.post('/steps/start', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }

    const { taskId, stepId } = req.body;

    if (!taskId || !stepId) {
      return res.status(400).json({ success: false, message: 'taskId and stepId are required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForEmployee(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (task.status !== 'in_progress') {
      return res.status(400).json({ success: false, message: 'Task must be started before starting a step' });
    }

    const stepIdx = task.steps.findIndex(s => s.stepId === stepId);
    if (stepIdx === -1) return res.status(404).json({ success: false, message: 'Step not found' });

    const step = task.steps[stepIdx];

    if (stepIdx > 0) {
      const prevStep = task.steps[stepIdx - 1];
      if (!['completed', 'skipped'].includes(prevStep.status)) {
        return res.status(400).json({
          success: false,
          message: 'Please complete the previous step before starting this one'
        });
      }
    }

    if (step.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Step is already ${step.status}` });
    }

    step.status = 'in_progress';
    step.employeeStartTime = new Date();

    await task.save();

    res.json({ success: true, message: 'Step started', data: { step } });

  } catch (error) {
    console.error('Start step error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/tasks/steps/reached ── Employee: Mark reached ──────────
//  Body: { taskId, stepId, coordinates }
router.post('/steps/reached', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }

    const { taskId, stepId, coordinates } = req.body;

    if (!taskId || !stepId) {
      return res.status(400).json({ success: false, message: 'taskId and stepId are required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForEmployee(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const stepIdx = task.steps.findIndex(s => s.stepId === stepId);
    if (stepIdx === -1) return res.status(404).json({ success: false, message: 'Step not found' });

    const step = task.steps[stepIdx];

    if (!step.isFieldWorkStep) {
      return res.status(400).json({ success: false, message: 'Reached action is only for field work steps' });
    }

    if (step.status !== 'in_progress') {
      return res.status(400).json({
        success: false,
        message: 'Step must be started (in_progress) before marking reached'
      });
    }

    if (!coordinates || coordinates.length !== 2) {
      return res.status(400).json({ success: false, message: 'Current GPS coordinates are required' });
    }

    if (step.destinationLocation && step.destinationLocation.coordinates) {
      const distance = getDistanceMeters(coordinates, step.destinationLocation.coordinates);
      if (distance > step.locationRadiusMeters) {
        return res.status(400).json({
          success: false,
          message: `You are ${Math.round(distance)}m away from the destination. Move within ${step.locationRadiusMeters}m and try again.`,
          data: {
            currentDistance: Math.round(distance),
            requiredRadius: step.locationRadiusMeters,
            shortfall: Math.round(distance - step.locationRadiusMeters)
          }
        });
      }
    }

    step.status = 'reached';
    step.employeeReachTime = new Date();
    step.submittedLocation = { type: 'Point', coordinates };

    await User.findByIdAndUpdate(req.userId, {
      'currentLocation.coordinates': coordinates,
      'currentLocation.lastUpdated': new Date()
    });

    await task.save();

    res.json({
      success: true,
      message: 'Location verified. You have reached the destination!',
      data: { step }
    });

  } catch (error) {
    console.error('Reached step error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/tasks/steps/complete ── Employee: Complete step ─────────
//  Body: { taskId, stepId, photoUrl?, signatureData?, ... }
router.post('/steps/complete', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }

    const {
      taskId, stepId, photoUrl, signatureData, signatureSignedBy,
      signatureRole, currentLocation, employeeNotes
    } = req.body;

    if (!taskId || !stepId) {
      return res.status(400).json({ success: false, message: 'taskId and stepId are required' });
    }
    if (!isValidObjectId(taskId)) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await findTaskForEmployee(taskId, req.userId, req.user.organization);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const stepIdx = task.steps.findIndex(s => s.stepId === stepId);
    if (stepIdx === -1) return res.status(404).json({ success: false, message: 'Step not found' });

    const step = task.steps[stepIdx];

    if (!['in_progress', 'reached'].includes(step.status)) {
      return res.status(400).json({
        success: false,
        message: 'Step must be in_progress or reached before completing'
      });
    }

    if (step.isFieldWorkStep && step.status !== 'reached') {
      return res.status(400).json({
        success: false,
        message: 'You must reach the destination before completing a field work step'
      });
    }

    const validationResult = task.validateStepSubmission(step.stepId, {
      photoUrl, signatureData, currentLocation
    });

    if (!validationResult.valid) {
      return res.status(400).json({
        success: false,
        message: validationResult.message,
        data: validationResult.distance ? { distance: validationResult.distance } : undefined
      });
    }

    const now = new Date();
    step.status = 'completed';
    step.employeeCompleteTime = now;
    step.isOverdue = now > step.endDatetime;

    if (photoUrl) step.submittedPhotoUrl = photoUrl;
    if (signatureData) {
      step.signatureData = signatureData;
      step.signatureSignedBy = signatureSignedBy || null;
      step.signatureRole = signatureRole || null;
    }
    if (currentLocation && currentLocation.coordinates) {
      step.submittedLocation = {
        type: 'Point',
        coordinates: currentLocation.coordinates,
        accuracyMeters: currentLocation.accuracyMeters || null
      };
    }
    if (employeeNotes) step.employeeNotes = employeeNotes;

    if (task.allStepsCompleted()) {
      task.status = 'completed';
      task.completedAt = now;
      await Room.findByIdAndUpdate(task.room, {
        $inc: { 'stats.activeTasks': -1, 'stats.completedTasks': 1 }
      });
    }

    await task.save();

    const isTaskDone = task.status === 'completed';

    res.json({
      success: true,
      message: isTaskDone
        ? 'Step completed! All steps done — task completed!'
        : 'Step completed successfully',
      data: {
        step,
        taskCompleted: isTaskDone,
        nextStep: isTaskDone ? null : task.steps[stepIdx + 1] || null
      }
    });

  } catch (error) {
    console.error('Complete step error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  LOCATION TRACKING ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ─── POST /api/tasks/location/ping ── Employee: GPS ping ──────────────
//  Body: { taskId, stepId, coordinates, accuracyMeters?, batteryLevel? }
router.post('/location/ping', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }
 
    const { taskId, stepId, coordinates, accuracyMeters, batteryLevel } = req.body;

    if (!taskId || !stepId || !coordinates || coordinates.length !== 2) {
      return res.status(400).json({
        success: false,
        message: 'taskId, stepId, and coordinates [longitude, latitude] are required'
      });
    }

    const task = await Task.findOne({
      _id: taskId,
      organization: req.user.organization,
      assignedTo: req.userId,
      status: 'in_progress'
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Active task not found' });
    }

    const step = task.getStep(stepId);
    if (!step) {
      return res.status(404).json({ success: false, message: 'Step not found' });
    }

    const isTracked = task.isFieldWork || step.validations.requireLocationTrace;
    if (!isTracked) {
      return res.status(400).json({
        success: false,
        message: 'Location tracking is not enabled for this task'
      });
    }

    // if (!step || !step.validations.requireLocationTrace) {
    //   return res.status(400).json({
    //     success: false,
    //     message: 'This step does not require location tracking'
    //   });
    // }

    const trace = new LocationTrace({
      organization: req.user.organization,
      task: taskId,
      stepId,
      employee: req.userId,
      location: { type: 'Point', coordinates },
      accuracyMeters: accuracyMeters || null,
      batteryLevel: batteryLevel || null
    });

    await trace.save();

    await User.findByIdAndUpdate(req.userId, {
      'currentLocation.coordinates': coordinates,
      'currentLocation.lastUpdated': new Date()
    });

    res.json({
      success: true,
      message: 'Location recorded',
      data: { recordedAt: trace.recordedAt }
    });

  } catch (error) {
    console.error('Location ping error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  ATTENDANCE ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ─── POST /api/tasks/attendance/punch-in ──────────────────────────────
router.post('/attendance/punch-in', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }

    const { start } = getTodayRange();
    const existing = await Attendance.findOne({
      employee: req.userId,
      workDate: { $gte: start }
    });

    if (existing && existing.punchInTime) {
      return res.status(400).json({
        success: false,
        message: 'Already punched in today',
        data: { punchInTime: existing.punchInTime }
      });
    }

    const { coordinates } = req.body;
    const now = new Date();

    const attendance = new Attendance({
      organization: req.user.organization,
      employee: req.userId,
      workDate: start,
      punchInTime: now,
      punchInLocation: coordinates ? { type: 'Point', coordinates } : undefined,
      punchInMethod: 'manual'
    });

    await attendance.save();

    res.json({
      success: true,
      message: 'Punched in successfully',
      data: { attendance }
    });

  } catch (error) {
    console.error('Punch in error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/tasks/attendance/punch-out ─────────────────────────────
router.post('/attendance/punch-out', async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Employee access only' });
    }

    const { start } = getTodayRange();
    const attendance = await Attendance.findOne({
      employee: req.userId,
      workDate: { $gte: start }
    });

    if (!attendance || !attendance.punchInTime) {
      return res.status(400).json({ success: false, message: 'You have not punched in today' });
    }

    if (attendance.punchOutTime) {
      return res.status(400).json({
        success: false,
        message: 'Already punched out today',
        data: { punchOutTime: attendance.punchOutTime }
      });
    }

    const { coordinates } = req.body;
    await attendance.punchOut(coordinates || null);

    res.json({
      success: true,
      message: 'Punched out successfully',
      data: {
        punchInTime: attendance.punchInTime,
        punchOutTime: attendance.punchOutTime,
        totalHours: attendance.totalHours
      }
    });

  } catch (error) {
    console.error('Punch out error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/tasks/attendance/today ──────────────────────────────────
router.get('/attendance/today', async (req, res) => {
  try {
    const { start } = getTodayRange();
    const attendance = await Attendance.findOne({
      employee: req.userId,
      workDate: { $gte: start }
    });

    res.json({
      success: true,
      message: 'ok',
      data: {
        isPunchedIn: !!(attendance && attendance.punchInTime),
        isPunchedOut: !!(attendance && attendance.punchOutTime),
        attendance: attendance || null
      }
    });

  } catch (error) {
    console.error('Attendance today error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/tasks/attendance/history ────────────────────────────────
router.get('/attendance/history', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    let query = { organization: req.user.organization };

    if (req.user.role === 'employee') {
      query.employee = req.userId;
    } else if (req.query.employeeId && isValidObjectId(req.query.employeeId)) {
      query.employee = req.query.employeeId;
    }

    if (req.query.month) {
      const [year, month] = req.query.month.split('-').map(Number);
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 1);
      query.workDate = { $gte: monthStart, $lt: monthEnd };
    }

    const [records, total] = await Promise.all([
      Attendance.find(query)
        .populate('employee', 'username fullName profilePicture')
        .sort({ workDate: -1 })
        .skip(skip)
        .limit(limit),
      Attendance.countDocuments(query)
    ]);

    res.json({
      success: true,
      message: 'ok',
      data: {
        records,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          total,
          limit
        }
      }
    });

  } catch (error) {
    console.error('Attendance history error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;