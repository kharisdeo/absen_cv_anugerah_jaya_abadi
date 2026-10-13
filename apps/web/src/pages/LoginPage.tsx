import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { toUserErrorMessage } from '../api/error-message.js';
import {
  acceptCurrentConsent,
  changePassword,
  getCurrentConsent,
  isSessionExpiryError,
  login,
  type ConsentPolicy,
} from '../auth/auth-api.js';
import { useSession } from '../auth/session.js';
import { Alert } from '../components/ui/Alert.js';
import { Button } from '../components/ui/Button.js';
import { LoadingState } from '../components/ui/AsyncState.js';
import { TextField } from '../components/ui/TextField.js';

const LOCKOUT_ADVISORY =
  'Sebagai langkah keamanan, setelah 5 kali kegagalan akun dapat terkunci selama 15 menit.';

function AuthFrame({
  title,
  introduction,
  wide = false,
  children,
}: Readonly<{
  title: string;
  introduction: string;
  wide?: boolean;
  children: ReactNode;
}>) {
  return (
    <main className="public-page auth-page">
      <section
        className={`public-card auth-card${wide ? ' auth-card--wide' : ''}`}
        aria-labelledby="auth-page-title"
      >
        <img className="public-logo" src="/icons/app-mark.svg" alt="" width="52" height="52" />
        <span className="section-kicker">CV ANUGERAH JAYA ABADI</span>
        <h1 className="auth-title" id="auth-page-title">
          {title}
        </h1>
        <p className="auth-introduction">{introduction}</p>
        {children}
        <small className="privacy-note">
          Sesi dikelola server melalui cookie HttpOnly. Password dan token sesi tidak disimpan di
          penyimpanan browser.
        </small>
      </section>
      <span className="public-footer">ABSENSI AJ · WAKTU WIB · PRIVASI TERJAGA</span>
    </main>
  );
}

export function LoginForm({
  onSubmit,
  initialError,
}: Readonly<{
  onSubmit: (identifier: string, password: string) => Promise<void>;
  initialError?: string;
}>) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const submissionInFlight = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionInFlight.current || !identifier.trim() || !password) return;
    const passwordField = event.currentTarget.elements.namedItem('password');

    submissionInFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(identifier.trim(), password);
    } catch (cause: unknown) {
      setError(toUserErrorMessage(cause));
    } finally {
      setPassword('');
      if (passwordField instanceof HTMLInputElement) passwordField.value = '';
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
      {error && (
        <Alert tone="danger" title="Login belum berhasil">
          {error}
        </Alert>
      )}
      <TextField
        autoCapitalize="none"
        autoComplete="username"
        autoCorrect="off"
        inputMode="text"
        label="Username atau NIK"
        name="identifier"
        onChange={(event) => {
          setIdentifier(event.currentTarget.value);
          setError(null);
        }}
        required
        spellCheck={false}
        value={identifier}
      />
      <TextField
        autoComplete="current-password"
        label="Password"
        name="password"
        onChange={(event) => {
          setPassword(event.currentTarget.value);
          setError(null);
        }}
        required
        type="password"
        value={password}
      />
      <p className="auth-advisory">{LOCKOUT_ADVISORY}</p>
      <Button
        className="auth-submit"
        disabled={!identifier.trim() || !password}
        loading={submitting}
        type="submit"
      >
        Masuk
      </Button>
    </form>
  );
}

export function LoginPage({ initialError }: Readonly<{ initialError?: string }>) {
  const { refreshSession } = useSession();
  const navigate = useNavigate();

  const submit = useCallback(
    async (identifier: string, password: string) => {
      try {
        await login(identifier, password);
        const refreshed = await refreshSession();
        if (refreshed.status === 'unauthenticated') {
          throw new Error('Sesi login belum dapat diverifikasi.');
        }
      } catch (error: unknown) {
        if (isSessionExpiryError(error)) {
          const refreshed = await refreshSession();
          if (refreshed.status === 'unauthenticated') {
            navigate('/login', {
              replace: true,
              state: { notice: toUserErrorMessage(error) },
            });
          }
        }
        throw error;
      }
    },
    [navigate, refreshSession],
  );

  return (
    <AuthFrame
      title="Selamat datang di ruang absensi."
      introduction="Masuk menggunakan username atau NIK yang diberikan oleh Admin."
    >
      <LoginForm {...(initialError ? { initialError } : {})} onSubmit={submit} />
    </AuthFrame>
  );
}

