interface Props {
  hover: { x: number; y: number; z: number } | null;
  projectId: string;
}

export default function StatusBar({ hover, projectId }: Props) {
  return (
    <div className="h-9 shrink-0 bg-panelAlt border-t border-border flex items-center justify-between px-4 text-xs">
      <div className="readout text-muted">
        project <span className="text-ink/70">{projectId.slice(0, 8)}</span>
      </div>
      <div className="readout flex gap-5">
        <Coord label="X" value={hover?.x} />
        <Coord label="Y" value={hover?.y} />
        <Coord label="Z" value={hover?.z} highlight />
      </div>
    </div>
  );
}

function Coord({ label, value, highlight }: { label: string; value?: number; highlight?: boolean }) {
  return (
    <span className={highlight ? "text-amber" : "text-ink/80"}>
      {label}: {value !== undefined ? value.toFixed(2) : "—.——"}
    </span>
  );
}
