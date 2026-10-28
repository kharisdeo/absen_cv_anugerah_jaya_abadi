import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { toUserErrorMessage } from '../api/error-message.js';
import { logout } from '../auth/auth-api.js';
import { homePathForRole } from '../auth/route-policy.js';
import { useSession } from '../auth/session.js';
import { Alert } from '../components/ui/Alert.js';
import { Button } from '../components/ui/Button.js';

export function LoginPlaceholder() {
  return (
    <main className="public-page">
      <div className="public-card">
        <img className="public-logo" src="/icons/app-mark.svg" alt="" width="56" height="56" />
        <span className="section-kicker">CV ANUGERAH JAYA ABADI</span>
        <h1>
          Selamat datang
          <br />
          <em>di ruang absensi.</em>
        </h1>
        <p>Login aman untuk karyawan, supervisor, dan admin akan tersedia pada tahap berikutnya.</p>
        <div className="login-placeholder" role="status">
          <span className="login-placeholder__dot" />
          <span>Halaman login sedang disiapkan.</span>
        </div>
        <small className="privacy-note">
          Sesi menggunakan cookie aman. Aplikasi tidak menyimpan password atau token di perangkat.
        </small>
      </div>
      <span className="public-footer">ABSENSI AJ · WAKTU WIB · PRIVASI TERJAGA</span>
    </main>
  );
}

export function AccessDeniedPage() {
  return (
    <main className="public-page">
      <div className="public-card public-card--compact">
        <span className="section-kicker">AKSES TERBATAS</span>
        <h1>
          Halaman ini
          <br />
          <em>bukan untuk peran Anda.</em>
        </h1>
        <p>Hak akses diperiksa kembali oleh server pada setiap permintaan data.</p>
        <Link className="primary-link" to="/">
          Kembali ke halaman utama
        </Link>
      </div>
    </main>
  );
}

export function DevicePendingPage() {
  const navigate = useNavigate();
  const { session, refreshSession, invalidateSession } = useSession();
  const [isChecking, setIsChecking] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const username = session.status === 'authenticated' ? session.user.username : 'akun ini';

  async function checkApproval(): Promise<void> {
    setIsChecking(true);
    setFeedback(null);
    setError(null);
    try {
      const current = await refreshSession();
      if (current.status === 'unauthenticated') {
        navigate('/login', { replace: true });
        return;
      }
      if (current.status === 'unavailable') {
        setError('Server belum dapat memeriksa persetujuan. Periksa koneksi lalu coba lagi.');
        return;
      }
      if (
        current.status === 'authenticated' &&
        (current.user.role === 'ADMIN' || current.user.deviceBindingStatus === 'APPROVED')
      ) {
        navigate(homePathForRole(current.user.role), { replace: true });
        return;
      }
      setFeedback(
        current.status === 'authenticated' && current.user.deviceBindingStatus === 'REVOKED'
          ? 'Permintaan perangkat ini telah dicabut. Hubungi Admin untuk meminta persetujuan baru.'
          : 'Perangkat masih menunggu persetujuan Admin.',
      );
    } catch (caught: unknown) {
      setError(toUserErrorMessage(caught));
    } finally {
      setIsChecking(false);
    }
  }

  async function switchAccount(): Promise<void> {
    setIsLoggingOut(true);
    setError(null);
    try {
      await logout();
      invalidateSession();
      navigate('/login', { replace: true });
    } catch (caught: unknown) {
      setError(toUserErrorMessage(caught));
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <main className="public-page">
      <div className="public-card public-card--compact">
        <span className="section-kicker">STATUS AKUN</span>
        <h1>Perangkat menunggu persetujuan</h1>
        <p>
          Login berhasil. Persetujuan privasi berbeda dari persetujuan perangkat: Admin perlu
          menyetujui perangkat baru sebelum akun karyawan dapat mengakses data kerja.
        </p>
        <ol className="device-pending-steps">
          <li>
            Minta Admin membuka <strong>Akun pengguna</strong> lalu tab{' '}
            <strong>Persetujuan perangkat</strong> di browser atau perangkat lain.
          </li>
          <li>
            Admin menyetujui permintaan untuk akun <strong>{username}</strong>.
          </li>
          <li>Kembali ke sini dan pilih Periksa persetujuan.</li>
        </ol>
        <p>
          Jika hanya memakai satu browser, keluar dari akun ini, masuk sebagai Admin untuk
          menyetujui perangkat, lalu keluar dan masuk kembali sebagai karyawan.
        </p>
        {error && (
          <Alert title="Tindakan belum berhasil" tone="danger">
            {error}
          </Alert>
        )}
        {feedback && (
          <p className="device-pending-feedback" role="status" aria-live="polite">
            {feedback}
          </p>
        )}
        <div className="device-pending-actions">
          <Button disabled={isLoggingOut} loading={isChecking} onClick={() => void checkApproval()}>
            Periksa persetujuan
          </Button>
          <Button
            disabled={isChecking}
            loading={isLoggingOut}
            onClick={() => void switchAccount()}
            variant="secondary"
          >
            Keluar untuk ganti akun
          </Button>
        </div>
      </div>
    </main>
  );
}

export function SessionStatusPage({
  title,
  message,
  action,
}: Readonly<{ title: string; message: string; action?: 'reload' }>) {
  return (
    <main className="public-page">
      <div className="public-card public-card--compact">
        <span className="section-kicker">STATUS AKUN</span>
        <h1>{title}</h1>
        <p>{message}</p>
        {action === 'reload' ? (
          <button className="primary-button" onClick={() => window.location.reload()} type="button">
            Coba lagi
          </button>
        ) : (
          <Link className="primary-link" to="/login">
            Kembali
          </Link>
        )}
      </div>
    </main>
  );
}
