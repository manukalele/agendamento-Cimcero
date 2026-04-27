console.log('=== TESTE ELECTRON ===')
console.log('process.type:', process.type)
console.log('process.versions.electron:', process.versions.electron)

const electron = require('electron')
console.log('typeof electron:', typeof electron)

if (typeof electron === 'object' && electron.app) {
  console.log('OK: electron.app definido!')
  electron.app.whenReady().then(() => {
    console.log('APP READY!')
    electron.app.quit()
  })
} else {
  console.log('FALHA: electron retornou', typeof electron)
  console.log('process.type:', process.type)
  
  // Tentar acessar via binding interno
  try {
    const binding = process._linkedBinding('electron_browser_app')
    console.log('binding encontrado:', typeof binding)
  } catch(e) {
    console.log('binding falhou:', e.message)
  }
  
  process.exit(1)
}
