import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ConsentPolicyView, FirstPasswordForm, LoginForm } from '../src/pages/LoginPage.js';

describe('login and onboarding form examples', () => {
  it('renders username/password fields and the same safe lockout advisory for every failure', () => {
    const html = renderToStaticMarkup(<LoginForm onSubmit={async () => undefined} />);

    expect(html).toContain('Username atau NIK');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('setelah 5 kali kegagalan');
    expect(html).not.toContain('countdown');
  });

  it('renders server policy text verbatim with purpose list and explicit checkbox', () => {
    const policy = {
      version: 'v-approved',
      text: 'Kalimat pertama.\n\nKalimat kedua.',
      purposes: [
        { id: 'selfie', label: 'Selfie sebagai bukti absensi.' },
        { id: 'location', label: 'Lokasi hanya saat proses absensi.' },
      ],
    } as const;
    const html = renderToStaticMarkup(
      <ConsentPolicyView accepted={false} onAcceptedChange={() => undefined} policy={policy} />,
    );

    expect(html).toContain(policy.text);
    expect(html).toContain('v-approved');
    expect(html).toContain('Selfie sebagai bukti absensi.');
    expect(html).toContain('Lokasi hanya saat proses absensi.');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('checked=""');
  });

  it('requires new-password confirmation without adding undocumented complexity rules', () => {
    const html = renderToStaticMarkup(<FirstPasswordForm onSubmit={async () => undefined} />);

    expect(html).toContain('Password saat ini');
    expect(html).toContain('Password baru');
    expect(html).toContain('Konfirmasi password baru');
    expect(html).toContain('Tidak ada aturan tambahan');
    expect(html).not.toContain('minlength');
  });
});
