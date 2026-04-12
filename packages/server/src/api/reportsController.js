import express from 'express';
import { queryDatabase } from '../db/db.js';

const router = express.Router();

// API route to get top 5 clients by revenue
router.get('/top-clients', async (req, res) => {
  try {
    const query = `
      SELECT TOP 5 ClientName, Revenue, Industry, Location, AccountManager
      FROM Clients
      ORDER BY Revenue DESC
    `;
    const results = await queryDatabase(query, []); // No dynamic parameters in this query
    res.json(results);
  } catch (error) {
    console.error('Error fetching top clients:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;