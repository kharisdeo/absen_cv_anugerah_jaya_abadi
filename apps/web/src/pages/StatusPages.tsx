import { Link } from 'react-router-dom';

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
