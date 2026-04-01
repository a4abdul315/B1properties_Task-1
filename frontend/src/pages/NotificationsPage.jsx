import React, { useEffect, useState } from "react";
import api from "../api/client.js";

const formatTimestamp = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchNotifications = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/notify/mine");
      setNotifications(response.data || []);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to load notifications");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
  }, []);

  return (
    <div className="card">
      <div className="header">
        <div>
          <h2>Notifications</h2>
          <p className="muted">Villa assignment and media upload alerts for your account.</p>
        </div>
        <button className="button secondary" onClick={fetchNotifications} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <div className="muted">{error}</div>}

      <div className="list" style={{ marginTop: 16 }}>
        {!loading && notifications.length === 0 && (
          <div className="muted">No notifications yet.</div>
        )}
        {notifications.map((item) => (
          <div className="row" key={item._id}>
            <div>
              <div>{item.message}</div>
              <div className="muted">
                {item.type} {item.villaId ? `- ${item.villaId}` : ""}
              </div>
            </div>
            <div className="muted">{formatTimestamp(item.createdAt)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
