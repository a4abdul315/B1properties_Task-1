import React, { useEffect, useState } from "react";
import api from "../api/client.js";
import { useAuth } from "../components/AuthProvider.jsx";

const formatTimestamp = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export default function VillasPage() {
  const { user } = useAuth();
  const [villas, setVillas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deletingVillaId, setDeletingVillaId] = useState("");
  const [error, setError] = useState("");

  const fetchVillas = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/media/villas");
      setVillas(response.data || []);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to load villas");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === "SALES_AGENT") {
      fetchVillas();
    }
  }, [user?.role]);

  const handleDeleteVilla = async (villaId) => {
    const confirmed = window.confirm(
      `Delete villa "${villaId}"? This will remove its media and unassign that villa from clients.`
    );
    if (!confirmed) return;

    setDeletingVillaId(villaId);
    setError("");
    try {
      await api.delete(`/media/villas/${encodeURIComponent(villaId)}`);
      setVillas((current) => current.filter((villa) => villa.villaId !== villaId));
    } catch (err) {
      setError(err.response?.data?.error || "Failed to delete villa");
    } finally {
      setDeletingVillaId("");
    }
  };

  if (user?.role !== "SALES_AGENT") {
    return (
      <div className="card">
        <h2>All Villas</h2>
        <p className="muted">Only sales agents can view all villas.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="header">
        <div>
          <h2>All Villas</h2>
          <p className="muted">See every villa with assigned clients or uploaded media.</p>
        </div>
        <button className="button secondary" onClick={fetchVillas} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <div className="muted">{error}</div>}

      <div className="list" style={{ marginTop: 16 }}>
        {!loading && villas.length === 0 && <div className="muted">No villas found yet.</div>}
        {villas.map((villa) => (
          <div className="row" key={villa.villaId}>
            <div style={{ flex: 1 }}>
              <div>{villa.villaId}</div>
              <div className="muted">
                {villa.assignedClientsCount} assigned client(s) - {villa.mediaCount} media file(s)
              </div>
              {villa.latestMedia && (
                <div className="muted">
                  Latest media: {villa.latestMedia.fileName} v{villa.latestMedia.version} at{" "}
                  {formatTimestamp(villa.latestMedia.createdAt)}
                </div>
              )}
            </div>
            <button
              className="button secondary"
              onClick={() => handleDeleteVilla(villa.villaId)}
              disabled={deletingVillaId === villa.villaId}
            >
              {deletingVillaId === villa.villaId ? "Deleting..." : "Delete Villa"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
