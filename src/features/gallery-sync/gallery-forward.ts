import type {
  ImageRepository,
  StoredImage,
} from '@/features/images/image-repository';
import type {
  AppSettings,
  ContentRating,
  ImageProviderKey,
} from '@/features/waifu/types';
import {
  encryptGalleryEntry,
  type GalleryEntryMeta,
  type GalleryRating,
} from './gallery-crypto';

/**
 * Gallery sync: after a fresh discover save lands on this phone, forward the
 * image to the user's Telegram private chat and record it in the website
 * gallery — through the gallery Worker's POST /api/fav (`add`), which fetches
 * the image, sends it to Telegram, and writes the encrypted index entries.
 * The app never talks to api.telegram.org directly (unreachable from the
 * user's network); the Worker is the relay.
 *
 * Fire-and-forget by design: every failure path (disabled, no passphrase,
 * missing metadata, crypto failure, network failure, Worker rejection) only
 * logs a warning. A forward never throws, never shows UI, and never touches
 * the local save — the collection flow cannot observe it.
 *
 * Freshness guard: `onOriginalReady` also fires for resumed, retried, and
 * repaired downloads, not just fresh saves. The Worker dedups gallery
 * entries by Telegram file id, but a re-forward would still send a duplicate
 * Telegram message, so only rows decided within the last 10 minutes are
 * forwarded. A save whose download genuinely takes longer than that is
 * skipped (best-effort sync; the image stays in the local collection).
 */

const FORWARD_TIMEOUT_MS = 15000;
const FRESH_SAVE_WINDOW_MS = 10 * 60 * 1000;

export type GalleryForwardDeps = {
  images: Pick<ImageRepository, 'getById'>;
  settings: () => Promise<
    Pick<AppSettings, 'gallerySyncEnabled' | 'gallerySyncUrl'>
  >;
  passphrase: () => Promise<string | null>;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable for tests; defaults to the current time. */
  now?: () => Date;
};

/** The website gallery's source names differ from the app's provider keys. */
export function mapProviderToGallerySource(provider: ImageProviderKey): string {
  switch (provider) {
    case 'yandere':
      return 'yande';
    case 'nekos_api':
      return 'nekosbest';
    default:
      return provider;
  }
}

/**
 * The app's `nsfw_unspecified` has no website equivalent; `questionable` is
 * the closest bucket (and still counts as NSFW there). Anything unmapped —
 * including a missing rating — is `unknown`, which the website treats as
 * NSFW (fail-safe).
 */
export function mapContentRatingToGallery(
  rating: ContentRating | undefined,
): GalleryRating {
  switch (rating) {
    case 'safe':
      return 'safe';
    case 'suggestive':
      return 'suggestive';
    case 'explicit':
      return 'explicit';
    case 'nsfw_unspecified':
      return 'questionable';
    default:
      return 'unknown';
  }
}

export function buildGalleryEntryMeta(
  image: StoredImage,
  now: Date,
): GalleryEntryMeta {
  const rating = mapContentRatingToGallery(image.contentRating);
  return {
    kind: 'photo',
    source: mapProviderToGallerySource(image.providerKey),
    pid: image.providerItemId,
    page: image.sourceUrl,
    // The website stores tags as one space-joined string (at most 12).
    tags: image.tags.slice(0, 12).join(' '),
    date: now.toISOString(),
    nsfw: rating !== 'safe',
    w: image.width,
    h: image.height,
    rating,
    orig: image.remoteUrl,
  };
}

export function normalizeGalleryBaseUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/u, '');
  if (!/^https?:\/\//u.test(trimmed)) return null;
  return trimmed;
}

export async function forwardCollectedImageToGallery(
  imageId: number,
  deps: GalleryForwardDeps,
): Promise<void> {
  try {
    const settings = await deps.settings();
    if (!settings.gallerySyncEnabled) return;
    const baseUrl = normalizeGalleryBaseUrl(settings.gallerySyncUrl);
    if (baseUrl === null) {
      console.warn('[GallerySync] invalid gallery URL; skipping forward.');
      return;
    }
    const passphrase = await deps.passphrase();
    if (passphrase === null) return;
    const image = await deps.images.getById(imageId);
    if (image === null || image.remoteUrl.length === 0) return;
    const now = deps.now?.() ?? new Date();
    if (
      image.decidedAt === null
      || now.getTime() - image.decidedAt > FRESH_SAVE_WINDOW_MS
    ) {
      return;
    }
    const meta = buildGalleryEntryMeta(image, now);
    // Two independent envelopes of the same metadata (fresh IV each), as
    // the website's favorite flow sends.
    const [favData, galleryData] = await Promise.all([
      encryptGalleryEntry(meta, passphrase),
      encryptGalleryEntry(meta, passphrase),
    ]);
    const fetchFn = deps.fetchFn ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
    try {
      const response = await fetchFn(`${baseUrl}/api/fav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          url: image.remoteUrl,
          kind: 'photo',
          source: meta.source,
          pid: meta.pid,
          favData,
          galleryData,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        console.warn(
          `[GallerySync] gallery /api/fav rejected the forward (HTTP ${response.status}).`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn('[GallerySync] forward failed', error);
  }
}
