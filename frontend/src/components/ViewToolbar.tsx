import { ColorMode, ViewPreset } from "./TerrainViewer";

interface Props {
  colorMode: ColorMode;
  onColorModeChange: (m: ColorMode) => void;
  onView: (preset: ViewPreset) => void;
  isLocationBased: boolean;
  showPlace: boolean;
  onShowPlaceChange: (v: boolean) => void;
  isPlaceLoading: boolean;
}

export default function ViewToolbar({
  colorMode,
  onColorModeChange,
  onView,
  isLocationBased,
  showPlace,
  onShowPlaceChange,
  isPlaceLoading,
}: Props) {
  return (
    <div className="absolute top-4 left-4 bg-panel/90 border border-border rounded-lg px-3 py-2.5 backdrop-blur-sm flex flex-col gap-2.5 max-w-[13rem]">
      <div>
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted mb-1.5">Color by</p>
        <div className="flex gap-1 flex-wrap">
          <ToggleButton active={colorMode === "elevation"} onClick={() => onColorModeChange("elevation")}>
            Elevation
          </ToggleButton>
          <ToggleButton active={colorMode === "slope"} onClick={() => onColorModeChange("slope")}>
            Slope
          </ToggleButton>
        </div>
        {colorMode === "elevation" && (
          <div className="mt-1.5">
            <div
              className="h-2 rounded-full w-full"
              style={{ background: "linear-gradient(90deg, #4a5f3a, #6b5d52, #e8f0f5)" }}
            />
            <div className="flex justify-between mt-1 text-[9px] readout text-muted">
              <span>Grass</span>
              <span>Rock</span>
              <span>Snow</span>
            </div>
          </div>
        )}
        {colorMode === "slope" && (
          <div className="mt-1.5">
            <div
              className="h-2 rounded-full w-full"
              style={{ background: "linear-gradient(90deg, #3FA88C, #E8623D)" }}
            />
            <div className="flex justify-between mt-1 text-[9px] readout text-muted">
              <span>0°</span>
              <span>35°+</span>
            </div>
            <p className="text-[10px] text-muted mt-1.5 leading-snug">
              Green = flatter, likely buildable. Red = steep.
            </p>
          </div>
        )}
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted mb-1.5">View</p>
        <div className="flex gap-1">
          <ViewButton onClick={() => onView("iso")}>Iso</ViewButton>
          <ViewButton onClick={() => onView("top")}>Top</ViewButton>
          <ViewButton onClick={() => onView("side")}>Side</ViewButton>
        </div>
      </div>
      <div className="pt-1.5 border-t border-border">
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted mb-1.5">Mode</p>
        <div className="flex gap-1">
          <ToggleButton active={!showPlace} onClick={() => onShowPlaceChange(false)}>
            Terrain
          </ToggleButton>
          <ToggleButton
            active={showPlace}
            onClick={() => onShowPlaceChange(true)}
            disabled={!isLocationBased}
            title={!isLocationBased ? "Only available for terrain fetched via 'Pick a Real Location'" : undefined}
          >
            {isPlaceLoading ? "Loading…" : "Place (buildings)"}
          </ToggleButton>
        </div>
        {showPlace && (
          <p className="text-[10px] text-muted mt-1.5 leading-snug">
            Real OSM buildings/roads draped on the terrain. Gray buildings have
            an estimated (not surveyed) height.
          </p>
        )}
      </div>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
  disabled,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
        disabled
          ? "border-border text-muted/40 cursor-not-allowed"
          : active
          ? "bg-teal/15 border-teal/40 text-teal"
          : "border-border text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function ViewButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-2.5 py-1 rounded border border-border text-muted hover:text-ink hover:border-teal/40 transition-colors"
    >
      {children}
    </button>
  );
}
