import { qrMatrix } from "@/lib/qr";

/** Render the official IDKit connector URI, without creating our own request. */
export function WorldConnectQr({ connectorUri }: { connectorUri: string }) {
  const modules = qrMatrix(connectorUri);
  return (
    <svg
      role="img"
      aria-label="World ID connect QR"
      data-testid="world-connect-qr"
      className="mx-auto size-64 rounded-2xl bg-white p-3"
      viewBox={`0 0 ${modules.length} ${modules.length}`}
      shapeRendering="crispEdges"
    >
      {modules.flatMap((row, y) => row.map((dark, x) => dark
        ? <rect key={`${y}-${x}`} x={x} y={y} width="1" height="1" fill="#000" />
        : null))}
    </svg>
  );
}
