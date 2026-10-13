import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';

import { toUserErrorMessage } from '../api/error-message.js';
import { type StoreAssignmentDto, type StoreDto } from '../api/admin-stores-api.js';
import { Alert } from '../components/ui/Alert.js';
import { Button } from '../components/ui/Button.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Modal } from '../components/ui/Modal.js';
import { TextField } from '../components/ui/TextField.js';
import { AdminStoresModel, type AdminStoresSnapshot } from './admin-stores-model.js';
import {
  storeSensitiveChangeLabels,
  emptyStoreDraft,
  storeToDraft,
  validateStoreDraft,
  type StoreDraft,
  type StoreDraftField,
} from './admin-store-form.js';
import './admin-stores.css';

function useAdminStores() {
  const model = useMemo(() => new AdminStoresModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );

  useEffect(() => {
    const controller = new AbortController();
    void model.loadStores(controller.signal);
    void model.loadEmployees(controller.signal);
    return () => controller.abort();
  }, [model]);

  useEffect(() => {
    const storeId = snapshot.selectedStoreId;
    if (!storeId) return;
    const controller = new AbortController();
    void model.loadAssignments(storeId, controller.signal);
    return () => controller.abort();
  }, [model, snapshot.selectedStoreId]);

  return { model, snapshot };
}

function StoreStatus({ active }: Readonly<{ active: boolean }>) {
  return (
    <span className={`ds-status ds-status--${active ? 'positive' : 'neutral'}`}>
      <span className="ds-status__dot" aria-hidden="true" />
      {active ? 'Aktif' : 'Tidak aktif'}
    </span>
  );
}

function StoreForm({
  store,
  snapshot,
  onCancel,
  onSave,
}: Readonly<{
  store: StoreDto | null;
  snapshot: AdminStoresSnapshot;
  onCancel: () => void;
  onSave: (storeId: string | null, draft: StoreDraft) => Promise<void>;
}>) {
  const [draft, setDraft] = useState(() => (store ? storeToDraft(store) : emptyStoreDraft()));
  const [errors, setErrors] = useState<Partial<Record<StoreDraftField, string>>>({});

  function updateField(field: StoreDraftField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateStoreDraft(draft);
    setErrors(result.errors);
    if (result.input) void onSave(store?.id ?? null, draft);
  }

  return (
    <form className="admin-store-form" noValidate onSubmit={submit}>
      {snapshot.storeMutationError !== null && (
        <Alert tone="danger" title="Perubahan belum tersimpan">
          {toUserErrorMessage(snapshot.storeMutationError)}
        </Alert>
      )}
      <TextField
        autoComplete="organization"
        error={errors.name ?? ''}
        label="Nama toko"
        maxLength={160}
        onChange={(event) => updateField('name', event.target.value)}
        required
        value={draft.name}
      />
      <TextField
        error={errors.address ?? ''}
        hint="Opsional, maksimal 500 karakter."
        label="Alamat"
        maxLength={500}
        onChange={(event) => updateField('address', event.target.value)}
        value={draft.address}
      />
      <div className="admin-store-form__coordinates">
        <TextField
          autoComplete="off"
          error={errors.latitude ?? ''}
          inputMode="decimal"
          label="Latitude"
          maxLength={12}
          onChange={(event) => updateField('latitude', event.target.value)}
          required
          value={draft.latitude}
        />
        <TextField
          autoComplete="off"
          error={errors.longitude ?? ''}
          inputMode="decimal"
          label="Longitude"
          maxLength={13}
          onChange={(event) => updateField('longitude', event.target.value)}
          required
          value={draft.longitude}
        />
      </div>
      <p className="admin-store-form__hint">
        Koordinat dipakai oleh server untuk memeriksa lokasi. Nilai ini bukan hasil pemeriksaan
        geofence.
      </p>
      <div className="admin-store-form__coordinates">
        <TextField
          error={errors.radiusMeters ?? ''}
          inputMode="numeric"
          label="Radius lokasi (meter)"
          maxLength={10}
          onChange={(event) => updateField('radiusMeters', event.target.value)}
          required
          value={draft.radiusMeters}
        />
        <TextField
          error={errors.accuracyLimitMeters ?? ''}
          inputMode="numeric"
          label="Batas akurasi GPS (meter)"
          maxLength={10}
          onChange={(event) => updateField('accuracyLimitMeters', event.target.value)}
          required
          value={draft.accuracyLimitMeters}
        />
      </div>
      <TextField
        autoComplete="off"
        error={errors.wifiPublicIp ?? ''}
        hint="Opsional; masukkan satu alamat IPv4 atau IPv6, bukan rentang."
        inputMode="text"
        label="IP publik Wi-Fi"
        maxLength={45}
        onChange={(event) => updateField('wifiPublicIp', event.target.value)}
        value={draft.wifiPublicIp}
      />
      <div className="admin-store-form__actions">
        <Button
          disabled={snapshot.storeMutation === 'saving'}
          onClick={onCancel}
          variant="secondary"
        >
          Batal
        </Button>
        <Button loading={snapshot.storeMutation === 'saving'} type="submit">
          Simpan toko
        </Button>
      </div>
    </form>
  );
}

