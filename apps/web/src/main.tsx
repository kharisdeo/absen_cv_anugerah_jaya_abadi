import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';
import './components/ui/ui.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Elemen root aplikasi tidak ditemukan.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
