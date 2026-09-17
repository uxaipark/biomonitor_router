import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },  // host:true → LAN(노트북 브라우저)에서 접속 허용
})
