import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdminShiftAssignmentsSection } from '../src/pages/AdminShiftAssignmentsSection.js';

describe('AdminShiftAssignmentsSection', () => {
  it('renders the assignment section in a clear loading state and disables writes before data is ready', () => {
    const html = renderToStaticMarkup(
      <AdminShiftAssignmentsSection shifts={[]} shiftsState="loading" />,
    );

    expect(html).toContain('Penugasan shift per karyawan');
    expect(html).toContain('Memuat pilihan karyawan dan toko');
    expect(html).toContain('Memuat penugasan shift');
    expect(html).toContain('Tambah penugasan');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Nonaktifkan permanen');
  });
});
