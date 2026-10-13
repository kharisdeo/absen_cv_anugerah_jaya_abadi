import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';

import { toUserErrorMessage } from '../api/error-message.js';
import type {
  ShiftAssignmentCreateInput,
  ShiftAssignmentDto,
} from '../api/admin-shift-assignments-api.js';
import type { WorkShiftDto } from '../api/admin-shifts-api.js';
import { Alert } from '../components/ui/Alert.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { TextField } from '../components/ui/TextField.js';
import { formatShiftMinutes, formatShiftTime, formatShiftWorkDays } from './admin-shift-form.js';
import {
  eligibleStoresForEmployee,
  emptyShiftAssignmentDraft,
  isValidCalendarDate,
  shiftAssignmentInputDiff,
  shiftAssignmentToDraft,
  validateAssignmentDeactivationDate,
  validateShiftAssignmentDraft,
  type ShiftAssignmentDraftField,
} from './admin-shift-assignment-form.js';
import {
  AdminShiftAssignmentsModel,
  type AdminShiftAssignmentsSnapshot,
} from './admin-shift-assignments-model.js';
import type { ShiftListState } from './admin-shifts-model.js';
import './admin-shift-assignments.css';

function useAdminShiftAssignments() {
  const model = useMemo(() => new AdminShiftAssignmentsModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );

  useEffect(() => {
    const controller = new AbortController();
    void model.loadAssignments(controller.signal);
    void model.loadReferences(controller.signal);
    return () => controller.abort();
  }, [model]);

  return { model, snapshot };
}

