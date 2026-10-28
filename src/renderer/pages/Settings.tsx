import { useEffect, useState } from 'react'
import type { AppSettings, BrowserProfile, DetectedBrowser, FormatInfo } from '@shared/types'
import { useApp } from '../AppContext'
import { useI18n } from '../i18n'
import { Button } from '../components/Button'
import { Card, Toggle } from '../components/ui'
import { Icon } from '../components/Icon'

const numOpts = (min: number, max: number): number[] => {
  const arr: number[] = []
  for (let i = min; i <= max; i++) arr.push(i)
  return arr
}

type NumKey = 'maxSimultaneousDownloads' | 'retryCount' | 'retryDelaySeconds' | 'maxConcurrentProcessing'

export function Settings(): JSX.Element {
  const { settings, saveSettings, toast } = useApp()
  const { t } = useI18n()
  const [choosing, setChoosing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formats, setFormats] = useState<{ video: FormatInfo[]; audio: FormatInfo[] } | null>(null)

  const [browsers, setBrowsers] = useState<DetectedBrowser[]>([])
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [ytDlpVersion, setYtDlpVersion] = useState<string>('')
  const [checkingYtDlp, setCheckingYtDlp] = useState(false)

  useEffect(() => {
    window.vidaud
      .getFormats()
      .then(setFormats)
      .catch(() => {})

    window.vidaud
      .getDetectedBrowsers()
      .then(setBrowsers)
      .catch(() => {})

    window.vidaud
      .getYtDlpVersion()
      .then(setYtDlpVersion)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!settings) return
    window.vidaud
      .getBrowserProfiles(settings.browserName)
      .then((profs) => {
        setProfiles(profs)
        if (profs.length > 0 && !profs.some((p) => p.id === settings.browserProfile)) {
          void saveSettings({ browserProfile: profs[0].id })
        }
      })
      .catch(() => setProfiles([]))
  }, [settings?.browserName])

  if (!settings) return <div />

  const setAndSave = (patch: Partial<AppSettings>): void => {
    void saveSettings(patch)
  }

  const changeLocation = async (): Promise<void> => {
    setChoosing(true)
    try {
      const res = await window.vidaud.chooseFolder()
      if (!res) return
      if (res.path) {
        await saveSettings({ downloadFolder: res.path })
        toast('success', t('settings.locationChanged'))
      } else if (res.error) {
        toast('error', t('settings.invalidFolder'))
      }
    } finally {
      setChoosing(false)
    }
  }

  const openDownloadFolder = async (): Promise<void> => {
    const res = await window.vidaud.openDownloadFolder()
    if (!res?.success) {
      toast('error', t('completed.unableToOpenFolder'), res?.error || undefined)
    }
  }

  const selectCustomProfileFolder = async (): Promise<void> => {
    const res = await window.vidaud.chooseProfileFolder()
    if (res.path) {
      await saveSettings({ browserName: 'custom', customBrowserProfilePath: res.path })
      toast('success', t('settings.saved'))
    }
  }

  const checkYtDlpUpdate = async (): Promise<void> => {
    setCheckingYtDlp(true)
    try {
      const res = await window.vidaud.updateYtDlp()
      if (res.success && res.version) {
        setYtDlpVersion(res.version)
        toast('success', t('settings.ytdlpUpdated', { v: res.version }))
      } else {
        toast('error', res.error || t('settings.ytdlpUpdateFailed'))
      }
    } finally {
      setCheckingYtDlp(false)
    }
  }

  const resetToDefault = async (): Promise<void> => {
    const folder = await window.vidaud.getDefaultDownloadFolder()
    if (!folder) return
    await saveSettings({ downloadFolder: folder })
    toast('success', t('settings.locationChanged'))
  }

  const changeConverterFolder = async (): Promise<void> => {
    const res = await window.vidaud.chooseFolder()
    if (!res) return
    if (res.path) {
      await saveSettings({ converterOutputFolder: res.path })
      toast('success', t('settings.saved'))
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveSettings()
      toast('success', t('settings.saved'))
    } finally {
      setSaving(false)
    }
  }

  const numField = (label: string, key: NumKey, min: number, max: number): JSX.Element => (
    <div className="field">
      <label>{label}</label>
      <select className="select" value={settings[key]} onChange={(e) => setAndSave({ [key]: Number(e.target.value) })}>
        {numOpts(min, max).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <div>
      <Card className="settings-hero">
        <div className="hero-icon">
          <Icon name="folder" size={18} />
        </div>
        <div className="hero-title">{t('settings.downloadLocation')}</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 8, textTransform: 'none' }}>{t('settings.currentFolder')}</div>
        <div className="hero-path" dir="ltr" title={settings.downloadFolder}>
          {settings.downloadFolder}
        </div>
        <div className="hero-actions">
          <Button variant="primary" icon="folder" onClick={() => void changeLocation()} loading={choosing}>
            {t('settings.changeLocation')}
          </Button>
          <Button variant="secondary" icon="openFolder" onClick={() => void openDownloadFolder()}>
            {t('settings.openFolder')}
          </Button>
          <button className="reset-link" onClick={() => void resetToDefault()}>
            {t('settings.resetToDefault')}
          </button>
        </div>
      </Card>

      <div className="settings-grid">
        <Card title={t('settings.general')}>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.startAutomatically')}</div>
              <div className="desc">{t('settings.startAutomaticallyDesc')}</div>
            </div>
            <Toggle checked={settings.startAutomatically} onChange={(v) => setAndSave({ startAutomatically: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.askBeforeStart')}</div>
            </div>
            <Toggle checked={settings.askBeforeStart} onChange={(v) => setAndSave({ askBeforeStart: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.openFolderAfter')}</div>
            </div>
            <Toggle checked={settings.openFolderAfterDownload} onChange={(v) => setAndSave({ openFolderAfterDownload: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.rememberLast')}</div>
            </div>
            <Toggle checked={settings.rememberLastSettings} onChange={(v) => setAndSave({ rememberLastSettings: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.notifications')}</div>
            </div>
            <Toggle checked={settings.notifications} onChange={(v) => setAndSave({ notifications: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.language')}</div>
            </div>
            <select className="select" value={settings.language} onChange={(e) => setAndSave({ language: e.target.value })} style={{ width: 150 }}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
              <option value="fr">Français</option>
            </select>
          </div>
        </Card>

        <Card title={t('settings.browserCookies')}>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.useBrowserSession')}</div>
              <div className="desc">{t('settings.useBrowserSessionDesc')}</div>
            </div>
            <Toggle checked={settings.useBrowserSession} onChange={(v) => setAndSave({ useBrowserSession: v })} />
          </div>

          {settings.useBrowserSession ? (
            <>
              <div className="field" style={{ marginTop: 12 }}>
                <label>{t('settings.browser')}</label>
                <select className="select" value={settings.browserName} onChange={(e) => setAndSave({ browserName: e.target.value })}>
                  {browsers.map((b) => (
                    <option key={b.id} value={b.id} disabled={!b.isInstalled && b.id !== 'auto' && b.id !== 'custom'}>
                      {b.name} {!b.isInstalled && b.id !== 'auto' && b.id !== 'custom' ? '(Not Installed)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {settings.browserName !== 'custom' ? (
                <div className="field">
                  <label>{t('settings.profile')}</label>
                  <select className="select" value={settings.browserProfile} onChange={(e) => setAndSave({ browserProfile: e.target.value })}>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {settings.browserName === 'custom' || settings.customBrowserProfilePath ? (
                <div className="field">
                  <label>{t('settings.profileFolder')}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input className="input" readOnly value={settings.customBrowserProfilePath || ''} placeholder="No folder selected" style={{ flex: 1 }} />
                    <Button variant="secondary" onClick={() => void selectCustomProfileFolder()}>
                      {t('settings.selectProfileFolder')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </Card>

        <Card title={t('settings.downloads')}>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.localDownloadOnly')}</div>
              <div className="desc">{t('settings.localDownloadOnlyDesc')}</div>
            </div>
            <Toggle checked={settings.localDownloadOnly} onChange={(v) => setAndSave({ localDownloadOnly: v })} />
          </div>
          {numField(t('settings.maxSimultaneous'), 'maxSimultaneousDownloads', 1, 8)}
          {numField(t('settings.retryCount'), 'retryCount', 0, 10)}
          {numField(t('settings.retryDelay'), 'retryDelaySeconds', 1, 120)}
          {numField(t('settings.maxProcessing'), 'maxConcurrentProcessing', 1, 4)}
          <div className="field">
            <label>{t('settings.existingFile')}</label>
            <select className="select" value={settings.onExistingFile} onChange={(e) => setAndSave({ onExistingFile: e.target.value as never })}>
              <option value="rename">{t('settings.existingRename')}</option>
              <option value="replace">{t('settings.existingReplace')}</option>
              <option value="skip">{t('settings.existingSkip')}</option>
            </select>
          </div>
        </Card>

        <Card title={t('settings.video')}>
          <div className="field">
            <label>{t('settings.defaultFormat')}</label>
            <select className="select" value={settings.defaultVideoFormat} onChange={(e) => setAndSave({ defaultVideoFormat: e.target.value })}>
              {formats
                ? formats.video.map((f) => (
                    <option key={f.id} value={f.id} disabled={!f.available}>
                      {f.id.toUpperCase()} — {f.label}
                    </option>
                  ))
                : (
                  <option value="mp4">MP4</option>
                )}
            </select>
          </div>
          <div className="field">
            <label>{t('settings.defaultQuality')}</label>
            <select className="select" value={settings.defaultVideoQuality} onChange={(e) => setAndSave({ defaultVideoQuality: e.target.value })}>
              <option value="best">{t('quality.best')}</option>
              <option value="1080">1080p</option>
              <option value="720">720p</option>
              <option value="480">480p</option>
              <option value="360">360p</option>
            </select>
          </div>
          <div className="field">
            <label>{t('settings.container')}</label>
            <select className="select" value={settings.container} disabled>
              <option value="mp4">MP4 (H.264 / AAC)</option>
            </select>
          </div>
          <div className="field">
            <label>{t('settings.preferredCodec')}</label>
            <select className="select" value={settings.preferredCodec} onChange={(e) => setAndSave({ preferredCodec: e.target.value })}>
              <option value="H.264 + AAC">H.264 + AAC</option>
              <option value="H.265 (HEVC) + AAC">H.265 (HEVC) + AAC</option>
              <option value="VP9 + Opus">VP9 + Opus</option>
            </select>
          </div>
        </Card>

        <Card title={t('settings.audio')}>
          <div className="field">
            <label>{t('settings.defaultAudioFormat')}</label>
            <select className="select" value={settings.defaultAudioFormat} onChange={(e) => setAndSave({ defaultAudioFormat: e.target.value })}>
              {formats
                ? formats.audio.map((f) => (
                    <option key={f.id} value={f.id} disabled={!f.available}>
                      {f.id.toUpperCase()} — {f.label}
                    </option>
                  ))
                : (
                  <option value="mp3">MP3</option>
                )}
            </select>
          </div>
          <div className="field">
            <label>{t('settings.mp3Bitrate')}</label>
            <select className="select" value={settings.mp3Bitrate} onChange={(e) => setAndSave({ mp3Bitrate: e.target.value })}>
              <option value="320">320 kbps</option>
              <option value="256">256 kbps</option>
              <option value="192">192 kbps</option>
              <option value="128">128 kbps</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.metadata')}</div>
            </div>
            <Toggle checked={settings.embedMetadata} onChange={(v) => setAndSave({ embedMetadata: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.coverArt')}</div>
            </div>
            <Toggle checked={settings.embedCoverArt} onChange={(v) => setAndSave({ embedCoverArt: v })} />
          </div>
        </Card>

        <Card title={t('settings.playlistDownloads')}>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.createPlaylistFolder')}</div>
              <div className="desc">{t('settings.createPlaylistFolderDesc')}</div>
            </div>
            <Toggle checked={settings.createPlaylistFolder} onChange={(v) => setAndSave({ createPlaylistFolder: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.playlistIndexInFilename')}</div>
            </div>
            <Toggle checked={settings.playlistIndexInFilename} onChange={(v) => setAndSave({ playlistIndexInFilename: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.usePlaylistTitleInFolder')}</div>
            </div>
            <Toggle checked={settings.usePlaylistTitleInFolder} onChange={(v) => setAndSave({ usePlaylistTitleInFolder: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.sanitizeFilenames')}</div>
            </div>
            <Toggle checked={settings.sanitizeFilenames} onChange={(v) => setAndSave({ sanitizeFilenames: v })} />
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label>{t('settings.playlistFolderConflict')}</label>
            <select className="select" value={settings.playlistFolderConflict} onChange={(e) => setAndSave({ playlistFolderConflict: e.target.value as never })}>
              <option value="use-existing">{t('settings.conflictUseExisting')}</option>
              <option value="new-numbered">{t('settings.conflictNewNumbered')}</option>
              <option value="ask">{t('settings.conflictAsk')}</option>
            </select>
          </div>
        </Card>

        <Card title={t('settings.performance')}>
          <div className="field">
            <label>{t('settings.analyzeCache')}</label>
            <select className="select" value={settings.analyzeCacheTtlMinutes} onChange={(e) => setAndSave({ analyzeCacheTtlMinutes: Number(e.target.value) })}>
              <option value={5}>5 min</option>
              <option value={10}>10 min</option>
              <option value={30}>30 min</option>
            </select>
          </div>
          <div className="field">
            <label>{t('settings.concurrentFragments')}</label>
            <select className="select" value={settings.concurrentFragments} onChange={(e) => setAndSave({ concurrentFragments: Number(e.target.value) })}>
              {numOpts(1, 16).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div>
              <div className="name">{t('settings.parallelVideoAudio')}</div>
              <div className="desc">{t('settings.parallelVideoAudioDesc')}</div>
            </div>
            <Toggle checked={settings.parallelVideoAudio} onChange={(v) => setAndSave({ parallelVideoAudio: v })} />
          </div>
        </Card>

        <Card title={t('settings.ytdlpVersion')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>yt-dlp</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>{ytDlpVersion || 'Checking...'}</div>
            </div>
            <Button variant="secondary" icon="refresh" onClick={() => void checkYtDlpUpdate()} loading={checkingYtDlp}>
              {t('settings.checkForUpdate')}
            </Button>
          </div>
        </Card>

        <Card title={t('settings.appearance')}>
          <div className="field">
            <label>{t('settings.theme')}</label>
            <div className="chip-grid">
              {(['dark', 'light', 'system'] as const).map((th) => (
                <button key={th} className={`chip ${settings.theme === th ? 'selected' : ''}`} onClick={() => setAndSave({ theme: th })}>
                  {t(`settings.${th}`)}
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="settings-actions">
        <Button variant="primary" icon="check" onClick={() => void save()} loading={saving}>
          {t('settings.save')}
        </Button>
      </div>
    </div>
  )
}
