import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AttendanceReceipt } from '../src/api/attendance-api.js';
import { AttendanceReceiptNotice } from '../src/components/attendance/AttendanceReceiptNotice.js';

const pendingReceipt: AttendanceReceipt = {
  attemptId: '00000000-0000-4000-8000-000000000004',
  state: 'RECORDED',
  type: 'CHECK_IN',
  receivedAt: '2026-10-11T03:00:00.000Z',
  replayed: false,
  attendanceId: '00000000-0000-4000-8000-000000000005',
  validationStatus: 'PENDING_VERIFICATION',
};

describe('AttendanceReceiptNotice', () => {
  it('says recorded and waiting for verification, never valid, for a pending server receipt', () => {
    const html = renderToStaticMarkup(<AttendanceReceiptNotice receipt={pendingReceipt} />);

    expect(html).toContain('Tercatat menunggu verifikasi');
    expect(html).toContain('Server telah mencatat absensi ini');
    expect(html).toContain('HASIL SERVER');
    expect(html).not.toContain('Absensi tercatat valid');
  });
});
