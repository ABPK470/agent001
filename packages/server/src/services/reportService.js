const sql = require('mssql');

// MSSQL database configuration
const dbConfig = {
  user: 'your_username',
  password: 'your_password',
  server: 'localhost',
  database: 'AgentDWH',
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

// Fetch top 5 clients by revenue
async function getTopClientsByRevenue() {
  try {
    // Connect to the database
    const pool = await sql.connect(dbConfig);
    const query = `
      SELECT TOP 5 
        ClientName,
        Industry,
        Region,
        LastPurchaseDate,
        Revenue
      FROM Clients
      ORDER BY Revenue DESC`;

    const result = await pool.request().query(query);
    await pool.close();

    return result.recordset;
  } catch (error) {
    console.error('Database query failed:', error);
    throw new Error('Failed to fetch top clients by revenue.');
  }
}

module.exports = { getTopClientsByRevenue };