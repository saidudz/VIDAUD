import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import './styles/global.css'

document.documentElement.dataset.theme = 'dark'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider lang="en">
      <App />
    </I18nProvider>
  </React.StrictMode>
)
