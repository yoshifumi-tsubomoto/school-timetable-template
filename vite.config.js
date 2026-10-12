import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 【v8_7_40】Vercel のプレビュー（PRごとの確認用）では、版番号の横にコミット番号の先頭7文字を出す。
// 本番（production）やローカルでは空になり、何も表示されない。
const buildTag = process.env.VERCEL_ENV === 'preview' ? (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) : ''

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TAG__: JSON.stringify(buildTag),
  },
})
