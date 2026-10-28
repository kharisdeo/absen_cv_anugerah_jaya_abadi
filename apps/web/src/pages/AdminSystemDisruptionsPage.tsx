import { useEffect, useId, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';

import type { StoreDto } from '../api/admin-stores-api.js';
import type {
  SystemDisruptionCreateInput,
  SystemDisruptionDto,
} from '../api/system-disruptions-api.js';
import { toUserErrorMessage } from '../api/error-message.js';
import { Alert } from '../components/ui/Alert.js';
import { Button } from '../components/ui/Button.js';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Modal } from '../components/ui/Modal.js';
import {
  BUSINESS_TIME_ZONE,
  GLOBAL_STORE_VALUE,
  canSubmitSystemDisruption,
  createEmptySystemDisruptionDraft,
  SystemDisruptionsModel,
  validateSystemDisruptionDraft,
  type SystemDisruptionDraft,
  type SystemDisruptionDraftErrors,
  type SystemDisruptionDraftField,
} from './system-disruptions-model.js';
import './notifications.css';

function formatWibDateTime(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: BUSINESS_TIME_ZONE,
  }).format(new Date(value));
}

function storeDisplayName(storeId: string | null, stores: readonly StoreDto[]): string {
  if (storeId === null) return 'Global · seluruh toko';
  return stores.find((store) => store.id === storeId)?.name ?? 'Toko tidak tersedia di master data';
}

function disruptionColumns(
  stores: readonly StoreDto[],
): readonly DataTableColumn<SystemDisruptionDto>[] {
  return [
    {
      key: 'scope',
      header: 'Cakupan',
      render: (item) => storeDisplayName(item.storeId, stores),
    },
    {
      key: 'period',
      header: 'Periode gangguan (WIB)',
      render: (item) => (
        <span className="system-disruption-time">
          <time dateTime={item.startsAt}>Mulai · {formatWibDateTime(item.startsAt)}</time>
          <time dateTime={item.endsAt}>Selesai · {formatWibDateTime(item.endsAt)}</time>
        </span>
      ),
    },
    { key: 'reason', header: 'Alasan', render: (item) => item.reason },
    {
      key: 'status',
      header: 'Status API',
      render: (item) => (
        <span className={`ds-status ds-status--${item.isActive ? 'positive' : 'neutral'}`}>
          <span className="ds-status__dot" aria-hidden="true" />
          {item.isActive ? 'Aktif' : 'Tidak aktif'}
        </span>
      ),
    },
  ];
}

function FieldError({ id, children }: Readonly<{ id: string; children: string | undefined }>) {
  if (!children) return null;
  return (
    <span className="system-disruption-field__error" id={id}>
      {children}
    </span>
  );
}

