// @vitest-environment jsdom

import { proofOfHuman, useIDKitRequest, type IDKitResult, type UseIDKitRequestHookResult } from "@worldcoin/idkit";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldConnectDialog } from "./world-connect-dialog";

vi.mock("@worldcoin/idkit", async (load) => {
  const actual = await load<typeof import("@worldcoin/idkit")>();
  return { ...actual, useIDKitRequest: vi.fn() };
});

describe("World connector lifecycle", () => {
  let root: Root;
  let element: HTMLDivElement;
  let flow: UseIDKitRequestHookResult;
  afterEach(() => root.unmount());
  beforeEach(() => {
    element = document.createElement("div");
    document.body.append(element);
    root = createRoot(element);
    flow = {
      open: vi.fn(), reset: vi.fn(), isAwaitingUserConnection: false,
      isAwaitingUserConfirmation: false, isSuccess: false, isError: false,
      connectorURI: null, result: null, errorCode: null,
      getDebugReport: vi.fn(), isOpen: false, isInWorldApp: false,
    };
    vi.mocked(useIDKitRequest).mockImplementation(() => flow);
  });

  it("opens once, follows polling without reopening, and forwards the result", async () => {
    const onSuccess = vi.fn();
    const render = () => act(async () => {
      root.render(createElement(WorldConnectDialog, {
        app_id: "app_test", action: "test-action", rp_context: {
          rp_id: "rp_test", nonce: "0xtest", created_at: 1, expires_at: 999,
          signature: "0xsignature",
        }, allow_legacy_proofs: false, preset: proofOfHuman(), onClose: vi.fn(), onSuccess, onError: vi.fn(),
      }));
    });
    await render();
    expect(flow.open).toHaveBeenCalledTimes(1);
    flow = { ...flow, connectorURI: "https://staging.world.org/verify?t=wld&i=official&k=signed" };
    await render();
    expect(flow.open).toHaveBeenCalledTimes(1);
    expect(element.querySelector("a[href]")?.getAttribute("href")).toBe(flow.connectorURI);
    expect(element.querySelector("p.break-all")?.textContent).toContain(flow.connectorURI);
    flow = { ...flow, result: { success: true } as unknown as IDKitResult, isSuccess: true };
    await render();
    expect(onSuccess).toHaveBeenCalledWith(flow.result);
  });
});
