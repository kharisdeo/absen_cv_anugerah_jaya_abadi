import type { AttendanceReceipt } from '../../api/attendance-api.js';
import './AttendanceReceiptNotice.css';

const LOCATION_FAILURE_LABELS = {
  PERMISSION_DENIED: 'izin lokasi tidak diberikan',
  POSITION_UNAVAILABLE: 'perangkat tidak memberikan posisi yang dapat digunakan',
  TIMEOUT: 'pengambilan lokasi melewati batas waktu',
} as const;

export function attendanceReceiptTitle(receipt: AttendanceReceipt): string {
  if (!receipt.validationStatus) {
    return receipt.state === 'RECEIVED'
      ? 'Absensi diterima, menunggu pencatatan'
      : 'Absensi tercatat, status menunggu';
  }
  switch (receipt.validationStatus) {
    case 'PENDING_VERIFICATION':
      return 'Tercatat menunggu verifikasi';
    case 'VALID':
      return 'Absensi tercatat valid';
    case 'APPROVED':
      return 'Absensi tercatat dan disetujui';
    case 'REJECTED':
      return 'Absensi tercatat dan ditolak';
    case 'PENDING_OFFLINE':
      return 'Absensi tertunda';
  }
}

export function attendanceReceiptDescription(receipt: AttendanceReceipt): string {
  if (!receipt.validationStatus) {
    if (receipt.locationFailureReason) {
      return `Server telah menyimpan receipt percobaan; ${LOCATION_FAILURE_LABELS[receipt.locationFailureReason]}. Status kehadiran belum tersedia dan belum dinyatakan valid.`;
    }
    return receipt.state === 'RECEIVED'
      ? 'Server telah menerima percobaan ini. Status kehadiran belum tersedia; periksa kembali riwayat absensi.'
      : 'Server telah mencatat percobaan ini, tetapi status kehadiran belum tersedia.';
  }
  if (receipt.validationStatus === 'PENDING_VERIFICATION') {
    return 'Server telah mencatat absensi ini. Statusnya belum valid dan menunggu verifikasi.';
  }
  if (receipt.validationStatus === 'REJECTED') {
    return 'Server mencatat hasil penolakan. Hubungi Admin bila Anda perlu mengajukan koreksi.';
  }
  if (receipt.validationStatus === 'PENDING_OFFLINE') {
    return 'Server mencatat absensi tertunda. Status ini belum dihitung sebagai valid sampai diproses.';
  }
  return 'Status ini berasal dari hasil server.';
}

export function AttendanceReceiptNotice({ receipt }: Readonly<{ receipt: AttendanceReceipt }>) {
  const statusClass = receipt.validationStatus?.toLowerCase() ?? 'pending';
  return (
    <section
      aria-label="Hasil absensi dari server"
      className={`attendance-result attendance-result--${statusClass}`}
      role="status"
      aria-live="polite"
    >
      <span className="section-kicker">HASIL SERVER</span>
      <h3>{attendanceReceiptTitle(receipt)}</h3>
      <p>{attendanceReceiptDescription(receipt)}</p>
      <p className="attendance-result__receipt">
        {receipt.type === 'CHECK_IN' ? 'Absen masuk' : 'Absen pulang'} · diterima{' '}
        {new Intl.DateTimeFormat('id-ID', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Jakarta',
        }).format(new Date(receipt.receivedAt))}{' '}
        WIB
      </p>
    </section>
  );
}
