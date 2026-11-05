"use client";

import type { RefObject } from "react";
import type { TileUi } from "@/lib/ui/job-view";

export const PROVIDER_COLORS = ["#38bdf8", "#f472b6", "#facc15", "#34d399", "#a78bfa", "#fb923c", "#22d3ee", "#f87171"];

export function providerColor(providers: string[], owner: string | null): string {
  if (!owner) return "transparent";
  const i = providers.findIndex((p) => p.toLowerCase() === owner.toLowerCase());
  return i < 0 ? "#a1a1aa" : PROVIDER_COLORS[i % PROVIDER_COLORS.length];
}

/**
 * The render as it assembles: a full-resolution canvas that tiles are painted onto as they arrive, with a grid
 * overlay that dims tiles not computed yet and outlines each tile in its provider's color.
 */
export function TileImage({
  canvasRef,
  width,
  height,
  gridCols,
  gridRows,
  tiles,
  providers,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  width: number;
  height: number;
  gridCols: number;
  gridRows: number;
  tiles: TileUi[];
  providers: string[];
}) {
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-zinc-400/30 bg-black" style={{ aspectRatio: `${width} / ${height}` }}>
      <canvas ref={canvasRef} width={width} height={height} className="absolute inset-0 h-full w-full" aria-label="Rendered image" />
      <div
        className="absolute inset-0 grid"
        style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gridTemplateRows: `repeat(${gridRows}, 1fr)` }}
        aria-hidden
      >
        {Array.from({ length: gridCols * gridRows }, (_, i) => {
          const t = tiles[i];
          const status = t?.status ?? "pending";
          const color = providerColor(providers, t?.owner ?? null);
          return (
            <div
              key={i}
              data-tile={i}
              data-status={status}
              className={status === "uploaded" ? "" : status === "assigned" ? "animate-pulse bg-white/10" : "bg-black/60"}
              style={{ boxShadow: `inset 0 0 0 1px ${status === "uploaded" ? `${color}55` : "rgba(255,255,255,0.08)"}` }}
            />
          );
        })}
      </div>
    </div>
  );
}
