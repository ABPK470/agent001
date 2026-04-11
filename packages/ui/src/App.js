import React, { useEffect, useState } from 'react';
import './App.css';

function App() {
  const [clients, setClients] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/top-clients')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Failed to fetch data');
        }
        return response.json();
      })
      .then((data) => setClients(data))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="App">
      <h1>Top 5 Clients by Revenue</h1>
      {error ? (
        <p>Error: {error}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Client Name</th>
              <th>Industry</th>
              <th>Region</th>
              <th>Last Purchase Date</th>
              <th>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client, index) => (
              <tr key={index}>
                <td>{client.ClientName}</td>
                <td>{client.Industry}</td>
                <td>{client.Region}</td>
                <td>{new Date(client.LastPurchaseDate).toLocaleDateString()}</td>
                <td>{client.Revenue.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default App;