import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './library.css';

const container = document.getElementById('root');
if (!container) throw new Error('library root element is missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
