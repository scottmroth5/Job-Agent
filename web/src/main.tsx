import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { LookupsProvider } from './lookups.tsx';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render( // index.html has the root element
  <StrictMode>
    <LookupsProvider>
      <App />
    </LookupsProvider>
  </StrictMode>,
);
