import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';

import {
  type AccountDto,
  type AccountPatch,
  type AccountRole,
  type AccountStatus,
} from '../api/admin-accounts-api.js';
import { toUserErrorMessage } from '../api/error-message.js';
import type { EmployeeDto } from '../api/admin-employees-api.js';
import { Alert } from '../components/ui/Alert.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { TextField } from '../components/ui/TextField.js';
import {
  accountToDraft,
  buildAccountPatch,
  emptyAccountDraft,
  employeeOptionLabel,
  getAssignableEmployees,
  requiresAccountUpdateConfirmation,
  temporaryPasswordError,
  validateCreateAccountDraft,
  validateEditAccountDraft,
  type AccountDraft,
  type AccountDraftErrors,
} from './admin-account-form.js';
import {
  AdminAccountsModel,
  type AdminAccountsConfirmation,
  type AdminAccountsSnapshot,
} from './admin-accounts-model.js';
import './admin-accounts.css';

type CredentialDisclosure = Readonly<{ account: AccountDto; temporaryPassword: string }>;

const roleLabels: Readonly<Record<AccountRole, string>> = {
  ADMIN: 'Admin',
  SUPERVISOR: 'Supervisor',
  EMPLOYEE: 'Karyawan',
};

const statusLabels: Readonly<Record<AccountStatus, string>> = {
  ACTIVE: 'Aktif',
  INACTIVE: 'Tidak aktif',
  SUSPENDED: 'Ditangguhkan',
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(date);
}

function employeeName(employeeId: string | null, employees: readonly EmployeeDto[]): string {
  if (!employeeId) return 'Tidak ditautkan';
  const employee = employees.find((item) => item.id === employeeId);
  return employee ? `${employee.fullName} · NIK ${employee.nik}` : 'Profil karyawan tidak tersedia';
}

