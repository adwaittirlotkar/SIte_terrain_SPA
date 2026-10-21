import { SiteData, SlopeAnalysis, GroundwaterData, GroundwaterMineral } from "../types";

interface Props {
  site: SiteData;
  onReset: () => void;
  groundwaterData: GroundwaterData | null;
}

function fmt(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export default function Sidebar({ site, onReset, groundwaterData }: Props) {
  return (
    <aside className="w-80 shrink-0 bg-panel border-r border-border flex flex-col h-full overflow-y-auto">
      <div className="px-5 pt-5 pb-4 border-b border-border">
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted mb-1">Site Model</p>
        <h1 className="font-display text-lg font-semibold text-ink leading-tight break-all">
          {site.filename}
        </h1>
        <button
          onClick={onReset}
          className="mt-3 text-xs text-muted hover:text-amber transition-colors underline underline-offset-2"
        >
          Upload a different survey
        </button>
      </div>

      <Section title="Boundary">
        <StatusPill status={site.boundary.status} />
        <Row label="Area" value={site.boundary.area_m2 ? `${fmt(site.boundary.area_m2, 0)} m²` : "—"} />
        <Row label="Perimeter" value={site.boundary.perimeter_m ? `${fmt(site.boundary.perimeter_m, 0)} m` : "—"} />
        <Row label="Source layer" value={site.boundary.layer ?? "—"} />
      </Section>

      <Section title="Elevation">
        <ElevationLegend min={site.elevation.min} max={site.elevation.max} />
        <Row label="Min" value={`${fmt(site.elevation.min)} m`} />
        <Row label="Max" value={`${fmt(site.elevation.max)} m`} />
        <Row label="Mean" value={`${fmt(site.elevation.mean)} m`} />
        <Row label="Relief" value={`${fmt(site.elevation.range)} m`} />
        <p className="text-[10px] text-muted mt-2 leading-relaxed">{site.elevation_reference}</p>
      </Section>

      <Section title="Slope analysis">
        <SlopeBreakdown analysis={site.slope_analysis} />
        <p className="text-[10px] text-muted mt-2.5 leading-relaxed">{site.slope_analysis.note}</p>
      </Section>

      <Section title="Terrain">
        <Row label="Survey points" value={site.point_count.toLocaleString()} />
        <Row label="TIN faces" value={site.face_count.toLocaleString()} />
        <Row label="Avg. slope" value={`${fmt(site.average_slope_percent)} %`} />
      </Section>

      {groundwaterData?.available && (
        <>
          <Section title="Groundwater — nearest known well">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ background: "#3d7ce8" }} />
              <span className="text-sm text-ink font-medium">{groundwaterData.station_name}</span>
            </div>
            <Row label="Distance from site" value={`${fmt(groundwaterData.distance_km, 1)} km`} />
            <Row label="District" value={groundwaterData.district ?? "—"} />
            <Row label="Depth to water" value={`${fmt(groundwaterData.latest_reading.depth_below_ground_m, 1)} m below ground`} />
            <Row label="Measured on" value={groundwaterData.latest_reading.date} />
            {groundwaterData.depth_trend && (
              <div className="mt-2 flex items-center gap-1.5">
                <TrendIcon trend={groundwaterData.depth_trend} />
                <span className="text-xs text-ink/70">
                  Water table is{" "}
                  <span className={
                    groundwaterData.depth_trend === "rising" ? "text-teal" :
                    groundwaterData.depth_trend === "falling" ? "text-warn" : "text-muted"
                  }>
                    {groundwaterData.depth_trend}
                  </span>
                  {" "}(based on recent readings)
                </span>
              </div>
            )}
            {/* Recent depth trend sparkline */}
            {groundwaterData.recent_readings.length > 1 && (
              <div className="mt-3">
                <p className="text-[10px] uppercase tracking-[0.12em] text-muted mb-1.5">Depth trend</p>
                <DepthSparkline readings={groundwaterData.recent_readings} />
              </div>
            )}
            <p className="text-[10px] text-muted mt-2.5 leading-relaxed">{groundwaterData.note}</p>
            <p className="text-[10px] text-muted mt-1 leading-relaxed">Source: {groundwaterData.source}</p>
          </Section>

          <Section title="Groundwater flow direction">
            <FlowDirectionDial bearing={groundwaterData.flow_direction.bearing_deg} />
            <p className="text-xs text-ink mt-2">{groundwaterData.flow_direction.direction_label}</p>
            <p className="text-[10px] text-muted mt-1.5 leading-relaxed">{groundwaterData.flow_direction.basis}</p>
          </Section>

          <Section title="Water quality — regional profile">
            <div className={`mb-3 px-2.5 py-2 rounded border text-xs leading-relaxed ${
              groundwaterData.water_quality.overall_rating.toLowerCase().includes("caution")
                ? "bg-warn/10 border-warn/30 text-warn"
                : "bg-teal/10 border-teal/30 text-teal"
            }`}>
              {groundwaterData.water_quality.overall_rating}
            </div>
            <Row label="Aquifer type" value={groundwaterData.water_quality.aquifer_type} />
            <Row label="Hardness" value={groundwaterData.water_quality.hardness_class} />
            <Row label="pH range" value={groundwaterData.water_quality.ph_range} />
            <div className="mt-3">
              <p className="text-[10px] uppercase tracking-[0.12em] text-muted mb-2">Minerals (typical)</p>
              <div className="flex flex-col gap-2">
                {groundwaterData.water_quality.minerals.map((m: GroundwaterMineral) => (
                  <MineralRow key={m.mineral} mineral={m} />
                ))}
              </div>
            </div>
            <div className="mt-3 text-[10px] text-muted leading-relaxed bg-panelAlt border border-border rounded px-2.5 py-2">
              <strong className="text-ink/60">Disclaimer: </strong>
              {groundwaterData.water_quality.disclaimer}
            </div>
            <p className="text-[10px] text-muted mt-1.5">Ref: {groundwaterData.water_quality.standards_reference}</p>
          </Section>
        </>
      )}

      <Section title="Source layers">
        <div className="flex flex-col gap-1.5">
          {Object.entries(site.layer_summary).map(([layer, count]) => (
            <div key={layer} className="flex items-center justify-between text-xs">
              <span className="text-ink/80 truncate mr-2">{layer}</span>
              <span className="readout text-muted">{count}</span>
            </div>
          ))}
        </div>
      </Section>

      {site.warnings.length > 0 && (
        <Section title="Notes">
          <div className="flex flex-col gap-2">
            {site.warnings.map((w, i) => (
              <div key={i} className="text-xs leading-relaxed text-warn/90 bg-warn/10 border border-warn/30 rounded px-2.5 py-2">
                {w}
              </div>
            ))}
          </div>
        </Section>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4 border-b border-border">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted mb-3">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className="text-sm text-ink/70">{label}</span>
      <span className="readout text-sm text-ink">{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    FOUND: "bg-teal/15 text-teal border-teal/40",
    AMBIGUOUS: "bg-amber/15 text-amber border-amber/40",
    NOT_FOUND: "bg-muted/15 text-muted border-muted/40",
  };
  const labels: Record<string, string> = {
    FOUND: "Boundary detected",
    AMBIGUOUS: "Boundary inferred — verify",
    NOT_FOUND: "No boundary found",
  };
  return (
    <span className={`inline-block text-[11px] px-2 py-1 rounded border mb-2 ${styles[status] ?? styles.NOT_FOUND}`}>
      {labels[status] ?? status}
    </span>
  );
}

function ElevationLegend({ min, max }: { min: number; max: number }) {
  return (
    <div className="mb-3">
      <div className="h-2 rounded-full w-full" style={{ background: "linear-gradient(90deg, #1F7A70, #E8A33D)" }} />
      <div className="flex justify-between mt-1 text-[10px] readout text-muted">
        <span>{min.toFixed(1)} m</span>
        <span>{max.toFixed(1)} m</span>
      </div>
    </div>
  );
}

const SLOPE_BANDS = [
  { key: "buildable_pct" as const, label: "Buildable (0–10°)", color: "#3FA88C" },
  { key: "moderate_pct" as const, label: "Moderate (10–25°)", color: "#E8A33D" },
  { key: "steep_pct" as const, label: "Steep (25°+)", color: "#E8623D" },
];

function SlopeBreakdown({ analysis }: { analysis: SlopeAnalysis }) {
  return (
    <div>
      <div className="flex h-2.5 rounded-full overflow-hidden mb-2.5 bg-line">
        {SLOPE_BANDS.map((b) => (
          <div key={b.key} style={{ width: `${analysis[b.key]}%`, background: b.color }} />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        {SLOPE_BANDS.map((b) => (
          <div key={b.key} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-ink/80">
              <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: b.color }} />
              {b.label}
            </span>
            <span className="readout text-ink">{analysis[b.key].toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Groundwater helper components ---

function TrendIcon({ trend }: { trend: "rising" | "falling" | "stable" }) {
  if (trend === "rising")  return <span className="text-teal text-sm">↑</span>;
  if (trend === "falling") return <span className="text-warn text-sm">↓</span>;
  return <span className="text-muted text-sm">→</span>;
}

function DepthSparkline({ readings }: { readings: Array<{ date: string; depth_below_ground_m: number }> }) {
  // Show last 6 readings oldest-first so the line reads left=past right=present
  const pts = [...readings].reverse().slice(0, 6);
  const depths = pts.map((r) => r.depth_below_ground_m);
  const minD = Math.min(...depths);
  const maxD = Math.max(...depths);
  const range = Math.max(maxD - minD, 0.1);
  const W = 200, H = 36, pad = 4;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  // Deeper = lower water table = higher on screen (inverted — deeper is "worse")
  const y = (d: number) => pad + ((d - minD) / range) * (H - pad * 2);
  const pathD = pts.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(r.depth_below_ground_m).toFixed(1)}`).join(" ");

  return (
    <div>
      <svg width={W} height={H} className="w-full overflow-visible">
        <polyline points={pts.map((r, i) => `${x(i)},${y(r.depth_below_ground_m)}`).join(" ")} fill="none" stroke="#3d7ce8" strokeWidth={1.5} strokeLinejoin="round" />
        <path d={pathD} fill="none" />
        {pts.map((r, i) => (
          <circle key={i} cx={x(i)} cy={y(r.depth_below_ground_m)} r={2.5} fill="#3d7ce8" />
        ))}
      </svg>
      <div className="flex justify-between text-[9px] readout text-muted mt-0.5">
        <span>older</span>
        <span>latest ({depths[depths.length - 1].toFixed(1)} m)</span>
      </div>
    </div>
  );
}

function FlowDirectionDial({ bearing }: { bearing: number }) {
  // Arrow points in the direction water flows, rotated from north
  const rad = (bearing * Math.PI) / 180;
  const cx = 28, cy = 28, r = 20;
  const ax = cx + Math.sin(rad) * r * 0.7;
  const ay = cy - Math.cos(rad) * r * 0.7;
  return (
    <div className="flex items-center gap-3">
      <svg width={56} height={56} className="shrink-0">
        {/* compass rose circle */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#233040" strokeWidth={1.5} />
        {/* N/S/E/W labels */}
        <text x={cx} y={cy - r + 6} textAnchor="middle" fontSize={7} fill="#7C8B99">N</text>
        <text x={cx} y={cy + r - 1} textAnchor="middle" fontSize={7} fill="#7C8B99">S</text>
        <text x={cx + r - 3} y={cy + 3} textAnchor="middle" fontSize={7} fill="#7C8B99">E</text>
        <text x={cx - r + 3} y={cy + 3} textAnchor="middle" fontSize={7} fill="#7C8B99">W</text>
        {/* flow arrow */}
        <line
          x1={cx - Math.sin(rad) * r * 0.45}
          y1={cy + Math.cos(rad) * r * 0.45}
          x2={ax}
          y2={ay}
          stroke="#3d7ce8"
          strokeWidth={2}
          strokeLinecap="round"
        />
        {/* arrowhead */}
        <circle cx={ax} cy={ay} r={3} fill="#3d7ce8" />
      </svg>
      <span className="text-[10px] text-muted leading-snug">{bearing.toFixed(0)}° from N</span>
    </div>
  );
}

function MineralRow({ mineral }: { mineral: GroundwaterMineral }) {
  const isCaution = mineral.role.toLowerCase().includes("caution");
  return (
    <div className={`rounded px-2.5 py-2 border text-xs ${isCaution ? "bg-warn/8 border-warn/25" : "bg-panelAlt border-border"}`}>
      <div className="flex items-start justify-between gap-2">
        <span className={`font-medium ${isCaution ? "text-warn" : "text-ink/90"}`}>{mineral.mineral}</span>
        <span className="readout text-muted shrink-0 text-[10px]">{mineral.typical_range}</span>
      </div>
      <p className={`mt-0.5 leading-snug ${isCaution ? "text-warn/80" : "text-muted"}`}>{mineral.role}</p>
    </div>
  );
}
