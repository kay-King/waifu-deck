import { utf8ToBytes } from '@noble/hashes/utils.js';

import { encodeBase64Url } from '@/features/vault/base64url';
import type { NsfwMode } from '@/features/waifu/types';
import {
  decryptGalleryEntry,
  type GalleryEntryMeta,
} from './gallery-crypto';

/**
 * Gallery browser (fork addition): read-only access to the website gallery
 * index from inside the app. The Worker serves the encrypted index at
 * GET /api/list (newest first, paginated); entries are decrypted here with
 * the passphrase from the secure store — the same envelope as the website
 * and the Python sender. Images come from /img/<fid> (Telegram-backed);
 * video previews are source URLs fetched through the Worker's /proxy.
 *
 * This module is pure data access — no React, no secure store — so it is
 * unit-testable with an injected fetch.
 */

export type GalleryBrowserItem = GalleryEntryMeta & { fid: string };

export type GalleryListPage = {
  total: number;
  items: { fid: string; data: string }[];
};

export type FetchGalleryPageFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export const GALLERY_BROWSER_PAGE_SIZE = 60;

/**
 * One page of the encrypted index. Throws on a network failure, a
 * non-2xx status, or an unexpected response shape — the screen turns that
 * into its error state with a retry button.
 */
export async function fetchGalleryPage(
  baseUrl: string,
  offset: number,
  limit: number = GALLERY_BROWSER_PAGE_SIZE,
  fetchFn: FetchGalleryPageFn = fetch,
): Promise<GalleryListPage> {
  const response = await fetchFn(
    `${baseUrl}/api/list?offset=${offset}&limit=${limit}`,
  );
  if (!response.ok) {
    throw new Error(`Gallery list failed (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as unknown;
  if (
    body === null
    || typeof body !== 'object'
    || (body as { ok?: unknown }).ok !== true
    || !Array.isArray((body as { items?: unknown }).items)
  ) {
    throw new Error('Gallery list returned an unexpected response.');
  }
  const { items, total } = body as {
    items: { fid: string; data: string }[];
    total?: unknown;
  };
  return {
    total: typeof total === 'number' ? total : items.length,
    items: items.filter(
      (item) => typeof item?.fid === 'string' && typeof item?.data === 'string',
    ),
  };
}

/**
 * Decrypt one page. Entries that fail to decrypt (a wrong passphrase, or a
 * damaged entry) are counted and skipped instead of failing the whole page:
 * with a wrong passphrase every entry fails, which the screen reports as a
 * passphrase problem rather than an empty gallery.
 */
export function decryptGalleryItems(
  items: { fid: string; data: string }[],
  passphrase: string,
): { items: GalleryBrowserItem[]; failed: number } {
  const decrypted: GalleryBrowserItem[] = [];
  let failed = 0;
  for (const item of items) {
    try {
      decrypted.push({ ...decryptGalleryEntry(item.data, passphrase), fid: item.fid });
    } catch {
      failed += 1;
    }
  }
  return { items: decrypted, failed };
}

/** The app's NSFW mode decides which gallery entries are shown. */
export function filterGalleryItemsByNsfw(
  items: GalleryBrowserItem[],
  mode: NsfwMode,
): GalleryBrowserItem[] {
  if (mode === 'mixed') return items;
  if (mode === 'nsfw') return items.filter((item) => item.nsfw);
  return items.filter((item) => !item.nsfw);
}

/** Grid thumbnail (Worker-side cf.image resize) and full-size image URLs. */
export function galleryImageUrls(
  baseUrl: string,
  fid: string,
): { thumb: string; full: string } {
  const encoded = encodeURIComponent(fid);
  return {
    thumb: `${baseUrl}/img/${encoded}?w=400`,
    full: `${baseUrl}/img/${encoded}`,
  };
}

/**
 * Proxy a source URL (a video preview image, an original) through the
 * Worker: /proxy takes the target as a base64url `u` param, exactly like
 * the website gallery does.
 */
export function galleryProxyUrl(baseUrl: string, sourceUrl: string): string {
  return `${baseUrl}/proxy?u=${encodeBase64Url(utf8ToBytes(sourceUrl))}`;
}
