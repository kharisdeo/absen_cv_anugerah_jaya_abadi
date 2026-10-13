export const SAFE_API_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ACCOUNT_EMPLOYEE_LINK_CONFLICT: 'Karyawan tersebut sudah terhubung ke akun lain.',
  ACCOUNT_CONFLICT: 'Data akun bertentangan dengan data yang sudah ada. Periksa lalu coba lagi.',
  ACCOUNT_NOT_FOUND: 'Akun tidak ditemukan atau sudah tidak tersedia.',
  ACCOUNT_USERNAME_CONFLICT: 'Nama pengguna atau NIK sudah digunakan.',
  ACTIVE_ADMIN_FLOOR: 'Setidaknya dua akun Admin aktif harus tetap tersedia.',
  ATTENDANCE_ATTEMPT_CONFLICT:
    'Percobaan absensi berbenturan dengan data yang sudah ada. Coba lagi dengan kunci baru.',
  ATTENDANCE_ATTEMPT_RULE_REJECTED:
    'Percobaan absensi tidak sesuai aturan jadwal. Periksa riwayat atau ajukan koreksi kepada Admin.',
  ATTENDANCE_VERIFICATION_CONFLICT:
    'Status absensi sudah berubah. Antrian diperbarui; pilih data yang masih menunggu.',
  ATTENDANCE_VERIFICATION_NOT_FOUND:
    'Data verifikasi tidak lagi tersedia atau berada di luar cakupan Anda.',
  ATTENDANCE_REQUEST_DECISION_CONFLICT:
    'Pengajuan sudah diputuskan atau tidak lagi menunggu. Daftar diperbarui.',
  ATTENDANCE_DEVICE_BINDING_REQUIRED:
    'Perangkat terdaftar yang disetujui diperlukan untuk mengirim percobaan absensi.',
  ATTENDANCE_EVIDENCE_INVALID: 'Bukti absensi tidak valid. Ambil ulang foto lalu coba lagi.',
  ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE:
    'Validasi bukti absensi sedang tidak tersedia. Coba lagi nanti.',
  ATTENDANCE_STORE_SELECTION_REQUIRED:
    'Toko absensi belum dapat ditentukan. Hubungi Admin untuk memastikan penugasan toko sebelum mencoba lagi.',
  ATTENDANCE_UPLOAD_EXPIRED:
    'Tautan unggah foto kedaluwarsa atau ditolak. Foto belum tercatat; coba unggah kembali.',
  ATTENDANCE_UPLOAD_FAILED:
    'Foto belum berhasil diunggah ke penyimpanan. Absensi belum tercatat; periksa koneksi lalu coba lagi.',
  REQUEST_TIMEOUT:
    'Server atau penyimpanan terlalu lama merespons. Periksa koneksi lalu coba lagi.',
  NETWORK_ERROR:
    'Tidak dapat terhubung ke server atau penyimpanan. Periksa koneksi lalu coba lagi.',
  UUID_UNAVAILABLE:
    'Perangkat belum mendukung pengiriman absensi yang aman. Perbarui browser lalu coba lagi.',
  CONSENT_POLICY_STALE: 'Kebijakan privasi berubah. Muat ulang lalu tinjau kebijakan terbaru.',
  CONSENT_POLICY_UNAVAILABLE: 'Kebijakan privasi belum tersedia. Silakan coba lagi nanti.',
  CONSENT_REQUIRED: 'Setujui kebijakan privasi terlebih dahulu untuk melanjutkan.',
  CSRF_ORIGIN_NOT_CONFIGURED: 'Layanan belum siap menerima permintaan. Silakan coba lagi nanti.',
  CSRF_ORIGIN_REJECTED: 'Permintaan tidak dapat diproses dari halaman ini.',
  CURRENT_PASSWORD_INVALID: 'Password saat ini tidak sesuai.',
  DEVICE_BINDING_NOT_FOUND: 'Pendaftaran perangkat tidak ditemukan.',
  DEVICE_BINDING_PENDING: 'Perangkat menunggu persetujuan Admin.',
  DEVICE_BINDING_REVOKED: 'Akses perangkat ini telah dicabut. Hubungi Admin.',
  DEVICE_BINDING_REQUIRED: 'Perangkat ini belum disetujui Admin.',
  DEVICE_BINDING_STATE_CONFLICT: 'Status pendaftaran perangkat sudah berubah. Muat ulang halaman.',
  DEVICE_ENROLLMENT_UNAVAILABLE: 'Pendaftaran perangkat belum tersedia. Silakan coba lagi nanti.',
  DEVICE_INFO_REQUIRED: 'Informasi perangkat untuk pendaftaran belum tersedia. Hubungi Admin.',
  EMPLOYEE_NOT_ASSIGNED_TO_STORE:
    'Karyawan harus ditugaskan ke toko sebelum menerima shift toko tersebut.',
  EMPLOYEE_NIK_CONFLICT: 'NIK sudah digunakan oleh karyawan lain.',
  EMPLOYEE_NIK_USERNAME_CONFLICT: 'NIK sudah digunakan sebagai nama pengguna.',
  EMPLOYEE_NOT_FOUND: 'Data karyawan tidak ditemukan atau sudah tidak tersedia.',
  EMPLOYEE_PROFILE_REQUIRED: 'Profil karyawan belum lengkap. Hubungi Admin.',
  FORBIDDEN: 'Anda tidak memiliki akses untuk melakukan tindakan ini.',
  INVALID_ACCOUNT_INPUT: 'Periksa kembali data akun yang dimasukkan.',
  INVALID_DASHBOARD_INPUT: 'Filter riwayat tidak valid. Periksa kembali rentang tanggalnya.',
  INVALID_NOTIFICATION_INPUT: 'Filter atau status notifikasi tidak valid. Muat ulang halaman.',
  INVALID_SYSTEM_DISRUPTION: 'Periksa kembali cakupan, waktu, dan alasan gangguan sistem.',
  INVALID_ATTENDANCE_ATTEMPT: 'Periksa kembali data percobaan absensi yang dikirim.',
  INVALID_SELFIE_UPLOAD_INTENT:
    'Permintaan unggah foto tidak valid. Ambil foto ulang lalu coba lagi.',
  INVALID_SELFIE_REFERENCE: 'Referensi foto tidak valid. Ambil foto ulang lalu coba lagi.',
  ATTENDANCE_CHECK_IN_DUPLICATE:
    'Absen masuk untuk shift ini sudah tercatat. Periksa riwayat absensi.',
  ATTENDANCE_CHECK_IN_REQUIRED:
    'Absen pulang belum dapat dilakukan karena absen masuk untuk shift ini belum tercatat.',
  ATTENDANCE_CHECKOUT_SHIFT_MISMATCH:
    'Absen pulang tidak cocok dengan shift aktif. Periksa jadwal atau hubungi Admin.',
  ATTENDANCE_CHECKOUT_OUT_OF_ORDER:
    'Urutan absen pulang belum sesuai. Periksa riwayat atau hubungi Admin.',
  ATTENDANCE_CHECKOUT_WINDOW_EXPIRED:
    'Batas waktu absen pulang sudah lewat. Ajukan koreksi kepada Admin.',
  ATTENDANCE_REQUEST_DATE_OVERLAP:
    'Rentang tanggal bertumpang tindih dengan pengajuan aktif lain. Periksa pengajuan Anda.',
  ATTENDANCE_REQUEST_NOT_FOUND: 'Pengajuan tidak ditemukan atau sudah tidak tersedia.',
  INVALID_ATTENDANCE_REQUEST: 'Periksa kembali jenis, tanggal, alasan, dan lampiran pengajuan.',
  INVALID_VERIFICATION_INPUT: 'Parameter atau data verifikasi absensi tidak valid.',
  INVALID_VERIFICATION_QUERY: 'Parameter antrean verifikasi tidak valid.',
  INVALID_VERIFICATION_REASON: 'Alasan verifikasi maksimal 500 karakter dan tidak boleh kosong.',
  REJECTION_REASON_REQUIRED: 'Alasan penolakan verifikasi wajib diisi.',
  SELFIE_NOT_FOUND: 'Foto bukti sudah kedaluwarsa atau tidak lagi tersedia.',
  INVALID_REQUEST_ATTACHMENT: 'Surat dokter tidak valid. Periksa format dan ukuran file.',
  REQUEST_ATTACHMENT_STORAGE_UNAVAILABLE:
    'Penyimpanan surat dokter sedang tidak tersedia. Coba lagi nanti.',
  REQUEST_REQUIRES_ADMIN: 'Keputusan pengajuan ini hanya dapat diberikan oleh Admin.',
  ATTENDANCE_SHIFT_NOT_ASSIGNED: 'Anda belum memiliki penugasan shift aktif. Hubungi Admin.',
  ATTENDANCE_SHIFT_AMBIGUOUS:
    'Jadwal shift Anda bertumpang tindih. Hubungi Admin untuk memperbaikinya.',
  ATTENDANCE_NON_WORKING_DAY:
    'Hari ini bukan hari kerja pada jadwal Anda. Hubungi Admin bila ada perubahan jadwal.',
  INVALID_ATTENDANCE_VALIDATION_TRANSITION:
    'Status absensi sudah berubah. Muat ulang lalu coba lagi.',
  INVALID_AUDIT_INPUT: 'Filter yang dimasukkan tidak valid.',
  INVALID_CREDENTIALS: 'ID pengguna atau password tidak sesuai.',
  INVALID_DEVICE_BINDING_INPUT: 'Periksa kembali informasi perangkat yang dimasukkan.',
  INVALID_EMPLOYEE_INPUT: 'Periksa kembali data karyawan yang dimasukkan.',
  INVALID_INPUT: 'Periksa kembali data yang dimasukkan.',
  INVALID_REQUEST: 'Permintaan belum dapat diproses. Periksa data lalu coba lagi.',
  INVALID_REQUEST_STATUS_TRANSITION: 'Status pengajuan sudah berubah. Muat ulang lalu coba lagi.',
  IDEMPOTENCY_KEY_REUSED:
    'Kunci pengiriman sudah dipakai untuk data berbeda. Jangan kirim ulang payload ini; ambil tindakan baru setelah memeriksa riwayat absensi.',
  INVALID_STORE_INPUT: 'Periksa kembali data lokasi toko yang dimasukkan.',
  INVALID_SCHEDULE_INPUT: 'Periksa kembali data jadwal atau hari libur yang dimasukkan.',
  HOLIDAY_DATE_CONFLICT:
    'Hari libur untuk cakupan tersebut sudah terdaftar pada tanggal yang sama.',
  HOLIDAY_NOT_FOUND: 'Hari libur tidak ditemukan atau sudah tidak tersedia.',
  NOT_FOUND: 'Data yang diminta tidak ditemukan atau sudah tidak tersedia.',
  PAYLOAD_TOO_LARGE: 'Data yang dikirim terlalu besar. Coba ambil foto dengan ukuran lebih kecil.',
  PASSWORD_CHANGE_REQUIRED: 'Ganti password awal terlebih dahulu untuk melanjutkan.',
  PASSWORD_CHANGED_CONCURRENTLY: 'Password telah berubah. Muat ulang lalu masuk kembali.',
  SESSION_EXPIRED: 'Sesi Anda berakhir. Masuk kembali untuk melanjutkan.',
  STORE_NOT_FOUND: 'Toko tidak ditemukan atau sudah tidak tersedia.',
  SYSTEM_DISRUPTION_NOT_FOUND: 'Gangguan tidak ditemukan atau sudah tidak tersedia.',
  STORE_INACTIVE: 'Penugasan shift hanya dapat menggunakan toko yang aktif.',
  STORE_OR_EMPLOYEE_NOT_FOUND: 'Toko atau karyawan tidak ditemukan atau sudah tidak tersedia.',
  SHIFT_ASSIGNMENT_AMBIGUOUS:
    'Jadwal karyawan bertumpang tindih. Hubungi Admin untuk memperbaikinya.',
  SHIFT_ASSIGNMENT_CONFLICT: 'Rentang tanggal bertabrakan dengan penugasan shift lain.',
  SHIFT_ASSIGNMENT_HAS_ATTENDANCE:
    'Penugasan ini sudah dipakai dalam absensi dan tidak dapat diubah seperti itu.',
  SHIFT_ASSIGNMENT_NOT_FOUND: 'Penugasan shift tidak ditemukan atau sudah tidak tersedia.',
  SHIFT_HAS_ACTIVE_ASSIGNMENTS:
    'Akhiri atau pindahkan penugasan yang masih berlaku sebelum menonaktifkan shift.',
  SHIFT_HAS_ATTENDANCE: 'Shift sudah dipakai dalam absensi. Buat shift baru untuk mengubah jadwal.',
  SHIFT_INACTIVE: 'Penugasan baru hanya dapat menggunakan shift yang aktif.',
  SHIFT_NOT_FOUND: 'Shift tidak ditemukan atau sudah tidak tersedia.',
  RATE_LIMITED: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
  UNAUTHENTICATED: 'Sesi Anda berakhir. Masuk kembali untuk melanjutkan.',
  UNSUPPORTED_MEDIA_TYPE: 'Format data yang dikirim tidak didukung.',
  INTERNAL_SERVER_ERROR: 'Terjadi kendala pada layanan. Silakan coba lagi nanti.',
};

