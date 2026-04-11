const express = require('express');
const { getTopClientsByRevenue } = require('./services/reportService');

const app = express();
const PORT = process.env.PORT || 3001;

// API route for fetching the report
app.get('/api/top-clients', async (req, res) => {
  try {
    const topClients = await getTopClientsByRevenue();
    res.json(topClients);
  } catch (error) {
    console.error('Error fetching report:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = app;