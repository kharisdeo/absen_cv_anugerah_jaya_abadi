import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { HolidayDto } from '../src/api/admin-holidays-api.js';
import { AdminHolidaysSection, HolidayCalendar } from '../src/pages/AdminHolidaysSection.js';

const holiday: HolidayDto = {
  id: '00000000-0000-4000-8000-000000000631',
  storeId: null,
  holidayDate: '2028-02-29',
  description: 'Libur nasional',
  createdAt: '2026-10-10T08:00:00.000Z',
};

describe('AdminHolidaysSection', () => {
  it('renders scope and explicit month controls without browser-derived defaults', () => {
    const html = renderToStaticMarkup(<AdminHolidaysSection />);

    expect(html).toContain('Hari libur nasional');
    expect(html).toContain('Cakupan yang ditampilkan');
    expect(html).toContain('Bulan kalender');
    expect(html).toContain('Pilih bulan secara eksplisit');
    expect(html).toContain('value=""');
    expect(html).not.toContain('Tambah route');
  });

  it('renders accessible day buttons and marks dates with server holiday data', () => {
    const html = renderToStaticMarkup(
      <HolidayCalendar
        holidays={[holiday]}
        month="2028-02"
        onSelectDate={() => undefined}
        selectedDate="2028-02-29"
      />,
    );

    expect(html).toContain('role="grid"');
    expect(html).toContain('role="columnheader"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('29 Februari 2028');
    expect(html).toContain('admin-holiday-calendar__count">1</span>');
  });
});
