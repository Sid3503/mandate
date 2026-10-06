import '@fontsource-variable/inter'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import '@fontsource/barlow-condensed/800.css'
import '@fontsource-variable/jetbrains-mono'
import './styles/app.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Shell } from './components/Shell'
import { ToastProvider } from './components/Toast'
import { ApiError } from './lib/api'
import { session } from './lib/session'
import { Today } from './screens/Today'
import { Proof } from './screens/Proof'
import { Landing } from './screens/Landing'
import { Clerk } from './screens/Clerk'
import { Deals } from './screens/Deals'
import { JobScreen, Jobs } from './screens/Jobs'
import { NewRequest } from './screens/NewRequest'
import { Receipt } from './screens/Receipt'
import { Rules } from './screens/Rules'
import { System } from './screens/System'
import { Unlock } from './screens/Unlock'
import { Loading } from './components/ui'

const Ledger = lazy(() => import('./screens/Ledger').then((module) => ({ default: module.Ledger })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
})

queryClient.getQueryCache().subscribe((event) => {
  const error = event.query.state.error
  if (error instanceof ApiError && error.status === 401) {
    session.clear()
    if (!location.pathname.endsWith('/unlock')) location.assign('/app/unlock')
  }
})

function RequireKey({ children }: { children: ReactNode }) {
  const where = useLocation()
  // The front door: a visitor with no key sees what Mandate is before being asked for one.
  if (!session.get()) return <Navigate to={where.pathname === '/' ? '/welcome' : '/unlock'} replace state={{ from: where.pathname }} />
  return <>{children}</>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
      <BrowserRouter basename="/app">
        <Routes>
          <Route path="/welcome" element={<Landing />} />
          <Route path="/unlock" element={<Unlock />} />
          <Route element={<RequireKey><Shell /></RequireKey>}>
            <Route index element={<Today />} />
            <Route path="p/:id" element={<Receipt />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/:jobId" element={<JobScreen />} />
            <Route path="deals" element={<Deals />} />
            <Route path="clerk" element={<Clerk />} />
            <Route path="new" element={<NewRequest />} />
            <Route path="ledger" element={<Suspense fallback={<div className="page"><Loading label="Opening ledger" /></div>}><Ledger /></Suspense>} />
            <Route path="rules" element={<Rules />} />
            <Route path="proof" element={<Proof />} />
            <Route path="system" element={<System />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
