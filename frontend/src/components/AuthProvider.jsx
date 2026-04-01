import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import api, { setAuthToken } from "../api/client.js";

const AuthContext = createContext(null);

const decodeToken = (token) => {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload));
    return decoded;
  } catch (err) {
    return null;
  }
};

const normalizeUser = (value) => {
  if (!value) return null;
  const emailId =
    typeof value.email === "string" && value.email.includes("@")
      ? value.email.split("@")[0]
      : null;
  return {
    ...value,
    id: emailId || value.id || value._id || null,
    villaId: value.villaId || null,
    role: value.role || null,
  };
};

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(() => localStorage.getItem("token"));
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      setAuthToken(token);
      api
        .get("/auth/me")
        .then((res) => setUser(normalizeUser(res.data)))
        .catch(() => {
          setToken(null);
          localStorage.removeItem("token");
        })
        .finally(() => setLoading(false));
    } else {
      setUser(null);
      setAuthToken(null);
      setLoading(false);
    }
  }, [token]);

  const login = async (email, password) => {
    const response = await api.post("/auth/login", { email, password });
    const newToken = response.data.token;
    setToken(newToken);
    localStorage.setItem("token", newToken);
    const claims = decodeToken(newToken);
    if (claims) {
      setUser(normalizeUser({ id: claims.id, role: claims.role, villaId: claims.villaId }));
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem("token");
  };

  const value = useMemo(
    () => ({ token, user, loading, login, logout }),
    [token, user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