export function AdminSystemDisruptionsPage() {
  const model = useMemo(() => new SystemDisruptionsModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );
  const formId = useId();
  const [draft, setDraft] = useState<SystemDisruptionDraft>(createEmptySystemDisruptionDraft);
  const [errors, setErrors] = useState<SystemDisruptionDraftErrors>({});
  const [pendingInput, setPendingInput] = useState<SystemDisruptionCreateInput | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void model.load(controller.signal);
    return () => controller.abort();
  }, [model, snapshot.page, snapshot.pageSize, snapshot.storeFilter, snapshot.refreshVersion]);

  useEffect(() => {
    const controller = new AbortController();
    void model.loadStores(controller.signal);
    return () => controller.abort();
  }, [model]);

  function updateDraft<K extends SystemDisruptionDraftField>(field: K, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submitForConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitSystemDisruption(snapshot)) return;
    const result = validateSystemDisruptionDraft(draft);
    setErrors(result.errors);
    if (result.input) {
      setPendingInput(result.input);
      setConfirmOpen(true);
    }
  }

  async function confirmCreate() {
    if (!pendingInput || !canSubmitSystemDisruption(model.getSnapshot())) return;
    const created = await model.create(pendingInput);
    setConfirmOpen(false);
    if (created) {
      setDraft(createEmptySystemDisruptionDraft());
      setErrors({});
      setPendingInput(null);
    }
  }

  async function retryCreate() {
    const created = await model.retryUncertainCreate();
    if (created) {
      setDraft(createEmptySystemDisruptionDraft());
      setErrors({});
      setPendingInput(null);
    }
  }

  const availableStores = snapshot.stores;
  const periodStart = pendingInput ? formatWibDateTime(pendingInput.startsAt) : '';
  const periodEnd = pendingInput ? formatWibDateTime(pendingInput.endsAt) : '';
  const columns = disruptionColumns(snapshot.stores);

  return (
    <section className="system-disruptions-page" aria-labelledby={`${formId}-page-title`}>
      <header className="system-disruptions-header">
        <div>
          <p className="eyebrow">PENGATURAN OPERASIONAL</p>
          <h1 id={`${formId}-page-title`}>Gangguan sistem</h1>
          <p>
            Catat rentang gangguan untuk mencegah status tidak hadir baru pada jadwal yang
            terdampak.
          </p>
        </div>
      </header>

      <Alert tone="warning" title="Pencatatan tidak mengubah absensi yang sudah ada">
        API hanya mencatat gangguan dan memakainya sebagai guard untuk status tidak hadir yang
        dibuat kemudian. Audit-list dan koreksi massal belum tersedia; status harian atau absensi
        lama tidak diubah dari halaman ini.
      </Alert>

      {snapshot.createNotice && <Alert tone="success">{snapshot.createNotice}</Alert>}
      {snapshot.createError !== null && snapshot.submissionOutcomeUncertain && (
        <Alert tone="danger" title="Hasil belum diketahui — pengiriman ulang aman">
          {toUserErrorMessage(snapshot.createError)} Server mungkin sudah menyimpan gangguan. Coba
          ulang payload yang sama untuk memakai kunci yang sama dan menerima record yang sama bila
          penyimpanan sebelumnya berhasil.
        </Alert>
      )}
      {snapshot.createError !== null && !snapshot.submissionOutcomeUncertain && (
        <Alert tone="danger" title="Gangguan belum tersimpan">
          {toUserErrorMessage(snapshot.createError)} Periksa isian atau hak akses, lalu kirim ulang
          setelah memperbaiki penyebab penolakan.
        </Alert>
      )}

      {snapshot.submissionOutcomeUncertain && (
        <section className="system-disruptions-panel" aria-labelledby={`${formId}-review-title`}>
          <h2 id={`${formId}-review-title`}>Periksa hasil pengiriman</h2>
          <p className="system-disruption-help">
            Pengiriman ulang identik aman karena memakai kunci idempotency yang sama. Pemeriksaan
            daftar tetap berguna, tetapi hasil kosong tidak membuktikan POST sebelumnya gagal karena
            daftar berpaginasi tanpa snapshot konsisten.
          </p>
          <Button
            disabled={snapshot.submitting}
            loading={snapshot.submitting}
            onClick={() => void retryCreate()}
          >
            Kirim ulang payload yang sama
          </Button>
          <Button
            disabled={snapshot.status === 'loading'}
            loading={snapshot.status === 'loading'}
            onClick={() => model.reviewUncertainOutcome()}
            variant="secondary"
          >
            Muat ulang daftar · halaman 1
          </Button>
          <p className="system-disruption-help">
            Form dikunci sampai hasil ini dipastikan dengan retry ber-key sama. Setelah berhasil,
            Anda dapat membuat gangguan lain dengan payload dan kunci baru.
          </p>
        </section>
      )}

      <div className="system-disruption-layout">
        <section className="system-disruptions-panel" aria-labelledby={`${formId}-create-title`}>
          <h2 id={`${formId}-create-title`}>Catat gangguan</h2>
          {snapshot.storesStatus === 'error' && (
            <Alert tone="warning" title="Master toko belum dapat dimuat">
              {toUserErrorMessage(snapshot.storesError)} Anda masih dapat mencatat gangguan global.
              <Button onClick={() => void model.loadStores()} variant="quiet">
                Muat ulang daftar toko
              </Button>
            </Alert>
          )}
          <form className="system-disruption-form" noValidate onSubmit={submitForConfirmation}>
            <fieldset
              className="system-disruption-fieldset"
              disabled={snapshot.submitting || snapshot.submissionOutcomeUncertain}
            >
              <div className="system-disruption-field">
                <label htmlFor={`${formId}-store`}>Cakupan gangguan</label>
                <select
                  aria-describedby={errors.storeId ? `${formId}-store-error` : undefined}
                  aria-invalid={Boolean(errors.storeId)}
                  id={`${formId}-store`}
                  onChange={(event) => updateDraft('storeId', event.target.value)}
                  value={draft.storeId}
                >
                  <option value={GLOBAL_STORE_VALUE}>Global · seluruh toko</option>
                  {availableStores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                      {store.isActive ? '' : ' · tidak aktif'}
                    </option>
                  ))}
                </select>
                <small>Toko berasal dari master data. Gangguan global memakai storeId null.</small>
                <FieldError id={`${formId}-store-error`}>{errors.storeId}</FieldError>
              </div>

              <div className="system-disruption-datetime-grid">
                <div className="system-disruption-field">
                  <label htmlFor={`${formId}-starts`}>Mulai (WIB)</label>
                  <input
                    aria-describedby={`${formId}-wib-note${errors.startsAtLocal ? ` ${formId}-starts-error` : ''}`}
                    aria-invalid={Boolean(errors.startsAtLocal)}
                    id={`${formId}-starts`}
                    onChange={(event) => updateDraft('startsAtLocal', event.target.value)}
                    required
                    type="datetime-local"
                    value={draft.startsAtLocal}
                  />
                  <FieldError id={`${formId}-starts-error`}>{errors.startsAtLocal}</FieldError>
                </div>
                <div className="system-disruption-field">
                  <label htmlFor={`${formId}-ends`}>Selesai (WIB)</label>
                  <input
                    aria-describedby={`${formId}-wib-note${errors.endsAtLocal ? ` ${formId}-ends-error` : ''}`}
                    aria-invalid={Boolean(errors.endsAtLocal)}
                    id={`${formId}-ends`}
                    onChange={(event) => updateDraft('endsAtLocal', event.target.value)}
                    required
                    type="datetime-local"
                    value={draft.endsAtLocal}
                  />
                  <FieldError id={`${formId}-ends-error`}>{errors.endsAtLocal}</FieldError>
                </div>
              </div>
              <p className="system-disruption-help" id={`${formId}-wib-note`}>
                Waktu yang Anda masukkan selalu ditafsirkan sebagai Asia/Jakarta (UTC+07:00), bukan
                zona waktu perangkat ini.
              </p>

              <div className="system-disruption-field">
                <label htmlFor={`${formId}-reason`}>Alasan gangguan</label>
                <textarea
                  aria-invalid={Boolean(errors.reason)}
                  aria-describedby={errors.reason ? `${formId}-reason-error` : undefined}
                  id={`${formId}-reason`}
                  maxLength={500}
                  onChange={(event) => updateDraft('reason', event.target.value)}
                  required
                  rows={4}
                  value={draft.reason}
                />
                <small>{draft.reason.length}/500 karakter</small>
                <FieldError id={`${formId}-reason-error`}>{errors.reason}</FieldError>
              </div>
              <div className="system-disruption-form__actions">
                <Button disabled={!canSubmitSystemDisruption(snapshot)} type="submit">
                  Tinjau pencatatan
                </Button>
              </div>
            </fieldset>
          </form>
        </section>

        <section className="system-disruptions-panel" aria-labelledby={`${formId}-history-title`}>
          <div className="notifications-toolbar">
            <h2 id={`${formId}-history-title`}>Riwayat pencatatan</h2>
            <div className="system-disruptions-filters">
              <label htmlFor={`${formId}-filter-store`}>Filter toko</label>
              <select
                id={`${formId}-filter-store`}
                onChange={(event) => model.setStoreFilter(event.target.value)}
                value={snapshot.storeFilter}
              >
                <option value="all">Semua toko dan global</option>
                {snapshot.stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                    {store.isActive ? '' : ' · tidak aktif'}
                  </option>
                ))}
              </select>
              <Button
                disabled={snapshot.status === 'loading'}
                onClick={() => model.requestRefresh()}
                variant="quiet"
              >
                Perbarui daftar
              </Button>
            </div>
          </div>
          {snapshot.status === 'loading' && <LoadingState label="Memuat riwayat gangguan…" />}
          {snapshot.status === 'error' && (
            <ErrorState error={snapshot.error} onRetry={() => model.requestRefresh()} />
          )}
          {snapshot.status === 'ready' && snapshot.items.length === 0 && (
            <EmptyState
              title={
                snapshot.submissionOutcomeUncertain
                  ? 'Tidak ada hasil pada daftar ini'
                  : 'Belum ada gangguan tercatat'
              }
              description={
                snapshot.submissionOutcomeUncertain
                  ? 'Hasil yang dimuat saat ini kosong. Karena daftar berpaginasi tanpa snapshot konsisten, ini bukan bukti bahwa POST gagal atau gangguan tidak tersimpan. Retry payload identik memakai key yang sama; payload berbeda membuat pencatatan baru.'
                  : 'Pencatatan baru akan muncul di sini setelah disimpan oleh Admin.'
              }
            />
          )}
          {snapshot.status === 'ready' && snapshot.items.length > 0 && (
            <>
              <DataTable
                columns={columns}
                getRowKey={(item) => item.id}
                label="Riwayat gangguan sistem"
                rows={snapshot.items}
              />
              <nav className="notifications-pagination" aria-label="Paginasi gangguan sistem">
                <Button
                  disabled={snapshot.page <= 1}
                  onClick={() => model.goToPage(snapshot.page - 1)}
                  variant="secondary"
                >
                  Sebelumnya
                </Button>
                <span aria-live="polite">Halaman {snapshot.page}</span>
                <Button
                  disabled={!snapshot.hasNextPage}
                  onClick={() => model.goToPage(snapshot.page + 1)}
                  variant="secondary"
                >
                  Berikutnya
                </Button>
              </nav>
            </>
          )}
        </section>
      </div>

      <Modal
        description="Gangguan bersifat append-only pada API saat ini. Pastikan rentang, toko, dan alasan sudah benar."
        onOpenChange={(open) => {
          if (!snapshot.submitting) setConfirmOpen(open);
        }}
        open={confirmOpen}
        title="Konfirmasi gangguan sistem"
      >
        {pendingInput && (
          <div className="system-disruption-form">
            <dl className="system-disruption-summary">
              <div>
                <dt>Cakupan</dt>
                <dd>{storeDisplayName(pendingInput.storeId, snapshot.stores)}</dd>
              </div>
              <div>
                <dt>Mulai</dt>
                <dd>{periodStart} WIB</dd>
              </div>
              <div>
                <dt>Selesai</dt>
                <dd>{periodEnd} WIB</dd>
              </div>
              <div>
                <dt>Alasan</dt>
                <dd>{pendingInput.reason}</dd>
              </div>
            </dl>
            <Alert tone="warning">
              Jika server timeout, record mungkin sudah tersimpan. Payload identik dapat dikirim
              ulang dengan kunci yang sama; perubahan payload menghasilkan kunci baru dan dianggap
              pencatatan terpisah.
            </Alert>
            <div className="system-disruption-form__actions">
              <Button
                disabled={snapshot.submitting}
                onClick={() => setConfirmOpen(false)}
                variant="secondary"
              >
                Kembali
              </Button>
              <Button loading={snapshot.submitting} onClick={() => void confirmCreate()}>
                Konfirmasi dan simpan
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
