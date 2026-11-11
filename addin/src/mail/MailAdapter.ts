// Mail-access abstraction (D-018 rule 2). The UI and core never call Office.js
// directly, so a GraphAdapter (mobile, later) can be added without touching them.
import type { SignatureImage } from "../core/stego";

export type ItemMode = "read" | "compose";

export interface CandidateImage {
  id: string;
  name: string;
  isInline: boolean;
  /** True when the filename matches the sig_*.png fast-path hint. */
  hinted: boolean;
  bytes: Uint8Array;
}

/** Per-attachment diagnostics shown in the pane's "Details" section. */
export interface AttachmentNote {
  name: string;
  contentType: string;
  isInline: boolean;
  size: number;
  outcome: string; // e.g. "read", "skipped: not PNG", "read failed: <code>"
}

export interface ScanResult {
  /** Subject, sender and received time of the item actually being checked, so the user can
   *  tell when the pane is still bound to an older message (no pinning on Outlook.com). */
  subject: string;
  from: string;
  received?: Date;
  images: CandidateImage[];
  notes: AttachmentNote[];
}

/** What replaceSignature found/did – shown in the compose pane's Details. */
export interface RemovalReport {
  attachmentsRemoved: number;
  imgTagsRemoved: number;
  notes: string[];
}

export interface SettingsStore {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): Promise<void>;
}

export interface MailAdapter {
  readonly mode: ItemMode;
  readonly settings: SettingsStore;
  userDisplayName(): string;

  /** Read mode: PNG attachments (inline and regular), hinted ones first (D-018 rule 4). */
  listCandidateImages(): Promise<ScanResult>;

  /**
   * Compose mode: remove previous signature images from this draft (D-010, best effort), e.g. quoted
   * in a reply, and insert the new one – above the quoted message on replies/forwards.
   * Inline images are identified by decoding them (`isOurs`) or, for new Outlook's quoted
   * placeholders, by our alt text (`altNames`); names can't be trusted.
   */
  replaceSignature(
    sig: SignatureImage, altText: string, isOurs: (png: Uint8Array) => boolean, altNames: string[],
    removeOld: boolean,
  ): Promise<RemovalReport>;


  /** Identity of the current item + mode, to detect changes when ItemChanged doesn't fire (no pinning). */
  currentItemKey(): string;

  /** Non-secret notice on the item (info bar). Never pass the secret itself (D-017). */
  notify(text: string): Promise<void>;
  clearNotification(): Promise<void>;

  /** Pinned pane: called when the user selects another message. */
  onItemChanged(handler: () => void): void;
}