function SelectField({
  label,
  value,
  onChange,
  children,
  error,
  hint,
  disabled,
  required = false,
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  error?: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
}>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="ds-field">
      <label className="ds-field__label" htmlFor={id}>
        {label}
        {required && (
          <span className="ds-field__required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <select
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`ds-input${error ? ' ds-input--error' : ''}`}
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        value={value}
      >
        {children}
      </select>
      {hint && (
        <span className="ds-field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="ds-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function AssignmentForm({
  assignment,
  snapshot,
  shifts,
  onCancel,
  onSave,
}: Readonly<{
  assignment: ShiftAssignmentDto | null;
  snapshot: AdminShiftAssignmentsSnapshot;
  shifts: readonly WorkShiftDto[];
  onCancel: () => void;
  onSave: (
    assignment: ShiftAssignmentDto | null,
    input: ShiftAssignmentCreateInput,
  ) => Promise<void>;
}>) {
  const [draft, setDraft] = useState(() =>
    assignment ? shiftAssignmentToDraft(assignment) : emptyShiftAssignmentDraft(),
  );
  const [errors, setErrors] = useState<Partial<Record<ShiftAssignmentDraftField, string>>>({});
  const options = useMemo(
    () => ({
      employees: snapshot.employees,
      stores: snapshot.stores,
      shifts,
      employeeStoreIds: snapshot.employeeStoreIds,
      ...(assignment ? { assignment } : {}),
    }),
    [assignment, shifts, snapshot.employeeStoreIds, snapshot.employees, snapshot.stores],
  );
  const activeEmployees = snapshot.employees.filter((employee) => employee.status === 'ACTIVE');
  const visibleShifts = shifts.filter(
    (shift) => shift.isActive || shift.id === assignment?.workShiftId,
  );
  const eligibleStores = eligibleStoresForEmployee(draft.employeeId, options);
  const busy = snapshot.mutation === 'saving';

  function updateField(field: ShiftAssignmentDraftField, value: string) {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === 'employeeId' ? { scope: '' } : {}),
    }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      if (field === 'employeeId') delete next.scope;
      return next;
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateShiftAssignmentDraft(draft, options);
    setErrors(result.errors);
    if (result.input) void onSave(assignment, result.input);
  }

  return (
    <form className="admin-shift-assignment-form" noValidate onSubmit={submit}>
      {snapshot.mutationError !== null && (
        <Alert tone="danger" title="Perubahan belum tersimpan">
          {toUserErrorMessage(snapshot.mutationError)}
        </Alert>
      )}
      {assignment ? (
        <div className="admin-shift-assignment-form__employee" aria-label="Karyawan penugasan">
          <span className="ds-field__label">Karyawan</span>
          <strong>{assignment.employee.fullName}</strong>
          <span>NIK {assignment.employee.nik} · tidak dapat diubah pada penugasan ini</span>
        </div>
      ) : (
        <SelectField
          {...(errors.employeeId === undefined ? {} : { error: errors.employeeId })}
          label="Karyawan aktif"
          onChange={(value) => updateField('employeeId', value)}
          required
          value={draft.employeeId}
        >
          <option value="">Pilih karyawan</option>
          {activeEmployees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.fullName} · NIK {employee.nik}
            </option>
          ))}
        </SelectField>
      )}

      <SelectField
        {...(errors.workShiftId === undefined ? {} : { error: errors.workShiftId })}
        label="Shift aktif"
        onChange={(value) => updateField('workShiftId', value)}
        required
        value={draft.workShiftId}
      >
        <option value="">Pilih shift</option>
        {visibleShifts.map((shift) => (
          <option key={shift.id} value={shift.id}>
            {shift.name} · {formatShiftTime(shift.startTime)}–{formatShiftTime(shift.endTime)}
            {!shift.isActive ? ' · tidak aktif (penugasan saat ini)' : ''}
          </option>
        ))}
      </SelectField>

      <SelectField
        {...(errors.scope === undefined ? {} : { error: errors.scope })}
        hint="Global berlaku untuk seluruh toko. Cakupan toko hanya tersedia untuk toko aktif yang sudah ditugaskan ke karyawan."
        label="Cakupan penugasan"
        onChange={(value) => updateField('scope', value)}
        required
        value={draft.scope}
      >
        <option value="">Pilih cakupan</option>
        <option value="global">Global · seluruh toko</option>
        {eligibleStores.map((store) => {
          const isCurrent = store.id === assignment?.storeId;
          const isEligible =
            store.isActive &&
            (snapshot.employeeStoreIds[draft.employeeId] ?? []).includes(store.id);
          return (
            <option key={store.id} value={store.id}>
              {store.name}
              {!isEligible && isCurrent ? ' · cakupan lama' : ''}
            </option>
          );
        })}
      </SelectField>

      {draft.employeeId && eligibleStores.length === 0 && (
        <p className="admin-shift-assignment-form__hint">
          Karyawan ini belum memiliki toko aktif yang ditugaskan. Cakupan global tetap dapat
          dipilih.
        </p>
      )}

      <div className="admin-shift-assignment-form__dates">
        <TextField
          error={errors.effectiveFrom ?? ''}
          label="Berlaku mulai"
          onChange={(event) => updateField('effectiveFrom', event.target.value)}
          required
          type="date"
          value={draft.effectiveFrom}
        />
        <TextField
          error={errors.effectiveTo ?? ''}
          hint="Kosongkan jika belum ada tanggal akhir."
          label="Berlaku sampai (opsional)"
          onChange={(event) => updateField('effectiveTo', event.target.value)}
          min={isValidCalendarDate(draft.effectiveFrom) ? draft.effectiveFrom : undefined}
          type="date"
          value={draft.effectiveTo}
        />
      </div>
      <p className="admin-shift-assignment-form__hint">
        Tanggal mulai dan akhir bersifat inklusif. Server memeriksa benturan penugasan dan validasi
        akhirnya tetap mengikuti data terkini di server.
      </p>
      {snapshot.referencesState === 'error' && (
        <Alert tone="danger" title="Pilihan belum dapat diverifikasi">
          {toUserErrorMessage(snapshot.referencesError)} Muat ulang pilihan sebelum menyimpan.
        </Alert>
      )}
      <div className="admin-shift-assignment-form__actions">
        <Button disabled={busy} onClick={onCancel} variant="secondary">
          Batal
        </Button>
        <Button
          disabled={snapshot.referencesState !== 'ready' || snapshot.assignmentsState !== 'ready'}
          loading={busy}
          type="submit"
        >
          Simpan penugasan
        </Button>
      </div>
    </form>
  );
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(date);
}

