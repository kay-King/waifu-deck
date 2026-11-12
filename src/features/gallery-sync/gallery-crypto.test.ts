jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';
import {
  decryptGalleryEntry,
  encryptGalleryEntry,
  type GalleryEntryMeta,
} from './gallery-crypto';

/**
 * The passphrase below is a TEST fixture only — it is not, and must never
 * become, a real gallery passphrase. The envelope vector was produced by the
 * Python gallery_crypto module with this same test passphrase, so the
 * decrypt test proves cross-implementation interop, not just a round-trip.
 */
const TEST_PASSPHRASE = 'gallery-sync-test-passphrase';

const META: GalleryEntryMeta = {
  kind: 'photo',
  source: 'gelbooru',
  pid: '1234567',
  page: 'https://gelbooru.com/index.php?page=post&s=view&id=1234567',
  tags: '1girl blue_hair',
  date: '2026-11-12T23:00:00.000Z',
  nsfw: false,
  w: 1200,
  h: 1600,
  rating: 'safe',
  orig: 'https://example.invalid/img.jpg',
};

// Produced by Python gallery_crypto.encrypt_entry(META) with TEST_PASSPHRASE.
const PYTHON_ENVELOPE = 'HtyOpuaIl8R9mfMvynPSsqqPQEu7MXx9RCOPjw1jVDmsC7ktQ020P_ICJDhVfgPiujuvATx5OHAMXrXeRk57HPThhESnIEefZEZDg5Z2od1aFjhY9JH2pKxiS0WHuAmsnV-KkZrvrIqliDBzBJ0VYYIVJzwgn379OZxaaQJQCpxtByIokQZp6vO1DHLFI3PnIUEfEokY_12QJqBs9DhSDaBcPIZB2F-b0qw48iP7DmaMIcaKODq7ROWZjaVQ_vDWvY5B93odxg3Pfg1h1Njf7mQVVQlj2BVpCV3guEmXHQ486NRC4aEvpHjDenBt8WgEhrRrXcHqw6KipHK440NFIsDGpATxx6QllfPLcCDch27HyrvkEwBUukEYMgajRRewgEJ3GdqsNGWs3EKLeg1QAWEr9YrXICAkyl4JRA';

describe('gallery-crypto', () => {
  beforeEach(() => {
    resetExpoCryptoDouble();
  });

  test('decrypts a Python-produced envelope', () => {
    expect(decryptGalleryEntry(PYTHON_ENVELOPE, TEST_PASSPHRASE)).toEqual(META);
  });

  test('encrypt round-trips through decrypt', async () => {
    const blob = await encryptGalleryEntry(META, TEST_PASSPHRASE);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decryptGalleryEntry(blob, TEST_PASSPHRASE)).toEqual(META);
  });

  test('two encryptions of the same entry differ (random IV)', async () => {
    const first = await encryptGalleryEntry(META, TEST_PASSPHRASE);
    const second = await encryptGalleryEntry(META, TEST_PASSPHRASE);
    expect(first).not.toBe(second);
    expect(decryptGalleryEntry(first, TEST_PASSPHRASE)).toEqual(META);
    expect(decryptGalleryEntry(second, TEST_PASSPHRASE)).toEqual(META);
  });

  test('a wrong passphrase fails to decrypt', async () => {
    const blob = await encryptGalleryEntry(META, TEST_PASSPHRASE);
    expect(() => decryptGalleryEntry(blob, 'wrong-passphrase')).toThrow();
  });

  test('a tampered envelope fails to decrypt', async () => {
    const blob = await encryptGalleryEntry(META, TEST_PASSPHRASE);
    // Tamper mid-blob: every bit of a middle base64url char is significant
    // (the final char carries padding bits a flip might not change).
    const at = 20;
    const replacement = blob[at] === 'A' ? 'B' : 'A';
    const tampered = blob.slice(0, at) + replacement + blob.slice(at + 1);
    expect(() => decryptGalleryEntry(tampered, TEST_PASSPHRASE)).toThrow();
  });
});
