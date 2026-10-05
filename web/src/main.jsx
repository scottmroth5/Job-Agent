import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { LookupsProvider } from './lookups.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LookupsProvider>
      <App />
    </LookupsProvider>
  </StrictMode>,
);