function StoreDetails({
  store,
  snapshot,
  model,
  onEdit,
}: Readonly<{
  store: StoreDto;
  snapshot: AdminStoresSnapshot;
  model: AdminStoresModel;
  onEdit: (store: StoreDto) => void;
}>) {
  const assignedIds = new Set(snapshot.assignments.map((assignment) => assignment.employeeId));
  const availableEmployees = snapshot.employees.filter((employee) => !assignedIds.has(employee.id));
  const [employeeId, setEmployeeId] = useState('');

  useEffect(() => setEmployeeId(''), [store.id]);

  const busy = snapshot.assignmentMutation !== 'idle' || snapshot.confirmationBusy;
  const canAssign =
    store.isActive &&
    employeeId.length > 0 &&
    snapshot.employeesState === 'ready' &&
    snapshot.assignmentsState === 'ready' &&
    !busy;

  async function addEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canAssign && (await model.assignEmployee(store.id, employeeId))) setEmployeeId('');
  }

  return (
    <div className="admin-store-detail">
      <section className="admin-store-detail__section" aria-labelledby="store-details-title">
        <div className="admin-store-detail__heading">
          <div>
            <span className="section-kicker">DETAIL LOKASI</span>
            <h2 id="store-details-title">Informasi toko</h2>
          </div>
          <StoreStatus active={store.isActive} />
        </div>
        <dl className="admin-store-facts">
          <div>
            <dt>Alamat</dt>
            <dd>{store.address || 'Belum diisi'}</dd>
          </div>
          <div>
            <dt>Koordinat toko</dt>
            <dd>
              <span className="admin-store-coordinate">
                {store.latitude}, {store.longitude}
              </span>
            </dd>
          </div>
          <div>
            <dt>Radius lokasi</dt>
            <dd>{store.radiusMeters.toLocaleString('id-ID')} meter</dd>
          </div>
          <div>
            <dt>Batas akurasi GPS</dt>
            <dd>{store.accuracyLimitMeters.toLocaleString('id-ID')} meter</dd>
          </div>
          <div>
            <dt>IP publik Wi-Fi</dt>
            <dd>{store.wifiPublicIp || 'Tidak dikonfigurasi'}</dd>
          </div>
        </dl>
        <div className="admin-store-detail__actions">
          <Button onClick={() => onEdit(store)} variant="secondary">
            Ubah data toko
          </Button>
          {store.isActive && (
            <Button
              disabled={busy || snapshot.storeMutation !== 'idle'}
              onClick={() => model.requestDeactivate(store.id)}
              variant="danger"
            >
              Tandai tidak aktif
            </Button>
          )}
        </div>
        {!store.isActive && (
          <Alert tone="warning" title="Toko tidak aktif">
            Toko ini tidak dapat menerima penugasan baru. Tidak tersedia aksi untuk mengaktifkannya
            kembali dari halaman ini.
          </Alert>
        )}
      </section>

      <section className="admin-store-detail__section" aria-labelledby="store-assignment-title">
        <div className="admin-store-detail__heading">
          <div>
            <span className="section-kicker">PENUGASAN</span>
            <h2 id="store-assignment-title">Karyawan pada toko ini</h2>
          </div>
          {snapshot.assignmentsState === 'ready' && (
            <span className="admin-store-count">{snapshot.assignments.length} penugasan</span>
          )}
        </div>
        <p className="admin-store-copy">
          Seorang karyawan dapat ditugaskan ke lebih dari satu toko bila sesuai penugasan kerja.
        </p>

        {(snapshot.assignmentsState === 'idle' || snapshot.assignmentsState === 'loading') && (
          <LoadingState label="Memuat penugasan…" />
        )}
        {snapshot.assignmentsState === 'error' && (
          <ErrorState
            error={snapshot.assignmentsError}
            onRetry={() => void model.loadAssignments(store.id)}
          />
        )}
        {snapshot.assignmentsState === 'ready' && snapshot.assignments.length === 0 && (
          <p className="admin-store-inline-empty">
            Belum ada karyawan yang ditugaskan ke toko ini.
          </p>
        )}
        {snapshot.assignmentsState === 'ready' && snapshot.assignments.length > 0 && (
          <ul className="admin-store-assignment-list">
            {snapshot.assignments.map((assignment) => (
              <AssignmentRow
                assignment={assignment}
                disabled={busy}
                key={assignment.employeeId}
                onRemove={() => model.requestAssignmentRemoval(assignment)}
              />
            ))}
          </ul>
        )}

        {snapshot.employeesState === 'error' ? (
          <ErrorState error={snapshot.employeesError} onRetry={() => void model.loadEmployees()} />
        ) : snapshot.employeesState === 'idle' || snapshot.employeesState === 'loading' ? (
          <LoadingState label="Memuat pilihan karyawan…" />
        ) : (
          <form className="admin-store-assign-form" onSubmit={addEmployee}>
            <label className="ds-field__label" htmlFor="admin-store-employee">
              Tambahkan karyawan aktif
            </label>
            <div className="admin-store-assign-form__controls">
              <select
                className="ds-input"
                disabled={!store.isActive || busy || snapshot.assignmentsState !== 'ready'}
                id="admin-store-employee"
                onChange={(event) => setEmployeeId(event.target.value)}
                value={employeeId}
              >
                <option value="">Pilih karyawan…</option>
                {availableEmployees.map((employee) => (
                  <option
                    disabled={employee.status !== 'ACTIVE'}
                    key={employee.id}
                    value={employee.id}
                  >
                    {employee.fullName} · {employee.nik}
                    {employee.status === 'INACTIVE' ? ' · Tidak aktif' : ''}
                  </option>
                ))}
              </select>
              <Button
                disabled={!canAssign}
                loading={snapshot.assignmentMutation === 'assigning'}
                type="submit"
              >
                Tambahkan
              </Button>
            </div>
            {snapshot.employees.length === 0 && (
              <span className="admin-store-form__hint">
                Belum ada data karyawan yang dapat ditugaskan.
              </span>
            )}
            {snapshot.employees.length > 0 && availableEmployees.length === 0 && (
              <span className="admin-store-form__hint">
                Semua karyawan yang tercatat sudah ditugaskan ke toko ini.
              </span>
            )}
            {!store.isActive && (
              <span className="admin-store-form__hint">
                Penugasan baru dinonaktifkan untuk toko berstatus tidak aktif.
              </span>
            )}
            {snapshot.assignmentMutationError !== null && (
              <p className="admin-store-form__error" role="alert">
                {toUserErrorMessage(snapshot.assignmentMutationError)}
              </p>
            )}
          </form>
        )}
      </section>
    </div>
  );
}

