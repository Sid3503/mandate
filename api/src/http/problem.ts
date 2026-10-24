import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail)
    this.name = 'Problem'
  }
}

export function problemBody(c: Context, problem: Problem): Record<string, unknown> {
  return {
    type: `urn:mandate:problem:${problem.code}`,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    instance: c.req.path,
    code: problem.code,
    requestId: c.get('requestId') as string | undefined,
    ...problem.extensions,
  }
}

export function sendProblem(c: Context, problem: Problem): Response {
  return c.body(JSON.stringify(problemBody(c, problem)), problem.status as 400, {
    'content-type': 'application/problem+json',
  })
}

export function zodIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

export function invalidRequest(error: ZodError): Problem {
  return new Problem(400, 'request.invalid', 'Request is invalid', 'The request failed validation.', {
    errors: zodIssues(error),
  })
}

export function onError(error: Error, c: Context): Response {
  if (error instanceof Problem) return sendProblem(c, error)
  if (error instanceof ZodError) return sendProblem(c, invalidRequest(error))
  if (error instanceof HTTPException) {
    return sendProblem(c, new Problem(error.status, 'request.invalid', 'Request is invalid', error.message))
  }
  const msg = error.message ?? ''
  const code = (error as { code?: string }).code
  if (code === 'SQLITE_BUSY' || /database is locked|sqlite_busy/i.test(msg)) {
    return sendProblem(c, new Problem(503, 'db.locked', 'Database is busy', 'The database is locked by another operation. Please retry.'))
  }
  if (code === 'SQLITE_FULL' || code === 'ENOSPC' || /disk is full|sqlite_full|enospc/i.test(msg)) {
    return sendProblem(c, new Problem(507, 'db.disk_full', 'Database storage full', 'The database or disk has run out of space. No changes were made.'))
  }
  const requestId = c.get('requestId') as string | undefined
  console.error(JSON.stringify({ level: 'error', requestId, name: error.name, message: process.env.LOG_ERRORS ? error.message : undefined }))
  return sendProblem(c, new Problem(500, 'internal', 'Internal error', 'The request failed.'))
}
