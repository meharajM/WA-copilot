import React from 'react'
import ReactDOM from 'react-dom/client'
import NativeHostDiagnostics from './NativeHostDiagnostics'
import BrowserProduct from './BrowserProduct'
import { isTauriRuntime } from './lib/tauri-native-bridge'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {/* Browser owns the product workspace; Tauri is a native capability host only. */}
    {isTauriRuntime() ? <NativeHostDiagnostics /> : <BrowserProduct />}
  </React.StrictMode>,
)
