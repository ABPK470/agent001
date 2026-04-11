import sql from 'mssql';

// Database configuration
const sqlConfig = {
  user: 'your_username',
  password: 'your_password',
  server: 'localhost',
  database: 'AgentDWH',
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};

let pool;

// Initialize or reuse MSSQL connection pool
export const getDatabasePool = async () => {
  if (!pool) {
    pool = await sql.connect(sqlConfig);
  }
  return pool;
};

// Query the database with parameters
export const queryDatabase = async (query, params) => {
  const dbPool = await getDatabasePool();
  const request = dbPool.request();

  params.forEach((param, index) => {
    request.input(`param${index}`, param);
  });

  const result = await request.query(query);
  return result.recordset;
};