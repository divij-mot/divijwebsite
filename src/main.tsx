import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import './index.css';
import './site/styles/site.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);
