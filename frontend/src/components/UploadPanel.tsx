import { useCallback, useRef, useState } from "react";

interface Props {
  onFile: (file: File) => void;
  isLoading: boolean;
  error: string | null;
}

export default function UploadPanel({ onFile, isLoading, error }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [onFile]
  );

  return (
    <div className="w-full h-full flex items-center justify-center blueprint-grid">
      <div className="max-w-md w-full mx-4">
        <p className="text-[11px] uppercase tracking-[0.2em] text-muted mb-2 text-center">
          SPA Site Intelligence
        </p>
        <h1 className="font-display text-3xl font-semibold text-ink text-center mb-1">
          Survey → Digital Site Model
        </h1>
        <p className="text-sm text-muted text-center mb-8">
          Upload a DXF survey to generate an interactive 3D terrain model —
          boundary, elevation, slope, all computed, none of it guessed.
        </p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`rounded-lg border-2 border-dashed p-10 text-center cursor-pointer transition-colors
            ${isDragging ? "border-amber bg-amber/5" : "border-border bg-panel hover:border-teal/60"}`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".dxf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
            }}
          />
          {isLoading ? (
            <p className="readout text-sm text-teal">Processing survey…</p>
          ) : (
            <>
              <p className="text-sm text-ink mb-1">Drop a .dxf file here, or click to browse</p>
              <p className="text-xs text-muted">DWG? Convert to DXF first — see README.</p>
            </>
          )}
        </div>

        {error && (
          <div className="mt-4 text-xs leading-relaxed text-warn bg-warn/10 border border-warn/30 rounded px-3 py-2.5">
            {error}
          </div>
        )}

        <p className="text-[11px] text-muted text-center mt-6">
          No sample data? Run{" "}
          <code className="readout text-ink/80">python sample_data/generate_sample_dxf.py</code> in{" "}
          <code className="readout text-ink/80">backend/</code> for a synthetic test parcel.
        </p>
      </div>
    </div>
  );
}
