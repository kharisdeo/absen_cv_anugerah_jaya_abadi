import { Link, NavLink, Outlet } from 'react-router-dom';

import type { AuthUser, UserRole } from '../auth/session.js';
import { ROLE_BASE_PATHS, ROLE_NAVIGATION } from '../app/role-navigation.js';

const roleLabel: Record<UserRole, string> = {
  EMPLOYEE: 'Karyawan',
  SUPERVISOR: 'Supervisor',
  ADMIN: 'Administrator',
};

export function AppShell({ user }: Readonly<{ user: AuthUser }>) {
  const items = ROLE_NAVIGATION[user.role];

  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="Navigasi utama">
        <Link className="brand" to={ROLE_BASE_PATHS[user.role]}>
          <img src="/icons/app-mark.svg" width="44" height="44" alt="" />
          <span className="brand-copy">
            <strong>Absensi AJ</strong>
            <span>ANUGERAH JAYA ABADI</span>
          </span>
        </Link>
        <p className="nav-caption">MENU UTAMA</p>
        <nav className="nav-list">
          {items.map((item) => (
            <NavLink
              className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
              {...(item.end ? { end: true } : {})}
              key={item.to}
              to={item.to}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footnote">
          <span className="sidebar-footnote__dot" aria-hidden="true" />
          <span>
            Ruang kerja aman
            <br />
            untuk tim Anda
          </span>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-title">
            <span className="eyebrow">CV ANUGERAH JAYA ABADI</span>
            <h1>Ruang kerja {roleLabel[user.role]}</h1>
          </div>
          <div
            className="profile-chip"
            aria-label={`Masuk sebagai ${user.username}, ${roleLabel[user.role]}`}
          >
            <span className="profile-avatar" aria-hidden="true">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="profile-copy">
              <strong>{user.username}</strong>
              <span>{roleLabel[user.role]}</span>
            </span>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>Absensi AJ</span>
          <span>Data pribadi hanya diakses sesuai peran.</span>
        </footer>
      </div>

      <nav className="mobile-nav" aria-label="Navigasi bawah; geser untuk melihat semua menu">
        {items.map((item) => (
          <NavLink
            className={({ isActive }) =>
              `mobile-nav__link${isActive ? ' mobile-nav__link--active' : ''}`
            }
            {...(item.end ? { end: true } : {})}
            key={item.to}
            to={item.to}
          >
            <span aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
