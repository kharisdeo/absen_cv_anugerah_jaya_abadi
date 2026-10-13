import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<Readonly<{ outcome: 'accepted' | 'dismissed'; platform: string }>>;
};

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

export function PwaControls() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [offlineReady, setOfflineReady] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const updateServiceWorkerRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    const updateStatus = () => setOffline(!navigator.onLine);
    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);

    updateServiceWorkerRef.current = registerSW({
      immediate: true,
      onOfflineReady: () => setOfflineReady(true),
      onNeedRefresh: () => setUpdateAvailable(true),
    });

    const rememberInstallPrompt = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener('beforeinstallprompt', rememberInstallPrompt);

    return () => {
      window.removeEventListener('online', updateStatus);
      window.removeEventListener('offline', updateStatus);
      window.removeEventListener('beforeinstallprompt', rememberInstallPrompt);
    };
  }, []);

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

  async function installApp(): Promise<void> {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
      return;
    }
    if (isIos && !isStandalone) setShowIosHelp((value) => !value);
  }

  async function updateApp(): Promise<void> {
    await updateServiceWorkerRef.current?.(true);
  }

  return (
    <div className="pwa-controls" aria-live="polite">
      {offline && (
        <p className="pwa-notice pwa-notice--warning">
          Mode offline: hanya tampilan aplikasi yang tersedia.
        </p>
      )}
      {offlineReady && !offline && (
        <p className="pwa-notice">
          Aplikasi siap dibuka saat offline. Data tetap memerlukan koneksi.
        </p>
      )}
      {updateAvailable && (
        <div className="pwa-notice pwa-notice--update">
          <span>Pembaruan aplikasi tersedia.</span>
          <button className="text-button" onClick={() => void updateApp()} type="button">
            Perbarui aplikasi
          </button>
        </div>
      )}
      {!isStandalone && (installPrompt || isIos) && (
        <div className="install-prompt">
          <button className="install-button" onClick={() => void installApp()} type="button">
            {isIos && !installPrompt ? 'Cara pasang aplikasi' : 'Pasang aplikasi'}
          </button>
          {showIosHelp && (
            <p className="ios-help">
              Di Safari, ketuk Bagikan lalu pilih <strong>Tambah ke Layar Utama</strong>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
