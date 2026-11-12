import * as SecureStore from 'expo-secure-store';

import type { SecureStorePort } from '@/features/providers/provider-credentials';

/**
 * The gallery passphrase, device-local secure store ONLY. It must never
 * enter AppSettings, the plaintext settings JSON, any log line, or the dev
 * round trace — the same rule as the provider API credentials. Storage only;
 * the sync enable-flag lives on the normal settings path.
 *
 * expo-secure-store keys must match /^[\w.-]+$/ (no slashes).
 */
export const GALLERY_PASSPHRASE_KEY = 'waifu-deck.gallery-passphrase.v1';

const defaultPort: SecureStorePort = {
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItemAsync: SecureStore.deleteItemAsync,
};

export type GalleryPassphraseStore = {
  /** The stored passphrase, or `null` when none was saved (or it is empty). */
  load(): Promise<string | null>;
  save(passphrase: string): Promise<void>;
  clear(): Promise<void>;
};

export function createGalleryPassphraseStore(
  port: SecureStorePort = defaultPort,
): GalleryPassphraseStore {
  return {
    async load() {
      const stored = await port.getItemAsync(GALLERY_PASSPHRASE_KEY);
      return stored !== null && stored.length > 0 ? stored : null;
    },
    async save(passphrase) {
      // No trimming: a passphrase is exact — trimming would derive a
      // different key than the website, which uses the passphrase verbatim.
      if (passphrase.length === 0) {
        throw new Error('Gallery passphrase must not be empty.');
      }
      await port.setItemAsync(GALLERY_PASSPHRASE_KEY, passphrase);
    },
    async clear() {
      await port.deleteItemAsync(GALLERY_PASSPHRASE_KEY);
    },
  };
}
