import React, { useMemo, useState } from "react";
import api from "../api/client.js";
import { useAuth } from "../components/AuthProvider.jsx";

const defaultNetworkName = "Villa WiFi";

const parseDeviceVersions = (value) => {
  if (!value.trim()) return undefined;
  return JSON.parse(value);
};

export default function SyncPage() {
  const { user } = useAuth();
  const [deviceVersions, setDeviceVersions] = useState("");
  const [networkName, setNetworkName] = useState(defaultNetworkName);
  const [villaIdInput, setVillaIdInput] = useState("");
  const [wifiConnected, setWifiConnected] = useState(false);
  const [downloadedIds, setDownloadedIds] = useState([]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const villaId = useMemo(() => {
    if (user?.role === "CLIENT") return user?.villaId || "";
    return villaIdInput.trim();
  }, [user, villaIdInput]);

  const handleSync = async () => {
    if (!villaId) {
      setError("Villa ID is required to run sync");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");
    setResult(null);
    setDownloadedIds([]);

    let parsedVersions;
    try {
      parsedVersions = parseDeviceVersions(deviceVersions);
    } catch (err) {
      setError("Device versions must be valid JSON");
      setLoading(false);
      return;
    }

    try {
      const response = await api.post("/sync", {
        villaId,
        deviceVersions: parsedVersions,
        networkName,
      });
      setWifiConnected(true);
      setResult(response.data);
      try {
        const activityResponse = await api.get(`/media/activity/${villaId}`);
        setDownloadedIds(activityResponse.data.downloadedFileIds || []);
      } catch (activityError) {
        // Keep sync results available even if activity lookup fails.
      }
    } catch (err) {
      setError(err.response?.data?.error || "Sync failed");
      setWifiConnected(false);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (item) => {
    try {
      const response = await api.get(item.downloadPath, {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", item.fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setDownloadedIds((current) => [...new Set([...current, item.id])]);
      setSuccess(`Downloaded ${item.fileName} version ${item.version}.`);
    } catch (err) {
      if (err.response?.status === 409) {
        setDownloadedIds((current) => [...new Set([...current, item.id])]);
        setSuccess(`${item.fileName} was already downloaded earlier.`);
        setError("");
        return;
      }
      setError(err.response?.data?.error || "Download failed");
    }
  };

  return (
    <div className="grid">
      <div className="card">
        <h2>WiFi Sync</h2>
        <p className="muted">Simulate a device connecting to villa WiFi and fetch updated media versions.</p>

        <div className="grid" style={{ marginTop: 16 }}>
          <label className="muted">Network name</label>
          <input
            className="input"
            value={networkName}
            onChange={(event) => setNetworkName(event.target.value)}
            placeholder={defaultNetworkName}
          />
          {user?.role === "SALES_AGENT" && (
            <>
              <label className="muted">Villa ID</label>
              <input
                className="input"
                value={villaIdInput}
                onChange={(event) => setVillaIdInput(event.target.value)}
                placeholder="villa-101"
              />
            </>
          )}
          {user?.role === "CLIENT" && (
            <div className="muted">Syncing for villa {villaId || "-"}</div>
          )}
          <label className="muted">Device versions (JSON optional)</label>
          <textarea
            className="input"
            rows={5}
            value={deviceVersions}
            onChange={(event) => setDeviceVersions(event.target.value)}
            placeholder='[{"fileName":"villa.jpg","version":1,"hash":"abc"}]'
          />
          <button className="button" onClick={handleSync} disabled={loading}>
            {loading ? "Connecting to WiFi..." : "Trigger WiFi Sync"}
          </button>
          <div className="muted">
            WiFi status: {wifiConnected ? `Connected to ${networkName || defaultNetworkName}` : "Disconnected"}
          </div>
          {error && <div className="muted">{error}</div>}
          {success && <div className="muted">{success}</div>}
        </div>
      </div>

      {result && (
        <div className="card">
          <h3>Sync Result</h3>
          <div className="muted">
            Triggered by {result.trigger?.type || "WIFI_CONNECTED"} on{" "}
            {result.trigger?.networkName || defaultNetworkName}
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            Connected at {result.trigger?.connectedAt || "-"}
          </div>

          <div style={{ marginTop: 24 }}>
            <h3>Available Updates</h3>
            <div className="list">
              {result.updates && result.updates.length > 0 ? (
                result.updates.map((item) => (
                  <div className="row" key={item.id}>
                    <div>
                      <div>{item.fileName}</div>
                      <div className="muted">
                        Version {item.version} - {item.reason === "HASH_MISMATCH" ? "Hash mismatch" : "New version"}
                      </div>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => handleDownload(item)}
                      disabled={downloadedIds.includes(item.id)}
                    >
                      {downloadedIds.includes(item.id) ? "Downloaded" : "Download Update"}
                    </button>
                  </div>
                ))
              ) : (
                <div className="muted">No updates found.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
