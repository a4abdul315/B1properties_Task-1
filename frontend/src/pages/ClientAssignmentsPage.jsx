import React, { useEffect, useState } from "react";
import api from "../api/client.js";
import { useAuth } from "../components/AuthProvider.jsx";

export default function ClientAssignmentsPage() {
  const { user } = useAuth();
  const [clients, setClients] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const fetchClients = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/auth/clients");
      const nextClients = response.data || [];
      setClients(nextClients);
      setDrafts(
        nextClients.reduce((acc, client) => {
          acc[client._id] = client.villaId || "";
          return acc;
        }, {})
      );
    } catch (err) {
      setError(err.response?.data?.error || "Failed to load clients");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === "SALES_AGENT") {
      fetchClients();
    }
  }, [user?.role]);

  const handleSave = async (clientId) => {
    const villaId = (drafts[clientId] || "").trim();
    if (!villaId) {
      setError("Villa ID is required");
      return;
    }

    setSavingId(clientId);
    setError("");
    setSuccess("");

    try {
      const response = await api.patch(`/auth/clients/${clientId}/villa`, { villaId });
      const updatedClient = response.data;
      setClients((current) =>
        current.map((client) => (client._id === clientId ? updatedClient : client))
      );
      setDrafts((current) => ({ ...current, [clientId]: updatedClient.villaId || "" }));
      setSuccess(`Assigned ${updatedClient.email} to villa ${updatedClient.villaId}.`);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to update villa assignment");
    } finally {
      setSavingId("");
    }
  };

  if (user?.role !== "SALES_AGENT") {
    return (
      <div className="card">
        <h2>Client Assignments</h2>
        <p className="muted">Only sales agents can manage villa assignments.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="header">
        <div>
          <h2>Client Assignments</h2>
          <p className="muted">Assign or update the villa ID for each client account.</p>
        </div>
        <button className="button secondary" onClick={fetchClients} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <div className="muted">{error}</div>}
      {success && <div className="muted">{success}</div>}

      <div className="list" style={{ marginTop: 16 }}>
        {!loading && clients.length === 0 && <div className="muted">No client accounts found.</div>}
        {clients.map((client) => (
          <div className="row" key={client._id}>
            <div style={{ flex: 1 }}>
              <div>{client.email}</div>
              <div className="muted">Current villa: {client.villaId || "-"}</div>
            </div>
            <input
              className="input"
              style={{ maxWidth: 180 }}
              value={drafts[client._id] || ""}
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [client._id]: event.target.value }))
              }
              placeholder="villa-101"
            />
            <button
              className="button secondary"
              onClick={() => handleSave(client._id)}
              disabled={savingId === client._id}
            >
              {savingId === client._id ? "Saving..." : "Save"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
