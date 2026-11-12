import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { getRandomBytesAsync } from 'expo-crypto';

import {
  decodeBase64Url,
  encodeBase64Url,
} from '@/features/vault/base64url';

/**
 * Gallery-sync envelope crypto. Byte-compatible with the website gallery
 * (Web Crypto) and the VM sender (Python `cryptography`):
 * PBKDF2(100k, SHA-256, salt 'waifu-gallery-v1') derives a 32-byte key from
 * the gallery passphrase; AES-256-GCM with a 12-byte random IV seals the
 * JSON metadata; the envelope is base64url(iv || ciphertext+tag).
 *
 * Pure JS only (@noble/ciphers + @noble/hashes): no native crypto module,
 * so this runs on Hermes, in Jest, and under plain Node alike. The only
 * platform call is the IV source (`expo-crypto`), which the test double
 * replaces.
 *
 * The passphrase itself is never stored here — callers read it from the
 * secure store per call, and it never enters a log line.
 */

export const GALLERY_CRYPTO_SALT = 'waifu-gallery-v1';

const PBKDF2_ITERATIONS = 100000;
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** The website gallery's normalized rating vocabulary. */
export type GalleryRating =
  | 'safe'
  | 'suggestive'
  | 'questionable'
  | 'explicit'
  | 'unknown';

/**
 * One gallery index/favorite entry's plaintext metadata — the same shape the
 * website's discover favorite sends (see the Worker's /api/fav `add`).
 * `tags` is a space-joined string (at most 12 tags), matching the website.
 */
export type GalleryEntryMeta = Readonly<{
  kind: 'photo';
  source: string;
  pid: string;
  page: string | null;
  tags: string;
  date: string;
  nsfw: boolean;
  w: number;
  h: number;
  rating: GalleryRating;
  orig: string;
}>;

export function deriveGalleryKey(passphrase: string): Uint8Array {
  return pbkdf2(sha256, utf8ToBytes(passphrase), utf8ToBytes(GALLERY_CRYPTO_SALT), {
    c: PBKDF2_ITERATIONS,
    dkLen: KEY_BYTES,
  });
}

export async function encryptGalleryEntry(
  meta: GalleryEntryMeta,
  passphrase: string,
): Promise<string> {
  const key = deriveGalleryKey(passphrase);
  const iv = await getRandomBytesAsync(IV_BYTES);
  const ciphertext = gcm(key, iv).encrypt(utf8ToBytes(JSON.stringify(meta)));
  const out = new Uint8Array(IV_BYTES + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, IV_BYTES);
  return encodeBase64Url(out);
}

export function decryptGalleryEntry(
  blob: string,
  passphrase: string,
): GalleryEntryMeta {
  const raw = decodeBase64Url(blob);
  if (raw.length <= IV_BYTES) {
    throw new Error('Invalid gallery entry envelope.');
  }
  const key = deriveGalleryKey(passphrase);
  const plaintext = gcm(key, raw.slice(0, IV_BYTES)).decrypt(raw.slice(IV_BYTES));
  return JSON.parse(new TextDecoder().decode(plaintext)) as GalleryEntryMeta;
}
