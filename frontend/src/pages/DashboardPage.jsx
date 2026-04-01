import React from "react";
import { useAuth } from "../components/AuthProvider.jsx";

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="grid two">
      <div className="card">
        <h2>Welcome back</h2>
        <p className="muted">Role-based access is active.</p>
        <div className="grid">
          <div>
            <span className="badge">{user?.role || "User"}</span>
          </div>
          <div className="muted">User ID: {user?.id || "-"}</div>
          <div className="muted">Villa ID: {user?.villaId || "-"}</div>
        </div>
      </div>
      <div className="card">
        <h3>Quick tips</h3>
        <ul className="muted">
          <li>Upload media from the Media Library page.</li>
          <li>Run a sync to receive latest files.</li>
          <li>Sales agents can search any villa.</li>
        </ul>
      </div>
    </div>
  );
}
