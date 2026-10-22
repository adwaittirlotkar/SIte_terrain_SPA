import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef, useState } from "react";

/**
 * MapPicker — satellite map for choosing a site location when no DXF survey
 * is available. Leaflet is used imperatively (not react-leaflet) so the map
 * instance survives React re-renders cleanly inside our modal.
 */
export default function MapPicker({ onPick, busy }:
  { onPick: (lat: number, lon: number, halfM: number) => void; busy: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(null);
  const [halfM, setHalfM] = useState(150);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, { zoomControl: true, attributionControl: true })
      .setView([19.076, 72.877], 5); // India default
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri" }
    ).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      if (markerRef.current) markerRef.current.setLatLng(e.latlng);
      else markerRef.current = L.marker(e.latlng).addTo(map);
      updateCircle(lat, lng, halfM);
      setPicked({ lat, lon: lng });
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateCircle(lat: number, lon: number, radiusM: number) {
    const map = mapRef.current;
    if (!map) return;
    if (circleRef.current) circleRef.current.setLatLng([lat, lon]).setRadius(radiusM);
    else circleRef.current = L.circle([lat, lon], {
      radius: radiusM, color: "#8ab4ff", weight: 1.5, fillOpacity: 0.08, dashArray: "6 4",
    }).addTo(map);
  }

  useEffect(() => {
    if (picked) updateCircle(picked.lat, picked.lon, halfM);
  }, [halfM]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-backdrop">
      <div className="modal map-modal">
        <div className="modal-head">
          <h3>Pick your plot on the satellite map</h3>
          <button className="icon-btn" onClick={() => (mapRef.current?.remove(), mapRef.current = null)}
                  aria-label="Close">✕</button>
        </div>
        <p className="hint">
          Click anywhere to drop the pin. Elevation comes from the public Copernicus
          GLO‑30 model (~30 m grid) — great for visual studies, not survey-grade.
        </p>
        <div ref={hostRef} className="map-host" />
        <div className="map-controls">
          <label className="slider compact">
            <div className="slider-row"><span>Site radius</span><b>{halfM} m</b></div>
            <input type="range" min={50} max={500} step={10} value={halfM}
                   onChange={(e) => setHalfM(parseInt(e.target.value))} />
          </label>
          <button
            className="btn primary"
            disabled={!picked || busy}
            onClick={() => picked && onPick(picked.lat, picked.lon, halfM)}>
            {busy ? "Fetching elevation…" : picked ? "Build terrain here" : "Click the map first"}
          </button>
        </div>
      </div>
    </div>
  );
}
