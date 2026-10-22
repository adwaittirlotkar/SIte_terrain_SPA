import React, { useCallback, useState } from "react";
import ReactDOM from "react-dom/client";
import TerrainScene, { SiteData, BuildingMesh, CameraView } from "./components/TerrainScene";
import MapPicker from "./components/MapPicker";
import "./styles.css";

/** Collapsible sidebar section — data stays hidden until the user opens it. */
function Section({ title, children, defaultOpen = false }:
  { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="section">
      <button className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev">{open ? "▾" : "▸"}</span>{title}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

function Toggle({ label, checked, onChange }:
  { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }:
  { label: string; value: number; min: number; max: number; step: number;
    unit?: string; onChange: (v: number) => void }) {
  return (
    <div className="slider">
      <div className="slider-row"><span>{label}</span><b>{value.toFixed(step < 1 ? 1 : 0)}{unit}</b></div>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

type Preset = "natural" | "slope" | "contour";

function App() {
  const [data, setData] = useState<SiteData | null>(null);
  const [building, setBuilding] = useState<BuildingMesh | null>(null);
  const [buildingBusy, setBuildingBusy] = useState(false);
  const [exaggeration, setExaggeration] = useState(1.0); // TRUE scale by default
  const [slopeColor, setSlopeColor] = useState(false);
  const [hillshade, setHillshade] = useState(true);
  const [sunAz, setSunAz] = useState(315);
  const [sunAlt, setSunAlt] = useState(45);
  const [showGrid, setShowGrid] = useState(false);
  const [showContours, setShowContours] = useState(true);
  const [showBoundary, setShowBoundary] = useState(true);
  const [measureMode, setMeasureMode] = useState(false);
  const [placeMode, setPlaceMode] = useState(false);
  const [cameraView, setCameraView] = useState<CameraView | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [fetchingLoc, setFetchingLoc] = useState(false);

  // ---- derived slope analysis (from the same true-scale normals the 3D view uses)
  const slopeBuckets = (() => {
    if (!data) return null;
    try {
      const pos = data.stats.positions;
      const tris = data.stats.triangles;
      const acc = new Float64Array(pos.length);
      const cnt = new Float64Array(pos.length);
      for (const [a, b, c] of tris) {
        const ax = pos[a][0], ay = pos[a][1], az = pos[a][2];
        const ux = pos[b][0] - ax, uy = pos[b][1] - ay, uz = pos[b][2] - az;
        const vx = pos[c][0] - ax, vy = pos[c][1] - ay, vz = pos[c][2] - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len === 0) continue;
        const slopeDeg = (Math.acos(Math.min(1, Math.abs(nz) / len)) * 180) / Math.PI;
        acc[a] += slopeDeg; cnt[a] += 1;
        acc[b] += slopeDeg; cnt[b] += 1;
        acc[c] += slopeDeg; cnt[c] += 1;
      }
      const edges = [5, 10, 15, 25, 35]; // ° class boundaries
      const counts = new Array(edges.length + 1).fill(0);
      for (const [a, b, c] of tris) {
        // triangle area in plan (shoelace) used as the weight for its mean slope
        const ax = pos[a][0], ay = pos[a][1];
        const bx = pos[b][0], by = pos[b][1];
        const cx = pos[c][0], cy = pos[c][1];
        const ar = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
        if (ar === 0 || cnt[a] === 0 || cnt[b] === 0 || cnt[c] === 0) continue;
        const s = (acc[a] / cnt[a] + acc[b] / cnt[b] + acc[c] / cnt[c]) / 3;
        let k = 0; while (k < edges.length && s >= edges[k]) k++;
        counts[k] += ar;
      }
      const sum = counts.reduce((a: number, b: number) => a + b, 0) || 1;
      const labels = ["0–5°", "5–10°", "10–15°", "15–25°", "25–35°", ">35°"];
      return labels.map((label, i) => ({ label, pct: (counts[i] / sum) * 100 }));
    } catch { return null; }
  })();

  /** Shared loader: both DXF upload and satellite fetch return the same payload shape. */
  const loadPayload = async (r: Response) => {
    if (!r.ok) {
      const e = await r.json().catch(() => ({ detail: r.statusText }));
      setError(e.detail ?? "Could not build the terrain.");
      return;
    }
    setData(await r.json());
    setBuilding(null);
    setPlaceMode(false);
  };

  const onPickLocation = useCallback(async (lat: number, lon: number, halfM: number) => {
    setError("");
    setFetchingLoc(true);
    try {
      const r = await fetch("/api/fetch-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lon, half_m: halfM }),
      });
      await loadPayload(r);
      if (r.ok) setMapOpen(false);
    } finally {
      setFetchingLoc(false);
    }
  }, []);

  const onFile = async (f: File) => {
    if (!f.name.toLowerCase().endsWith(".dxf")) {
      setError("Please choose a .dxf survey file.");
      return;
    }
    setError("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ detail: r.statusText }));
        setError(e.detail ?? "Upload failed");
        return;
      }
      setData(await r.json());
    } finally {
      setUploading(false);
    }
  };

  /** After the site is loaded, an architect can drop their BIM model on it. */
  const onBuilding = useCallback(async (f: File) => {
    if (!data) return;
    setError("");
    setBuildingBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`/api/building/${data.id}`, { method: "POST", body: fd });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ detail: r.statusText }));
        setError(e.detail ?? "IFC conversion failed");
        return;
      }
      const mesh = await r.json();
      setBuilding(mesh);
      setPlaceMode(true); // guide the user to click where the building goes
    } finally {
      setBuildingBusy(false);
    }
  }, [data]);

  // One-click presentation looks that architects actually pitch with.
  const applyPreset = (p: Preset) => {
    if (p === "natural")  { setSlopeColor(false); setShowContours(false); setHillshade(true); }
    if (p === "slope")    { setSlopeColor(true);  setShowContours(false); setHillshade(false); }
    if (p === "contour")  { setSlopeColor(false); setShowContours(true);  setHillshade(false); }
  };

  const st = data?.stats;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>TerraSite<span className="logo-dot">.</span></h1>
          <p className="sub">True-scale 3D land analysis for architects</p>
        </header>

        {/* STEP 1 — survey: DXF upload OR satellite location pick */}
        <div className="step">
          <span className={`step-num ${data ? "done" : ""}`}>{data ? "✓" : "1"}</span>
          <div className="step-actions">
            <label className="btn primary">
              {uploading ? <><span className="spinner" /> Processing…</>
                         : data ? "Load another DXF survey" : "Upload DXF survey"}
              <input type="file" accept=".dxf" hidden disabled={uploading}
                     onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </label>
            <button className="btn" onClick={() => setMapOpen(true)}>
              Pick location on map
            </button>
          </div>
          <p className="hint small">
            No survey yet? Choose a plot on the satellite map and we will fetch real
            elevation (Copernicus GLO‑30) instantly.
          </p>
        </div>

        {error && <p className="error">{error}</p>}

        {data && (
          <>
            {/* STEP 2 — optional BIM overlay */}
            <div className="step">
              <span className={`step-num ${building ? "done" : ""}`}>{building ? "✓" : "2"}</span>
              <label className="btn">
                {buildingBusy ? <><span className="spinner" /> Converting IFC…</>
                  : building ? `Replace model (${building.name})` : "Upload building model (IFC)"}
                <input type="file" accept=".ifc,.xifc" hidden disabled={buildingBusy}
                       onChange={(e) => e.target.files?.[0] && onBuilding(e.target.files[0])} />
              </label>
              <p className="hint small">Place your design on the land to pitch it in true scale.</p>
            </div>

            {building && (
              <div className="preset-row">
                <button className={`btn small ${placeMode ? "active" : ""}`}
                        onClick={() => setPlaceMode(!placeMode)}>
                  {placeMode ? "Click terrain to place…" : "Re-place building"}
                </button>
                <button className="btn small danger"
                        onClick={() => { setBuilding(null); setPlaceMode(false); }}>
                  Remove
                </button>
              </div>
            )}

            {/* Presentation presets + camera — the quick-win UX */}
            <div className="preset-row">
              <button className="btn small" onClick={() => applyPreset("natural")}>Natural</button>
              <button className="btn small" onClick={() => applyPreset("slope")}>Slope map</button>
              <button className="btn small" onClick={() => applyPreset("contour")}>Contours</button>
            </div>
            <div className="preset-row" style={{ paddingBottom: 8 }}>
              <button className="btn small" onClick={() => setCameraView({ kind: "top" })}>Top view</button>
              <button className="btn small" onClick={() => setCameraView({ kind: "perspective" })}>3D view</button>
              <button className="btn small" onClick={() => setCameraView({ kind: "fit" })}>Fit site</button>
            </div>

            {/* SITE ANALYSIS — appears only after the 3D model is shown */}
            <Section title="Site analysis" defaultOpen>
              <table className="kv">
                <tbody>
                  {data.area_m2 != null && (
                    <tr><td>Plot area</td><td>{data.area_m2.toFixed(1)} m²</td></tr>)}
                  {data.perimeter_m != null && (
                    <tr><td>Perimeter</td><td>{data.perimeter_m.toFixed(1)} m</td></tr>)}
                  <tr><td>Elevation range</td>
                      <td>{st!.min_elev.toFixed(2)} – {st!.max_elev.toFixed(2)} m</td></tr>
                  <tr><td>Relief</td><td>{(st!.max_elev - st!.min_elev).toFixed(2)} m</td></tr>
                  <tr><td>Average slope</td>
                      <td>{((st as any).slope_mean_deg ?? 0).toFixed(1)}°</td></tr>
                  {data.contour_interval && (
                    <tr><td>Contour interval</td><td>{data.contour_interval} m</td></tr>)}
                </tbody>
              </table>
              {slopeBuckets && (
                <div className="slope-chart">
                  <p className="chart-title">Slope distribution (by area)</p>
                  {slopeBuckets.map((b) => (
                    <div key={b.label} className="bar-row">
                      <span className="bar-label">{b.label}</span>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${Math.min(100, b.pct)}%` }} />
                      </div>
                      <span className="bar-pct">{b.pct.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Display & visualization">
              <Toggle label="Elevation coloring" checked={!slopeColor} onChange={(v) => setSlopeColor(!v)} />
              <Toggle label="Slope coloring" checked={slopeColor} onChange={setSlopeColor} />
              <Toggle label="Contour lines" checked={showContours} onChange={setShowContours} />
              <Toggle label="Site boundary" checked={showBoundary} onChange={setShowBoundary} />
              <Toggle label="Ground grid" checked={showGrid} onChange={setShowGrid} />
              <Slider label="Vertical exaggeration" value={exaggeration} min={0.5} max={5}
                      step={0.1} unit="×" onChange={setExaggeration} />
              {exaggeration === 1.0 && <p className="hint">True scale — what you see is the real slope.</p>}
            </Section>

            <Section title="Light & shadow">
              <Toggle label="Hillshade" checked={hillshade} onChange={setHillshade} />
              {hillshade && (
                <>
                  <Slider label="Sun azimuth" value={sunAz} min={0} max={360} step={5}
                          unit="°" onChange={setSunAz} />
                  <Slider label="Sun altitude" value={sunAlt} min={5} max={85} step={1}
                          unit="°" onChange={setSunAlt} />
                </>
              )}
            </Section>

            <Section title="Measure">
              <Toggle label="Distance & height tool" checked={measureMode} onChange={setMeasureMode} />
              <p className="hint">Click two points on the ground to read distance and level difference.</p>
            </Section>

            <Section title="Site data (detailed)">
              <table className="kv">
                <tbody>
                  <tr><td>Min elevation</td><td>{st!.min_elev.toFixed(3)} m</td></tr>
                  <tr><td>Max elevation</td><td>{st!.max_elev.toFixed(3)} m</td></tr>
                  <tr><td>Relief</td><td>{(st!.max_elev - st!.min_elev).toFixed(3)} m</td></tr>
                  {data.area_m2 != null && (
                    <tr><td>Plot area</td><td>{data.area_m2.toFixed(1)} m²</td></tr>)}
                  {data.perimeter_m != null && (
                    <tr><td>Perimeter</td><td>{data.perimeter_m.toFixed(1)} m</td></tr>)}
                  <tr><td>Average slope</td><td>{((st as any).slope_mean_deg ?? 0).toFixed(1)}°</td></tr>
                  {data.contour_interval && (
                    <tr><td>Contour interval</td><td>{data.contour_interval} m</td></tr>)}
                </tbody>
              </table>
              <p className="hint">Survey points: {st!.positions.length.toLocaleString()} · Mesh triangles: {st!.triangles.length.toLocaleString()}</p>
            </Section>

            {building && (
              <Section title="Building model">
                <table className="kv">
                  <tbody>
                    <tr><td>Name</td><td title={building.name}>{building.name}</td></tr>
                    <tr><td>Footprint</td><td>{building.bbox.width.toFixed(1)} × {building.bbox.depth.toFixed(1)} m</td></tr>
                    <tr><td>Height</td><td>{building.bbox.height.toFixed(1)} m</td></tr>
                  </tbody>
                </table>
                <p className="hint">Base conforms to the surveyed ground at the placement point.</p>
              </Section>
            )}

            {data.warnings && data.warnings.length > 0 && (
              <Section title={`Warnings (${data.warnings.length})`}>
                <ul className="warnlist">
                  {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </Section>
            )}
          </>
        )}
      </aside>

      <main className="viewer"
            onDragOver={(e) => { if (!data) { e.preventDefault(); setDragOver(true); } }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false);
              if (!data && e.dataTransfer.files?.[0]) onFile(e.dataTransfer.files[0]);
            }}>
        {data ? (
          <TerrainScene
            data={data}
            building={building}
            placeMode={placeMode}
            onPlaced={() => setPlaceMode(false)}
            exaggeration={exaggeration}
            showContours={showContours}
            showBoundary={showBoundary}
            slopeColor={slopeColor}
            hillshade={hillshade}
            sunAzimuthDeg={sunAz}
            sunAltitudeDeg={sunAlt}
            showGrid={showGrid}
            measureMode={measureMode}
            cameraView={cameraView}
            onCameraDone={() => setCameraView(null)}
          />
        ) : (
          <div className="empty">
            <h2>See your land in true-scale 3D</h2>
            <p>Start with one of the two options below. The 3D model appears instantly,
               then slope analysis and visualization tools unlock — and you can drop
               your building design (IFC) right onto the terrain.</p>

            <div className="choice-grid">
              <label className={`choice-card ${dragOver ? "drag" : ""}`}>
                <span className="choice-icon">📐</span>
                <span className="choice-title">Upload DXF survey</span>
                <span className="choice-desc">
                  Land survey with spot levels (POINT / CONTPOINT entities).
                  Drop the file here or click to browse.
                </span>
                {uploading && <span className="choice-desc">Processing…</span>}
                <input type="file" accept=".dxf" hidden disabled={uploading}
                       onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </label>

              <button className="choice-card" onClick={() => setMapOpen(true)}>
                <span className="choice-icon">🗺️</span>
                <span className="choice-title">Select land on map</span>
                <span className="choice-desc">
                  Pick any plot on the satellite map — we fetch real elevation
                  (Copernicus GLO‑30) for that area automatically.
                </span>
                {fetchingLoc && <span className="choice-desc">Fetching elevation…</span>}
              </button>
            </div>
          </div>
        )}
      </main>

      {mapOpen && <MapPicker onPick={onPickLocation} busy={fetchingLoc} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
