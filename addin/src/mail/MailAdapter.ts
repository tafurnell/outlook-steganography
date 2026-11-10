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

export interface SettingsStore {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): Promise<void>;
}

export interface MailAdapter {
  readonly mode: ItemMode;
  readonly settings: SettingsStore;
  userDisplayName(): string;

  /** Read mode: PNG attachments (inline and regular), hinted ones first (D-018 rule 4). */
  listCandidateImages(): Promise<CandidateImage[]>;

  /** Compose mode: remove previous signature images from this draft (D-010). Returns count removed. */
  removeExistingSignatures(): Promise<number>;
  /** Compose mode: insert the signature image as an inline attachment + <img> in the signature area. */
  insertSignature(sig: SignatureImage, altText: string): Promise<void>;

  /** Non-secret notice on the item (info bar). Never pass the secret itself (D-017). */
  notify(text: string): Promise<void>;
  clearNotification(): Promise<void>;

  /** Pinned pane: called when the user selects another message. */
  onItemChanged(handler: () => void): void;
}
