import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { enableProductCopyPolish } from './lib/productCopy';
import './index.css';

enableProductCopyPolish();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
