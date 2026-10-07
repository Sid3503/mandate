import '@fontsource-variable/inter'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import '@fontsource/barlow-condensed/800.css'
import '@fontsource-variable/jetbrains-mono'
import './styles/app.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, StrictMode, Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Shell } from './components/Shell'
import { ToastProvider, useToast } from './components/Toast'
import { LiveProvider } from './lib/live'
import { ApiError } from './lib/api'
import { reportClientError } from './lib/report'
import { session } from './lib/session'
import { Today } from './screens/Today'
import { Proof } from './screens/Proof'
import { Verify } from './screens/Verify'
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

const ControlRoom = lazy(() => import('./screens/ControlRoom'))
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

/**
 * Failures nobody caught: a promise that rejected with no one listening, an error thrown outside React. They are
 * reported, and the person is told once in a while that something failed in the background. An ApiError is not one of
 * these: the screen that asked for it already shows it.
 */
function GlobalGuards() {
  const toast = useToast()
  useEffect(() => {
    let last = 0
    const tell = (scope: string, error: unknown) => {
      if (error instanceof ApiError || (error as Error)?.name === 'AbortError') return
      reportClientError(scope, error)
      if (Date.now() - last > 15_000) {
        last = Date.now()
        toast({ title: 'Something failed in the background', body: 'Nothing was sent to PayPal. If a screen looks wrong, reload it.', tone: 'warn', key: 'background-error' })
      }
    }
    const onRejection = (event: PromiseRejectionEvent) => tell('rejection', event.reason)
    const onError = (event: ErrorEvent) => tell('window', event.error ?? event.message)
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [toast])
  return null
}

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
        <GlobalGuards />
        <ErrorBoundary scope="app" fullPage>
        <Routes>
          <Route path="/welcome" element={<Landing />} />
          <Route path="/unlock" element={<Unlock />} />
          <Route path="/verify" element={<Verify />} />
          <Route element={<RequireKey><LiveProvider><Shell /></LiveProvider></RequireKey>}>
            <Route index element={<Today />} />
            <Route path="p/:id" element={<Receipt />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/:jobId" element={<JobScreen />} />
            <Route path="deals" element={<Deals />} />
            <Route path="clerk" element={<Clerk />} />
            <Route path="new" element={<NewRequest />} />
            <Route path="ledger" element={<Suspense fallback={<div className="page"><Loading label="Opening ledger" /></div>}><Ledger /></Suspense>} />
            <Route path="control-room" element={<Suspense fallback={<div className="page"><Loading label="Opening the control room" /></div>}><ControlRoom /></Suspense>} />
            <Route path="rules" element={<Rules />} />
            <Route path="proof" element={<Proof />} />
            <Route path="system" element={<System />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
