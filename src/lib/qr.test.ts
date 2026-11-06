import { create } from "qrcode";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorldConnectQr } from "@/components/world-connect-qr";
import { qrMatrix } from "./qr";

// This is a previously issued, now-expired request used for deterministic tests.
const uri = "https://staging.world.org/verify?t=wld&i=c4056bd6-745a-4c1f-85d5-005ff13b3b9d&k=IKb4S8NnySQA%2BxrNl%2BIvj7cdFbJmnU29xI50nbDOTvY%3D";
const options = { errorCorrectionLevel: "M" } as const;

describe("World ID connect QR", () => {
  it("preserves every module in standard row-major order", () => {
    const actual = qrMatrix(uri);
    const expected = create(uri, options).modules;
    expect(actual.length).toBe(expected.size);
    for (let row = 0; row < expected.size; row++) {
      for (let col = 0; col < expected.size; col++) {
        expect(actual[row][col], `module at row ${row}, col ${col}`).toBe(Boolean(expected.get(row, col)));
      }
    }
  });

  it("does not transpose the near-edge alignment pattern", () => {
    const actual = qrMatrix(uri);
    const expected = create(uri, options).modules;
    const start = actual.length - 10;
    for (let row = start; row < start + 5; row++) {
      for (let col = start; col < start + 5; col++) {
        expect(actual[row][col]).toBe(Boolean(expected.get(row, col)));
      }
    }
  });

  it("renders exactly the generated matrix, retaining the three finder patterns", () => {
    const expected = qrMatrix(uri);
    const html = renderToStaticMarkup(createElement(WorldConnectQr, { connectorUri: uri }));
    const rendered = new Map([...html.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"/g)]
      .map((match) => [`${match[2]},${match[1]}`, true]));
    const actual = expected.map((row, y) => row.map((_, x) => rendered.has(`${y},${x}`)));
    expect(actual).toEqual(expected);
  });
});
