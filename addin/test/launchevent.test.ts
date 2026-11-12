import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { completed: () => void }) => void;
let handlers: Record<string, Handler>;
let settings: Record<string, string>;
let addAsync: ReturnType<typeof vi.fn>;
let setAsync: ReturnType<typeof vi.fn>;
const later = (fn: () => void) => queueMicrotask(fn); // Outlook calls back asynchronously
const flush = () => new Promise((r) => setTimeout(r, 0));

const REPLY_HTML =
  '<div>x</div><div id="appendonsend"></div><div>From: Tim</div>' +
  '<img data-imagetype="AttachmentByCid" src="data:image/gif;base64,R0lG" alt="Regards">';

function installOfficeMock(opts: { addThrows?: boolean; noItem?: boolean; removeOld?: boolean; body?: string } = {}) {
  handlers = {};
  settings = opts.removeOld ? { "ostg.removeOldSignatures": "1", "ostg.recentNames": '["Regards"]' } : {};
  addAsync = vi.fn((_k: string, _d: unknown, cb: () => void) => {
    if (opts.addThrows) throw new Error("boom");
    later(cb);
  });
  setAsync = vi.fn((_html: string, _o: unknown, cb: () => void) => later(cb));
  const item = {
    notificationMessages: { addAsync },
    body: {
      getAsync: (_t: unknown, cb: (r: unknown) => void) => later(() => cb({ status: "succeeded", value: opts.body ?? REPLY_HTML })),
      setAsync,
    },
  };
  (globalThis as any).Office = {
    actions: { associate: (name: string, fn: Handler) => (handlers[name] = fn) },
    context: {
      roamingSettings: {
        get: (k: string) => settings[k],
        set: (k: string, v: string) => (settings[k] = v),
        saveAsync: (cb: () => void) => later(cb),
      },
      mailbox: { item: opts.noItem ? null : item, userProfile: { displayName: "Tim Furnell" } },
    },
    CoercionType: { Html: "html" },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    MailboxEnums: {
      ItemNotificationMessageType: { InsightMessage: "insightMessage" },
      ActionType: { ShowTaskPane: "showTaskPane" },
    },
  };
}

async function run(opts: Parameters<typeof installOfficeMock>[0] = {}) {
  installOfficeMock(opts);
  vi.resetModules();
  await import("../src/launchevent/launchevent");
  const completed = vi.fn();
  handlers.onNewMessageComposeHandler({ completed });
  await flush();
  await flush();
  return completed;
}

describe("OnNewMessageCompose handler", () => {
  beforeEach(() => installOfficeMock());

  it("records the time, offers the compose pane, completes – without touching the body by default", async () => {
    const completed = await run();
    expect(settings["ostg.lastComposeEvent"]).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(addAsync.mock.calls[0][1]).toMatchObject({
      type: "insightMessage",
      actions: [{ actionType: "showTaskPane", commandId: "ostgComposeButton" }],
    });
    expect(setAsync).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledOnce();
  });

  it("with the setting on, removes quoted old signatures before offering", async () => {
    const completed = await run({ removeOld: true });
    expect(setAsync).toHaveBeenCalledOnce();
    expect(setAsync.mock.calls[0][0]).not.toContain('alt="Regards"');
    expect(settings["ostg.lastAutoRemoved"]).toBe("1");
    expect(addAsync).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
  });

  it("with the setting on but nothing to remove, doesn't rewrite the body", async () => {
    await run({ removeOld: true, body: "<div>New email</div>" });
    expect(setAsync).not.toHaveBeenCalled();
    expect(addAsync).toHaveBeenCalledOnce();
  });

  it("always completes, even if Outlook throws later or there is no item", async () => {
    expect(await run({ addThrows: true })).toHaveBeenCalledOnce();
    expect(await run({ noItem: true })).toHaveBeenCalledOnce();
  });
});
