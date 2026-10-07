import type { AgFieldDefinition, AgReportState } from 'ag-studio'

/** The one data source Studio is given. Its id is the prefix of every field id below (`ledger.moneyIn`). */
export const SOURCE = 'ledger'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const text = (id: string, name: string, extra: Partial<AgFieldDefinition> = {}): AgFieldDefinition => ({ id, name, format: 'textFormat', ...extra }) as AgFieldDefinition
const money = (id: string, name: string): AgFieldDefinition => ({ id, name, format: 'currencyFormat', formatOptions: { format: usd } }) as AgFieldDefinition

/** Names and formats, so the dashboard says "Money in" and "$150.00" and not `moneyIn` and `150`. */
export const LEDGER_FIELDS: AgFieldDefinition[] = [
  text('id', 'Request', { hide: true }),
  { id: 'asked', name: 'Asked', format: 'dateTimeFormat' } as AgFieldDefinition,
  text('day', 'Day'),
  text('who', 'Who'),
  text('what', 'What for'),
  text('kind', 'Kind'),
  text('direction', 'Direction'),
  text('decision', 'Decision'),
  text('reason', 'Rule'),
  text('status', 'Status'),
  text('how', 'Approved by'),
  money('amount', 'Asked for'),
  money('moneyIn', 'Money in'),
  money('moneyOut', 'Money out'),
  money('kept', 'Kept'),
  money('refused', 'Refused'),
  money('owed', 'Still owed'),
  { id: 'daysOut', name: 'Days out', format: 'integerFormat' } as AgFieldDefinition,
  text('job', 'Job'),
  text('orderId', 'PayPal order'),
  text('captureId', 'PayPal capture'),
]

const f = (id: string, aggregation?: 'sum' | 'count' | 'countd') => ({ id: `${SOURCE}.${id}`, ...(aggregation ? { aggregation } : {}) })
const title = (text: string) => ({ title: { enabled: true, text } })
const only = (id: string, operator: 'equals' | 'greaterThan', value: string | number) => ({ field: { id: `${SOURCE}.${id}` }, model: { operator, value } })

/**
 * The dashboard Meera opens. Three tiles that only count what PayPal confirmed, the rules' refusals by rule, how each
 * request was approved, what the rules refused, and who still owes what. It is the saved layout: the owner can change
 * it in Studio and save their own, and "Reset" comes back to this one.
 */
export function demoLayout(): AgReportState {
  return {
    pages: [
      {
        id: 'control-room',
        widgets: {
          in: { type: 'value', dataMapping: { value: [f('moneyIn', 'sum')] }, format: title('MONEY IN · CONFIRMED') },
          out: { type: 'value', dataMapping: { value: [f('moneyOut', 'sum')] }, format: title('MONEY OUT · CONFIRMED') },
          kept: { type: 'value', dataMapping: { value: [f('kept', 'sum')] }, format: title('KEPT') },
          refusals: { type: 'bar-chart-grouped', dataMapping: { categoryKey: [f('reason')], valueKey: [f('id', 'count')], tooltipKey: [] }, format: title('REFUSALS BY RULE') },
          how: { type: 'donut-chart', dataMapping: { categoryKey: [f('how')], valueKey: [f('id', 'count')], tooltipKey: [] }, format: title('APPROVED BY') },
          refused: { type: 'grid', dataMapping: { cols: [f('who'), f('what'), f('reason'), f('amount')] }, format: title('WHAT THE RULES REFUSED') },
          owed: { type: 'grid', dataMapping: { cols: [f('who'), f('what'), f('owed', 'sum'), f('daysOut')] }, format: title('WHO STILL OWES WHAT') },
        },
        widgetLayout: {
          in: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 7 },
          out: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 7 },
          kept: { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 7 },
          refusals: { xTrack: 0, yTrack: 7, xSpan: 14, ySpan: 16 },
          how: { xTrack: 14, yTrack: 7, xSpan: 10, ySpan: 16 },
          refused: { xTrack: 0, yTrack: 23, xSpan: 16, ySpan: 17 },
          owed: { xTrack: 16, yTrack: 23, xSpan: 8, ySpan: 17 },
        },
        filter: {
          widget: {
            refusals: [only('decision', 'equals', 'DENY')],
            refused: [only('decision', 'equals', 'DENY')],
            owed: [only('owed', 'greaterThan', 0)],
          },
        },
      },
    ],
    selectedPageId: 'control-room',
    // Quiet by default so the canvas has room: the chat panel stays open, the rest open on demand.
    panels: { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true } },
  } as AgReportState
}

const KEY = 'mandate.control-room.layout.v1'

/** The owner's own saved layout for this browser, or null. A layout that is not a report is ignored, never trusted. */
export function loadLayout(): AgReportState | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AgReportState
    return Array.isArray(parsed?.pages) && parsed.pages.length > 0 && typeof parsed.selectedPageId === 'string' ? parsed : null
  } catch {
    return null
  }
}

export const saveLayout = (state: AgReportState) => localStorage.setItem(KEY, JSON.stringify(state))
export const clearLayout = () => localStorage.removeItem(KEY)