function AccountForm({
  account,
  snapshot,
  onCancel,
  onSave,
}: Readonly<{
  account: AccountDto | null;
  snapshot: AdminAccountsSnapshot;
  onCancel: () => void;
  onSave: (account: AccountDto | null, draft: AccountDraft) => void;
}>) {
  const [draft, setDraft] = useState(() =>
    account ? accountToDraft(account) : emptyAccountDraft(),
  );
  const [errors, setErrors] = useState<AccountDraftErrors>({});
  const editingAccountId = account?.id ?? null;
  const assignableEmployees = getAssignableEmployees(
    snapshot.employees,
    snapshot.accounts,
    editingAccountId,
  );
  const employeesUnavailable = snapshot.employeesState !== 'ready';

  function setField<K extends keyof AccountDraft>(field: K, value: AccountDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (account) {
      const nextErrors = validateEditAccountDraft(draft);
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length === 0) onSave(account, draft);
      return;
    }
    const validation = validateCreateAccountDraft(draft);
    setErrors(validation.errors);
    if (validation.input) onSave(null, draft);
  }

  return (
    <form className="admin-account-form" noValidate onSubmit={submit}>
      {snapshot.mutationError !== null && (
        <Alert tone="danger" title="Perubahan belum tersimpan">
          {toUserErrorMessage(snapshot.mutationError)}
        </Alert>
      )}
      <TextField
        autoComplete="off"
        error={errors.username ?? ''}
        hint="Maksimal 256 karakter. Username harus berbeda dari username dan NIK yang sudah digunakan."
        label="Nama pengguna"
        maxLength={256}
        onChange={(event) => setField('username', event.target.value)}
        required
        value={draft.username}
      />
      <SelectField
        error={errors.role ?? ''}
        label="Peran"
        onChange={(value) => setField('role', value as AccountRole | '')}
        options={[
          { value: '', label: 'Pilih peran' },
          { value: 'ADMIN', label: 'Admin' },
          { value: 'SUPERVISOR', label: 'Supervisor' },
          { value: 'EMPLOYEE', label: 'Karyawan' },
        ]}
        required
        value={draft.role}
      />
      {account && (
        <SelectField
          error={errors.status ?? ''}
          label="Status akun"
          onChange={(value) => setField('status', value as AccountStatus | '')}
          options={[
            { value: '', label: 'Pilih status' },
            { value: 'ACTIVE', label: 'Aktif' },
            { value: 'INACTIVE', label: 'Tidak aktif' },
            { value: 'SUSPENDED', label: 'Ditangguhkan' },
          ]}
          required
          value={draft.status}
        />
      )}
      <div className="admin-account-form__employee">
        <label className="ds-field__label" htmlFor="admin-account-employee">
          Profil karyawan <span className="admin-account-form__optional">Opsional</span>
        </label>
        <select
          className="ds-input"
          disabled={employeesUnavailable}
          id="admin-account-employee"
          onChange={(event) => setField('employeeId', event.target.value)}
          value={draft.employeeId}
        >
          <option value="">Tidak ditautkan</option>
          {account?.employeeId &&
            employeesUnavailable &&
            draft.employeeId === account.employeeId && (
              <option value={account.employeeId}>Profil saat ini · detail belum tersedia</option>
            )}
          {assignableEmployees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employeeOptionLabel(employee)}
            </option>
          ))}
        </select>
        {snapshot.employeesState === 'loading' && (
          <span className="ds-field__hint">Memuat profil untuk pemilihan…</span>
        )}
        {snapshot.employeesState === 'error' && (
          <span className="ds-field__hint">
            Daftar profil belum tersedia. Pilihan tautan dikunci agar relasi yang ada tidak berubah.
          </span>
        )}
        {snapshot.employeesState === 'ready' && (
          <span className="ds-field__hint">
            Hanya profil yang belum ditautkan ke akun lain yang dapat dipilih. Profil tidak dibuat
            otomatis.
          </span>
        )}
      </div>
      {!account && (
        <p className="admin-account-form__hint">
          Status awal mengikuti server. Password sementara dibuat oleh server dan hanya ditampilkan
          satu kali setelah akun berhasil dibuat.
        </p>
      )}
      <div className="admin-account-form__actions">
        <Button disabled={snapshot.mutation === 'saving'} onClick={onCancel} variant="secondary">
          Batal
        </Button>
        <Button loading={snapshot.mutation === 'saving'} type="submit">
          {account ? 'Simpan perubahan' : 'Buat akun'}
        </Button>
      </div>
    </form>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  error,
  required,
}: Readonly<{
  label: string;
  value: string;
  options: readonly Readonly<{ value: string; label: string }>[];
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
}>) {
  const id = `account-select-${label.toLowerCase().replaceAll(' ', '-')}`;
  const errorId = `${id}-error`;
  return (
    <div className="ds-field">
      <label className="ds-field__label" htmlFor={id}>
        {label}
        {required && <span className="ds-field__required"> *</span>}
      </label>
      <select
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className={`ds-input${error ? ' ds-input--error' : ''}`}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value || 'empty'} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <span className="ds-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function AccountCard({
  account,
  employee,
  disabled,
  onEdit,
  onDeactivate,
  onResetPassword,
}: Readonly<{
  account: AccountDto;
  employee: string;
  disabled: boolean;
  onEdit: (account: AccountDto) => void;
  onDeactivate: (account: AccountDto) => void;
  onResetPassword: (account: AccountDto) => void;
}>) {
  return (
    <article className="admin-account-card">
      <header className="admin-account-card__header">
        <div>
          <h3>{account.username}</h3>
          <p>{employee}</p>
        </div>
        <span
          className={`admin-account-status admin-account-status--${account.status.toLowerCase()}`}
        >
          {statusLabels[account.status]}
        </span>
      </header>
      <dl className="admin-account-card__facts">
        <div>
          <dt>Peran</dt>
          <dd>{roleLabels[account.role]}</dd>
        </div>
        <div>
          <dt>Password awal</dt>
          <dd>
            {account.mustChangePassword ? 'Wajib diganti saat login' : 'Tidak ada perubahan wajib'}
          </dd>
        </div>
        <div>
          <dt>Diperbarui</dt>
          <dd>{formatDate(account.updatedAt)}</dd>
        </div>
      </dl>
      <div className="admin-account-card__actions">
        <Button disabled={disabled} onClick={() => onEdit(account)} variant="secondary">
          Ubah akun
        </Button>
        <Button disabled={disabled} onClick={() => onResetPassword(account)} variant="quiet">
          Reset password
        </Button>
        {account.status === 'ACTIVE' && (
          <Button disabled={disabled} onClick={() => onDeactivate(account)} variant="danger">
            Nonaktifkan
          </Button>
        )}
      </div>
    </article>
  );
}

