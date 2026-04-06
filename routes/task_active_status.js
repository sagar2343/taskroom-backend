
// const express         = require('express');
// const Task            = require('../models/Task');
// const authMiddleware  = require('../middleware/auth');

// const router = express.Router();
// router.use(authMiddleware);

// router.get('/active-status', async (req, res) => {
//   try {
//     if (req.user.role !== 'employee') {
//       return res.status(403).json({ success: false, message: 'Employee access only' });
//     }

//     const task = await Task.findOne({
//       organization: req.user.organization,
//       assignedTo:   req.userId,
//       status:       'in_progress'
//     }).select('_id room isFieldWork steps');

//     if (!task) {
//       return res.json({
//         success: true,
//         data: { hasActiveTask: false, taskId: null, stepId: null, requiresTracking: false, roomId: null }
//       });
//     }

//     const activeStep = task.steps.find(s =>
//       ['in_progress', 'travelling', 'reached'].includes(s.status)
//     );

//     return res.json({
//       success: true,
//       data: {
//         hasActiveTask:    true,
//         taskId:           task._id.toString(),
//         stepId:           activeStep?.stepId ?? null,
//         requiresTracking: task.isFieldWork === true,
//         roomId:           task.room.toString(),
//       }
//     });

//   } catch (err) {
//     console.error('active-status error:', err);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// });

// module.exports = router;