function AssignmentRow({
  assignment,
  disabled,
  onRemove,
}: Readonly<{
  assignment: StoreAssignmentDto;
  disabled: boolean;
  onRemove: () => void;
}>) {
  return (
    <li className="admin-store-assignment">
      <div className="admin-store-assignment__identity">
        <strong>{assignment.employee.fullName}</strong>
        <span>
          {assignment.employee.nik} ·{' '}
          {assignment.employee.status === 'ACTIVE' ? 'Aktif' : 'Tidak aktif'}
        </span>
      </div>
      <Button disabled={disabled} onClick={onRemove} variant="quiet">
        Hapus penugasan
      </Button>
    </li>
  );
}

export function AdminStoresPage() {
  const { model, snapshot } = useAdminStores();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingStore, setEditingStore] = useState<StoreDto | null>(null);
  const selectedStore =
    snapshot.stores.find((store) => store.id === snapshot.selectedStoreId) ?? null;
  const pendingConfirmation = snapshot.pendingConfirmation;

  function openCreate() {
    setEditingStore(null);
    setEditorOpen(true);
  }

  function openEdit(store: StoreDto) {
    setEditingStore(store);
    setEditorOpen(true);
  }

  async function saveStore(storeId: string | null, draft: StoreDraft) {
    const { input } = validateStoreDraft(draft);
    if (!input) return;
    if (storeId) {
      const current = snapshot.stores.find((store) => store.id === storeId);
      if (!current) return;
      const changedFields = storeSensitiveChangeLabels(current, input);
      if (changedFields.length > 0) {
        model.requestStoreUpdateConfirmation(storeId, input, changedFields);
        return;
      }
    }
    const saved = await model.saveStore(storeId, input);
    if (saved) setEditorOpen(false);
  }

  async function confirmPendingAction() {
    const pending = snapshot.pendingConfirmation;
    if ((await model.confirmPendingAction()) && pending?.action === 'update-store') {
      setEditorOpen(false);
    }
  }

  return (
    <main className="admin-stores-page">
      <header className="admin-stores-header">
        <div>
          <span className="section-kicker">MASTER DATA</span>
          <h1>Lokasi toko</h1>
          <p>Atur lokasi, batas validasi, dan penugasan karyawan sesuai data dari server.</p>
        </div>
        <Button onClick={openCreate}>
          Tambah toko <span aria-hidden="true">＋</span>
        </Button>
      </header>

      {snapshot.notice && (
        <Alert tone="success" title="Perubahan tersimpan">
          {snapshot.notice}
        </Alert>
      )}

      {(snapshot.storesState === 'idle' || snapshot.storesState === 'loading') && (
        <LoadingState label="Memuat data toko…" />
      )}
      {snapshot.storesState === 'error' && (
        <ErrorState error={snapshot.storesError} onRetry={() => void model.loadStores()} />
      )}
      {snapshot.storesState === 'ready' && snapshot.stores.length === 0 && (
        <EmptyState
          title="Belum ada data toko"
          description="Tambahkan data toko yang telah dikonfirmasi oleh perusahaan."
          action={<Button onClick={openCreate}>Tambah toko</Button>}
        />
      )}
      {snapshot.storesState === 'ready' && snapshot.stores.length > 0 && (
        <div className="admin-stores-layout">
          <nav aria-label="Daftar toko" className="admin-store-list">
            {snapshot.stores.map((store) => (
              <button
                aria-current={store.id === snapshot.selectedStoreId ? 'true' : undefined}
                aria-pressed={store.id === snapshot.selectedStoreId}
                className={`admin-store-list__item${store.id === snapshot.selectedStoreId ? ' admin-store-list__item--selected' : ''}`}
                key={store.id}
                onClick={() => model.selectStore(store.id)}
                type="button"
              >
                <span className="admin-store-list__name">{store.name}</span>
                <span className="admin-store-list__meta">
                  <StoreStatus active={store.isActive} />
                  <span>{store.address || 'Alamat belum diisi'}</span>
                </span>
              </button>
            ))}
          </nav>
          {selectedStore ? (
            <StoreDetails
              key={selectedStore.id}
              model={model}
              onEdit={openEdit}
              snapshot={snapshot}
              store={selectedStore}
            />
          ) : (
            <LoadingState label="Memilih toko…" />
          )}
        </div>
      )}

      <Modal
        description="Perubahan akan divalidasi kembali oleh server sebelum disimpan."
        onOpenChange={(open) => {
          if (!open && snapshot.storeMutation === 'idle') setEditorOpen(false);
        }}
        open={editorOpen}
        title={editingStore ? 'Ubah data toko' : 'Tambah toko'}
      >
        <StoreForm
          key={editingStore?.id ?? 'new'}
          onCancel={() => setEditorOpen(false)}
          onSave={saveStore}
          snapshot={snapshot}
          store={editingStore}
        />
      </Modal>

      <Modal
        description={
          pendingConfirmation?.action === 'deactivate'
            ? 'Server akan menandai toko sebagai tidak aktif. Halaman ini tidak menghapus data historis dan tidak menyediakan pengaktifan kembali.'
            : pendingConfirmation?.action === 'update-store'
              ? 'Perubahan pengaturan lokasi berlaku untuk pemeriksaan absensi berikutnya; riwayat yang sudah tercatat tidak diubah.'
              : 'Penugasan karyawan dan toko ini akan dihapus setelah dikonfirmasi.'
        }
        onOpenChange={(open) => {
          if (!open) model.cancelConfirmation();
        }}
        open={pendingConfirmation !== null}
        title={
          pendingConfirmation?.action === 'deactivate'
            ? 'Tandai toko tidak aktif?'
            : pendingConfirmation?.action === 'update-store'
              ? 'Konfirmasi perubahan lokasi toko'
              : 'Hapus penugasan?'
        }
      >
        {pendingConfirmation?.action === 'update-store' && (
          <>
            <p>
              Terapkan perubahan berikut untuk toko <strong>{pendingConfirmation.storeName}</strong>
              ?
            </p>
            <ul>
              {pendingConfirmation.changedFields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
            <p>Detail nilai tidak diulang di dialog ini. Perubahan tidak mengubah absensi lama.</p>
          </>
        )}
        {pendingConfirmation?.action === 'remove-assignment' && (
          <p>
            Hapus penugasan <strong>{pendingConfirmation.employeeName}</strong> dari toko ini?
          </p>
        )}
        {snapshot.confirmationError !== null && (
          <Alert tone="danger" title="Tindakan belum berhasil">
            {toUserErrorMessage(snapshot.confirmationError)}
          </Alert>
        )}
        <div className="admin-store-form__actions">
          <Button
            disabled={snapshot.confirmationBusy}
            onClick={() => model.cancelConfirmation()}
            variant="secondary"
          >
            Batal
          </Button>
          <Button
            loading={snapshot.confirmationBusy}
            onClick={() => void confirmPendingAction()}
            variant={pendingConfirmation?.action === 'update-store' ? 'primary' : 'danger'}
          >
            {pendingConfirmation?.action === 'deactivate'
              ? 'Ya, tandai tidak aktif'
              : pendingConfirmation?.action === 'update-store'
                ? 'Ya, terapkan perubahan'
                : 'Hapus penugasan'}
          </Button>
        </div>
      </Modal>
    </main>
  );
}