function AssignmentCard({
  assignment,
  storeName,
  editDisabled,
  deactivationDisabled,
  onEdit,
  onDeactivate,
}: Readonly<{
  assignment: ShiftAssignmentDto;
  storeName: string;
  editDisabled: boolean;
  deactivationDisabled: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
}>) {
  return (
    <article className="admin-shift-assignment-card">
      <header className="admin-shift-assignment-card__header">
        <div>
          <span className="section-kicker">KARYAWAN · NIK {assignment.employee.nik}</span>
          <h3>{assignment.employee.fullName}</h3>
        </div>
        <span
          className={`ds-status ds-status--${assignment.employee.status === 'ACTIVE' ? 'positive' : 'neutral'}`}
        >
          <span className="ds-status__dot" aria-hidden="true" />
          {assignment.employee.status === 'ACTIVE' ? 'Karyawan aktif' : 'Karyawan tidak aktif'}
        </span>
      </header>
      <dl className="admin-shift-assignment-facts">
        <div>
          <dt>Shift</dt>
          <dd>
            {assignment.workShift.name}
            {!assignment.workShift.isActive ? ' · tidak aktif' : ''}
            <span className="admin-shift-assignment-facts__subline">
              {formatShiftTime(assignment.workShift.startTime)}–
              {formatShiftTime(assignment.workShift.endTime)} ·{' '}
              {formatShiftWorkDays(assignment.workShift.workDays)}
            </span>
          </dd>
        </div>
        <div>
          <dt>Cakupan</dt>
          <dd>{storeName}</dd>
        </div>
        <div>
          <dt>Mulai berlaku</dt>
          <dd>{formatDate(assignment.effectiveFrom)}</dd>
        </div>
        <div>
          <dt>Akhir berlaku</dt>
          <dd>
            {assignment.effectiveTo ? formatDate(assignment.effectiveTo) : 'Belum ditetapkan'}
          </dd>
        </div>
        <div>
          <dt>Istirahat / toleransi</dt>
          <dd>
            {formatShiftMinutes(assignment.workShift.breakMinutes)} istirahat ·{' '}
            {formatShiftMinutes(assignment.workShift.lateToleranceMinutes)} toleransi telat
          </dd>
        </div>
      </dl>
      <div className="admin-shift-assignment-card__actions">
        <Button disabled={editDisabled} onClick={onEdit} variant="secondary">
          Ubah penugasan
        </Button>
        <Button disabled={deactivationDisabled} onClick={onDeactivate} variant="danger">
          {assignment.effectiveTo ? 'Ubah tanggal akhir' : 'Akhiri penugasan'}
        </Button>
      </div>
    </article>
  );
}

function DeactivationForm({
  assignment,
  snapshot,
  value,
  error,
  onValueChange,
  onCancel,
  onConfirm,
}: Readonly<{
  assignment: ShiftAssignmentDto;
  snapshot: AdminShiftAssignmentsSnapshot;
  value: string;
  error: string;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm();
  }

  return (
    <form className="admin-shift-assignment-form" noValidate onSubmit={submit}>
      <p>
        Tentukan tanggal terakhir penugasan <strong>{assignment.employee.fullName}</strong> untuk{' '}
        <strong>{assignment.workShift.name}</strong>. Tanggal ini inklusif dan data tidak dihapus.
      </p>
      {assignment.effectiveTo && (
        <p className="admin-shift-assignment-form__hint">
          Tanggal akhir saat ini {formatDate(assignment.effectiveTo)}; perubahan tidak dapat
          memperpanjangnya.
        </p>
      )}
      <TextField
        error={error}
        hint={`Pilih tanggal mulai ${formatDate(assignment.effectiveFrom)} atau sesudahnya.`}
        label="Tanggal akhir berlaku"
        max={assignment.effectiveTo ?? undefined}
        min={assignment.effectiveFrom}
        onChange={(event) => onValueChange(event.target.value)}
        required
        type="date"
        value={value}
      />
      {snapshot.confirmationError !== null && (
        <Alert tone="danger" title="Tanggal akhir belum tersimpan">
          {toUserErrorMessage(snapshot.confirmationError)}
        </Alert>
      )}
      <div className="admin-shift-assignment-form__actions">
        <Button disabled={snapshot.confirmationBusy} onClick={onCancel} variant="secondary">
          Batal
        </Button>
        <Button loading={snapshot.confirmationBusy} type="submit" variant="danger">
          Simpan tanggal akhir
        </Button>
      </div>
    </form>
  );
}

