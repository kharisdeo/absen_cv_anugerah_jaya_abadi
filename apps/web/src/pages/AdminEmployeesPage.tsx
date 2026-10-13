import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';

import { toUserErrorMessage } from '../api/error-message.js';
import type { EmployeeDto } from '../api/admin-employees-api.js';
import { Alert } from '../components/ui/Alert.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { TextField } from '../components/ui/TextField.js';
import { AdminEmployeesModel, type AdminEmployeesSnapshot } from './admin-employees-model.js';
import {
  employeeProfileDiff,
  employeeToDraft,
  emptyEmployeeDraft,
  formatEmploymentDate,
  validateEmployeeDraft,
  type EmployeeDraft,
  type EmployeeDraftField,
} from './admin-employee-form.js';
import './admin-employees.css';

function useAdminEmployees() {
  const model = useMemo(() => new AdminEmployeesModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );

  useEffect(() => {
    const controller = new AbortController();
    void model.loadEmployees(controller.signal);
    return () => controller.abort();
  }, [model]);

  return { model, snapshot };
}

function EmployeeStatus({ active }: Readonly<{ active: boolean }>) {
  return (
    <span className={`ds-status ds-status--${active ? 'positive' : 'neutral'}`}>
      <span className="ds-status__dot" aria-hidden="true" />
      {active ? 'Aktif' : 'Tidak aktif'}
    </span>
  );
}

function EmployeeForm({
  employee,
  snapshot,
  onCancel,
  onSave,
}: Readonly<{
  employee: EmployeeDto | null;
  snapshot: AdminEmployeesSnapshot;
  onCancel: () => void;
  onSave: (employee: EmployeeDto | null, draft: EmployeeDraft) => Promise<void>;
}>) {
  const [draft, setDraft] = useState(() =>
    employee ? employeeToDraft(employee) : emptyEmployeeDraft(),
  );
  const [errors, setErrors] = useState<Partial<Record<EmployeeDraftField, string>>>({});

  function updateField(field: EmployeeDraftField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateEmployeeDraft(draft);
    setErrors(result.errors);
    if (result.input) void onSave(employee, draft);
  }

  return (
    <form className="admin-employee-form" noValidate onSubmit={submit}>
      {snapshot.mutationError !== null && (
        <Alert tone="danger" title="Perubahan belum tersimpan">
          {toUserErrorMessage(snapshot.mutationError)}
        </Alert>
      )}
      <TextField
        autoComplete="off"
        error={errors.nik ?? ''}
        hint="Maksimal 64 karakter. NIK/identitas harus unik sesuai data perusahaan."
        label="NIK"
        maxLength={64}
        onChange={(event) => updateField('nik', event.target.value)}
        required
        value={draft.nik}
      />
      <TextField
        autoComplete="name"
        error={errors.fullName ?? ''}
        label="Nama lengkap"
        maxLength={150}
        onChange={(event) => updateField('fullName', event.target.value)}
        required
        value={draft.fullName}
      />
      <TextField
        error={errors.position ?? ''}
        hint="Opsional, maksimal 100 karakter."
        label="Jabatan"
        maxLength={100}
        onChange={(event) => updateField('position', event.target.value)}
        value={draft.position}
      />
      <TextField
        autoComplete="off"
        error={errors.employmentDate ?? ''}
        label="Tanggal mulai bekerja"
        onChange={(event) => updateField('employmentDate', event.target.value)}
        type="date"
        value={draft.employmentDate}
      />
      <p className="admin-employee-form__hint">
        Form ini mengelola profil karyawan saja. Akun login dan persetujuan perangkat dikelola
        melalui fitur terpisah.
      </p>
      <div className="admin-employee-form__actions">
        <Button disabled={snapshot.mutation === 'saving'} onClick={onCancel} variant="secondary">
          Batal
        </Button>
        <Button loading={snapshot.mutation === 'saving'} type="submit">
          Simpan profil
        </Button>
      </div>
    </form>
  );
}

function EmployeeCard({
  employee,
  disabled,
  onEdit,
  onDeactivate,
}: Readonly<{
  employee: EmployeeDto;
  disabled: boolean;
  onEdit: (employee: EmployeeDto) => void;
  onDeactivate: (employeeId: string) => void;
}>) {
  return (
    <article className="admin-employee-card">
      <div className="admin-employee-card__header">
        <div>
          <h2>{employee.fullName}</h2>
          <p className="admin-employee-card__nik">NIK: {employee.nik}</p>
        </div>
        <EmployeeStatus active={employee.status === 'ACTIVE'} />
      </div>
      <dl className="admin-employee-facts">
        <div>
          <dt>Jabatan</dt>
          <dd>{employee.position || 'Belum diisi'}</dd>
        </div>
        <div>
          <dt>Mulai bekerja</dt>
          <dd>{formatEmploymentDate(employee.employmentDate)}</dd>
        </div>
      </dl>
      <div className="admin-employee-card__actions">
        <Button disabled={disabled} onClick={() => onEdit(employee)} variant="secondary">
          Ubah profil
        </Button>
        {employee.status === 'ACTIVE' && (
          <Button disabled={disabled} onClick={() => onDeactivate(employee.id)} variant="danger">
            Tandai tidak aktif
          </Button>
        )}
      </div>
    </article>
  );
}

