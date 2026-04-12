import React, { useEffect, useState } from 'react';
import axios from 'axios';

const TopClientsReport = () => {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchClients = async () => {
      try {
        const response = await axios.get('/api/reports/top-clients');
        setClients(response.data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchClients();
  }, []);

  if (loading) return <div aria-live="polite">Loading...</div>;
  if (error) return <div role="alert">Error: {error}</div>;

  return (
    <table aria-label="Top Clients">
      <thead>
        <tr>
          <th>Client Name</th>
          <th>Revenue</th>
          <th>Industry</th>
          <th>Location</th>
          <th>Account Manager</th>
        </tr>
      </thead>
      <tbody>
        {clients.map((client, idx) => (
          <tr key={idx}>
            <td>{client.ClientName}</td>
            <td>{client.Revenue}</td>
            <td>{client.Industry}</td>
            <td>{client.Location}</td>
            <td>{client.AccountManager}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default TopClientsReport;