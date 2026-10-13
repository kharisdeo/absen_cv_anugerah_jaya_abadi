import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';

import { toUserErrorMessage } from '../api/error-message.js';
import type { HolidayCreateInput, HolidayDto } from '../api/admin-holidays-api.js';
import type { StoreDto } from '../api/admin-stores-api.js';
import { Alert } from '../components/ui/Alert.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { TextField } from '../components/ui/TextField.js';
import {
  countHolidaysByDate,
  formatHolidayDate,
  getCalendarCells,
  CALENDAR_WEEKDAYS,
} from './admin-holiday-calendar.js';
import {
  emptyHolidayDraft,
  holidayInputDiff,
  holidayToDraft,
  NATIONAL_HOLIDAY_SCOPE,
  validateHolidayDraft,
  type HolidayDraft,
  type HolidayDraftField,
} from './admin-holiday-form.js';
import {
  AdminHolidaysModel,
  type AdminHolidaysSnapshot,
  type HolidayScopeFilter,
} from './admin-holidays-model.js';
import './admin-holidays.css';

function useAdminHolidays(scope: HolidayScopeFilter) {
  const model = useMemo(() => new AdminHolidaysModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );

  useEffect(() => {
    const controller = new AbortController();
    void model.loadHolidays(scope, controller.signal);
    return () => controller.abort();
  }, [model, scope]);

  useEffect(() => {
    const controller = new AbortController();
    void model.loadStores(controller.signal);
    return () => controller.abort();
  }, [model]);

  return { model, snapshot };
}

function storeScopeLabel(store: StoreDto): string {
  return `${store.name} (${store.isActive ? 'Aktif' : 'Tidak aktif'})`;
}

function HolidayForm({
  holiday,
  initialDate,
  snapshot,
  stores,
  onCancel,
  onSave,
}: Readonly<{
  holiday: HolidayDto | null;
  initialDate: string;
  snapshot: AdminHolidaysSnapshot;
  stores: readonly StoreDto[];
  onCancel: () => void;
  onSave: (holiday: HolidayDto | null, input: HolidayCreateInput) => Promise<void>;
}>) {
  const [draft, setDraft] = useState<HolidayDraft>(() =>
    holiday ? holidayToDraft(holiday) : { ...emptyHolidayDraft(), holidayDate: initialDate },
  );
  const [errors, setErrors] = useState<Partial<Record<HolidayDraftField, string>>>({});
  const existingStore =
    holiday?.storeId && !stores.some((store) => store.id === holiday.storeId)
      ? holiday.storeId
      : null;

  function updateField(field: HolidayDraftField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateHolidayDraft(draft);
    setErrors(result.errors);
    if (result.input) void onSave(holiday, result.input);
  }

  return (
    <form className="admin-holiday-form" noValidate onSubmit={submit}>
      {snapshot.mutationError !== null && (
        <Alert tone="danger" title="Perubahan belum tersimpan">
          {toUserErrorMessage(snapshot.mutationError)}
        </Alert>
      )}
      <TextField
        autoComplete="off"
        error={errors.holidayDate ?? ''}
        label="Tanggal libur"
        onChange={(event) => updateField('holidayDate', event.target.value)}
        required
        type="date"
        value={draft.holidayDate}
      />
      <div className="ds-field">
        <label className="ds-field__label" htmlFor="admin-holiday-scope">
          Cakupan libur{' '}
          <span className="ds-field__required" aria-hidden="true">
            {' '}
            *
          </span>
        </label>
        <select
          aria-describedby={errors.storeScope ? 'admin-holiday-scope-error' : undefined}
          aria-invalid={errors.storeScope ? true : undefined}
          className={`ds-input${errors.storeScope ? ' ds-input--error' : ''}`}
          id="admin-holiday-scope"
          onChange={(event) => updateField('storeScope', event.target.value)}
          required
          value={draft.storeScope}
        >
          <option value="">Pilih cakupan</option>
          <option value={NATIONAL_HOLIDAY_SCOPE}>Nasional</option>
          {existingStore && (
            <option value={existingStore}>Toko tidak tersedia (data tersimpan)</option>
          )}
          {stores.map((store) => (
            <option key={store.id} value={store.id}>
              {storeScopeLabel(store)}
            </option>
          ))}
        </select>
        {errors.storeScope && (
          <span className="ds-field__error" id="admin-holiday-scope-error" role="alert">
            {errors.storeScope}
          </span>
        )}
        <span className="ds-field__hint">
          Semua toko dari server tersedia, termasuk toko tidak aktif. Statusnya ditampilkan sebagai
          informasi.
        </span>
      </div>
      <div className="ds-field">
        <label className="ds-field__label" htmlFor="admin-holiday-description">
          Keterangan{' '}
          <span className="ds-field__required" aria-hidden="true">
            {' '}
            *
          </span>
        </label>
        <textarea
          aria-describedby={errors.description ? 'admin-holiday-description-error' : undefined}
          aria-invalid={errors.description ? true : undefined}
          className={`ds-input admin-holiday-form__description${errors.description ? ' ds-input--error' : ''}`}
          id="admin-holiday-description"
          onChange={(event) => updateField('description', event.target.value)}
          required
          rows={3}
          value={draft.description}
        />
        {errors.description && (
          <span className="ds-field__error" id="admin-holiday-description-error" role="alert">
            {errors.description}
          </span>
        )}
      </div>
      <p className="admin-holiday-form__hint">
        Konflik tanggal dan cakupan diperiksa oleh server. Kalender ini tidak mengubah status
        absensi.
      </p>
      <div className="admin-holiday-form__actions">
        <Button
          disabled={snapshot.mutation === 'saving'}
          onClick={onCancel}
          type="button"
          variant="secondary"
        >
          Batal
        </Button>
        <Button loading={snapshot.mutation === 'saving'} type="submit">
          Simpan hari libur
        </Button>
      </div>
    </form>
  );
}