export function AdminAccountsPage() {
  const model = useMemo(() => new AdminAccountsModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );
  const [section, setSection] = useState<'accounts' | 'devices'>('accounts');
  const [editorAccount, setEditorAccount] = useState<AccountDto | null | undefined>(undefined);
  const [resetTarget, setResetTarget] = useState<AccountDto | null>(null);
  const [resetDraft, setResetDraft] = useState('');
  const [resetDraftError, setResetDraftError] = useState<string | null>(null);
  const [passwordForConfirmation, setPasswordForConfirmation] = useState<string | null>(null);
  const [credentialDisclosure, setCredentialDisclosure] = useState<CredentialDisclosure | null>(
    null,
  );
  const [resetOutcome, setResetOutcome] = useState<Readonly<{ mustChangePassword: true }> | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    void model.loadAll(controller.signal);
    return () => {
      controller.abort();
      model.invalidateRequests();
    };
  }, [model]);

  function closeEditor() {
    if (snapshot.mutation !== 'saving') setEditorAccount(undefined);
  }

  function openReset(account: AccountDto) {
    setResetTarget(account);
    setResetDraft('');
    setResetDraftError(null);
    setResetOutcome(null);
  }

  function closeReset() {
    if (snapshot.mutation === 'saving') return;
    setResetTarget(null);
    setResetDraft('');
    setResetDraftError(null);
  }

  function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetTarget) return;
    const validationError = temporaryPasswordError(resetDraft);
    setResetDraftError(validationError);
    if (validationError) return;
    if (model.requestPasswordReset(resetTarget.id)) {
      setPasswordForConfirmation(resetDraft);
      setResetTarget(null);
      setResetDraft('');
      setResetDraftError(null);
    }
  }

  function saveAccount(account: AccountDto | null, draft: AccountDraft) {
    if (!account) {
      const validation = validateCreateAccountDraft(draft);
      if (validation.input && model.requestCreate(validation.input)) setEditorAccount(undefined);
      return;
    }

    const patch: AccountPatch | null = buildAccountPatch(account, draft);
    if (!patch) {
      setEditorAccount(undefined);
      return;
    }
    if (requiresAccountUpdateConfirmation(patch)) {
      if (model.requestUpdate(account.id, patch)) setEditorAccount(undefined);
      return;
    }
    void model.updateAccount(account.id, patch).then((saved) => {
      if (saved) setEditorAccount(undefined);
    });
  }

  async function confirmAction() {
    const pending = snapshot.pendingConfirmation;
    const result = await model.confirmPending(
      pending?.kind === 'reset-password' ? (passwordForConfirmation ?? undefined) : undefined,
    );
    if (!result) return;
    if (result.kind === 'created') {
      setCredentialDisclosure({
        account: result.account,
        temporaryPassword: result.temporaryPassword,
      });
    }
    if (result.kind === 'password-reset') {
      setPasswordForConfirmation(null);
      setResetDraft('');
      setResetDraftError(null);
      setResetOutcome({ mustChangePassword: result.result.mustChangePassword });
    }
  }

  function cancelConfirmation() {
    model.cancelConfirmation();
    if (!snapshot.confirmationBusy && snapshot.pendingConfirmation?.kind === 'reset-password') {
      setPasswordForConfirmation(null);
      setResetDraft('');
    }
  }

  const pending = snapshot.pendingConfirmation;
  return (
    <main className="admin-accounts-page">
      <header className="admin-accounts-header">
        <div>
          <span className="section-kicker">AKSES & PERANGKAT</span>
          <h1>Akun pengguna</h1>
          <p>Kelola hak akses, tautan profil, password sementara, dan persetujuan perangkat.</p>
        </div>
        {section === 'accounts' && (
          <Button disabled={snapshot.mutation === 'saving'} onClick={() => setEditorAccount(null)}>
            Tambah akun
          </Button>
        )}
      </header>

      {snapshot.notice && (
        <Alert tone="success" title="Pembaruan berhasil">
          {snapshot.notice}
        </Alert>
      )}
      {snapshot.mutationError !== null && (
        <Alert tone="danger" title="Perubahan belum berhasil">
          {toUserErrorMessage(snapshot.mutationError)}
        </Alert>
      )}
      {resetOutcome && (
        <Alert tone="success" title="Password sementara berhasil diatur">
          Server menyatakan wajib ganti password saat login berikutnya:{' '}
          {resetOutcome.mustChangePassword ? 'Ya' : 'Tidak'}.
        </Alert>
      )}

      <nav className="admin-accounts-tabs" aria-label="Bagian pengelolaan akun">
        <button
          aria-current={section === 'accounts' ? 'page' : undefined}
          className={section === 'accounts' ? 'is-active' : ''}
          onClick={() => setSection('accounts')}
          type="button"
        >
          Akun
        </button>
        <button
          aria-current={section === 'devices' ? 'page' : undefined}
          className={section === 'devices' ? 'is-active' : ''}
          onClick={() => setSection('devices')}
          type="button"
        >
          Persetujuan perangkat
        </button>
      </nav>

      {section === 'accounts' ? (
        <section className="admin-account-list" aria-labelledby="admin-account-list-title">
          <header className="admin-account-list__header">
            <div>
              <span className="section-kicker">DAFTAR SERVER</span>
              <h2 id="admin-account-list-title">Akun login</h2>
            </div>
            <p>Perubahan akun divalidasi kembali oleh server.</p>
          </header>
          {snapshot.accountsState === 'error' && (
            <ErrorState error={snapshot.accountsError} onRetry={() => void model.loadAccounts()} />
          )}
          {(snapshot.accountsState === 'idle' || snapshot.accountsState === 'loading') && (
            <LoadingState label="Memuat akun dari server…" />
          )}
          {snapshot.accountsState === 'ready' && snapshot.accounts.length === 0 && (
            <EmptyState
              title="Belum ada akun"
              description="Buat akun login hanya setelah username, peran, dan tautan profil dikonfirmasi."
              action={<Button onClick={() => setEditorAccount(null)}>Tambah akun</Button>}
            />
          )}
          {snapshot.accountsState === 'ready' && snapshot.accounts.length > 0 && (
            <div className="admin-account-grid">
              {snapshot.accounts.map((account) => (
                <AccountCard
                  account={account}
                  disabled={snapshot.mutation === 'saving'}
                  employee={employeeName(account.employeeId, snapshot.employees)}
                  key={account.id}
                  onDeactivate={(value) => model.requestDeactivation(value.id)}
                  onEdit={(value) => setEditorAccount(value)}
                  onResetPassword={openReset}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="admin-device-list" aria-labelledby="admin-device-list-title">
          <header className="admin-account-list__header">
            <div>
              <span className="section-kicker">HANYA PERMINTAAN PENDING</span>
              <h2 id="admin-device-list-title">Persetujuan perangkat</h2>
            </div>
            <Button
              disabled={snapshot.bindingsState === 'loading' || snapshot.mutation === 'saving'}
              onClick={() => void model.loadPendingBindings()}
              variant="secondary"
            >
              Muat ulang
            </Button>
          </header>
          {snapshot.employeesState === 'error' && (
            <Alert tone="warning" title="Nama karyawan belum tersedia">
              Permintaan tetap ditampilkan dari server; label karyawan menggunakan keterangan umum.
              <button
                className="admin-accounts-inline-action"
                onClick={() => void model.loadEmployees()}
                type="button"
              >
                Coba muat profil lagi
              </button>
            </Alert>
          )}
          {snapshot.bindingsState === 'error' && (
            <ErrorState
              error={snapshot.bindingsError}
              onRetry={() => void model.loadPendingBindings()}
            />
          )}
          {(snapshot.bindingsState === 'idle' || snapshot.bindingsState === 'loading') && (
            <LoadingState label="Memuat permintaan perangkat…" />
          )}
          {snapshot.bindingsState === 'ready' && snapshot.pendingBindings.length === 0 && (
            <EmptyState
              title="Tidak ada permintaan perangkat pending"
              description="Daftar ini hanya memuat permintaan yang statusnya masih menunggu persetujuan."
            />
          )}
          {snapshot.bindingsState === 'ready' && snapshot.pendingBindings.length > 0 && (
            <div className="admin-account-grid">
              {snapshot.pendingBindings.map((binding) => (
                <article className="admin-device-card" key={binding.id}>
                  <header className="admin-account-card__header">
                    <div>
                      <h3>{employeeName(binding.employeeId, snapshot.employees)}</h3>
                      <p>Nama perangkat: {binding.deviceName}</p>
                    </div>
                    <span className="admin-account-status admin-account-status--pending">
                      Menunggu
                    </span>
                  </header>
                  <dl className="admin-account-card__facts">
                    <div>
                      <dt>Diminta pada</dt>
                      <dd>{formatDate(binding.requestedAt)}</dd>
                    </div>
                  </dl>
                  <div className="admin-account-card__actions">
                    <Button
                      disabled={snapshot.mutation === 'saving'}
                      onClick={() => model.requestDeviceApproval(binding.id)}
                    >
                      Setujui perangkat
                    </Button>
                    <Button
                      disabled={snapshot.mutation === 'saving'}
                      onClick={() => model.requestDeviceRevocation(binding.id)}
                      variant="danger"
                    >
                      Cabut permintaan
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <Modal
        description="Perubahan dikirim ke server hanya setelah data diperiksa."
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editorAccount !== undefined}
        title={editorAccount ? 'Ubah akun pengguna' : 'Buat akun pengguna'}
      >
        {editorAccount !== undefined && (
          <AccountForm
            account={editorAccount}
            onCancel={closeEditor}
            onSave={saveAccount}
            snapshot={snapshot}
          />
        )}
      </Modal>

      <Modal
        description="Password ini dikirim ke server dan tidak disimpan di browser."
        onOpenChange={(open) => {
          if (!open) closeReset();
        }}
        open={resetTarget !== null}
        title="Atur password sementara"
      >
        {resetTarget && (
          <form className="admin-account-form" noValidate onSubmit={submitReset}>
            <p>
              Akun <strong>{resetTarget.username}</strong>. Password tidak akan ditampilkan kembali
              setelah permintaan berhasil.
            </p>
            <TextField
              autoComplete="new-password"
              error={resetDraftError ?? ''}
              hint="Wajib diisi; maksimum 1.024 karakter UTF-16 dan 4.096 byte UTF-8. Tidak ada aturan kompleksitas tambahan."
              label="Password sementara baru"
              maxLength={1_024}
              onChange={(event) => {
                setResetDraft(event.target.value);
                setResetDraftError(null);
              }}
              required
              type="password"
              value={resetDraft}
            />
            <div className="admin-account-form__actions">
              <Button onClick={closeReset} variant="secondary">
                Batal
              </Button>
              <Button type="submit">Lanjutkan reset</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        description="Tindakan sensitif memerlukan konfirmasi sebelum dikirim ke server."
        onOpenChange={(open) => {
          if (!open) cancelConfirmation();
        }}
        open={pending !== null}
        title={confirmationTitle(pending)}
      >
        {pending && (
          <div className="admin-account-confirmation">
            {confirmationBody(pending, snapshot)}
            {snapshot.confirmationError !== null && (
              <Alert tone="danger" title="Tindakan belum berhasil">
                {toUserErrorMessage(snapshot.confirmationError)}
              </Alert>
            )}
            <div className="admin-account-form__actions">
              <Button
                disabled={snapshot.confirmationBusy}
                onClick={cancelConfirmation}
                variant="secondary"
              >
                Batal
              </Button>
              <Button
                loading={snapshot.confirmationBusy}
                onClick={() => void confirmAction()}
                variant={
                  pending.kind === 'deactivate-account' || pending.kind === 'revoke-device'
                    ? 'danger'
                    : 'primary'
                }
              >
                {confirmationActionLabel(pending)}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        description="Password ini hanya tersedia sekarang. Setelah dialog ditutup, password dihapus dari state halaman dan tidak dapat dibuka kembali."
        onOpenChange={(open) => {
          if (!open) setCredentialDisclosure(null);
        }}
        open={credentialDisclosure !== null}
        title="Akun dibuat — catat password satu kali"
      >
        {credentialDisclosure && (
          <section className="admin-account-credential" aria-live="polite">
            <p>
              Akun <strong>{credentialDisclosure.account.username}</strong> berhasil dibuat.
            </p>
            <p className="admin-account-credential__warning">
              Bagikan melalui saluran aman yang disetujui. Minta pengguna mengganti password pada
              login pertama.
            </p>
            <div className="admin-account-credential__value" aria-label="Password sementara">
              <code>{credentialDisclosure.temporaryPassword}</code>
            </div>
            <Button onClick={() => setCredentialDisclosure(null)}>Tutup dan hapus password</Button>
          </section>
        )}
      </Modal>
    </main>
  );
}

function confirmationTitle(pending: AdminAccountsConfirmation | null): string {
  if (!pending) return 'Konfirmasi tindakan';
  switch (pending.kind) {
    case 'create-account':
      return 'Konfirmasi pembuatan akun';
    case 'update-account':
      return 'Konfirmasi perubahan akses';
    case 'deactivate-account':
      return 'Nonaktifkan akun?';
    case 'reset-password':
      return 'Konfirmasi reset password';
    case 'approve-device':
      return 'Setujui perangkat ini?';
    case 'revoke-device':
      return 'Cabut permintaan perangkat?';
  }
}

function confirmationActionLabel(pending: AdminAccountsConfirmation): string {
  switch (pending.kind) {
    case 'create-account':
      return 'Buat akun';
    case 'update-account':
      return 'Simpan perubahan';
    case 'deactivate-account':
      return 'Ya, nonaktifkan';
    case 'reset-password':
      return 'Reset password';
    case 'approve-device':
      return 'Ya, setujui';
    case 'revoke-device':
      return 'Ya, cabut';
  }
}

function confirmationBody(pending: AdminAccountsConfirmation, snapshot: AdminAccountsSnapshot) {
  switch (pending.kind) {
    case 'create-account':
      return (
        <>
          <p>
            Buat akun <strong>{pending.input.username}</strong> dengan peran{' '}
            <strong>{roleLabels[pending.input.role]}</strong>?
          </p>
          <p>
            {pending.input.employeeId
              ? `Profil: ${employeeName(pending.input.employeeId, snapshot.employees)}.`
              : 'Akun ini tidak ditautkan ke profil karyawan.'}{' '}
            Status awal mengikuti server. Password akan ditampilkan satu kali setelah berhasil.
          </p>
        </>
      );
    case 'update-account': {
      const account = snapshot.accounts.find((item) => item.id === pending.accountId);
      const changes: string[] = [];
      if (pending.patch.username !== undefined)
        changes.push(`Nama pengguna: ${pending.patch.username}`);
      if (pending.patch.role !== undefined)
        changes.push(`Peran: ${roleLabels[pending.patch.role]}`);
      if (pending.patch.status !== undefined)
        changes.push(`Status: ${statusLabels[pending.patch.status]}`);
      if (pending.patch.employeeId !== undefined) {
        changes.push(`Profil: ${employeeName(pending.patch.employeeId, snapshot.employees)}`);
      }
      return (
        <>
          <p>
            Simpan perubahan untuk akun <strong>{account?.username ?? 'yang dipilih'}</strong>?
          </p>
          <ul>
            {changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          <p>Perubahan peran, status, dan tautan profil dapat mengubah akses akun.</p>
        </>
      );
    }
    case 'deactivate-account':
      return (
        <>
          <p>
            Akun{' '}
            <strong>
              {snapshot.accounts.find((item) => item.id === pending.accountId)?.username ??
                'yang dipilih'}
            </strong>{' '}
            akan ditandai tidak aktif. Data akun tidak dihapus.
          </p>
          <p>
            Server menjaga minimal dua Admin aktif. UI tidak memperkirakan batas ini dari daftar
            yang mungkin sudah berubah; bila server menolak, pesan aman akan ditampilkan.
          </p>
        </>
      );
    case 'reset-password':
      return (
        <>
          <p>
            Reset password untuk akun{' '}
            <strong>
              {snapshot.accounts.find((item) => item.id === pending.accountId)?.username ??
                'yang dipilih'}
            </strong>
            ?
          </p>
          <p>
            Password yang Anda masukkan dikirim ke server, seluruh sesi aktif akun akan dicabut, dan
            pengguna wajib mengganti password saat login berikutnya. Password tidak akan disimpan
            atau ditampilkan setelah berhasil.
          </p>
        </>
      );
    case 'approve-device': {
      const binding = snapshot.pendingBindings.find((item) => item.id === pending.bindingId);
      return (
        <>
          <p>
            Setujui perangkat <strong>{binding?.deviceName ?? 'yang dipilih'}</strong> untuk{' '}
            {binding ? employeeName(binding.employeeId, snapshot.employees) : 'karyawan terkait'}?
          </p>
          <p>
            Persetujuan dapat otomatis mencabut perangkat lain yang sudah disetujui untuk karyawan
            yang sama. Sesi pada perangkat lama itu juga akan diakhiri oleh server.
          </p>
        </>
      );
    }
    case 'revoke-device': {
      const binding = snapshot.pendingBindings.find((item) => item.id === pending.bindingId);
      return (
        <>
          <p>
            Cabut permintaan perangkat <strong>{binding?.deviceName ?? 'yang dipilih'}</strong>?
          </p>
          <p>
            Server akan mengubah status binding menjadi dicabut dan mengakhiri sesi yang terkait.
            Jika status binding berubah sejak daftar dimuat, akses pada perangkat itu dapat
            terputus.
          </p>
        </>
      );
    }
  }
}
