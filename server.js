const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const organizationRoutes = require('./routes/organization');
const roomRoutes = require('./routes/room');
const taskRoutes = require('./routes/task');

const app = express();
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ Mongo error:", err.message));

// Routes
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: "Backend is running"
  });
});

// Auth routes (public)
app.use('/api/auth', authRoutes);

// User routes (protected)
app.use('/api/user', userRoutes);

// Organization routes (public) 
app.use('/api/organization', organizationRoutes);

// Room routes (protected)
app.use('/api/rooms', roomRoutes);

// Task routes 
app.use('/api/tasks', taskRoutes);


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});