export function HolidayCalendar({
  month,
  holidays,
  selectedDate,
  onSelectDate,
}: Readonly<{
  month: string;
  holidays: readonly HolidayDto[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}>) {
  const cells = getCalendarCells(month);
  if (cells.length === 0) return null;
  const counts = countHolidaysByDate(holidays);
  const paddedCells = [
    ...cells,
    ...Array.from({ length: (7 - (cells.length % 7)) % 7 }, () => null),
  ];
  const monthLabel = new Intl.DateTimeFormat('id-ID', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00.000Z`));

  return (
    <div className="admin-holiday-calendar">
      <div
        aria-label={`Kalender hari libur ${monthLabel}`}
        className="admin-holiday-calendar__grid"
        role="grid"
      >
        <div className="admin-holiday-calendar__row" role="row">
          {CALENDAR_WEEKDAYS.map((day) => (
            <span className="admin-holiday-calendar__weekday" key={day} role="columnheader">
              {day}
            </span>
          ))}
        </div>
        {Array.from({ length: paddedCells.length / 7 }, (_, rowIndex) => (
          <div className="admin-holiday-calendar__row" key={`${month}-week-${rowIndex}`} role="row">
            {paddedCells.slice(rowIndex * 7, rowIndex * 7 + 7).map((date, columnIndex) => {
              const count = date ? (counts[date] ?? 0) : 0;
              return (
                <div
                  className="admin-holiday-calendar__cell"
                  key={date ?? `${month}-blank-${rowIndex}-${columnIndex}`}
                  role="gridcell"
                >
                  {date ? (
                    <button
                      aria-label={`${formatHolidayDate(date)}${count > 0 ? `, ${count} hari libur` : ''}`}
                      aria-pressed={selectedDate === date}
                      className={`admin-holiday-calendar__day${count > 0 ? ' admin-holiday-calendar__day--has-holiday' : ''}`}
                      onClick={() => onSelectDate(date)}
                      type="button"
                    >
                      <span>{Number(date.slice(-2))}</span>
                      {count > 0 && <span className="admin-holiday-calendar__count">{count}</span>}
                    </button>
                  ) : (
                    <span aria-hidden="true" className="admin-holiday-calendar__blank" />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="admin-holiday-calendar__legend">
        Angka kecil menandai jumlah data hari libur pada tanggal itu dalam cakupan yang sedang
        dipilih.
      </p>
    </div>
  );
}

function HolidayScope({
  holiday,
  stores,
}: Readonly<{ holiday: HolidayDto; stores: readonly StoreDto[] }>) {
  if (holiday.storeId === null) {
    return <span className="admin-holiday-scope">Nasional</span>;
  }
  const store = stores.find((item) => item.id === holiday.storeId);
  if (!store) return <span className="admin-holiday-scope">Toko tidak tersedia</span>;
  return (
    <span className="admin-holiday-scope">
      {store.name}
      <span className={`ds-status ds-status--${store.isActive ? 'positive' : 'neutral'}`}>
        <span className="ds-status__dot" aria-hidden="true" />
        {store.isActive ? 'Aktif' : 'Tidak aktif'}
      </span>
    </span>
  );
}

export function AdminHolidaysSection() {
  const [scope, setScope] = useState<HolidayScopeFilter>('all');
  const [calendarMonth, setCalendarMonth] = useState('');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingHolidayId, setEditingHolidayId] = useState<string | null>(null);
  const [initialDate, setInitialDate] = useState('');
  const { model, snapshot } = useAdminHolidays(scope);
  const editingHoliday =
    snapshot.holidays.find((holiday) => holiday.id === editingHolidayId) ?? null;
  const busy = snapshot.mutation !== 'idle' || snapshot.confirmationBusy;

  function openCreate(date = '') {
    if (snapshot.holidaysState !== 'ready' || snapshot.storesState !== 'ready' || busy) return;
    setEditingHolidayId(null);
    setInitialDate(date);
    model.clearMutationError();
    setEditorOpen(true);
  }

  function openEdit(holiday: HolidayDto) {
    if (busy) return;
    setEditingHolidayId(holiday.id);
    setInitialDate('');
    model.clearMutationError();
    setEditorOpen(true);
  }

  function closeEditor() {
    if (snapshot.mutation !== 'idle') return;
    setEditingHolidayId(null);
    setInitialDate('');
    setEditorOpen(false);
  }

  async function saveHoliday(holiday: HolidayDto | null, input: HolidayCreateInput) {
    if (holiday) {
      const patch = holidayInputDiff(holiday, input);
      if (Object.keys(patch).length === 0) {
        closeEditor();
        return;
      }
      if (await model.saveHoliday(holiday.id, patch, scope)) closeEditor();
      return;
    }
    if (await model.saveHoliday(null, input, scope)) closeEditor();
  }

  return (
    <section className="admin-holidays" aria-labelledby="admin-holidays-title">
      <header className="admin-holidays__header">
        <div>
          <span className="section-kicker">KALENDER</span>
          <h2 id="admin-holidays-title">Hari libur nasional &amp; toko</h2>
          <p>Catat hari libur berdasarkan tanggal dan cakupannya. Data libur dimuat dari server.</p>
        </div>
        <Button
          disabled={snapshot.holidaysState !== 'ready' || snapshot.storesState !== 'ready' || busy}
          onClick={() => openCreate()}
        >
          Tambah hari libur <span aria-hidden="true">＋</span>
        </Button>
      </header>

      {snapshot.notice && (
        <Alert tone="success" title="Perubahan tersimpan">
          {snapshot.notice}
        </Alert>
      )}

      {snapshot.storesState === 'error' && (
        <ErrorState
          error={snapshot.storesError}
          onRetry={() => void model.loadStores()}
          title="Daftar toko belum dapat dimuat"
        />
      )}
      {(snapshot.storesState === 'idle' || snapshot.storesState === 'loading') && (
        <LoadingState label="Memuat pilihan toko…" />
      )}

      <div className="admin-holiday-controls">
        <div className="ds-field">
          <label className="ds-field__label" htmlFor="admin-holiday-filter-scope">
            Cakupan yang ditampilkan
          </label>
          <select
            className="ds-input"
            id="admin-holiday-filter-scope"
            onChange={(event) => {
              setScope(event.target.value);
              setSelectedDate(null);
            }}
            value={scope}
          >
            <option value="all">Semua cakupan</option>
            <option value="national">Nasional saja</option>
            {snapshot.stores.map((store) => (
              <option key={store.id} value={store.id}>
                {storeScopeLabel(store)}
              </option>
            ))}
          </select>
        </div>
        <TextField
          autoComplete="off"
          label="Bulan kalender"
          onChange={(event) => {
            setCalendarMonth(event.target.value);
            setSelectedDate(null);
          }}
          type="month"
          value={calendarMonth}
        />
      </div>

      {calendarMonth ? (
        <HolidayCalendar
          holidays={snapshot.holidays}
          month={calendarMonth}
          onSelectDate={setSelectedDate}
          selectedDate={selectedDate}
        />
      ) : (
        <p className="admin-holiday-calendar__prompt">
          Pilih bulan secara eksplisit untuk menampilkan kalender. Tidak ada bulan bawaan.
        </p>
      )}
      {selectedDate && (
        <div className="admin-holiday-selected-date" aria-live="polite">
          <p>
            Tanggal dipilih: <strong>{formatHolidayDate(selectedDate)}</strong>
          </p>
          <Button
            disabled={
              snapshot.holidaysState !== 'ready' || snapshot.storesState !== 'ready' || busy
            }
            onClick={() => openCreate(selectedDate)}
            variant="secondary"
          >
            Tambah libur pada tanggal ini
          </Button>
        </div>
      )}

      {snapshot.holidaysState === 'error' && (
        <ErrorState
          error={snapshot.holidaysError}
          onRetry={() => void model.loadHolidays(scope)}
          title="Data hari libur belum dapat dimuat"
        />
      )}
      {(snapshot.holidaysState === 'idle' || snapshot.holidaysState === 'loading') && (
        <LoadingState label="Memuat kalender hari libur…" />
      )}
      {snapshot.holidaysState === 'ready' && snapshot.holidays.length === 0 && (
        <EmptyState
          title="Belum ada hari libur pada cakupan ini"
          description="Tambahkan catatan hari libur. Tidak ada tanggal atau hari libur yang diisi otomatis."
          action={
            <Button
              disabled={snapshot.storesState !== 'ready' || busy}
              onClick={() => openCreate(selectedDate ?? '')}
            >
              Tambah hari libur
            </Button>
          }
        />
      )}
      {snapshot.holidaysState === 'ready' && snapshot.holidays.length > 0 && (
        <div className="admin-holiday-list">
          <div className="admin-holiday-list__heading">
            <div>
              <span className="section-kicker">DAFTAR DARI SERVER</span>
              <h3>Hari libur ({snapshot.holidays.length})</h3>
            </div>
          </div>
          <div className="admin-holiday-list__items">
            {snapshot.holidays.map((holiday) => (
              <article className="admin-holiday-card" key={holiday.id}>
                <div className="admin-holiday-card__content">
                  <time className="admin-holiday-card__date" dateTime={holiday.holidayDate}>
                    {formatHolidayDate(holiday.holidayDate)}
                  </time>
                  <p>{holiday.description}</p>
                  <HolidayScope holiday={holiday} stores={snapshot.stores} />
                </div>
                <div className="admin-holiday-card__actions">
                  <Button
                    aria-label={`Ubah hari libur ${formatHolidayDate(holiday.holidayDate)}: ${holiday.description}`}
                    disabled={busy}
                    onClick={() => openEdit(holiday)}
                    variant="secondary"
                  >
                    Ubah
                  </Button>
                  <Button
                    aria-label={`Hapus hari libur ${formatHolidayDate(holiday.holidayDate)}: ${holiday.description}`}
                    disabled={busy}
                    onClick={() => model.requestDelete(holiday.id)}
                    variant="danger"
                  >
                    Hapus
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      <Modal
        description="Tanggal dan cakupan diperiksa oleh server sebelum perubahan disimpan."
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editorOpen}
        title={editingHolidayId ? 'Ubah hari libur' : 'Tambah hari libur'}
      >
        {snapshot.storesState === 'ready' && (
          <HolidayForm
            holiday={editingHoliday}
            initialDate={initialDate}
            key={editingHolidayId ?? `new-${initialDate}`}
            onCancel={closeEditor}
            onSave={saveHoliday}
            snapshot={snapshot}
            stores={snapshot.stores}
          />
        )}
      </Modal>

      <Modal
        description="Penghapusan dikirim ke server dan tidak dapat dibatalkan dari halaman ini."
        onOpenChange={(open) => {
          if (!open) model.cancelDelete();
        }}
        open={snapshot.pendingDelete !== null}
        title="Hapus hari libur?"
      >
        {snapshot.pendingDelete && (
          <p>
            Hapus catatan <strong>{snapshot.pendingDelete.description}</strong> untuk{' '}
            <strong>{formatHolidayDate(snapshot.pendingDelete.holidayDate)}</strong>, cakupan{' '}
            <HolidayScope holiday={snapshot.pendingDelete} stores={snapshot.stores} />?
          </p>
        )}
        {snapshot.confirmationError !== null && (
          <Alert tone="danger" title="Penghapusan belum berhasil">
            {toUserErrorMessage(snapshot.confirmationError)}
          </Alert>
        )}
        <div className="admin-holiday-form__actions">
          <Button
            disabled={snapshot.confirmationBusy}
            onClick={() => model.cancelDelete()}
            type="button"
            variant="secondary"
          >
            Batal
          </Button>
          <Button
            loading={snapshot.confirmationBusy}
            onClick={() => void model.confirmDelete()}
            variant="danger"
          >
            Ya, hapus hari libur
          </Button>
        </div>
      </Modal>
    </section>
  );
}