export function AdminEmployeesPage() {
  const { model, snapshot } = useAdminEmployees();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase('id-ID');
  const visibleEmployees = snapshot.employees.filter((employee) =>
    `${employee.fullName} ${employee.nik} ${employee.position ?? ''}`
      .toLocaleLowerCase('id-ID')
      .includes(query),
  );
  const isBusy = snapshot.mutation === 'saving' || snapshot.confirmationBusy;

  function createEmployee() {
    setEditingEmployeeId(null);
    model.beginCreate();
    setEditorOpen(true);
  }

  function editEmployee(employee: EmployeeDto) {
    setEditingEmployeeId(employee.id);
    setEditorOpen(true);
    void model.beginEdit(employee.id);
  }

  function closeEditor() {
    if (snapshot.mutation !== 'idle') return;
    model.closeEditor();
    setEditingEmployeeId(null);
    setEditorOpen(false);
  }

  async function saveEmployee(employee: EmployeeDto | null, draft: EmployeeDraft) {
    const { input } = validateEmployeeDraft(draft);
    if (!input) return;
    if (!employee) {
      const created = await model.createEmployee(input);
      if (created) {
        setEditingEmployeeId(null);
        setEditorOpen(false);
      }
      return;
    }
    const patch = employeeProfileDiff(employee, input);
    if (Object.keys(patch).length === 0) {
      model.closeEditor();
      setEditorOpen(false);
      return;
    }
    const updated = await model.updateEmployee(employee.id, patch);
    if (updated) {
      setEditingEmployeeId(null);
      setEditorOpen(false);
    }
  }

  return (
    <main className="admin-employees-page">
      <header className="admin-employees-header">
        <div>
          <span className="section-kicker">MASTER DATA</span>
          <h1>Data karyawan</h1>
          <p>Kelola profil karyawan berdasarkan data resmi perusahaan.</p>
        </div>
        <Button onClick={createEmployee}>
          Tambah karyawan <span aria-hidden="true">＋</span>
        </Button>
      </header>

      {snapshot.notice && (
        <Alert tone="success" title="Perubahan tersimpan">
          {snapshot.notice}
        </Alert>
      )}

      {snapshot.employeesState === 'error' && (
        <ErrorState error={snapshot.employeesError} onRetry={() => void model.loadEmployees()} />
      )}
      {(snapshot.employeesState === 'idle' || snapshot.employeesState === 'loading') && (
        <LoadingState label="Memuat data karyawan…" />
      )}
      {snapshot.employeesState === 'ready' && snapshot.employees.length === 0 && (
        <EmptyState
          title="Belum ada data karyawan"
          description="Tambahkan profil karyawan yang telah dikonfirmasi oleh perusahaan."
          action={<Button onClick={createEmployee}>Tambah karyawan</Button>}
        />
      )}
      {snapshot.employeesState === 'ready' && snapshot.employees.length > 0 && (
        <section className="admin-employee-list" aria-labelledby="employee-list-title">
          <div className="admin-employee-list__toolbar">
            <div>
              <span className="section-kicker">PROFIL</span>
              <h2 id="employee-list-title">Karyawan</h2>
            </div>
            <TextField
              aria-label="Cari nama, NIK, atau jabatan"
              label="Cari karyawan"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nama, NIK, jabatan"
              value={search}
            />
          </div>
          {visibleEmployees.length === 0 ? (
            <p className="admin-employee-list__empty" role="status">
              Tidak ada profil yang cocok dengan pencarian.
            </p>
          ) : (
            <div className="admin-employee-grid">
              {visibleEmployees.map((employee) => (
                <EmployeeCard
                  disabled={isBusy}
                  employee={employee}
                  key={employee.id}
                  onDeactivate={(employeeId) => model.requestDeactivation(employeeId)}
                  onEdit={editEmployee}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <Modal
        description="Perubahan divalidasi kembali oleh server sebelum disimpan."
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editorOpen}
        title={editingEmployeeId ? 'Ubah profil karyawan' : 'Tambah karyawan'}
      >
        {snapshot.editorState === 'loading' && <LoadingState label="Memuat profil karyawan…" />}
        {snapshot.editorState === 'error' && (
          <ErrorState
            error={snapshot.editorError}
            onRetry={() => {
              if (editingEmployeeId) void model.beginEdit(editingEmployeeId);
            }}
          />
        )}
        {snapshot.editorState === 'ready' && (
          <EmployeeForm
            key={snapshot.editorEmployee?.id ?? 'new'}
            employee={snapshot.editorEmployee}
            onCancel={closeEditor}
            onSave={saveEmployee}
            snapshot={snapshot}
          />
        )}
      </Modal>

      <Modal
        description="Profil karyawan akan ditandai tidak aktif. Data profil dan histori terkait tidak dihapus."
        onOpenChange={(open) => {
          if (!open) model.cancelDeactivation();
        }}
        open={snapshot.pendingDeactivation !== null}
        title="Tandai karyawan tidak aktif?"
      >
        {snapshot.pendingDeactivation !== null && (
          <p>
            Nonaktifkan profil <strong>{snapshot.pendingDeactivation.fullName}</strong> (
            {snapshot.pendingDeactivation.nik})?
          </p>
        )}
        {snapshot.confirmationError !== null && (
          <Alert tone="danger" title="Perubahan belum berhasil">
            {toUserErrorMessage(snapshot.confirmationError)}
          </Alert>
        )}
        <div className="admin-employee-form__actions">
          <Button
            disabled={snapshot.confirmationBusy}
            onClick={() => model.cancelDeactivation()}
            variant="secondary"
          >
            Batal
          </Button>
          <Button
            loading={snapshot.confirmationBusy}
            onClick={() => void model.confirmDeactivation()}
            variant="danger"
          >
            Ya, tandai tidak aktif
          </Button>
        </div>
      </Modal>
    </main>
  );
}
