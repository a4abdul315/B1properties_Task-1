import React, { useEffect, useMemo, useState } from "react";
import api from "../api/client.js";
import { useAuth } from "../components/AuthProvider.jsx";

const formatBytes = (value) => {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const formatTimestamp = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export default function MediaLibraryPage() {
  const { user } = useAuth();
  const [villaIdInput, setVillaIdInput] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [media, setMedia] = useState([]);
  const [activity, setActivity] = useState([]);
  const [downloadedFileIds, setDownloadedFileIds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const villaId = useMemo(() => {
    if (user?.role === "CLIENT") return user?.villaId || "";
    return villaIdInput.trim();
  }, [user, villaIdInput]);
  const canUpload = user?.role === "SALES_AGENT";

  const groupedMedia = useMemo(() => {
    return media.reduce((acc, item) => {
      if (!acc[item.fileName]) {
        acc[item.fileName] = [];
      }
      acc[item.fileName].push(item);
      acc[item.fileName].sort((a, b) => b.version - a.version);
      return acc;
    }, {});
  }, [media]);

  const fetchActivity = async (targetVillaId) => {
    if (!targetVillaId) {
      setActivity([]);
      setDownloadedFileIds([]);
      return;
    }

    const response = await api.get(`/media/activity/${targetVillaId}`);
    setActivity(response.data.activity || []);
    setDownloadedFileIds(response.data.downloadedFileIds || []);
  };

  const fetchMedia = async () => {
    if (!villaId) return;
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      const [mediaResponse] = await Promise.all([
        api.get(`/media/${villaId}`),
        fetchActivity(villaId),
      ]);
      setMedia(mediaResponse.data || []);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to load media");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === "CLIENT" && user?.villaId) {
      fetchMedia();
    }
  }, [user?.role, user?.villaId]);

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!villaId) {
      setError("Enter a villa ID before uploading.");
      return;
    }
    if (!selectedFile) {
      setError("Choose a file to upload.");
      return;
    }

    const formData = new FormData();
    formData.append("villaId", villaId);
    formData.append("file", selectedFile);

    setUploading(true);
    setError("");
    setSuccess("");

    try {
      const response = await api.post("/media/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setSuccess(
        `Uploaded ${response.data.fileName} as version ${response.data.version} for villa ${response.data.villaId}.`
      );
      setSelectedFile(null);
      event.target.reset();
      await fetchMedia();
    } catch (err) {
      setError(err.response?.data?.error || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (item) => {
    try {
      const response = await api.get(`/media/file/${item._id}`, {
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
      setSuccess(`Downloaded ${item.fileName} version ${item.version}.`);
      await fetchActivity(villaId);
    } catch (err) {
      setError(err.response?.data?.error || "Download failed");
      if (err.response?.status === 409) {
        await fetchActivity(villaId);
      }
    }
  };

  return (
    <div className="grid">
      <div className="card">
        <div className="header">
          <div>
            <h2>Media Library</h2>
            <p className="muted">Upload files, track versions, download once, and review access activity.</p>
          </div>
          {user?.role === "SALES_AGENT" && (
            <div className="grid" style={{ minWidth: 220 }}>
              <input
                className="input"
                placeholder="Enter villa ID"
                value={villaIdInput}
                onChange={(event) => setVillaIdInput(event.target.value)}
              />
              <button className="button" onClick={fetchMedia}>
                Fetch Media
              </button>
            </div>
          )}
        </div>

        {user?.role === "CLIENT" && (
          <div className="muted">Showing media for villa {villaId || "-"}</div>
        )}

        {canUpload ? (
          <form className="grid" style={{ marginTop: 16 }} onSubmit={handleUpload}>
            <label className="muted">Upload new media</label>
            <input
              className="input"
              type="file"
              onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
            />
            <button className="button" type="submit" disabled={uploading}>
              {uploading ? "Uploading..." : "Upload Media"}
            </button>
          </form>
        ) : (
          <div className="muted" style={{ marginTop: 16 }}>
            Client accounts can only view and download media assigned to their villa.
          </div>
        )}

        {error && (
          <div className="muted" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
        {success && (
          <div className="muted" style={{ marginTop: 12 }}>
            {success}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Version History</h3>
        <p className="muted">Each upload of the same file name creates the next version for that villa.</p>

        <div className="list" style={{ marginTop: 16 }}>
          {loading && <div className="muted">Loading...</div>}
          {!loading && media.length === 0 && (
            <div className="muted">
              {villaId
                ? `No media found for villa ${villaId}. Ask a sales agent to upload files for this villa.`
                : "No villa is assigned to this account yet."}
            </div>
          )}
          {!loading &&
            Object.entries(groupedMedia).map(([fileName, versions]) => {
              const latest = versions[0];
              return (
                <div
                  className="card"
                  key={fileName}
                  style={{ padding: 16, boxShadow: "none", border: "1px solid #eee" }}
                >
                  <div className="row" style={{ background: "transparent", padding: 0 }}>
                    <div>
                      <div>{fileName}</div>
                      <div className="muted">
                        Latest version {latest.version} - {formatBytes(latest.size)}
                      </div>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => handleDownload(latest)}
                      disabled={downloadedFileIds.includes(String(latest._id))}
                    >
                      {downloadedFileIds.includes(String(latest._id)) ? "Already downloaded" : "Download Latest"}
                    </button>
                  </div>
                  <div className="list" style={{ marginTop: 12 }}>
                    {versions.map((item) => (
                      <div className="row" key={item._id}>
                        <div>
                          <div>Version {item.version}</div>
                          <div className="muted">{formatBytes(item.size)}</div>
                        </div>
                        <button
                          className="button secondary"
                          onClick={() => handleDownload(item)}
                          disabled={downloadedFileIds.includes(String(item._id))}
                        >
                          {downloadedFileIds.includes(String(item._id)) ? "Already downloaded" : "Download"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      <div className="card">
        <h3>Access Activity</h3>
        <p className="muted">Recent media views and downloads for the current villa.</p>

        <div className="list" style={{ marginTop: 16 }}>
          {activity.length === 0 ? (
            <div className="muted">No activity logged yet.</div>
          ) : (
            activity.map((item) => (
              <div className="row" key={item.id}>
                <div>
                  <div>
                    {item.action} - {item.fileName}
                  </div>
                  <div className="muted">
                    Version {item.version || "-"} - User {item.userId}
                  </div>
                </div>
                <div className="muted">{formatTimestamp(item.timestamp)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
