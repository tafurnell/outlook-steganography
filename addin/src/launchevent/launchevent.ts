// Event-based activation (D-039, D-040). Runs without the pane being open when the user
// starts a new email, reply or forward:
//  - records when it last fired (shown in Settings);
//  - if "Remove previous secure signatures" is on, removes earlier signature images from
//    the quoted text straight away – before the user starts typing;
//  - offers a one-click "Add secure signature" bar that opens the compose pane.
// Loaded by commands.html (new Outlook / web: browser runtime) and as the standalone
// launchevent.js (classic Outlook on Windows: JavaScript-only runtime – no DOM, no imports
// at runtime; webpack bundles everything into one file).
import { stripSignatureImgTags } from "../mail/bodyEdit";
import {
  LAST_EVENT_SETTING, NAME_SETTING, OFFER_NOTIFICATION_KEY, RECENT_NAMES_SETTING, REMOVE_OLD_SETTING, parseRecentNames,
} from "../shared/settings";

type AsyncCallback<T> = (r: Office.AsyncResult<T>) => void;

function onNewMessageComposeHandler(event: { completed: (options?: unknown) => void }): void {
  // Outlook waits until completed() is called: call it exactly once on every path,
  // including errors thrown later inside async callbacks.
  let finished = false;
  const done = () => {
    if (!finished) {
      finished = true;
      event.completed();
    }
  };
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      try {
        fn(...a);
      } catch {
        done();
      }
    };

  guard(() => {
    const rs = Office.context.roamingSettings;
    const item = Office.context.mailbox.item as unknown as Office.MessageCompose | null;
    rs.set(LAST_EVENT_SETTING, new Date().toISOString());

    const offer = guard(() => {
      if (!item) return done();
      item.notificationMessages.addAsync(
        OFFER_NOTIFICATION_KEY,
        {
          type: Office.MailboxEnums.ItemNotificationMessageType.InsightMessage,
          message: "Add a secure signature with a hidden secret?",
          icon: "Icon.16",
          actions: [
            {
              actionType: Office.MailboxEnums.ActionType.ShowTaskPane,
              actionText: "Add secure signature",
              commandId: "ostgComposeButton", // the compose ribbon button (manifest)
              contextData: "{}",
            },
          ],
        },
        done,
      );
    });
    const saveThenOffer = guard(() => rs.saveAsync(offer));

    if (!item || rs.get(REMOVE_OLD_SETTING) !== "1") return saveThenOffer();

    // Remove earlier signatures from the quoted text before the user types.
    const names = [
      ...parseRecentNames(rs.get(RECENT_NAMES_SETTING) as string | undefined),
      (rs.get(NAME_SETTING) as string | undefined) ?? "",
      Office.context.mailbox.userProfile?.displayName ?? "",
    ];
    item.body.getAsync(
      Office.CoercionType.Html,
      guard(((r: Office.AsyncResult<string>) => {
        if (r.status !== Office.AsyncResultStatus.Succeeded) return saveThenOffer();
        const { html, removed } = stripSignatureImgTags(r.value, names);
        if (removed === 0) return saveThenOffer();
        rs.set("ostg.lastAutoRemoved", String(removed));
        item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, guard(saveThenOffer));
      }) as AsyncCallback<string>),
    );
  })();
}

Office.actions.associate("onNewMessageComposeHandler", onNewMessageComposeHandler);
