import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import ClientAssignmentsPage from "./pages/ClientAssignmentsPage.jsx";
import MediaLibraryPage from "./pages/MediaLibraryPage.jsx";
import NotificationsPage from "./pages/NotificationsPage.jsx";
import SyncPage from "./pages/SyncPage.jsx";
import VillasPage from "./pages/VillasPage.jsx";
import AppShell from "./components/AppShell.jsx";
import { AuthProvider, useAuth } from "./components/AuthProvider.jsx";

const ProtectedRoute = ({ children }) => {
  const { token } = useAuth();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
};

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="villas" element={<VillasPage />} />
          <Route path="clients" element={<ClientAssignmentsPage />} />
          <Route path="media" element={<MediaLibraryPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="sync" element={<SyncPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
