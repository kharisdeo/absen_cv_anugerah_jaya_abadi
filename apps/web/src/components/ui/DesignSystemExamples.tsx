import {
  ATTENDANCE_VALIDATION_STATUSES,
  DAILY_ATTENDANCE_STATUSES,
  REQUEST_STATUSES,
} from '../../domain/attendance-state.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { DataTable } from './DataTable.js';
import { EmptyState, ErrorState, LoadingState } from './AsyncState.js';
import { Modal } from './Modal.js';
import { StatusBadge } from './StatusBadge.js';
import { TextField } from './TextField.js';

type ExampleRow = Readonly<{ name: string; status: string }>;
type ErrorExample = Readonly<{ key: string; error: unknown }>;

const EXAMPLE_ERRORS: readonly ErrorExample[] = [
  {
    key: 'credentials',
    error: { code: 'INVALID_CREDENTIALS', detail: 'Contoh detail server yang tidak ditampilkan.' },
  },
  {
    key: 'forbidden',
    error: { code: 'FORBIDDEN', detail: 'Contoh informasi internal yang tidak ditampilkan.' },
  },
  {
    key: 'device-binding',
    error: {
      code: 'DEVICE_BINDING_REQUIRED',
      detail: 'Informasi perangkat internal yang tidak ditampilkan.',
    },
  },
  {
    key: 'server',
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'SQL connection information must stay private.',
    },
  },
  {
    key: 'unknown',
    error: { code: 'UNRECOGNIZED_CODE', title: 'Internal Error', requestId: 'example-only' },
  },
  { key: 'network', error: new TypeError('Contoh detail koneksi yang tidak ditampilkan.') },
];

export function DesignSystemExamples() {
  return (
    <main className="ds-showcase">
      <header className="ds-showcase__group">
        <span className="section-kicker">CONTOH KOMPONEN</span>
        <h1>Design system Absensi AJ</h1>
        <p>Contoh ini mencakup status dari kontrak backend dan state umum tampilan.</p>
      </header>

      <section className="ds-showcase__group" aria-labelledby="validation-examples">
        <h2 id="validation-examples">Status validasi absensi</h2>
        <div className="ds-showcase__statuses">
          {ATTENDANCE_VALIDATION_STATUSES.map((status) => (
            <StatusBadge domain="validation" key={status} status={status} />
          ))}
        </div>
      </section>

      <section className="ds-showcase__group" aria-labelledby="daily-examples">
        <h2 id="daily-examples">Status harian</h2>
        <div className="ds-showcase__statuses">
          {DAILY_ATTENDANCE_STATUSES.map((status) => (
            <StatusBadge domain="daily" key={status} status={status} />
          ))}
        </div>
      </section>

      <section className="ds-showcase__group" aria-labelledby="request-examples">
        <h2 id="request-examples">Status pengajuan</h2>
        <div className="ds-showcase__statuses">
          {REQUEST_STATUSES.map((status) => (
            <StatusBadge domain="request" key={status} status={status} />
          ))}
        </div>
      </section>

      <section className="ds-showcase__group" aria-labelledby="controls-examples">
        <h2 id="controls-examples">Form dan tombol</h2>
        <TextField label="NIK atau nama pengguna" hint="Gunakan identitas dari Admin." />
        <TextField
          label="Contoh field tidak valid"
          defaultValue=""
          error="Periksa kembali nilai yang dimasukkan."
          required
        />
        <div className="ds-showcase__statuses">
          <Button>Simpan perubahan</Button>
          <Button variant="secondary">Batal</Button>
          <Button variant="danger">Tolak pengajuan</Button>
          <Button loading>Sedang menyimpan</Button>
        </div>
      </section>

      <section className="ds-showcase__group" aria-labelledby="alerts-examples">
        <h2 id="alerts-examples">Alert, loading, empty, dan error</h2>
        <Alert tone="success" title="Berhasil">
          Perubahan sudah tersimpan.
        </Alert>
        <Alert tone="warning" title="Menunggu verifikasi">
          Hasil validasi belum ditetapkan. Ini bukan status tidak hadir.
        </Alert>
        <LoadingState label="Memuat ringkasan…" />
        <EmptyState title="Belum ada data" description="Data akan tampil setelah tersedia." />
        {EXAMPLE_ERRORS.map((example) => (
          <ErrorState error={example.error} key={example.key} />
        ))}
      </section>

      <section className="ds-showcase__group" aria-labelledby="table-examples">
        <h2 id="table-examples">Tabel responsif</h2>
        <DataTable<ExampleRow>
          label="Contoh daftar permintaan"
          columns={[
            { key: 'name', header: 'Nama', render: (row: { name: string }) => row.name },
            {
              key: 'status',
              header: 'Status',
              render: (row: { status: string }) => row.status,
            },
          ]}
          rows={[]}
          getRowKey={(row) => row.name}
        />
      </section>

      <Modal
        open={false}
        title="Dialog konfirmasi"
        description="Dialog native mengunci fokus dan mendukung tombol Escape."
        onOpenChange={() => undefined}
      >
        <p>Konten contoh untuk dialog konfirmasi.</p>
      </Modal>
    </main>
  );
}
