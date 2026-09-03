/**
 * The companion's injection bookkeeping. Both behaviours here are regressions that were
 * measured on live Discord (AGENTS.md §12, 2026-09-02), not hypotheticals:
 *
 * - `companion.ts` subscribes to both `targetcreated` and `targetchanged`, which fire for the
 *   same page, so `attachKibitz` must claim the page BEFORE its first await or the second
 *   call reaches `exposeFunction` and Puppeteer rejects with "already exposed".
 * - `replaceBundle` exists so a rebuilt bundle reaches the next reload; it must remove the
 *   previous init script rather than stack a second copy, and must refuse a page whose attach
 *   has not finished.
 */
import { describe, expect, it, vi } from "vitest";
import type { Page } from "puppeteer-core";
import { attachKibitz, replaceBundle } from "../../desktop/inject";

/**
 * A stand-in for the parts of Page injection uses. `exposeFunction` mimics Puppeteer's real
 * failure (a second call for the same name rejects), which is the trap under test; the
 * deferred resolution lets a test hold the first attach open and start a second.
 */
function fakePage(): {
  page: Page;
  scripts: Map<string, string>;
  exposeCalls: number;
  releaseExpose: () => void;
  callBinding: (json: string) => Promise<string>;
} {
  const scripts = new Map<string, string>();
  const exposed = new Set<string>();
  let installed: ((json: string) => Promise<string>) | null = null;
  let nextId = 1;
  const gate = Promise.withResolvers<void>();
  const state = {
    exposeCalls: 0,
    releaseExpose: gate.resolve,
    /** Calls the page binding the way the renderer does, to see which handler answers. */
    callBinding: async (json: string): Promise<string> => {
      if (installed === null) throw new Error("no binding installed");
      return await installed(json);
    },
    scripts,
    page: {
      url: () => "https://discord.com/channels/@me",
      once: () => undefined,
      exposeFunction: async (name: string, fn: (json: string) => Promise<string>) => {
        state.exposeCalls++;
        if (exposed.has(name)) throw new Error(`Failed to add page binding with name ${name}: already exposed`);
        exposed.add(name);
        installed = fn;
        await gate.promise;
      },
      evaluateOnNewDocument: async (source: string) => {
        const identifier = String(nextId++);
        scripts.set(identifier, source);
        return { identifier };
      },
      removeScriptToEvaluateOnNewDocument: async (identifier: string) => {
        scripts.delete(identifier);
      },
      evaluate: async () => undefined,
    } as unknown as Page,
  };
  return state;
}

describe("attachKibitz", () => {
  it("claims the page before awaiting, so overlapping target events do not double-expose", async () => {
    const fake = fakePage();
    const onRequest = vi.fn();
    // targetcreated and targetchanged, back to back, with nothing awaited in between.
    const first = attachKibitz(fake.page, { bundle: "//v1", onRequest });
    const second = attachKibitz(fake.page, { bundle: "//v1", onRequest });
    fake.releaseExpose();
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(fake.exposeCalls).toBe(1);
    expect([...fake.scripts.values()]).toEqual(["//v1"]);
  });

  it("retries after a failure that happened AFTER the binding installed, without re-exposing", async () => {
    // Real Puppeteer cannot undo `exposeFunction`, so a retry that calls it again can only
    // reject with "already exposed". The window that died between the two CDP calls used to
    // be unrecoverable for exactly that reason.
    const fake = fakePage();
    fake.releaseExpose();
    vi.spyOn(fake.page, "evaluateOnNewDocument").mockRejectedValueOnce(new Error("Target closed"));
    const first = vi.fn();
    await expect(attachKibitz(fake.page, { bundle: "//v1", onRequest: first })).rejects.toThrow("Target closed");

    const second = vi.fn().mockResolvedValue('{"ok":true}');
    await expect(attachKibitz(fake.page, { bundle: "//v1", onRequest: second })).resolves.toBeUndefined();
    expect(fake.exposeCalls).toBe(1);
    // The binding routes to the handler from the attach that actually completed.
    await fake.callBinding('{"type":"ping"}');
    expect(second).toHaveBeenCalledWith('{"type":"ping"}');
    expect(first).not.toHaveBeenCalled();
  });

  it("re-exposes on the retry when the BINDING itself failed, so the page really gets one", async () => {
    const fake = fakePage();
    fake.releaseExpose();
    // A window that dies mid-attach: the binding never installs. The trap this pins is an
    // attach that "succeeds" by skipping `exposeFunction` because some earlier bookkeeping
    // already recorded the page — the panel would then talk to a binding that is not there.
    vi.spyOn(fake.page, "exposeFunction").mockRejectedValueOnce(new Error("Target closed"));
    await expect(attachKibitz(fake.page, { bundle: "//v1", onRequest: vi.fn() })).rejects.toThrow("Target closed");

    const handler = vi.fn().mockResolvedValue('{"ok":true}');
    await expect(attachKibitz(fake.page, { bundle: "//v1", onRequest: handler })).resolves.toBeUndefined();
    // One counted call: the first attempt was replaced by the rejecting mock, so this count
    // is the retry's own call reaching the fake — i.e. the binding was installed, not assumed.
    expect(fake.exposeCalls).toBe(1);
    expect([...fake.scripts.values()]).toEqual(["//v1"]);
    // The decisive part: a call from the page reaches the handler, which is only possible if
    // the retry installed the binding rather than assuming it was there.
    await expect(fake.callBinding('{"type":"ping"}')).resolves.toBe('{"ok":true}');
    expect(handler).toHaveBeenCalledWith('{"type":"ping"}');
  });
});

describe("replaceBundle", () => {
  it("swaps the init script instead of stacking a second copy", async () => {
    const fake = fakePage();
    fake.releaseExpose();
    await attachKibitz(fake.page, { bundle: "//old", onRequest: vi.fn() });
    await expect(replaceBundle(fake.page, "//new")).resolves.toBe(true);
    // One script, and it is the new one: a stale copy left behind would run on the next
    // document and re-mount the old renderer.
    expect([...fake.scripts.values()]).toEqual(["//new"]);
    await expect(replaceBundle(fake.page, "//newer")).resolves.toBe(true);
    expect([...fake.scripts.values()]).toEqual(["//newer"]);
  });

  it("refuses a page that was never attached", async () => {
    await expect(replaceBundle(fakePage().page, "//new")).resolves.toBe(false);
  });

  it("refuses a page whose attach is still in flight, which will register the fresh bundle anyway", async () => {
    const fake = fakePage();
    const attaching = attachKibitz(fake.page, { bundle: "//old", onRequest: vi.fn() });
    await expect(replaceBundle(fake.page, "//new")).resolves.toBe(false);
    fake.releaseExpose();
    await attaching;
  });
});