const GENERIC_MESSAGE = 'Permintaan belum dapat diproses. Silakan coba lagi.';
const NETWORK_MESSAGE = 'Tidak dapat terhubung ke server. Periksa koneksi internet lalu coba lagi.';
const UNAVAILABLE_MESSAGE = 'Layanan sedang tidak tersedia. Silakan coba lagi nanti.';
const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  400: 'Periksa kembali data yang dimasukkan.',
  401: 'Sesi Anda berakhir. Masuk kembali untuk melanjutkan.',
  403: 'Anda tidak memiliki akses untuk melakukan tindakan ini.',
  404: 'Data tidak lagi tersedia. Muat ulang halaman untuk melihat data terbaru.',
  409: 'Data sudah berubah atau bertentangan. Muat ulang sebelum melanjutkan.',
  422: 'Data belum memenuhi aturan. Periksa kembali isian lalu coba lagi.',
  429: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
  500: 'Terjadi kendala pada layanan. Silakan coba lagi nanti.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Convert an API/network error to a safe Indonesian message; never show server detail fields. */
export function toUserErrorMessage(error: unknown): string {
  if (error instanceof TypeError) return NETWORK_MESSAGE;
  if (!isRecord(error)) return GENERIC_MESSAGE;

  const code = typeof error.code === 'string' ? error.code : undefined;
  if (code && Object.hasOwn(SAFE_API_ERROR_MESSAGES, code)) return SAFE_API_ERROR_MESSAGES[code]!;
  if (typeof error.status === 'number' && STATUS_MESSAGES[error.status]) {
    return STATUS_MESSAGES[error.status]!;
  }
  if (typeof error.status === 'number' && error.status >= 500) return UNAVAILABLE_MESSAGE;
  return GENERIC_MESSAGE;
}
