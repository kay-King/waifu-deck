import { useEffect, useState, type ReactElement } from 'react';
import { Text, View } from 'react-native';

import { normalizeGalleryBaseUrl } from '@/features/gallery-sync/gallery-forward';
import type { AppSettings } from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import type { GallerySyncService } from '@/providers/app-services';
import { PersistedSwitch } from '@/screens/settings/setting-row';
import { SettingsBlock } from '@/screens/settings/ui/settings-block';
import { SettingsButton } from '@/screens/settings/ui/settings-button';
import { SettingsField } from '@/screens/settings/ui/settings-field';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type GallerySyncSectionProps = {
  settings: Pick<AppSettings, 'gallerySyncEnabled' | 'gallerySyncUrl'>;
  busy: boolean;
  /**
   * The passphrase service. Absent in bare test renders — the toggle and
   * URL still work; only the passphrase rows are hidden.
   */
  gallerySync?: GallerySyncService | null;
  onSave(patch: Partial<AppSettings>): Promise<boolean>;
  onNotice(message: string): void;
};

/**
 * Gallery sync (fork addition): one SettingsGroup child, following the
 * credentialed-provider row shape — a toggle row, an internal 1dp hair,
 * then the URL field block and the passphrase form (or, once a passphrase
 * is saved, a masked status row plus a clear row). SettingsGroup separates
 * direct children only, so the internal hair exists for the same reason as
 * in CredentialProviderRow.
 *
 * The passphrase is write-only here: the UI never reads it back, only
 * whether one is stored. It lives in the secure store, never in settings.
 */
export function GallerySyncSection({
  settings,
  busy,
  gallerySync,
  onSave,
  onNotice,
}: GallerySyncSectionProps): ReactElement {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const [urlDraft, setUrlDraft] = useState(settings.gallerySyncUrl);
  const [savingUrl, setSavingUrl] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [passphraseLoaded, setPassphraseLoaded] = useState(false);
  const [savingPassphrase, setSavingPassphrase] = useState(false);
  const [clearingPassphrase, setClearingPassphrase] = useState(false);
  const internalHair = (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.hair }} />
  );

  useEffect(() => {
    setUrlDraft(settings.gallerySyncUrl);
  }, [settings.gallerySyncUrl]);

  useEffect(() => {
    if (gallerySync == null) return;
    let cancelled = false;
    void gallerySync.loadPassphrase().then((stored) => {
      if (!cancelled) {
        setHasPassphrase(stored !== null);
        setPassphraseLoaded(true);
      }
    }).catch(() => {
      if (!cancelled) setPassphraseLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [gallerySync]);

  const normalizedUrl = normalizeGalleryBaseUrl(urlDraft);
  const canSaveUrl = !savingUrl
    && normalizedUrl !== null
    && normalizedUrl !== settings.gallerySyncUrl;

  return (
    <>
      <SettingsRow
        testID="settings-gallery-sync-toggle"
        label={t('settings.gallerySync.enable')}
        detail={t('settings.gallerySync.enableDetail')}
        trailing={(
          <PersistedSwitch
            testID="settings-gallery-sync-toggle-switch"
            accessibilityLabel={t('settings.gallerySync.enable')}
            busy={busy}
            value={settings.gallerySyncEnabled}
            onValueChange={(value) => onSave({ gallerySyncEnabled: value })}
          />
        )}
      />
      {internalHair}
      <SettingsBlock>
        <SettingsField
          testID="settings-gallery-sync-url"
          accessibilityLabel={t('settings.gallerySync.urlLabel')}
          placeholder={t('settings.gallerySync.urlPlaceholder')}
          keyboardType="url"
          disabled={busy || savingUrl}
          value={urlDraft}
          onChangeText={setUrlDraft}
        />
        {normalizedUrl === null && urlDraft.trim().length > 0 ? (
          <Text
            style={[settingsTypography.hint, {
              marginTop: metrics.spacing.small,
              color: theme.danger,
            }]}>
            {t('settings.gallerySync.urlInvalid')}
          </Text>
        ) : null}
        <View style={{ marginTop: metrics.settingsBlockTitleGap }}>
          <SettingsButton
            testID="settings-gallery-sync-url-save"
            variant="primary"
            disabled={!canSaveUrl || busy}
            onPress={() => {
              if (normalizedUrl === null) {
                onNotice(t('settings.gallerySync.urlInvalid'));
                return;
              }
              setSavingUrl(true);
              void onSave({ gallerySyncUrl: normalizedUrl }).then((saved) => {
                if (saved) onNotice(t('settings.gallerySync.urlSaved'));
              }).finally(() => setSavingUrl(false));
            }}>
            {t('settings.gallerySync.urlSave')}
          </SettingsButton>
        </View>
      </SettingsBlock>
      {gallerySync == null || !passphraseLoaded ? null : (
        <>
          {internalHair}
          {hasPassphrase ? (
            <SettingsRow
              testID="settings-gallery-sync-passphrase-clear"
              label={t('settings.gallerySync.passphraseClear')}
              detail={t('settings.gallerySync.passphraseSet')}
              disabled={busy || clearingPassphrase}
              chevron
              onPress={() => {
                setClearingPassphrase(true);
                void gallerySync.clearPassphrase().then(() => {
                  setHasPassphrase(false);
                  onNotice(t('settings.gallerySync.passphraseCleared'));
                }).catch(() => {
                  onNotice(t('settings.operationError'));
                }).finally(() => setClearingPassphrase(false));
              }}
            />
          ) : (
            <SettingsBlock>
              <SettingsField
                testID="settings-gallery-sync-passphrase"
                accessibilityLabel={t('settings.gallerySync.passphraseLabel')}
                placeholder={t('settings.gallerySync.passphrasePlaceholder')}
                secureTextEntry
                disabled={busy || savingPassphrase}
                value={passphrase}
                onChangeText={setPassphrase}
              />
              <Text
                style={[settingsTypography.hint, {
                  marginTop: metrics.spacing.small,
                  color: theme.textSecondary,
                }]}>
                {t('settings.gallerySync.passphraseHint')}
              </Text>
              <View style={{ marginTop: metrics.settingsBlockTitleGap }}>
                <SettingsButton
                  testID="settings-gallery-sync-passphrase-save"
                  variant="primary"
                  disabled={busy || savingPassphrase || passphrase.length === 0}
                  onPress={() => {
                    setSavingPassphrase(true);
                    void gallerySync.savePassphrase(passphrase).then(() => {
                      setPassphrase('');
                      setHasPassphrase(true);
                      onNotice(t('settings.gallerySync.passphraseSaved'));
                    }).catch(() => {
                      onNotice(t('settings.operationError'));
                    }).finally(() => setSavingPassphrase(false));
                  }}>
                  {t('settings.gallerySync.passphraseSave')}
                </SettingsButton>
              </View>
            </SettingsBlock>
          )}
        </>
      )}
    </>
  );
}
