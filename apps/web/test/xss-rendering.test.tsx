import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const { fixture } = vi.hoisted(() => ({
  fixture: {
    employees: [
      {
        id: '00000000-0000-4000-8000-000000000101',
        fullName: '<img src=x onerror=alert(1)>',
        nik: 'NIK-<script>alert(2)</script>',
        position: '<svg onload=alert(3)>',
        employmentDate: '2025-01-15',
        status: 'ACTIVE',
      },
    ],
    employeesState: 'ready',
    employeesError: null,
    editorState: 'closed',
    editorEmployee: null,
    editorError: null,
    mutation: 'idle',
    mutationError: null,
    pendingDeactivation: null,
    confirmationBusy: false,
    confirmationError: null,
    notice: null,
  },
}));

vi.mock('../src/pages/admin-employees-model.js', () => ({
  AdminEmployeesModel: class {
    subscribe = () => () => undefined;
    getSnapshot = () => fixture;
    getServerSnapshot = () => fixture;
    loadEmployees = async () => undefined;
  },
}));

import { AdminEmployeesPage } from '../src/pages/AdminEmployeesPage.js';

describe('XSS-safe rendering of API-provided employee values', () => {
  it('renders hostile employee text as escaped text, never as executable markup', () => {
    const markup = renderToStaticMarkup(<AdminEmployeesPage />);

    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).toContain('NIK-&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(markup).toContain('&lt;svg onload=alert(3)&gt;');
    expect(markup).not.toContain('<img src=x');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<svg onload=');
  });
});
