import { useEffect, useId, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';

import type { AdminAuditLogItem } from '../api/admin-audit-logs-api.js';
import { Alert } from '../components/ui/Alert.js';
import { Button } from '../components/ui/Button.js';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import {
  AdminAuditLogsModel,
  EMPTY_ADMIN_AUDIT_LOG_FILTERS,
  AUDIT_LOGS_TIME_ZONE,
  type AdminAuditLogFilters,
} from './admin-audit-logs-model.js';
import './admin-audit-logs.css';

function formatWibDateTime(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: AUDIT_LOGS_TIME_ZONE,
  }).format(new Date(value));
}

function renderJsonDetails(label: string, value: Readonly<Record<string, unknown>> | null) {
  if (value === null) return <span aria-label={`${label}: tidak ada`}>—</span>;
  return (
    <details className="admin-audit-json">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function auditLogColumns(): readonly DataTableColumn<AdminAuditLogItem>[] {
  return [
    {
      key: 'occurredAt',
      header: 'Waktu (WIB)',
      render: (item) => (
        <time dateTime={item.occurredAt}>{formatWibDateTime(item.occurredAt)} WIB</time>
      ),
      className: 'admin-audit-cell--time',
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (item) => item.actorUserAccountId ?? 'Tidak diketahui',
      className: 'admin-audit-cell--wrap',
    },
    {
      key: 'entity',
      header: 'Aksi / entity',
      render: (item) => (
        <span className="admin-audit-entity">
          <strong>{item.action}</strong>
          <span>
            {item.entityType} · {item.entityId ?? '—'}
          </span>
        </span>
      ),
      className: 'admin-audit-cell--wrap',
    },
    {
      key: 'source',
      header: 'IP / device hash',
      render: (item) => (
        <span className="admin-audit-source">
          <span>IP · {item.clientIp ?? '—'}</span>
          <span>Device · {item.deviceIdHash ?? '—'}</span>
        </span>
      ),
      className: 'admin-audit-cell--wrap',
    },
    {
      key: 'reason',
      header: 'Alasan',
      render: (item) => item.reason ?? '—',
      className: 'admin-audit-cell--wrap',
    },
    {
      key: 'changes',
      header: 'Before / after',
      render: (item) => (
        <span className="admin-audit-changes">
          {renderJsonDetails('Sebelum', item.beforeData)}
          {renderJsonDetails('Sesudah', item.afterData)}
        </span>
      ),
    },
  ];
}

export function AdminAuditLogsPage() {
  const model = useMemo(() => new AdminAuditLogsModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );
  const formId = useId();
  const [draftFilters, setDraftFilters] = useState<AdminAuditLogFilters>(
    EMPTY_ADMIN_AUDIT_LOG_FILTERS,
  );

  useEffect(() => {
    void model.load();
    return () => model.cancelLoad();
  }, [model, snapshot.filters, snapshot.page, snapshot.pageSize, snapshot.refreshVersion]);

  function updateDraft<K extends keyof AdminAuditLogFilters>(field: K, value: string) {
    setDraftFilters((current) => ({ ...current, [field]: value }));
  }

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (model.setFilters(draftFilters)) setDraftFilters(model.getSnapshot().filters);
  }

  function clearFilters() {
    setDraftFilters(EMPTY_ADMIN_AUDIT_LOG_FILTERS);
    model.setFilters(EMPTY_ADMIN_AUDIT_LOG_FILTERS);
  }

  const columns = auditLogColumns();

  return (
    <section className="admin-audit-logs-page" aria-labelledby={`${formId}-title`}>
      <header className="admin-audit-logs-header">
        <div>
          <p className="eyebrow">KEAMANAN DAN AKUNTABILITAS</p>
          <h1 id={`${formId}-title`}>Audit log</h1>
          <p>Riwayat aktivitas tersimpan untuk pemeriksaan. Data di halaman ini hanya-baca.</p>
        </div>
      </header>

      <form className="admin-audit-filters" onSubmit={submitFilters}>
        <h2>Filter audit</h2>
        <p className="admin-audit-help" id={`${formId}-date-help`}>
          Rentang tanggal inklusif. Batas awal memakai 00.00 WIB dan batas akhir 23.59.59,999 WIB
          (Asia/Jakarta, UTC+07:00).
        </p>
        <div className="admin-audit-filter-grid">
          <label htmlFor={`${formId}-actor`}>
            Actor user account ID (UUID)
            <input
              autoComplete="off"
              id={`${formId}-actor`}
              maxLength={36}
              onChange={(event) => updateDraft('actorUserAccountId', event.currentTarget.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              value={draftFilters.actorUserAccountId}
            />
          </label>
          <label htmlFor={`${formId}-action`}>
            Aksi
            <input
              id={`${formId}-action`}
              maxLength={100}
              onChange={(event) => updateDraft('action', event.currentTarget.value)}
              placeholder="attendance.record.create"
              value={draftFilters.action}
            />
          </label>
          <label htmlFor={`${formId}-entity-type`}>
            Jenis entitas
            <input
              id={`${formId}-entity-type`}
              maxLength={100}
              onChange={(event) => updateDraft('entityType', event.currentTarget.value)}
              placeholder="attendance"
              value={draftFilters.entityType}
            />
          </label>
          <label htmlFor={`${formId}-entity-id`}>
            ID entitas
            <input
              id={`${formId}-entity-id`}
              maxLength={128}
              onChange={(event) => updateDraft('entityId', event.currentTarget.value)}
              value={draftFilters.entityId}
            />
          </label>
          <label htmlFor={`${formId}-from`}>
            Dari tanggal (WIB)
            <input
              aria-describedby={`${formId}-date-help`}
              id={`${formId}-from`}
              onChange={(event) => updateDraft('fromDate', event.currentTarget.value)}
              type="date"
              value={draftFilters.fromDate}
            />
          </label>
          <label htmlFor={`${formId}-to`}>
            Sampai tanggal (WIB)
            <input
              aria-describedby={`${formId}-date-help`}
              id={`${formId}-to`}
              onChange={(event) => updateDraft('toDate', event.currentTarget.value)}
              type="date"
              value={draftFilters.toDate}
            />
          </label>
        </div>
        {snapshot.filterError !== null && (
          <Alert tone="danger" title="Filter belum diterapkan">
            {snapshot.filterError}
          </Alert>
        )}
        <div className="admin-audit-filter-actions">
          <Button type="submit">Terapkan filter</Button>
          <Button onClick={clearFilters} variant="quiet">
            Bersihkan filter
          </Button>
        </div>
      </form>

      <section className="admin-audit-results" aria-label="Hasil audit log">
        {snapshot.status === 'loading' && <LoadingState label="Memuat audit log…" />}
        {snapshot.status === 'error' && (
          <ErrorState error={snapshot.error} onRetry={() => model.requestRefresh()} />
        )}
        {snapshot.status === 'ready' && snapshot.items.length === 0 && (
          <EmptyState
            title="Tidak ada audit log"
            description="Tidak ada catatan yang cocok dengan filter saat ini."
          />
        )}
        {snapshot.status === 'ready' && snapshot.items.length > 0 && (
          <DataTable
            label="Daftar audit log"
            columns={columns}
            rows={snapshot.items}
            getRowKey={(item) => item.id}
          />
        )}
        {snapshot.status === 'ready' && (
          <nav className="admin-audit-pagination" aria-label="Paginasi audit log">
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
        )}
      </section>
    </section>
  );
}
