import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { Proposal } from './types'
import { namer } from './words'

export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: () => api.session(), staleTime: 60_000, retry: false })
}

export function useWarrant() {
  return useQuery({ queryKey: ['warrant'], queryFn: api.warrant, staleTime: 30_000 })
}

export function useVersions() {
  return useQuery({ queryKey: ['versions'], queryFn: api.warrantVersions, staleTime: 30_000 })
}

export function useProposals() {
  return useQuery({ queryKey: ['proposals'], queryFn: () => api.proposals(), refetchInterval: 15_000 })
}

export function useNames() {
  const versions = useVersions()
  return useMemo(() => namer(versions.data?.data), [versions.data])
}

/** Map of PayPal capture id to the proposal that produced it, for "funded by" lines. */
export function useCaptures(proposals: Proposal[] | undefined) {
  return useMemo(() => {
    const map = new Map<string, Proposal>()
    for (const proposal of proposals ?? []) if (proposal.captureId) map.set(proposal.captureId, proposal)
    return map
  }, [proposals])
}

export function useIsOwner(): boolean {
  return useSession().data?.role === 'owner'
}

export function useNarrow(query = '(max-width: 860px)'): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const change = () => setNarrow(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [query])
  return narrow
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

/** Everything a money action can change. Called after approve, reject, settle, propose, publish. */
export function useRefreshMoney() {
  const client = useQueryClient()
  return () => Promise.all([
    client.invalidateQueries({ queryKey: ['proposals'] }),
    client.invalidateQueries({ queryKey: ['packet'] }),
    client.invalidateQueries({ queryKey: ['job'] }),
    client.invalidateQueries({ queryKey: ['ledger'] }),
  ])
}
