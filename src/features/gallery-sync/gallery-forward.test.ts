jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import type { StoredImage } from '@/features/images/image-repository';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';
import { decryptGalleryEntry } from './gallery-crypto';
import {
  buildGalleryEntryMeta,
  forwardCollectedImageToGallery,
  mapContentRatingToGallery,
  mapProviderToGallerySource,
  normalizeGalleryBaseUrl,
  type GalleryForwardDeps,
} from './gallery-forward';

// Test passphrase only — never a real gallery passphrase.
const TEST_PASSPHRASE = 'gallery-sync-test-passphrase';
const NOW = new Date('2026-11-12T23:30:00.000Z');

function storedImage(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: 7,
    providerKey: 'gelbooru',
    providerItemId: '1234567',
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: 'https://example.invalid/img.jpg',
    sourceUrl: 'https://gelbooru.com/index.php?page=post&s=view&id=1234567',
    artistName: null,
    artistUrl: null,
    width: 1200,
    height: 1600,
    byteSize: 123456,
    extension: '.jpg',
    dominantColor: '#aabbcc',
    contentRating: 'safe',
    nativeRating: 'general',
    isNsfw: false,
    isAnimated: false,
    tags: ['1girl', 'blue_hair'],
    decision: 'saved',
    presentedAt: NOW.getTime(),
    decidedAt: NOW.getTime(),
    queueOrdinal: 0,
    decisionOrdinal: 0,
    localUri: 'file:///documents/collection/7.jpg',
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

describe('gallery-forward mappings', () => {
  test('provider keys map to website source names', () => {
    expect(mapProviderToGallerySource('yandere')).toBe('yande');
    expect(mapProviderToGallerySource('nekos_api')).toBe('nekosbest');
    expect(mapProviderToGallerySource('gelbooru')).toBe('gelbooru');
    expect(mapProviderToGallerySource('danbooru')).toBe('danbooru');
  });

  test('content ratings map to the website vocabulary, unknown fails safe', () => {
    expect(mapContentRatingToGallery('safe')).toBe('safe');
    expect(mapContentRatingToGallery('suggestive')).toBe('suggestive');
    expect(mapContentRatingToGallery('explicit')).toBe('explicit');
    expect(mapContentRatingToGallery('nsfw_unspecified')).toBe('questionable');
    expect(mapContentRatingToGallery('unknown')).toBe('unknown');
    expect(mapContentRatingToGallery(undefined)).toBe('unknown');
  });

  test('base URLs normalize, non-http(s) is rejected', () => {
    expect(normalizeGalleryBaseUrl('https://gallery.suny.qzz.io/')).toBe(
      'https://gallery.suny.qzz.io',
    );
    expect(normalizeGalleryBaseUrl('  http://localhost:8787/// ')).toBe(
      'http://localhost:8787',
    );
    expect(normalizeGalleryBaseUrl('ftp://example.invalid')).toBeNull();
    expect(normalizeGalleryBaseUrl('')).toBeNull();
  });

  test('metadata follows the website favorite shape', () => {
    const meta = buildGalleryEntryMeta(
      storedImage({ tags: Array.from({ length: 20 }, (_, i) => `tag${i}`) }),
      NOW,
    );
    expect(meta).toEqual({
      kind: 'photo',
      source: 'gelbooru',
      pid: '1234567',
      page: 'https://gelbooru.com/index.php?page=post&s=view&id=1234567',
      tags: Array.from({ length: 12 }, (_, i) => `tag${i}`).join(' '),
      date: '2026-11-12T23:30:00.000Z',
      nsfw: false,
      w: 1200,
      h: 1600,
      rating: 'safe',
      orig: 'https://example.invalid/img.jpg',
    });
  });

  test('an unknown rating counts as NSFW', () => {
    const meta = buildGalleryEntryMeta(
      storedImage({ contentRating: 'unknown', isNsfw: false }),
      NOW,
    );
    expect(meta.rating).toBe('unknown');
    expect(meta.nsfw).toBe(true);
  });
});

describe('forwardCollectedImageToGallery', () => {
  beforeEach(() => {
    resetExpoCryptoDouble();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function deps(overrides: Partial<GalleryForwardDeps> = {}): {
    deps: GalleryForwardDeps;
    fetchFn: jest.Mock;
  } {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }) as Response);
    return {
      fetchFn,
      deps: {
        images: { getById: async () => storedImage() },
        settings: async () => ({
          gallerySyncEnabled: true,
          gallerySyncUrl: 'https://gallery.suny.qzz.io',
        }),
        passphrase: async () => TEST_PASSPHRASE,
        fetchFn,
        now: () => NOW,
        ...overrides,
      },
    };
  }

  test('posts an add request with two decryptable envelopes', async () => {
    const { deps: d, fetchFn } = deps();
    await forwardCollectedImageToGallery(7, d);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gallery.suny.qzz.io/api/fav');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      action: 'add',
      url: 'https://example.invalid/img.jpg',
      kind: 'photo',
      source: 'gelbooru',
      pid: '1234567',
    });
    expect(typeof body.favData).toBe('string');
    expect(typeof body.galleryData).toBe('string');
    expect(body.favData).not.toBe(body.galleryData);
    const expected = buildGalleryEntryMeta(storedImage(), NOW);
    expect(decryptGalleryEntry(body.favData as string, TEST_PASSPHRASE))
      .toEqual(expected);
    expect(decryptGalleryEntry(body.galleryData as string, TEST_PASSPHRASE))
      .toEqual(expected);
  });

  test('does nothing when the toggle is off', async () => {
    const { deps: d, fetchFn } = deps({
      settings: async () => ({
        gallerySyncEnabled: false,
        gallerySyncUrl: 'https://gallery.suny.qzz.io',
      }),
    });
    await forwardCollectedImageToGallery(7, d);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('does nothing when no passphrase is saved', async () => {
    const { deps: d, fetchFn } = deps({ passphrase: async () => null });
    await forwardCollectedImageToGallery(7, d);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('does nothing when the image row is missing', async () => {
    const { deps: d, fetchFn } = deps({
      images: { getById: async () => null },
    });
    await forwardCollectedImageToGallery(7, d);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('does nothing for a stale decision (resume/retry, not a fresh save)', async () => {
    const { deps: d, fetchFn } = deps({
      images: {
        getById: async () => storedImage({
          decidedAt: NOW.getTime() - 60 * 60 * 1000,
        }),
      },
    });
    await forwardCollectedImageToGallery(7, d);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('a Worker rejection warns but never throws', async () => {
    const { deps: d, fetchFn } = deps();
    fetchFn.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    await expect(forwardCollectedImageToGallery(7, d)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  test('a network failure warns but never throws', async () => {
    const { deps: d } = deps({
      fetchFn: jest.fn(async () => {
        throw new Error('network down');
      }),
    });
    await expect(forwardCollectedImageToGallery(7, d)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  test('a settings read failure warns but never throws', async () => {
    const { deps: d, fetchFn } = deps({
      settings: async () => {
        throw new Error('storage down');
      },
    });
    await expect(forwardCollectedImageToGallery(7, d)).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
