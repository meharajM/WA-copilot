import React from 'react'
import ReactDOM from 'react-dom/client'
import NativeHostDiagnostics from './NativeHostDiagnostics'
import BrowserProduct from './BrowserProduct'
import { isTauriRuntime } from './lib/tauri-native-bridge'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isTauriRuntime() ? <NativeHostDiagnostics /> : <BrowserProduct />}
  </React.StrictMode>,
)