function redirectExpiredSession(
  error: unknown,
  refreshSession: () => Promise<import('../auth/session.js').SessionState>,
  navigate: ReturnType<typeof useNavigate>,
): Promise<boolean> {
  if (!isSessionExpiryError(error)) return Promise.resolve(false);

  return refreshSession().then((session) => {
    if (session.status !== 'unauthenticated') return false;
    navigate('/login', {
      replace: true,
      state: { notice: toUserErrorMessage(error) },
    });
    return true;
  });
}

export function ConsentPolicyView({
  policy,
  accepted,
  disabled = false,
  onAcceptedChange,
}: Readonly<{
  policy: ConsentPolicy;
  accepted: boolean;
  disabled?: boolean;
  onAcceptedChange: (accepted: boolean) => void;
}>) {
  return (
    <div className="consent-content">
      <div className="consent-version">Versi kebijakan: {policy.version}</div>
      <section className="consent-policy" aria-label="Teks kebijakan privasi">
        <div className="consent-policy__text">{policy.text}</div>
      </section>
      <section className="consent-purposes" aria-labelledby="consent-purposes-title">
        <h2 id="consent-purposes-title">Tujuan penggunaan data</h2>
        <ul>
          {policy.purposes.map((purpose) => (
            <li key={purpose.id}>{purpose.label}</li>
          ))}
        </ul>
      </section>
      <label className="consent-checkbox">
        <input
          checked={accepted}
          disabled={disabled}
          onChange={(event) => onAcceptedChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>Saya telah membaca dan menyetujui kebijakan privasi di atas.</span>
      </label>
    </div>
  );
}

export function ConsentStep() {
  const { refreshSession } = useSession();
  const navigate = useNavigate();
  const [policy, setPolicy] = useState<ConsentPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const submissionInFlight = useRef(false);

  const reloadPolicy = useCallback(() => {
    setReloadVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setPolicy(null);
    setAccepted(false);
    setError(null);

    async function loadPolicy(): Promise<void> {
      try {
        const current = await getCurrentConsent(controller.signal);
        if (!active) return;
        setPolicy(current.policy);
        if (!current.consentRequired) {
          const refreshed = await refreshSession();
          if (active && refreshed.status === 'unauthenticated') {
            navigate('/login', {
              replace: true,
              state: { notice: 'Sesi Anda berakhir. Masuk kembali untuk melanjutkan.' },
            });
          }
        }
      } catch (cause: unknown) {
        if (!active) return;
        const redirected = await redirectExpiredSession(cause, refreshSession, navigate);
        if (active && !redirected) setError(cause);
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadPolicy();
    return () => {
      active = false;
      controller.abort();
    };
  }, [navigate, refreshSession, reloadVersion]);

  return (
    <ConsentStepContent
      accepted={accepted}
      error={error}
      loading={loading}
      onAccept={async () => {
        if (!policy || submissionInFlight.current) return;
        submissionInFlight.current = true;
        setSubmitting(true);
        setError(null);
        try {
          await acceptCurrentConsent(policy.version);
          const refreshed = await refreshSession();
          if (refreshed.status === 'authenticated' && refreshed.user.consentRequired) {
            setError({ status: 409, code: 'CONSENT_POLICY_STALE' });
          }
        } catch (cause: unknown) {
          const redirected = await redirectExpiredSession(cause, refreshSession, navigate);
          if (!redirected) setError(cause);
        } finally {
          submissionInFlight.current = false;
          setSubmitting(false);
        }
      }}
      onAcceptedChange={(value) => {
        setAccepted(value);
        setError(null);
      }}
      onReloadPolicy={reloadPolicy}
      policy={policy}
      submitting={submitting}
    />
  );
}

function ConsentStepContent({
  policy,
  accepted,
  loading,
  submitting,
  error,
  onAcceptedChange,
  onAccept,
  onReloadPolicy,
}: Readonly<{
  policy: ConsentPolicy | null;
  accepted: boolean;
  loading: boolean;
  submitting: boolean;
  error: unknown;
  onAcceptedChange: (accepted: boolean) => void;
  onAccept: () => Promise<void>;
  onReloadPolicy: () => void;
}>) {
  if (loading) {
    return (
      <AuthFrame
        title="Tinjau kebijakan privasi"
        introduction="Persetujuan diperlukan sebelum fitur absensi dapat digunakan."
        wide
      >
        <LoadingState label="Memuat kebijakan dari server…" />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Tinjau kebijakan privasi"
      introduction="Baca teks dan tujuan yang disediakan server. Persetujuan tidak akan dikirim sebelum Anda memilih kotak persetujuan."
      wide
    >
      {error !== null && (
        <div className="auth-error-block">
          <Alert tone="danger" title="Kebijakan belum dapat diproses">
            {toUserErrorMessage(error)}
          </Alert>
          <Button onClick={onReloadPolicy} variant="secondary">
            Muat ulang kebijakan
          </Button>
        </div>
      )}
      {policy && (
        <>
          <ConsentPolicyView
            accepted={accepted}
            disabled={submitting}
            onAcceptedChange={onAcceptedChange}
            policy={policy}
          />
          <Button
            className="auth-submit"
            disabled={!accepted || submitting || Boolean(error)}
            loading={submitting}
            onClick={() => void onAccept()}
            type="button"
          >
            Setujui dan lanjutkan
          </Button>
        </>
      )}
      {!policy && !error && (
        <Alert tone="warning" title="Kebijakan belum tersedia">
          Silakan muat ulang kebijakan. Fitur kerja tetap terkunci sampai statusnya dikonfirmasi
          server.
        </Alert>
      )}
    </AuthFrame>
  );
}

export function FirstPasswordForm({
  onSubmit,
}: Readonly<{
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
}>) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const submissionInFlight = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionInFlight.current || !currentPassword || !newPassword || !confirmation) return;
    const passwordFields = ['currentPassword', 'newPassword', 'confirmPassword']
      .map((name) => event.currentTarget.elements.namedItem(name))
      .filter((field): field is HTMLInputElement => field instanceof HTMLInputElement);

    if (newPassword !== confirmation) {
      setConfirmationError('Konfirmasi password belum cocok.');
      return;
    }

    const passwordTooLong = [currentPassword, newPassword].some(
      (value) => value.length > 1_024 || new TextEncoder().encode(value).byteLength > 4_096,
    );
    if (passwordTooLong) {
      setValidationError('Password melebihi batas yang diterima server.');
      return;
    }

    submissionInFlight.current = true;
    setSubmitting(true);
    setError(null);
    setValidationError(null);
    setConfirmationError(null);
    try {
      await onSubmit(currentPassword, newPassword);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      for (const field of passwordFields) field.value = '';
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
      {error !== null && (
        <Alert tone="danger" title="Password belum berhasil diubah">
          {toUserErrorMessage(error)}
        </Alert>
      )}
      <TextField
        autoComplete="current-password"
        label="Password saat ini"
        maxLength={1_024}
        name="currentPassword"
        onChange={(event) => setCurrentPassword(event.currentTarget.value)}
        required
        type="password"
        value={currentPassword}
      />
      <TextField
        autoComplete="new-password"
        {...(validationError ? { error: validationError } : {})}
        hint="Isi password baru. Tidak ada aturan tambahan yang diterapkan di halaman ini."
        label="Password baru"
        maxLength={1_024}
        name="newPassword"
        onChange={(event) => {
          setNewPassword(event.currentTarget.value);
          setValidationError(null);
          setConfirmationError(null);
        }}
        required
        type="password"
        value={newPassword}
      />
      <TextField
        autoComplete="new-password"
        {...(confirmationError ? { error: confirmationError } : {})}
        label="Konfirmasi password baru"
        name="confirmPassword"
        onChange={(event) => {
          setConfirmation(event.currentTarget.value);
          setConfirmationError(null);
        }}
        required
        type="password"
        value={confirmation}
      />
      <Button
        className="auth-submit"
        disabled={!currentPassword || !newPassword || !confirmation}
        loading={submitting}
        type="submit"
      >
        Simpan password baru
      </Button>
    </form>
  );
}

export function FirstPasswordStep() {
  const { refreshSession } = useSession();
  const navigate = useNavigate();

  const submit = useCallback(
    async (currentPassword: string, newPassword: string) => {
      try {
        await changePassword(currentPassword, newPassword);
        const refreshed = await refreshSession();
        if (refreshed.status === 'unauthenticated') {
          navigate('/login', {
            replace: true,
            state: { notice: 'Sesi Anda berakhir. Masuk kembali untuk melanjutkan.' },
          });
        }
      } catch (error: unknown) {
        await redirectExpiredSession(error, refreshSession, navigate);
        throw error;
      }
    },
    [navigate, refreshSession],
  );

  return (
    <AuthFrame
      title="Buat password baru"
      introduction="Akun ini perlu mengganti password sebelum halaman kerja dapat dibuka."
    >
      <FirstPasswordForm onSubmit={submit} />
    </AuthFrame>
  );
}

export function ConsentOnboardingStep() {
  return <ConsentStep />;
}

export function PasswordOnboardingStep() {
  return <FirstPasswordStep />;
}
