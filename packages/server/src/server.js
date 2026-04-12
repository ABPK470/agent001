import express from 'express';
import reportsController from './api/reportsController.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Routes
app.use('/api/reports', reportsController);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});