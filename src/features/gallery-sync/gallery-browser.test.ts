import { decodeBase64Url } from '@/features/vault/base64url';
import {
  decryptGalleryItems,
  fetchGalleryPage,
  type FetchGalleryPageFn,
  filterGalleryItemsByNsfw,
  galleryImageUrls,
  galleryProxyUrl,
  type GalleryBrowserItem,
} from './gallery-browser';

// Test passphrase only — never a real gallery passphrase.
const TEST_PASSPHRASE = 'gallery-sync-test-passphrase';

// Produced by Python gallery_crypto.encrypt_entry with TEST_PASSPHRASE
// (same fixture as gallery-crypto.test.ts): a gelbooru photo, rating safe.
const PYTHON_ENVELOPE = 'HtyOpuaIl8R9mfMvynPSsqqPQEu7MXx9RCOPjw1jVDmsC7ktQ020P_ICJDhVfgPiujuvATx5OHAMXrXeRk57HPThhESnIEefZEZDg5Z2od1aFjhY9JH2pKxiS0WHuAmsnV-KkZrvrIqliDBzBJ0VYYIVJzwgn379OZxaaQJQCpxtByIokQZp6vO1DHLFI3PnIUEfEokY_12QJqBs9DhSDaBcPIZB2F-b0qw48iP7DmaMIcaKODq7ROWZjaVQ_vDWvY5B93odxg3Pfg1h1Njf7mQVVQlj2BVpCV3guEmXHQ486NRC4aEvpHjDenBt8WgEhrRrXcHqw6KipHK440NFIsDGpATxx6QllfPLcCDch27HyrvkEwBUukEYMgajRRewgEJ3GdqsNGWs3EKLeg1QAWEr9YrXICAkyl4JRA';

const BASE_URL = 'https://gallery.example.invalid';

function item(overrides: Partial<GalleryBrowserItem> = {}): GalleryBrowserItem {
  return {
    fid: 'fid-1',
    kind: 'photo',
    source: 'gelbooru',
    pid: '1234567',
    page: null,
    tags: '',
    date: '2026-11-12T23:00:00.000Z',
    nsfw: false,
    w: 1200,
    h: 1600,
    rating: 'safe',
    orig: 'https://example.invalid/img.jpg',
    ...overrides,
  };
}

describe('fetchGalleryPage', () => {
  test('returns total and items for a well-formed page', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        total: 188,
        items: [{ fid: 'a', data: 'blob-a' }, { fid: 'b', data: 'blob-b' }],
      }),
    })) as unknown as FetchGalleryPageFn;
    const page = await fetchGalleryPage(BASE_URL, 0, 60, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(`${BASE_URL}/api/list?offset=0&limit=60`);
    expect(page.total).toBe(188);
    expect(page.items).toHaveLength(2);
  });

  test('drops malformed entries', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        total: 2,
        items: [{ fid: 'a', data: 'blob-a' }, { fid: 7 }, { data: 'no-fid' }],
      }),
    })) as unknown as FetchGalleryPageFn;
    const page = await fetchGalleryPage(BASE_URL, 0, 60, fetchFn);
    expect(page.items).toEqual([{ fid: 'a', data: 'blob-a' }]);
  });

  test('throws on a non-2xx status', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
    })) as unknown as FetchGalleryPageFn;
    await expect(fetchGalleryPage(BASE_URL, 0, 60, fetchFn)).rejects.toThrow('HTTP 502');
  });

  test('throws on an unexpected response shape', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, error: 'unauthorized' }),
    })) as unknown as FetchGalleryPageFn;
    await expect(fetchGalleryPage(BASE_URL, 0, 60, fetchFn)).rejects.toThrow('unexpected response');
  });
});

describe('decryptGalleryItems', () => {
  test('decrypts a Python-produced envelope and keeps its fid', () => {
    const { items, failed } = decryptGalleryItems(
      [{ fid: 'fid-9', data: PYTHON_ENVELOPE }],
      TEST_PASSPHRASE,
    );
    expect(failed).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      fid: 'fid-9',
      kind: 'photo',
      source: 'gelbooru',
      pid: '1234567',
      rating: 'safe',
      nsfw: false,
    });
  });

  test('counts failures instead of throwing', () => {
    const { items, failed } = decryptGalleryItems(
      [
        { fid: 'good', data: PYTHON_ENVELOPE },
        { fid: 'bad', data: 'not-an-envelope' },
      ],
      TEST_PASSPHRASE,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.fid).toBe('good');
    expect(failed).toBe(1);
  });

  test('a wrong passphrase fails every entry', () => {
    const { items, failed } = decryptGalleryItems(
      [{ fid: 'a', data: PYTHON_ENVELOPE }],
      'wrong-passphrase',
    );
    expect(items).toHaveLength(0);
    expect(failed).toBe(1);
  });
});

describe('filterGalleryItemsByNsfw', () => {
  const safeItem = item({ fid: 'safe' });
  const nsfwItem = item({ fid: 'nsfw', nsfw: true, rating: 'explicit' });
  const list = [safeItem, nsfwItem];

  test('sfw hides NSFW entries', () => {
    expect(filterGalleryItemsByNsfw(list, 'sfw')).toEqual([safeItem]);
  });

  test('mixed shows everything', () => {
    expect(filterGalleryItemsByNsfw(list, 'mixed')).toEqual(list);
  });

  test('nsfw shows only NSFW entries', () => {
    expect(filterGalleryItemsByNsfw(list, 'nsfw')).toEqual([nsfwItem]);
  });
});

describe('gallery URLs', () => {
  test('image URLs point at /img/<fid>', () => {
    const urls = galleryImageUrls(BASE_URL, 'AgACAgUAAxkB');
    expect(urls.thumb).toBe(`${BASE_URL}/img/AgACAgUAAxkB?w=400`);
    expect(urls.full).toBe(`${BASE_URL}/img/AgACAgUAAxkB`);
  });

  test('proxy URL round-trips the source URL', () => {
    const source = 'https://example.invalid/preview.jpg?x=1&y=2';
    const proxied = galleryProxyUrl(BASE_URL, source);
    const encoded = new URL(proxied).searchParams.get('u')!;
    expect(new TextDecoder().decode(decodeBase64Url(encoded))).toBe(source);
  });
});
