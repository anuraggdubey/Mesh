import { create } from "qrcode";

/** The library's row-major matrix, including standard finder/alignment modules. */
export function qrMatrix(connectUrl: string): boolean[][] {
  const modules = create(connectUrl, { errorCorrectionLevel: "M" }).modules;
  return Array.from({ length: modules.size }, (_, row) =>
    Array.from({ length: modules.size }, (_, col) => Boolean(modules.get(row, col))),
  );
}