export function AdminShiftAssignmentsSection({
  shifts,
  shiftsState,
}: Readonly<{
  shifts: readonly WorkShiftDto[];
  shiftsState: ShiftListState;
}>) {
  const { model, snapshot } = useAdminShiftAssignments();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null);
  const [deactivationDate, setDeactivationDate] = useState('');
  const [deactivationDateError, setDeactivationDateError] = useState('');
  const editingAssignment =
    snapshot.assignments.find((assignment) => assignment.id === editingAssignmentId) ?? null;
  const pendingDeactivation = snapshot.pendingDeactivation;
  const busy = snapshot.mutation !== 'idle';
  const canWrite =
    snapshot.assignmentsState === 'ready' &&
    snapshot.referencesState === 'ready' &&
    shiftsState === 'ready';

  function openCreate() {
    if (!canWrite || busy) return;
    setEditingAssignmentId(null);
    model.clearMutationError();
    setEditorOpen(true);
  }

  function openEdit(assignment: ShiftAssignmentDto) {
    if (!canWrite || busy) return;
    setEditingAssignmentId(assignment.id);
    model.clearMutationError();
    setEditorOpen(true);
  }

  function closeEditor() {
    if (busy) return;
    setEditingAssignmentId(null);
    setEditorOpen(false);
  }

  async function saveAssignment(
    assignment: ShiftAssignmentDto | null,
    input: ShiftAssignmentCreateInput,
  ) {
    if (assignment) {
      const patch = shiftAssignmentInputDiff(assignment, input);
      if (Object.keys(patch).length === 0) {
        closeEditor();
        return;
      }
      if (await model.saveAssignment(assignment.id, patch)) closeEditor();
      return;
    }
    if (await model.saveAssignment(null, input)) closeEditor();
  }

  function requestDeactivation(assignmentId: string) {
    setDeactivationDate('');
    setDeactivationDateError('');
    model.requestDeactivation(assignmentId);
  }

  async function confirmDeactivation() {
    if (!pendingDeactivation) return;
    const validationError = validateAssignmentDeactivationDate(
      deactivationDate,
      pendingDeactivation,
    );
    setDeactivationDateError(validationError ?? '');
    if (validationError) return;
    if (await model.confirmDeactivation(deactivationDate)) setDeactivationDate('');
  }

  const activeEmployeesCount = snapshot.employees.filter(
    (employee) => employee.status === 'ACTIVE',
  ).length;
  const activeShiftsCount = shifts.filter((shift) => shift.isActive).length;

  return (
    <section className="admin-shift-assignments" aria-labelledby="shift-assignments-title">
      <header className="admin-shift-assignments__header">
        <div>
          <span className="section-kicker">PENJADWALAN</span>
          <h2 id="shift-assignments-title">Penugasan shift per karyawan</h2>
          <p>
            Atur shift, cakupan toko, dan tanggal berlaku. Tanggal bersifat inklusif; server menjadi
            otoritas untuk memeriksa benturan.
          </p>
        </div>
        <Button disabled={!canWrite || busy} onClick={openCreate}>
          Tambah penugasan <span aria-hidden="true">＋</span>
        </Button>
      </header>

      {snapshot.notice && (
        <Alert tone="success" title="Perubahan tersimpan">
          {snapshot.notice}
        </Alert>
      )}

      {shiftsState === 'error' && (
        <p className="admin-shift-assignment-form__hint" role="status">
          Katalog shift belum termuat. Muat ulang daftar shift di bagian atas untuk mengubah
          penugasan.
        </p>
      )}

      {snapshot.referencesState === 'error' && (
        <ErrorState
          error={snapshot.referencesError}
          onRetry={() => void model.loadReferences()}
          title="Pilihan karyawan dan toko belum dapat dimuat"
        />
      )}
      {(snapshot.referencesState === 'idle' || snapshot.referencesState === 'loading') && (
        <LoadingState label="Memuat pilihan karyawan dan toko…" />
      )}
      {snapshot.assignmentsState === 'error' && (
        <ErrorState
          error={snapshot.assignmentsError}
          onRetry={() => void model.loadAssignments()}
          title="Daftar penugasan shift belum dapat dimuat"
        />
      )}
      {(snapshot.assignmentsState === 'idle' || snapshot.assignmentsState === 'loading') && (
        <LoadingState label="Memuat penugasan shift…" />
      )}
      {snapshot.assignmentsState === 'ready' && snapshot.assignments.length === 0 && (
        <EmptyState
          title="Belum ada penugasan shift"
          description="Buat penugasan untuk karyawan aktif menggunakan shift yang tersedia. Tanggal mulai harus ditentukan secara eksplisit."
          action={
            <Button disabled={!canWrite || busy} onClick={openCreate}>
              Tambah penugasan
            </Button>
          }
        />
      )}
      {snapshot.assignmentsState === 'ready' && snapshot.assignments.length > 0 && (
        <>
          {snapshot.referencesState === 'ready' && activeEmployeesCount === 0 && (
            <p className="admin-shift-assignment-form__hint" role="status">
              Belum ada karyawan aktif untuk penugasan baru. Riwayat penugasan tetap ditampilkan.
            </p>
          )}
          {shiftsState === 'ready' && activeShiftsCount === 0 && (
            <p className="admin-shift-assignment-form__hint" role="status">
              Belum ada shift aktif untuk penugasan baru. Riwayat penugasan tetap ditampilkan.
            </p>
          )}
          <div className="admin-shift-assignment-list">
            {snapshot.assignments.map((assignment) => {
              const store = assignment.storeId
                ? snapshot.stores.find((item) => item.id === assignment.storeId)
                : null;
              const storeName = assignment.storeId
                ? (store?.name ?? 'Toko penugasan')
                : 'Global · seluruh toko';
              return (
                <AssignmentCard
                  assignment={assignment}
                  deactivationDisabled={busy}
                  editDisabled={busy || !canWrite}
                  key={assignment.id}
                  onDeactivate={() => requestDeactivation(assignment.id)}
                  onEdit={() => openEdit(assignment)}
                  storeName={storeName}
                />
              );
            })}
          </div>
        </>
      )}

      <Modal
        description="Tanggal mulai dan akhir bersifat inklusif. Perubahan divalidasi server, termasuk riwayat absensi dan benturan cakupan."
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editorOpen}
        title={editingAssignment ? 'Ubah penugasan shift' : 'Tambah penugasan shift'}
      >
        <AssignmentForm
          assignment={editingAssignment}
          key={editingAssignment?.id ?? 'new-assignment'}
          onCancel={closeEditor}
          onSave={saveAssignment}
          shifts={shifts}
          snapshot={snapshot}
        />
      </Modal>

      <Modal
        description="Penugasan tidak dihapus. Tanggal akhir tersimpan inklusif dan perubahan tetap tunduk pada pemeriksaan histori oleh server."
        onOpenChange={(open) => {
          if (!open) model.cancelDeactivation();
        }}
        open={pendingDeactivation !== null}
        title={
          pendingDeactivation?.effectiveTo
            ? 'Ubah tanggal akhir penugasan?'
            : 'Akhiri penugasan shift?'
        }
      >
        {pendingDeactivation && (
          <DeactivationForm
            assignment={pendingDeactivation}
            error={deactivationDateError}
            onCancel={() => model.cancelDeactivation()}
            onConfirm={() => void confirmDeactivation()}
            onValueChange={(value) => {
              setDeactivationDate(value);
              setDeactivationDateError('');
            }}
            snapshot={snapshot}
            value={deactivationDate}
          />
        )}
      </Modal>
    </section>
  );
}
