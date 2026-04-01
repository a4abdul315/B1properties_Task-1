import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "./AuthProvider.jsx";

export default function AppShell() {
  const { user, logout } = useAuth();

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1>Villa Media Sync</h1>
          <p className="muted">Signed in as {user?.role || "User"}</p>
        </div>
        <div className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Dashboard
          </NavLink>
          {user?.role === "SALES_AGENT" && (
            <NavLink to="/clients" className={({ isActive }) => (isActive ? "active" : "")}>
              Client Assignments
            </NavLink>
          )}
          {user?.role === "SALES_AGENT" && (
            <NavLink to="/villas" className={({ isActive }) => (isActive ? "active" : "")}>
              All Villas
            </NavLink>
          )}
          <NavLink to="/media" className={({ isActive }) => (isActive ? "active" : "")}>
            Media Library
          </NavLink>
          <NavLink to="/notifications" className={({ isActive }) => (isActive ? "active" : "")}>
            Notifications
          </NavLink>
          <NavLink to="/sync" className={({ isActive }) => (isActive ? "active" : "")}>
            Sync
          </NavLink>
          <button className="button secondary" onClick={logout}>
            Logout
          </button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
