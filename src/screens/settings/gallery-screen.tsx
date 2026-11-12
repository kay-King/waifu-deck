import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { Play, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenState } from '@/components/screen-state';
import {
  decryptGalleryItems,
  fetchGalleryPage,
  filterGalleryItemsByNsfw,
  galleryImageUrls,
  galleryProxyUrl,
  GALLERY_BROWSER_PAGE_SIZE,
  type GalleryBrowserItem,
} from '@/features/gallery-sync/gallery-browser';
import { normalizeGalleryBaseUrl } from '@/features/gallery-sync/gallery-forward';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppServices } from '@/providers/app-services';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

/**
 * Gallery browser (fork addition): a read-only view of the website gallery
 * inside the app, laid out like the collection page — a 3:4 grid, tap a
 * tile for the full image and its details. Entries are decrypted on this
 * phone with the passphrase from the secure store; the Worker only ever
 * sees ciphertext. Videos show their preview image only — the app has no
 * video player, so the detail view links out to the original instead.
 */

type LoadState =
  | { phase: 'passphrase' }
  | { phase: 'no-passphrase' }
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'wrong-passphrase' }
  | { phase: 'ready' };

function formatGalleryDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
}

function formatBytes(size: number | undefined): string | null {
  if (size === undefined) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function GalleryTile({
  item,
  baseUrl,
  blurNsfw,
  onOpen,
}: {
  item: GalleryBrowserItem;
  baseUrl: string;
  blurNsfw: boolean;
  onOpen: () => void;
}): ReactElement {
  const theme = useAppThemeColors();
  const isVideo = item.kind === 'video';
  const source = isVideo && item.preview
    ? galleryProxyUrl(baseUrl, item.preview)
    : galleryImageUrls(baseUrl, item.fid).thumb;
  return (
    <Pressable
      testID={`gallery-tile-${item.fid}`}
      accessibilityLabel={`${item.source} ${item.pid}`}
      onPress={onOpen}
      style={{ flex: 1, aspectRatio: 3 / 4, padding: 1 }}>
      <View style={{ flex: 1, backgroundColor: theme.controlFill, overflow: 'hidden' }}>
        <Image
          source={{ uri: source }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          blurRadius={blurNsfw && item.nsfw ? 18 : 0}
          recyclingKey={item.fid}
        />
        {isVideo ? (
          <View
            style={{
              position: 'absolute',
              right: 6,
              bottom: 6,
              width: 26,
              height: 26,
              borderRadius: 13,
              backgroundColor: 'rgba(0,0,0,0.55)',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Play size={14} color="#FFFFFF" fill="#FFFFFF" />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <View style={{ flexDirection: 'row', paddingVertical: 5 }}>
      <Text style={{ width: 76, color: '#9C9C9C', fontSize: 13 }}>{label}</Text>
      <Text style={{ flex: 1, color: '#F2F2F2', fontSize: 13 }}>{value}</Text>
    </View>
  );
}

export function GalleryScreen(): ReactElement {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { settings, gallerySync } = useAppServices();
  const columns = width >= 700 ? 5 : 3;

  const [loadState, setLoadState] = useState<LoadState>({ phase: 'passphrase' });
  const [items, setItems] = useState<GalleryBrowserItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<GalleryBrowserItem | null>(null);
  // The base URL lives in a ref for the async loaders and is mirrored into
  // state for rendering (refs must not be read during render).
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const passphraseRef = useRef<string | null>(null);
  const baseUrlRef = useRef<string | null>(null);
  const loadedRef = useRef(0);

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    const baseUrl = baseUrlRef.current;
    const passphrase = passphraseRef.current;
    if (baseUrl === null || passphrase === null) return;
    const page = await fetchGalleryPage(baseUrl, offset);
    const { items: decrypted, failed } = decryptGalleryItems(page.items, passphrase);
    if (offset === 0 && page.items.length > 0 && decrypted.length === 0 && failed > 0) {
      setLoadState({ phase: 'wrong-passphrase' });
      return;
    }
    const filtered = filterGalleryItemsByNsfw(decrypted, settings.nsfwMode);
    setTotal(page.total);
    setItems((current) => (replace ? filtered : [...current, ...filtered]));
    loadedRef.current = offset + page.items.length;
    setLoadState({ phase: 'ready' });
  }, [settings.nsfwMode]);

  const loadFirstPage = useCallback(async () => {
    setLoadState({ phase: 'loading' });
    setItems([]);
    loadedRef.current = 0;
    try {
      await loadPage(0, true);
    } catch {
      setLoadState({ phase: 'error' });
    }
  }, [loadPage]);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      const baseUrl = normalizeGalleryBaseUrl(settings.gallerySyncUrl);
      if (baseUrl === null) {
        if (!cancelled) setLoadState({ phase: 'error' });
        return;
      }
      baseUrlRef.current = baseUrl;
      setBaseUrl(baseUrl);
      const passphrase = await gallerySync.loadPassphrase().catch(() => null);
      if (cancelled) return;
      if (passphrase === null) {
        setLoadState({ phase: 'no-passphrase' });
        return;
      }
      passphraseRef.current = passphrase;
      await loadFirstPage();
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [gallerySync, loadFirstPage, settings.gallerySyncUrl]);

  const loadMore = useCallback(async () => {
    if (loadState.phase !== 'ready' || loadingMore || loadedRef.current >= total) return;
    setLoadingMore(true);
    try {
      await loadPage(loadedRef.current, false);
    } catch {
      // A failed next page leaves the loaded items in place; the next
      // scroll to the end retries.
    } finally {
      setLoadingMore(false);
    }
  }, [loadPage, loadState.phase, loadingMore, total]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadPage(0, true);
    } catch {
      setLoadState({ phase: 'error' });
    } finally {
      setRefreshing(false);
    }
  }, [loadPage]);

  const openLink = useCallback((url: string) => {
    void Linking.openURL(url).catch(() => undefined);
  }, []);

  if (loadState.phase === 'passphrase' || loadState.phase === 'loading') {
    return (
      <View testID="gallery-screen" style={{ flex: 1, backgroundColor: theme.surface }}>
        <ScreenState kind="loading" title={t('gallery.title')} message={t('gallery.loading')} />
      </View>
    );
  }

  if (loadState.phase === 'no-passphrase') {
    return (
      <View testID="gallery-screen" style={{ flex: 1, backgroundColor: theme.surface }}>
        <ScreenState
          kind="empty"
          title={t('gallery.noPassphrase')}
          message={t('gallery.noPassphraseDetail')}
        />
      </View>
    );
  }

  if (loadState.phase === 'wrong-passphrase') {
    return (
      <View testID="gallery-screen" style={{ flex: 1, backgroundColor: theme.surface }}>
        <ScreenState
          kind="error"
          title={t('gallery.title')}
          message={t('gallery.wrongPassphrase')}
          onRetry={() => void loadFirstPage()}
          retryLabel={t('gallery.retry')}
        />
      </View>
    );
  }

  if (loadState.phase === 'error') {
    return (
      <View testID="gallery-screen" style={{ flex: 1, backgroundColor: theme.surface }}>
        <ScreenState
          kind="error"
          title={t('gallery.title')}
          message={t('gallery.loadError')}
          onRetry={() => void loadFirstPage()}
          retryLabel={t('gallery.retry')}
        />
      </View>
    );
  }

  const baseUrlForRender = baseUrl ?? '';
  const detailImage = selected === null
    ? null
    : selected.kind === 'video' && selected.preview
      ? galleryProxyUrl(baseUrlForRender, selected.preview)
      : galleryImageUrls(baseUrlForRender, selected.fid).full;

  return (
    <View testID="gallery-screen" style={{ flex: 1, backgroundColor: theme.surface }}>
      <Text
        style={[settingsTypography.hint, {
          color: theme.textSecondary,
          paddingHorizontal: metrics.contentPadding,
          paddingTop: metrics.spacing.small,
          paddingBottom: metrics.spacing.small,
        }]}>
        {t('gallery.total', { count: total })}
      </Text>
      {items.length === 0 ? (
        <ScreenState kind="empty" title={t('gallery.title')} message={t('gallery.empty')} />
      ) : (
        <FlashList
          testID="gallery-grid"
          data={items}
          numColumns={columns}
          keyExtractor={(item) => item.fid}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.5}
          refreshControl={(
            <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />
          )}
          renderItem={({ item }) => (
            <GalleryTile
              item={item}
              baseUrl={baseUrlForRender}
              blurNsfw={settings.blurNsfwThumbnails}
              onOpen={() => setSelected(item)}
            />
          )}
        />
      )}
      <Modal
        visible={selected !== null}
        animationType="fade"
        onRequestClose={() => setSelected(null)}>
        <View style={{ flex: 1, backgroundColor: '#000000', paddingTop: insets.top }}>
          <Pressable
            testID="gallery-detail-close"
            accessibilityLabel={t('gallery.close')}
            onPress={() => setSelected(null)}
            style={{
              position: 'absolute',
              top: insets.top + 8,
              left: 12,
              zIndex: 1,
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: 'rgba(255,255,255,0.12)',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <X size={20} color="#FFFFFF" />
          </Pressable>
          {selected !== null && detailImage !== null ? (
            <>
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Image
                  source={{ uri: detailImage }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="contain"
                  recyclingKey={`detail-${selected.fid}`}
                />
              </View>
              <ScrollView
                style={{ maxHeight: '38%', paddingHorizontal: 20, paddingBottom: insets.bottom + 16 }}
                contentContainerStyle={{ paddingTop: 8 }}>
                {selected.kind === 'video' ? (
                  <Text style={{ color: '#9C9C9C', fontSize: 13, paddingBottom: 6 }}>
                    {t('gallery.videoOnlyPreview')}
                  </Text>
                ) : null}
                <DetailRow label={t('gallery.source')} value={selected.source} />
                <DetailRow label={t('gallery.postId')} value={selected.pid} />
                <DetailRow label={t('gallery.date')} value={formatGalleryDate(selected.date)} />
                <DetailRow label={t('gallery.rating')} value={t(`gallery.ratings.${selected.rating}`)} />
                {selected.w > 0 && selected.h > 0 ? (
                  <DetailRow label={t('gallery.size')} value={`${selected.w} × ${selected.h}`} />
                ) : null}
                {formatBytes(selected.size) !== null ? (
                  <DetailRow label={t('gallery.size')} value={formatBytes(selected.size)!} />
                ) : null}
                {selected.tags.length > 0 ? (
                  <DetailRow label={t('gallery.tags')} value={selected.tags} />
                ) : null}
                <Pressable
                  testID="gallery-detail-open-original"
                  onPress={() => openLink(selected.orig || galleryImageUrls(baseUrlForRender, selected.fid).full)}
                  style={{ paddingVertical: 10 }}>
                  <Text style={{ color: theme.save, fontSize: 14 }}>{t('gallery.openOriginal')}</Text>
                </Pressable>
                {selected.page !== null && selected.page.length > 0 ? (
                  <Pressable
                    testID="gallery-detail-open-post"
                    onPress={() => openLink(selected.page!)}
                    style={{ paddingVertical: 10 }}>
                    <Text style={{ color: theme.save, fontSize: 14 }}>{t('gallery.openSourcePost')}</Text>
                  </Pressable>
                ) : null}
              </ScrollView>
            </>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
