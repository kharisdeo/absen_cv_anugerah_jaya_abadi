import { useEffect, useId, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';

import { toUserErrorMessage } from '../api/error-message.js';
import type { WorkShiftDto } from '../api/admin-shifts-api.js';
import { Alert } from '../components/ui/Alert.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { TextField } from '../components/ui/TextField.js';
import {
  emptyShiftDraft,
  formatShiftMinutes,
  formatShiftTime,
  formatShiftWorkDays,
  ISO_WEEKDAYS,
  shiftInputDiff,
  shiftToDraft,
  validateShiftDraft,
  type ShiftDraft,
  type ShiftDraftField,
} from './admin-shift-form.js';
import { AdminHolidaysSection } from './AdminHolidaysSection.js';
import { AdminShiftAssignmentsSection } from './AdminShiftAssignmentsSection.js';
import { AdminShiftsModel, type AdminShiftsSnapshot } from './admin-shifts-model.js';
import './admin-shifts.css';

function useAdminShifts() {
  const model = useMemo(() => new AdminShiftsModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );

  useEffect(() => {
    const controller = new AbortController();
    void model.loadShifts(controller.signal);
    return () => controller.abort();
  }, [model]);

  return { model, snapshot };
}

function ShiftStatus({ active }: Readonly<{ active: boolean }>) {
  return (
    <span className={`ds-status ds-status--${active ? 'positive' : 'neutral'}`}>
      <span className="ds-status__dot" aria-hidden="true" />
      {active ? 'Aktif' : 'Tidak aktif'}
    </span>
  );
}

function ShiftForm({
  shift,
  snapshot,
  onCancel,
  onSave,
}: Readonly<{
  shift: WorkShiftDto | null;
  snapshot: AdminShiftsSnapshot;
  onCancel: () => void;
  onSave: (shift: WorkShiftDto | null, draft: ShiftDraft) => Promise<void>;
}>) {
  const [draft, setDraft] = useState(() => (shift ? shiftToDraft(shift) : emptyShiftDraft()));
  const [errors, setErrors] = useState<Partial<Record<ShiftDraftField, string>>>({});
  const workDaysErrorId = useId();

  function updateField(field: Exclude<ShiftDraftField, 'workDays'>, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function toggleWorkDay(day: number) {
    setDraft((current) => ({
      ...current,
      workDays: current.workDays.includes(day)
        ? current.workDays.filter((value) => value !== day)
        : [...current.workDays, day].sort((first, second) => first - second),
    }));
    setErrors((current) => ({ ...current, workDays: '' }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateShiftDraft(draft);
    setErrors(result.errors);
    if (result.input) void onSave(shift, draft);
  }

  return (
    <form className="admin-shift-form" noValidate onSubmit={submit}>
      {snapshot.mutationError !== null && (
        <Alert tone="danger" title="Perubahan belum tersimpan">
          {toUserErrorMessage(snapshot.mutationError)}
        </Alert>
      )}
      <TextField
        autoComplete="off"
        error={errors.name ?? ''}
        label="Nama shift"
        onChange={(event) => updateField('name', event.target.value)}
        required
        value={draft.name}
      />
      <div className="admin-shift-form__times">
        <TextField
          error={errors.startTime ?? ''}
          label="Jam mulai"
          onChange={(event) => updateField('startTime', event.target.value)}
          required
          step={1}
          type="time"
          value={draft.startTime}
        />
        <TextField
          error={errors.endTime ?? ''}
          label="Jam selesai"
          onChange={(event) => updateField('endTime', event.target.value)}
          required
          step={1}
          type="time"
          value={draft.endTime}
        />
      </div>
      <div className="admin-shift-form__minutes">
        <TextField
          error={errors.breakMinutes ?? ''}
          inputMode="numeric"
          label="Istirahat (menit)"
          max={2_147_483_647}
          min={0}
          onChange={(event) => updateField('breakMinutes', event.target.value)}
          required
          step={1}
          type="number"
          value={draft.breakMinutes}
        />
        <TextField
          error={errors.lateToleranceMinutes ?? ''}
          inputMode="numeric"
          label="Toleransi telat (menit)"
          max={2_147_483_647}
          min={0}
          onChange={(event) => updateField('lateToleranceMinutes', event.target.value)}
          required
          step={1}
          type="number"
          value={draft.lateToleranceMinutes}
        />
      </div>
      <fieldset
        aria-describedby={errors.workDays ? workDaysErrorId : undefined}
        aria-invalid={errors.workDays ? true : undefined}
        className="admin-shift-weekdays"
      >
        <legend>Hari kerja</legend>
        <p className="admin-shift-weekdays__hint">Pilih minimal satu hari.</p>
        <div className="admin-shift-weekdays__options">
          {ISO_WEEKDAYS.map(({ value, label }) => (
            <label className="admin-shift-weekdays__option" key={value}>
              <input
                checked={draft.workDays.includes(value)}
                onChange={() => toggleWorkDay(value)}
                type="checkbox"
                value={value}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {errors.workDays && (
          <span className="admin-shift-weekdays__error" id={workDaysErrorId} role="alert">
            {errors.workDays}
          </span>
        )}
      </fieldset>
      <p className="admin-shift-form__hint">
        Hari memakai urutan ISO: Senin 1 sampai Minggu 7. Status shift baru mengikuti nilai bawaan
        server.
      </p>
      <div className="admin-shift-form__actions">
        <Button disabled={snapshot.mutation === 'saving'} onClick={onCancel} variant="secondary">
          Batal
        </Button>
        <Button loading={snapshot.mutation === 'saving'} type="submit">
          Simpan shift
        </Button>
      </div>
    </form>
  );
}

function ShiftCard({
  shift,
  disabled,
  onEdit,
  onDeactivate,
}: Readonly<{
  shift: WorkShiftDto;
  disabled: boolean;
  onEdit: (shift: WorkShiftDto) => void;
  onDeactivate: (shiftId: string) => void;
}>) {
  return (
    <article className="admin-shift-card">
      <div className="admin-shift-card__header">
        <h2>{shift.name}</h2>
        <ShiftStatus active={shift.isActive} />
      </div>
      <dl className="admin-shift-facts">
        <div>
          <dt>Jam kerja</dt>
          <dd>
            <time>{formatShiftTime(shift.startTime)}</time>
            <span aria-hidden="true"> – </span>
            <time>{formatShiftTime(shift.endTime)}</time>
          </dd>
        </div>
        <div>
          <dt>Istirahat</dt>
          <dd>{formatShiftMinutes(shift.breakMinutes)}</dd>
        </div>
        <div>
          <dt>Toleransi telat</dt>
          <dd>{formatShiftMinutes(shift.lateToleranceMinutes)}</dd>
        </div>
        <div className="admin-shift-facts__days">
          <dt>Hari kerja</dt>
          <dd>{formatShiftWorkDays(shift.workDays)}</dd>
        </div>
      </dl>
      <div className="admin-shift-card__actions">
        <Button disabled={disabled} onClick={() => onEdit(shift)} variant="secondary">
          Ubah shift
        </Button>
        {shift.isActive && (
          <Button disabled={disabled} onClick={() => onDeactivate(shift.id)} variant="danger">
            Nonaktifkan
          </Button>
        )}
      </div>
    </article>
  );
}

export function AdminShiftsPage() {
  const { model, snapshot } = useAdminShifts();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null);
  const editingShift = snapshot.shifts.find((shift) => shift.id === editingShiftId) ?? null;
  const busy = snapshot.mutation !== 'idle' || snapshot.confirmationBusy;

  function openCreate() {
    if (snapshot.shiftsState !== 'ready' || busy) return;
    setEditingShiftId(null);
    model.clearMutationError();
    setEditorOpen(true);
  }

  function openEdit(shift: WorkShiftDto) {
    if (busy) return;
    setEditingShiftId(shift.id);
    model.clearMutationError();
    setEditorOpen(true);
  }

  function closeEditor() {
    if (snapshot.mutation !== 'idle') return;
    setEditingShiftId(null);
    setEditorOpen(false);
  }

  async function saveShift(shift: WorkShiftDto | null, draft: ShiftDraft) {
    const { input } = validateShiftDraft(draft);
    if (!input) return;

    if (shift) {
      const patch = shiftInputDiff(shift, input);
      if (Object.keys(patch).length === 0) {
        closeEditor();
        return;
      }
      if (await model.saveShift(shift.id, patch)) closeEditor();
      return;
    }

    if (await model.saveShift(null, input)) closeEditor();
  }

  return (
    <main className="admin-shifts-page">
      <header className="admin-shifts-header">
        <div>
          <span className="section-kicker">MASTER DATA</span>
          <h1>Jadwal &amp; shift</h1>
          <p>Kelola katalog jam kerja dan hari kerja yang digunakan sistem.</p>
        </div>
        <Button disabled={snapshot.shiftsState !== 'ready' || busy} onClick={openCreate}>
          Tambah shift <span aria-hidden="true">＋</span>
        </Button>
      </header>

      {snapshot.notice && (
        <Alert tone="success" title="Perubahan tersimpan">
          {snapshot.notice}
        </Alert>
      )}

      {snapshot.shiftsState === 'error' && (
        <ErrorState error={snapshot.shiftsError} onRetry={() => void model.loadShifts()} />
      )}
      {(snapshot.shiftsState === 'idle' || snapshot.shiftsState === 'loading') && (
        <LoadingState label="Memuat data shift…" />
      )}
      {snapshot.shiftsState === 'ready' && snapshot.shifts.length === 0 && (
        <EmptyState
          title="Belum ada katalog shift"
          description="Tambahkan data shift untuk mengelola jam kerja dan hari kerja yang tercatat di sistem."
          action={<Button onClick={openCreate}>Tambah shift</Button>}
        />
      )}
      {snapshot.shiftsState === 'ready' && snapshot.shifts.length > 0 && (
        <section className="admin-shift-list" aria-labelledby="shift-list-title">
          <div className="admin-shift-list__heading">
            <div>
              <span className="section-kicker">KATALOG</span>
              <h2 id="shift-list-title">Shift kerja</h2>
            </div>
          </div>
          <div className="admin-shift-grid">
            {snapshot.shifts.map((shift) => (
              <ShiftCard
                disabled={busy}
                key={shift.id}
                onDeactivate={(shiftId) => model.requestDeactivation(shiftId)}
                onEdit={openEdit}
                shift={shift}
              />
            ))}
          </div>
        </section>
      )}

      <AdminShiftAssignmentsSection shifts={snapshot.shifts} shiftsState={snapshot.shiftsState} />

      <AdminHolidaysSection />

      <Modal
        description="Perubahan katalog divalidasi kembali oleh server sebelum disimpan."
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editorOpen}
        title={editingShiftId ? 'Ubah shift' : 'Tambah shift'}
      >
        <ShiftForm
          key={editingShift?.id ?? 'new'}
          onCancel={closeEditor}
          onSave={saveShift}
          shift={editingShift}
          snapshot={snapshot}
        />
      </Modal>

      <Modal
        description="Shift akan ditandai tidak aktif oleh server. Data shift tidak dihapus permanen."
        onOpenChange={(open) => {
          if (!open) model.cancelDeactivation();
        }}
        open={snapshot.pendingDeactivation !== null}
        title="Nonaktifkan shift?"
      >
        {snapshot.pendingDeactivation !== null && (
          <p>
            Nonaktifkan shift <strong>{snapshot.pendingDeactivation.name}</strong>?
          </p>
        )}
        {snapshot.confirmationError !== null && (
          <Alert tone="danger" title="Perubahan belum berhasil">
            {toUserErrorMessage(snapshot.confirmationError)}
          </Alert>
        )}
        <div className="admin-shift-form__actions">
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
            Ya, nonaktifkan
          </Button>
        </div>
      </Modal>
    </main>
  );
}
